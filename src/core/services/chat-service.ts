import "server-only";
import { AppError } from "@halo/core/errors/app-error";
import type { Business, ChatMessage, Receptionist } from "@halo/core/domain/types";
import type { KnowledgeProvider } from "@halo/ports/knowledge-provider";
import type { LLMProvider } from "@halo/ports/llm-provider";
import type { NotificationProvider } from "@halo/ports/notification-provider";
import { logger } from "@halo/platform/logger";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { getKnowledgeProvider } from "@halo/providers/knowledge/factory";
import { getNotificationProvider } from "@halo/providers/notification/factory";
import { emitBusinessEvent, type EmitInput } from "@halo/workflows/event-bus";
import type { BookingOrchestrator } from "@halo/scheduling/booking-orchestrator";
import { BookingSystemActionProvider } from "@halo/scheduling/booking-runtime-adapter";
import { AgentRuntime, defaultDoctrine, newTurnId, type RuntimePolicy } from "@halo/runtime/agent-runtime";
import { channelProfileForConversation } from "@halo/runtime/channel-profile";
import type { ResolvedAgentRuntimeContext, RuntimeEventSink, RuntimeOutput } from "@halo/runtime/contracts";
import type { ConversationStateStore } from "@halo/runtime/conversation-state";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { SupabaseConversationStateStore } from "@halo/runtime/stores/supabase-conversation-state-store";
import type { ConversationStore } from "@halo/runtime/system-actions";
import { BUILTIN_TOOLS, ToolRegistry } from "@halo/runtime/tools/registry";
import { PROMPT_ASSEMBLER_VERSION } from "./prompt-builder";
import {
  KnowledgeGapHook,
  LeadCaptureHook,
  LeadCaptureService,
  requestHumanHandoffExecutor,
  saveContactDetailsExecutor,
} from "./lead-capture";
import { WidgetRepository } from "./widget-repository";

export type { ResolvedAgentRuntimeContext } from "@halo/runtime/contracts";

const log = logger.child({ service: "chat" });

/** Deprecated: mutable receptionist rows cannot establish a pinned identity. */
export function resolvedContextFromReceptionist(_params: {
  business: Business;
  receptionist: Receptionist;
}): ResolvedAgentRuntimeContext {
  throw AppError.validation("A published pinned agent context is required; use respondForAgent", {
    reason: "agent_context_required",
  });
}

export interface ChatServiceOptions {
  /** Defaults to the Postgres-backed store; tests inject an in-memory one. */
  stateStore?: ConversationStateStore;
  events?: RuntimeEventSink;
  policy?: Partial<RuntimePolicy>;
}

/**
 * The web-chat channel adapter over the HALO Agent Runtime (Phase 2).
 *
 * Before Phase 2 this class WAS the turn: retrieve → prompt → complete →
 * persist → capture. It now binds the application's trusted services to
 * the generic runtime — knowledge provider, transcript repository, the
 * scheduling engine as a system action, lead capture as a post-turn hook,
 * the two built-in controlled tools — and keeps its public surface so
 * routes and tests are unchanged.
 *
 * Trust: the resolved agent context (tenant, agent, version) comes from the
 * caller's server-side resolution; nothing here consults the client.
 */
export class ChatService {
  private runtime: AgentRuntime | null = null;

  constructor(
    private readonly llm: LLMProvider = getLLMProvider(),
    private readonly knowledge: KnowledgeProvider = getKnowledgeProvider(),
    private readonly notifications: NotificationProvider = getNotificationProvider(),
    private readonly repository: WidgetRepository = new WidgetRepository(),
    /** Appointment intelligence; null disables booking (e.g. in tests). */
    private readonly booking: BookingOrchestrator | null = null,
    /** Workflow/CRM automation feed; failures are logged, never propagated. */
    private readonly emitEvent: (input: EmitInput) => Promise<void> = emitBusinessEvent,
    private readonly options: ChatServiceOptions = {},
  ) {}

  private getRuntime(): AgentRuntime {
    if (this.runtime) return this.runtime;
    const leads = new LeadCaptureService(this.llm, this.notifications, this.repository, this.emitEvent);
    const conversations: ConversationStore = {
      loadHistory: (conversationId, _businessId, limit) => this.repository.getRecentMessages(conversationId, limit),
      appendMessages: (conversationId, businessId, messages) =>
        this.repository.appendMessages(conversationId, businessId, messages),
      appendToolRecords: (conversationId, businessId, records) =>
        typeof this.repository.appendToolRecords === "function"
          ? this.repository.appendToolRecords(conversationId, businessId, records)
          : Promise.resolve(),
    };
    this.runtime = new AgentRuntime({
      llm: this.llm,
      knowledge: new ProviderKnowledgeResolver(this.knowledge),
      conversations,
      stateStore: this.options.stateStore ?? new SupabaseConversationStateStore(),
      registry: new ToolRegistry(BUILTIN_TOOLS, {
        request_human_handoff: requestHumanHandoffExecutor,
        save_contact_details: saveContactDetailsExecutor(leads),
      }),
      systemActions: this.booking ? [new BookingSystemActionProvider(this.booking)] : [],
      hooks: [new LeadCaptureHook(leads), new KnowledgeGapHook(this.repository)],
      doctrine: defaultDoctrine,
      events: this.options.events,
      policy: this.options.policy,
    });
    return this.runtime;
  }

  /**
   * One conversational turn for a RESOLVED agent context — the runtime
   * boundary for the web channel. Unpinned legacy calls fail closed.
   */
  async respondForAgent(
    ctx: ResolvedAgentRuntimeContext,
    input: { conversationId: string; userMessage: string; channel?: "chat" | "voice"; turnId?: string; signal?: AbortSignal },
  ): Promise<{ reply: string; runtime: RuntimeOutput }> {
    const trusted = {
      businessId: ctx.business.id,
      conversationId: input.conversationId,
      agentId: ctx.agentId ?? null,
      agentVersionId: ctx.agentVersionId ?? null,
      turnId: input.turnId ?? newTurnId(),
    };

    log.info("responding", {
      businessId: ctx.business.id,
      conversationId: input.conversationId,
      turnId: trusted.turnId,
      agentId: ctx.agentId ?? undefined,
      agentVersionId: ctx.agentVersionId ?? undefined,
      promptAssemblerVersion: PROMPT_ASSEMBLER_VERSION,
      agentVersion: ctx.agentVersion > 0 ? ctx.agentVersion : undefined,
    });

    const output = await this.getRuntime().run({
      trusted,
      agent: ctx,
      channel: channelProfileForConversation(input.channel ?? "chat"),
      userMessage: input.userMessage,
      signal: input.signal,
    });
    return { reply: output.reply, runtime: output };
  }

  /**
   * @deprecated Always rejects; use `respondForAgent` with a resolver-built context.
   */
  async respond(params: {
    business: Business;
    receptionist: Receptionist;
    conversationId: string;
    userMessage: string;
    channel?: "chat" | "voice";
  }): Promise<{ reply: string; runtime: RuntimeOutput }> {
    return this.respondForAgent(resolvedContextFromReceptionist(params), {
      conversationId: params.conversationId,
      userMessage: params.userMessage,
      channel: params.channel,
    });
  }
}

export type { ChatMessage };
