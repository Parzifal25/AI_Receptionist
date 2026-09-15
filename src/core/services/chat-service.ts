import "server-only";
import type { AgentConfig } from "@halo/core/domain/agents";
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
import { PROMPT_ASSEMBLER_VERSION, receptionistDoctrine } from "./prompt-builder";
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

/**
 * Compatibility adapter: lifts a receptionist-shaped context (the pre-HALO
 * path) into a resolved agent context. Agent identity is unknown on this
 * path (legacy callers); the receptionist row remains the selector and the
 * conversation carries no agent linkage. The 0014 backfill maps every
 * receptionist to an agent, so this path is behaviour-identical, not
 * agent-broken.
 */
export function resolvedContextFromReceptionist(params: {
  business: Business;
  receptionist: Receptionist;
}): ResolvedAgentRuntimeContext {
  const config: AgentConfig = {
    identity: { name: params.receptionist.name, persona: params.receptionist.tone },
    objective: "",
    instructions: {
      promptTemplate: "",
      customInstructions: params.receptionist.customInstructions,
    },
    language: { primary: params.receptionist.language || "en", fallbacks: [], codeSwitchPolicy: "allow" },
    voice: { bargeIn: true },
    knowledge: { collectionIds: [], retrievalPolicy: "hybrid" },
    tools: { grantedToolIds: [], policy: {} },
    workflows: { allowedTriggers: [] },
    guardrails: { refusals: [], escalationTriggers: [], piiRules: {} },
  };
  return {
    business: params.business,
    agentId: null as unknown as string,
    agentVersionId: null as unknown as string,
    agentVersion: 0,
    config,
    promptTemplate: "",
    model: undefined,
    receptionist: params.receptionist,
  };
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
      // Agents with a published template run the generic doctrine; the
      // receptionist compatibility path keeps its persona, tone and playbook.
      doctrine: (agent, channel) =>
        agent.promptTemplate.trim()
          ? defaultDoctrine(agent, channel)
          : receptionistDoctrine({ business: agent.business, receptionist: agent.receptionist }),
      events: this.options.events,
      policy: this.options.policy,
    });
    return this.runtime;
  }

  /**
   * One conversational turn for a RESOLVED agent context — the runtime
   * boundary for the web channel. `respond()` remains as a thin, deprecated
   * compatibility shim over it.
   */
  async respondForAgent(
    ctx: ResolvedAgentRuntimeContext,
    input: { conversationId: string; userMessage: string; channel?: "chat" | "voice"; turnId?: string },
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
    });
    return { reply: output.reply, runtime: output };
  }

  /**
   * @deprecated Compatibility shim for the pre-agent receptionist path.
   * Prefer `respondForAgent` with a resolver-built context.
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
