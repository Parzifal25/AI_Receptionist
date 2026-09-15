import "server-only";
import type { Business, ChatMessage, LeadDraft } from "@halo/core/domain/types";
import type { LLMProvider } from "@halo/ports/llm-provider";
import type { NotificationProvider } from "@halo/ports/notification-provider";
import { logger } from "@halo/platform/logger";
import type { EmitInput } from "@halo/workflows/event-bus";
import type { TurnHook, TurnHookInput } from "@halo/runtime/system-actions";
import type { ToolExecutionOutcome } from "@halo/runtime/tools/registry";
import { extractLead, isLeadWorthSaving } from "./lead-extractor";
import type { WidgetRepository } from "./widget-repository";

const log = logger.child({ service: "lead-capture" });

/** Run lead extraction every N visitor messages to bound LLM cost. */
const LEAD_EXTRACTION_INTERVAL = 3;
/**
 * Messages that likely just changed the lead picture — contact details,
 * booking/pricing intent, urgency — trigger extraction immediately instead
 * of waiting for the periodic pass, so a hot lead is scored while it's hot.
 */
const LEAD_TRIGGER_RE =
  /@|\d{6,}|\b(book|booking|appointment|schedule|quote|estimate|price|pricing|cost|urgent|emergency|asap|call me|contact me|reach me)\b/i;

/** System actions whose success means the visitor just handed over lead details. */
const BOOKING_ACTIONS = new Set(["book_appointment", "reschedule_appointment"]);

/**
 * Application-owned lead persistence: the one path through which a lead
 * reaches the database, the CRM/workflow feed and the owner notification.
 * Used by the post-turn hook (automatic extraction) and by the
 * `save_contact_details` controlled tool (model-proposed, app-authorized).
 */
export class LeadCaptureService {
  constructor(
    private readonly llm: LLMProvider,
    private readonly notifications: NotificationProvider,
    private readonly repository: WidgetRepository,
    private readonly emitEvent: (input: EmitInput) => Promise<void>,
  ) {}

  async extractAndPersist(business: Business, conversationId: string, transcript: ChatMessage[]): Promise<void> {
    const draft = await extractLead(this.llm, transcript);
    if (!isLeadWorthSaving(draft)) return;
    await this.persist(business, conversationId, draft, transcript);
  }

  async persist(
    business: Business,
    conversationId: string,
    draft: LeadDraft,
    transcript: ChatMessage[],
  ): Promise<{ isNew: boolean }> {
    const { isNew } = await this.repository.upsertConversationLead(business.id, conversationId, draft, transcript);

    // Feed the automation platform: CRM sync + tenant workflows react to
    // every captured/updated lead. Fire-and-forget — never blocks the turn.
    void this.emitEvent({
      businessId: business.id,
      type: isNew ? "lead.created" : "lead.updated",
      correlationId: conversationId,
      payload: {
        conversationId,
        name: draft.name ?? "",
        email: draft.email ?? "",
        phone: draft.phone ?? "",
        intent: draft.intent ?? "",
      },
    }).catch((error) => log.warn("business event emit failed", { error }));

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
    return { isNew };
  }
}

/**
 * Post-turn hook reproducing the receptionist's lead-capture cadence:
 * periodic (every 3rd visitor message), on trigger phrases, or immediately
 * after a completed booking; skipped after a provider outage.
 */
export class LeadCaptureHook implements TurnHook {
  readonly name = "lead-capture";

  constructor(private readonly leads: LeadCaptureService) {}

  async afterTurn(input: TurnHookInput): Promise<void> {
    const { agent, output, context } = input;
    if (!agent.receptionist.leadCaptureEnabled || output.degraded.provider) return;

    // Same cadence as before Phase 2: visitor messages in the recent window
    // (16) plus this turn's message.
    const visitorMessageCount = context.recentMessages.filter((m) => m.role === "user").length + 1;
    const userMessage = output.transcript[0]?.content ?? "";
    const bookedNow = output.actions.some(
      (a) => a.source === "system" && a.status === "succeeded" && BOOKING_ACTIONS.has(a.name),
    );
    if (
      bookedNow ||
      visitorMessageCount % LEAD_EXTRACTION_INTERVAL === 0 ||
      LEAD_TRIGGER_RE.test(userMessage)
    ) {
      const transcript = [...context.recentMessages, ...output.transcript];
      await this.leads
        .extractAndPersist(agent.business, input.trusted.conversationId, transcript)
        .catch((error) => log.warn("lead capture failed", { error }));
    }
  }
}

/** Records a knowledge gap the owner should see (usage_events: unanswered_question). */
export class KnowledgeGapHook implements TurnHook {
  readonly name = "knowledge-gap";

  constructor(private readonly repository: Pick<WidgetRepository, "trackEvent">) {}

  async afterTurn(input: TurnHookInput): Promise<void> {
    if (!input.output.knowledgeGap) return;
    void this.repository
      .trackEvent(input.trusted.businessId, "unanswered_question", {
        conversationId: input.trusted.conversationId,
        question: (input.output.transcript[0]?.content ?? "").slice(0, 300),
      })
      .catch(() => {});
  }
}

/**
 * Executor for the `save_contact_details` controlled tool. The model may
 * propose it; this code decides what "saving" means — the same trusted
 * lead path as automatic capture — and reports exactly what happened.
 */
export function saveContactDetailsExecutor(leads: LeadCaptureService) {
  return async (
    args: { name: string; phone: string; email: string; note: string },
    ctx: { business: Business; trusted: { conversationId: string } },
  ): Promise<ToolExecutionOutcome> => {
    const draft: LeadDraft = {
      name: args.name.trim() || undefined,
      phone: args.phone.trim() || undefined,
      email: args.email.trim() || undefined,
      intent: args.note.trim() || undefined,
    };
    if (!isLeadWorthSaving(draft)) {
      return { ok: false, summary: "A phone number or email is required to save contact details." };
    }
    const { isNew } = await leads.persist(ctx.business, ctx.trusted.conversationId, draft, []);
    return {
      ok: true,
      summary: isNew
        ? "The visitor's contact details were saved for the team to follow up."
        : "The visitor's contact details were updated.",
      claimsPermitted: ["contact.saved"],
      statePatch: {
        slots: {
          ...(draft.name ? { visitor_name: draft.name.slice(0, 120) } : {}),
          ...(draft.phone ? { visitor_phone: draft.phone.slice(0, 40) } : {}),
          ...(draft.email ? { visitor_email: draft.email.slice(0, 200) } : {}),
        },
      },
    };
  };
}

/**
 * Executor for `request_human_handoff`: records the request as a typed
 * escalation. It does NOT claim anyone was contacted — the web channel has
 * no live transfer; the team is informed through the escalation event and
 * the visitor is offered a callback.
 */
export async function requestHumanHandoffExecutor(
  args: { reason: string },
): Promise<ToolExecutionOutcome> {
  return {
    ok: true,
    summary:
      "Handoff requested and recorded. Tell the visitor you will pass this on to the team, offer the business phone number if listed, and ask for the best way to reach them. Do not say anyone has already been contacted.",
    data: { reason: args.reason.slice(0, 200) },
    claimsPermitted: [],
    statePatch: { escalation: { status: "requested", reason: "explicit_human_request", at: null } },
    escalation: { reason: "explicit_human_request", priority: "normal" },
  };
}
