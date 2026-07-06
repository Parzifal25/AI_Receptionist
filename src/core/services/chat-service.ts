import "server-only";
import type { Business, ChatMessage, Receptionist } from "@/core/domain/types";
import type { KnowledgeProvider } from "@/core/ports/knowledge-provider";
import type { LLMProvider } from "@/core/ports/llm-provider";
import type { NotificationProvider } from "@/core/ports/notification-provider";
import { buildSystemPrompt } from "./prompt-builder";
import { extractLead, isLeadWorthSaving } from "./lead-extractor";
import { WidgetRepository } from "./widget-repository";
import { logger } from "@/lib/logger";
import { getLLMProvider } from "@/providers/llm/factory";
import { getKnowledgeProvider } from "@/providers/knowledge/factory";
import { getNotificationProvider } from "@/providers/notification/log-notification-provider";

const HISTORY_LIMIT = 16;
/** Run lead extraction every N visitor messages to bound LLM cost. */
const LEAD_EXTRACTION_INTERVAL = 3;

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
  ) {}

  async respond(params: {
    business: Business;
    receptionist: Receptionist;
    conversationId: string;
    userMessage: string;
  }): Promise<{ reply: string }> {
    const { business, receptionist, conversationId, userMessage } = params;

    const [history, snippets] = await Promise.all([
      this.repository.getRecentMessages(conversationId, HISTORY_LIMIT),
      this.knowledge
        .search(business.id, userMessage)
        .catch((error) => {
          // Retrieval failure degrades to profile-only answers, never a 500.
          log.warn("knowledge search failed, continuing without context", { error });
          return [];
        }),
    ]);

    const systemPrompt = buildSystemPrompt({ business, receptionist, knowledge: snippets });
    const messages: ChatMessage[] = [...history, { role: "user", content: userMessage }];

    // Low temperature: a receptionist must be factual, not creative.
    const result = await this.llm.complete(systemPrompt, messages, {
      temperature: 0.2,
      maxTokens: 400,
    });

    await this.repository.appendMessages(conversationId, business.id, [
      { role: "user", content: userMessage },
      { role: "assistant", content: result.content },
    ]);

    // Lead capture runs out of the hot path's critical failure domain.
    if (receptionist.leadCaptureEnabled) {
      const visitorMessageCount = messages.filter((m) => m.role === "user").length;
      if (visitorMessageCount % LEAD_EXTRACTION_INTERVAL === 0 || /@|\d{6,}/.test(userMessage)) {
        await this.captureLead(business, conversationId, [
          ...messages,
          { role: "assistant", content: result.content },
        ]).catch((error) => log.warn("lead capture failed", { error }));
      }
    }

    return { reply: result.content };
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
