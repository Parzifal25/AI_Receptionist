import { DEFAULT_BRANDING, type ChatMessage } from "@halo/core/domain/types";
import type { TranscriptDelivery } from "@halo/core/domain/voice";
import type { AgentVersion } from "@halo/core/domain/agents";
import type { Business } from "@halo/core/domain/types";
import type { LLMProvider } from "@halo/ports/llm-provider";
import { AgentRuntime, newTurnId, type DoctrineProvider, type RuntimePolicy } from "@halo/runtime/agent-runtime";
import { isRuntimeCancelled } from "@halo/runtime/cancellation";
import { VOICE_CONTEXT_LIMITS } from "@halo/runtime/context-builder";
import { PHONE_VOICE_PROFILE } from "@halo/runtime/channel-profile";
import type {
  EscalationReason,
  ResolvedAgentRuntimeContext,
  RuntimeEventSink,
  RuntimeOutput,
} from "@halo/runtime/contracts";
import type { ConversationStateStore } from "@halo/runtime/conversation-state";
import type { KnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import type { ConversationStore, SystemActionProvider, ToolTranscriptRecord, TurnHook } from "@halo/runtime/system-actions";
import { BUILTIN_TOOLS, ToolRegistry, type AnyToolExecutor } from "@halo/runtime/tools/registry";
import {
  TurnCancelledError,
  type VoiceDirective,
  type VoiceTurnHandler,
  type VoiceTurnRequest,
  type VoiceTurnResult,
} from "./turn-handler";

/**
 * HALO Phase 3 — the phone channel adapter over the HALO Agent Runtime.
 *
 * The phone counterpart of `ChatService` (the web adapter): it binds a
 * resolved agent context to the UNCHANGED runtime loop with the
 * `phone-voice` channel profile, and translates between the media loop's
 * VoiceTurnHandler contract and the runtime:
 *
 *   - barge-in → `RuntimeInput.signal` → `RuntimeCancelledError` →
 *     `TurnCancelledError` (nothing persisted);
 *   - the assistant transcript row is held until the session reports what
 *     the caller actually heard, then written as complete, interrupted
 *     (heard portion + marker) or not heard — so the next turn's model
 *     context tells the truth (plan §P5.6);
 *   - deterministic directives: `end_call` when conversation state says the
 *     conversation closed; `transfer` (at most once per call) when a human
 *     handoff was requested AND the tenant configured a live handoff number.
 *     The transfer target itself never passes through the model.
 */

/** Conversation-state `workflowStep` value that ends the call after the reply. */
export const CONVERSATION_CLOSED_STEP = "closed";

export const INTERRUPTED_MARKER = "[caller interrupted]";
export const NOT_HEARD_MARKER = "[not heard by caller]";

/**
 * Builds the runtime's resolved agent context for a call from server-side
 * routing. The `receptionist` field is the runtime's presentation block (name,
 * custom instructions, lead-capture flag) — never an identity source; tenant,
 * agent and version all come from the routed agent version.
 */
export function resolvedContextForCall(params: {
  business: Business;
  agentId: string;
  version: AgentVersion;
}): ResolvedAgentRuntimeContext {
  const { business, agentId, version } = params;
  return {
    business,
    agentId,
    agentVersionId: version.id,
    agentVersion: version.version,
    config: version.config,
    promptTemplate: version.promptTemplate,
    model: version.model,
    receptionist: {
      id: agentId,
      businessId: business.id,
      name: version.config.identity.name || business.name,
      greeting: version.config.voice.prompts.greeting,
      tone: "friendly",
      language: version.config.language.primary || "en",
      customInstructions: version.config.instructions.customInstructions,
      widgetKey: "",
      isActive: true,
      // Phone qualification captures contacts deterministically; the web
      // lead-capture doctrine does not apply.
      leadCaptureEnabled: false,
      voiceEnabled: true,
      branding: DEFAULT_BRANDING,
    },
  };
}

export interface VoiceTurnSignals {
  sttConfidence: number | null;
  language: string | null;
  turnIndex: number;
}

export interface PhoneTurnHandlerOptions {
  agent: ResolvedAgentRuntimeContext;
  conversationId: string;
  /** Real transcript persistence (tenant-scoped). */
  store: ConversationStore;
  llm: LLMProvider;
  knowledge: KnowledgeResolver;
  stateStore: ConversationStateStore;
  /** Built per call; receives the current turn's STT signals (trusted, server-side). */
  systemActions?: (signals: () => VoiceTurnSignals) => SystemActionProvider[];
  hooks?: TurnHook[];
  doctrine?: DoctrineProvider;
  events?: RuntimeEventSink;
  policy?: Partial<RuntimePolicy>;
  /** A tenant-configured handoff number exists and the provider can transfer. */
  liveHandoffAvailable: boolean;
  /** Escalation reasons that trigger a live transfer (default: explicit request only). */
  transferReasons?: EscalationReason[];
  /** Observes every completed runtime output (outcome computation, telemetry). */
  onTurnOutput?: (output: RuntimeOutput) => void;
}

interface PendingAssistant {
  conversationId: string;
  businessId: string;
  reply: string;
  turnId: string | null;
}

/**
 * A ConversationStore that writes caller rows immediately and holds the
 * assistant row until delivery is known. Writes are serialized.
 */
export class DeferredAssistantStore implements ConversationStore {
  private pending: PendingAssistant | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly inner: ConversationStore) {}

  loadHistory(conversationId: string, businessId: string, limit: number): Promise<ChatMessage[]> {
    return this.inner.loadHistory(conversationId, businessId, limit);
  }

  appendMessages(conversationId: string, businessId: string, messages: ChatMessage[]): Promise<void> {
    const assistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");
    const immediate = assistantIndex >= 0 ? messages.filter((_, i) => i !== assistantIndex) : messages;
    if (assistantIndex >= 0) {
      this.pending = { conversationId, businessId, reply: messages[assistantIndex].content, turnId: null };
    }
    return this.enqueue(() => (immediate.length > 0 ? this.inner.appendMessages(conversationId, businessId, immediate) : Promise.resolve()));
  }

  appendToolRecords(conversationId: string, businessId: string, records: ToolTranscriptRecord[]): Promise<void> {
    if (!this.inner.appendToolRecords) return Promise.resolve();
    return this.enqueue(() => this.inner.appendToolRecords!(conversationId, businessId, records));
  }

  /** Associates the held assistant row with the runtime turn that produced it. */
  bindPending(turnId: string): void {
    if (this.pending && this.pending.turnId === null) this.pending.turnId = turnId;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Writes the held row for `turnId` (or any held row when turnId is null). */
  resolve(turnId: string | null, status: TranscriptDelivery, deliveredText: string): Promise<void> {
    const pending = this.pending;
    if (!pending || (turnId !== null && pending.turnId !== turnId)) return this.chain;
    this.pending = null;
    const content = deliveredContent(pending.reply, status, deliveredText);
    return this.enqueue(() =>
      this.inner.appendMessages(pending.conversationId, pending.businessId, [{ role: "assistant", content }]),
    );
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }
}

export function deliveredContent(reply: string, status: TranscriptDelivery, deliveredText: string): string {
  if (status === "complete") return reply;
  const heard = deliveredText.trim();
  if (status === "interrupted" && heard) return `${heard} ${INTERRUPTED_MARKER}`;
  return NOT_HEARD_MARKER;
}

export class PhoneTurnHandler implements VoiceTurnHandler {
  private readonly runtime: AgentRuntime;
  private readonly store: DeferredAssistantStore;
  private signals: VoiceTurnSignals = { sttConfidence: null, language: null, turnIndex: 0 };
  private transferIssued = false;
  private readonly transferReasons: Set<EscalationReason>;

  constructor(private readonly options: PhoneTurnHandlerOptions) {
    this.store = new DeferredAssistantStore(options.store);
    this.transferReasons = new Set(options.transferReasons ?? ["explicit_human_request"]);
    this.runtime = new AgentRuntime({
      llm: options.llm,
      knowledge: options.knowledge,
      conversations: this.store,
      stateStore: options.stateStore,
      registry: new ToolRegistry(BUILTIN_TOOLS, {
        request_human_handoff: phoneHandoffExecutor(options.liveHandoffAvailable),
      }),
      systemActions: options.systemActions?.(() => this.signals) ?? [],
      hooks: options.hooks,
      doctrine: options.doctrine,
      events: options.events,
      // Voice-sized context budget: the caller waits in silence, so prompt
      // size is the part of time-to-first-token we control (§VOICE_TOKEN_BUDGET).
      policy: { turnTimeoutMs: 12_000, maxToolRounds: 1, contextLimits: VOICE_CONTEXT_LIMITS, ...options.policy },
    });
  }

  async handleTurn(request: VoiceTurnRequest): Promise<VoiceTurnResult> {
    // A reply the session never reported on (abandoned turn) is written as
    // not heard before the next turn reads history.
    if (this.store.hasPending()) await this.store.resolve(null, "not_delivered", "");
    this.signals = { sttConfidence: request.sttConfidence, language: request.language, turnIndex: request.turnIndex };
    const agent = this.options.agent;
    const turnId = newTurnId();
    let output: RuntimeOutput;
    try {
      output = await this.runtime.run({
        trusted: {
          businessId: agent.business.id,
          conversationId: this.options.conversationId,
          agentId: agent.agentId,
          agentVersionId: agent.agentVersionId,
          turnId,
        },
        agent,
        channel: PHONE_VOICE_PROFILE,
        userMessage: request.utterance,
        signal: request.signal,
      });
    } catch (error) {
      if (isRuntimeCancelled(error)) throw new TurnCancelledError();
      throw error;
    }
    this.store.bindPending(output.turnId);
    try {
      this.options.onTurnOutput?.(output);
    } catch {
      // observers never break the call
    }
    return {
      turnId: output.turnId,
      reply: output.reply,
      directive: this.directiveFor(output),
      usage: {
        modelCalls: output.usage.modelCalls,
        ...(output.usage.inputTokens !== undefined ? { inputTokens: output.usage.inputTokens } : {}),
        ...(output.usage.outputTokens !== undefined ? { outputTokens: output.usage.outputTokens } : {}),
      },
      degraded: output.degraded.provider || output.degraded.knowledge || output.degraded.state,
    };
  }

  recordDelivery(turnId: string, delivery: { status: TranscriptDelivery; deliveredText: string }): Promise<void> {
    return this.store.resolve(turnId, delivery.status, delivery.deliveredText);
  }

  async close(): Promise<void> {
    try {
      await this.store.flush();
      if (this.store.hasPending()) await this.store.resolve(null, "not_delivered", "");
    } catch {
      // close never throws
    }
  }

  private directiveFor(output: RuntimeOutput): VoiceDirective {
    if (output.state.workflowStep === CONVERSATION_CLOSED_STEP && !output.degraded.provider) {
      return { kind: "end_call", reason: "conversation_closed" };
    }
    if (!this.options.liveHandoffAvailable || this.transferIssued) return { kind: "continue" };
    const handoffTool = output.toolResults.some((r) => r.name === "request_human_handoff" && r.status === "succeeded");
    const reason = output.escalation.escalate ? output.escalation.reason : undefined;
    if (handoffTool || (reason && this.transferReasons.has(reason))) {
      this.transferIssued = true;
      return { kind: "transfer", reason: reason ?? "explicit_human_request" };
    }
    return { kind: "continue" };
  }
}

/**
 * Phone binding of the built-in `request_human_handoff` tool. It records the
 * escalation; whether a live transfer follows is decided by the adapter from
 * tenant configuration. The model is told exactly what will happen, and may
 * claim a handoff only when a live transfer is really available.
 */
export function phoneHandoffExecutor(liveHandoffAvailable: boolean): AnyToolExecutor {
  return async (_args, ctx) => ({
    ok: true,
    summary: liveHandoffAvailable
      ? "Recorded. The system will connect the caller to a team member right after your reply. Say briefly that you are connecting them."
      : "Recorded for a callback. Nobody can take the call live right now. Tell the caller honestly that the team will call them back; do not say they are being connected.",
    claimsPermitted: liveHandoffAvailable ? ["handoff"] : [],
    escalation: { reason: "explicit_human_request", priority: liveHandoffAvailable ? "high" : "normal" },
    statePatch: { escalation: { status: "requested", reason: "explicit_human_request", at: ctx.now.toISOString() } },
  });
}
