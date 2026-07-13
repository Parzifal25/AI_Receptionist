import "server-only";
import type { Business, ChatMessage, Receptionist } from "@/core/domain/types";
import type { KnowledgeProvider } from "@/core/ports/knowledge-provider";
import type { LLMProvider } from "@/core/ports/llm-provider";
import type { NotificationProvider } from "@/core/ports/notification-provider";
import { buildSystemPrompt, PROMPT_VERSION } from "./prompt-builder";
import { buildRetrievalQuery, isSubstantiveQuestion } from "./retrieval-query";
import { extractLead, isLeadWorthSaving } from "./lead-extractor";
import type { BookingOrchestrator } from "./scheduling/booking-orchestrator";
import { WidgetRepository } from "./widget-repository";
import { isAppError } from "@/core/errors/app-error";
import { logger } from "@/lib/logger";
import { getLLMProvider } from "@/providers/llm/factory";
import { getKnowledgeProvider } from "@/providers/knowledge/factory";
import { getNotificationProvider } from "@/providers/notification/log-notification-provider";

/**
 * Shown when the LLM provider is down or times out. The widget must never
 * hard-fail a chat turn over an upstream outage — a canned but honest reply
 * keeps the conversation usable and still gives the visitor a next step.
 */
const PROVIDER_FALLBACK_REPLY =
  "Sorry, I'm having trouble connecting right now. Please try again in a moment, " +
  "or leave your name and phone/email and the team will follow up.";

const HISTORY_LIMIT = 16;
/** Run lead extraction every N visitor messages to bound LLM cost. */
const LEAD_EXTRACTION_INTERVAL = 3;
/**
 * Messages that likely just changed the lead picture — contact details,
 * booking/pricing intent, urgency — trigger extraction immediately instead
 * of waiting for the periodic pass, so a hot lead is scored while it's hot.
 */
const LEAD_TRIGGER_RE =
  /@|\d{6,}|\b(book|booking|appointment|schedule|quote|estimate|price|pricing|cost|urgent|emergency|asap|call me|contact me|reach me)\b/i;

const log = logger.child({ service: "chat" });

/**
 * Orchestrates one conversational turn:
 * retrieve knowledge → build prompt → complete → persist → capture lead.
 * Depends only on ports; providers are injected (defaulted from factories).
 */
export class ChatService {
  constructor(
    private readonly llm: LLMProvider = getLLMProvider(),
    private readonly knowledge: KnowledgeProvider = getKnowledgeProvider(),
    private readonly notifications: NotificationProvider = getNotificationProvider(),
    private readonly repository: WidgetRepository = new WidgetRepository(),
    /** Appointment intelligence; null disables booking (e.g. in tests). */
    private readonly booking: BookingOrchestrator | null = null,
  ) {}

  async respond(params: {
    business: Business;
    receptionist: Receptionist;
    conversationId: string;
    userMessage: string;
    channel?: "chat" | "voice";
  }): Promise<{ reply: string }> {
    const { business, receptionist, conversationId, userMessage, channel } = params;

    // History first: follow-up messages ("how much is that?") retrieve
    // against the conversation topic, not just the literal words.
    const history = await this.repository.getRecentMessages(conversationId, HISTORY_LIMIT);
    const retrievalQuery = buildRetrievalQuery(history, userMessage);

    const snippets = await this.knowledge
      .search(business.id, retrievalQuery)
      .catch((error) => {
        // Retrieval failure degrades to profile-only answers, never a 500.
        log.warn("knowledge search failed, continuing without context", { error });
        return [];
      });

    // A real question with zero grounding is a knowledge gap the owner should
    // see — the knowledge base improves in the order customers ask for it.
    if (snippets.length === 0 && isSubstantiveQuestion(userMessage)) {
      void this.repository
        .trackEvent(business.id, "unanswered_question", {
          conversationId,
          question: userMessage.slice(0, 300),
        })
        .catch(() => {});
    }

    // Appointment intelligence: real availability and just-executed booking
    // actions are injected as ground truth, so the model narrates what the
    // engine actually did instead of inventing times. Failures degrade to a
    // normal (booking-free) turn — scheduling must never break the chat.
    const bookingContext = this.booking
      ? await this.booking
          .prepareTurn({ business, conversationId, history, userMessage })
          .catch((error) => {
            log.warn("booking orchestration failed, continuing without it", { error });
            return null;
          })
      : null;

    const basePrompt = buildSystemPrompt({ business, receptionist, knowledge: snippets, channel });
    const systemPrompt = bookingContext
      ? `${basePrompt}\n\n${bookingContext.promptSection}`
      : basePrompt;
    const messages: ChatMessage[] = [...history, { role: "user", content: userMessage }];

    // Grounding telemetry: how many sources the turn was anchored to, and
    // which prompt revision produced it — feeds answer-quality analysis.
    log.info("responding", {
      businessId: business.id,
      conversationId,
      promptVersion: PROMPT_VERSION,
      groundingSources: snippets.length,
      historyTurns: history.length,
    });

    // Low temperature keeps a receptionist factual; a touch above the floor
    // stops it repeating identical canned phrasings turn after turn.
    // A provider outage/timeout degrades to a canned reply instead of
    // failing the request — the widget must never surface a raw 5xx.
    let replyContent: string;
    let providerFailed = false;
    try {
      const result = await this.llm.complete(systemPrompt, messages, {
        temperature: 0.3,
        maxTokens: 400,
      });
      replyContent = result.content;
    } catch (error) {
      providerFailed = true;
      log.error("llm completion failed, degrading to fallback reply", {
        businessId: business.id,
        conversationId,
        provider: this.llm.name,
        code: isAppError(error) ? error.code : undefined,
        error,
      });
      replyContent = PROVIDER_FALLBACK_REPLY;
    }

    await this.repository.appendMessages(conversationId, business.id, [
      { role: "user", content: userMessage },
      { role: "assistant", content: replyContent },
    ]);

    // Lead capture also calls the LLM (extraction pass) — skip it this turn
    // if the provider just failed, rather than compounding one outage with a
    // second doomed call.
    if (receptionist.leadCaptureEnabled && !providerFailed) {
      const visitorMessageCount = messages.filter((m) => m.role === "user").length;
      // A completed booking always captures the lead — the visitor just
      // handed over exactly the details a lead needs.
      if (
        bookingContext?.bookedNow ||
        visitorMessageCount % LEAD_EXTRACTION_INTERVAL === 0 ||
        LEAD_TRIGGER_RE.test(userMessage)
      ) {
        await this.captureLead(business, conversationId, [
          ...messages,
          { role: "assistant", content: replyContent },
        ]).catch((error) => log.warn("lead capture failed", { error }));
      }
    }

    return { reply: replyContent };
  }

  private async captureLead(
    business: Business,
    conversationId: string,
    transcript: ChatMessage[],
  ): Promise<void> {
    const draft = await extractLead(this.llm, transcript);
    if (!isLeadWorthSaving(draft)) return;

    const { isNew } = await this.repository.upsertConversationLead(
      business.id,
      conversationId,
      draft,
      transcript,
    );

    if (isNew) {
      await this.repository.trackEvent(business.id, "lead_captured");
      const settings = await this.repository.getBusinessNotificationSettings(business.id);
      if (settings.notifyOnLead) {
        await this.notifications.notifyNewLead({
          businessId: business.id,
          businessName: business.name,
          recipientEmail: settings.notificationEmail,
          lead: {
            name: draft.name ?? "",
            email: draft.email ?? "",
            phone: draft.phone ?? "",
            intent: draft.intent ?? "",
          },
        });
      }
    }
  }
}
