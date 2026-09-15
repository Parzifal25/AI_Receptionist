import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@halo/core/domain/types";
import { AppError, isAppError } from "@halo/core/errors/app-error";
import { isSubstantiveQuestion } from "@halo/knowledge/retrieval-query";
import { describeCapabilities, type LLMDelta, type LLMMessage, type LLMProvider } from "@halo/ports/llm-provider";
import { logger } from "@halo/platform/logger";
import { isRuntimeCancelled, RuntimeCancelledError } from "./cancellation";
import { buildConversationContext, conversationalHistory, DEFAULT_CONTEXT_LIMITS } from "./context-builder";
import type {
  ActionRecord,
  ChannelProfile,
  ContextLimits,
  EscalationDecision,
  ModelCallUsage,
  ResolvedAgentRuntimeContext,
  RuntimeDegradation,
  RuntimeEventSink,
  RuntimeInput,
  RuntimeOutput,
  ToolIntent,
  ToolResult,
  UsageMetadata,
  ValidationOutcome,
} from "./contracts";
import {
  applyStatePatch,
  emptyConversationState,
  type ConversationState,
  type ConversationStateStore,
} from "./conversation-state";
import { decideEscalation } from "./escalation-manager";
import { LoggerEventSink, TurnEvents } from "./events";
import { emptyKnowledge, type KnowledgeResolver } from "./knowledge-resolver";
import { DEFAULT_MODEL_RETRY_POLICY, invokeModel, type ModelRetryPolicy } from "./llm-adapter";
import { updateMemory } from "./memory-manager";
import {
  composePrompt,
  genericDoctrine,
  LEAD_CAPTURE_DOCTRINE,
  PROMPT_COMPOSER_VERSION,
  type PromptDoctrine,
} from "./prompt-composer";
import { correctiveInstruction, safeFallbackReply, validateReply } from "./response-validator";
import type { ConversationStore, SystemActionProvider, ToolTranscriptRecord, TurnHook } from "./system-actions";
import {
  authorizeIntent,
  executeIntent,
  rejectionResult,
  selectTools,
  TOOL_BOUNDARY_LIMITS,
  toToolIntent,
} from "./tools/boundary";
import { ToolRegistry, type ToolExecutionContext } from "./tools/registry";

/**
 * HALO Phase 2 — the Agent Runtime (Workstream 9 and the pipeline).
 *
 *   TrustedRequestContext + ResolvedAgentRuntimeContext
 *     → state + history            (stores; degrade on state failure)
 *     → KnowledgeResolver          (degrade to no knowledge)
 *     → SystemActionProviders      (deterministic act-before-narrate)
 *     → selectTools                (offered capabilities, capability-aware)
 *     → ContextBuilder             (bounded, deterministic)
 *     → PromptComposer             (persisted agent content + code policy)
 *     → bounded model/tool loop    (maxToolRounds, deadline, idempotency)
 *     → ResponseValidator          (act-then-narrate, channel constraints)
 *     → EscalationManager          (typed decision)
 *     → MemoryManager              (bounded recap, state)
 *     → persist transcript + state → TurnHooks → Output + Events + Usage
 *
 * Bounds that hold regardless of provider behaviour:
 *   - model calls per turn ≤ maxToolRounds + 1 (+ maxRegenerations);
 *   - tool intents per round ≤ maxIntentsPerRound; each executed at most
 *     once per turn (idempotency key), never retried;
 *   - wall clock ≤ turnTimeoutMs for model work (deadline race);
 *   - context size ≤ ContextLimits;
 *   - an aborted `input.signal` cancels the turn only while nothing has
 *     committed; a cancelled turn persists nothing (cancellation.ts).
 */

export const PROVIDER_FALLBACK_REPLY =
  "Sorry, I'm having trouble connecting right now. Please try again in a moment, " +
  "or leave your name and phone/email and the team will follow up.";

export interface RuntimePolicy {
  maxToolRounds: number;
  maxIntentsPerRound: number;
  turnTimeoutMs: number;
  /** Ceiling on each conversation-state load/save; exceeding it degrades, never blocks the turn. */
  stateTimeoutMs: number;
  maxRegenerations: number;
  modelRetry: ModelRetryPolicy;
  contextLimits: ContextLimits;
  defaultTemperature: number;
  defaultMaxTokens: number;
  providerFallbackReply: string;
}

export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = Object.freeze({
  maxToolRounds: 2,
  maxIntentsPerRound: TOOL_BOUNDARY_LIMITS.maxIntentsPerRound,
  turnTimeoutMs: 120_000,
  stateTimeoutMs: 2_000,
  maxRegenerations: 1,
  modelRetry: DEFAULT_MODEL_RETRY_POLICY,
  contextLimits: DEFAULT_CONTEXT_LIMITS,
  defaultTemperature: 0.3,
  defaultMaxTokens: 400,
  providerFallbackReply: PROVIDER_FALLBACK_REPLY,
});

export type DoctrineProvider = (agent: ResolvedAgentRuntimeContext, channel: ChannelProfile) => PromptDoctrine;

/** Generic doctrine plus contact-capture behaviour when the agent captures leads. */
export const defaultDoctrine: DoctrineProvider = (agent) => {
  const doctrine = genericDoctrine();
  if (agent.receptionist.leadCaptureEnabled) doctrine.extras.push(LEAD_CAPTURE_DOCTRINE);
  return doctrine;
};

export interface AgentRuntimeDeps {
  llm: LLMProvider;
  knowledge: KnowledgeResolver;
  conversations: ConversationStore;
  stateStore: ConversationStateStore;
  registry?: ToolRegistry;
  systemActions?: SystemActionProvider[];
  hooks?: TurnHook[];
  doctrine?: DoctrineProvider;
  events?: RuntimeEventSink;
  policy?: Partial<RuntimePolicy>;
  /** Present → streaming is used when the provider supports it. */
  onDelta?: (delta: LLMDelta) => void;
  clock?: () => Date;
  turnIdGenerator?: () => string;
}

const log = logger.child({ service: "agent-runtime" });

export function newTurnId(): string {
  return randomUUID();
}

export class AgentRuntime {
  private readonly policy: RuntimePolicy;
  private readonly registry: ToolRegistry;
  private readonly systemActions: SystemActionProvider[];
  private readonly hooks: TurnHook[];
  private readonly doctrine: DoctrineProvider;
  private readonly sink: RuntimeEventSink;
  private readonly clock: () => Date;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.policy = { ...DEFAULT_RUNTIME_POLICY, ...(deps.policy ?? {}) };
    this.registry = deps.registry ?? new ToolRegistry();
    this.systemActions = deps.systemActions ?? [];
    this.hooks = deps.hooks ?? [];
    this.doctrine = deps.doctrine ?? defaultDoctrine;
    this.sink = deps.events ?? new LoggerEventSink();
    this.clock = deps.clock ?? (() => new Date());
  }

  async run(input: RuntimeInput): Promise<RuntimeOutput> {
    const { trusted, agent, channel } = input;
    // Defence in depth: the trusted context and the resolved agent must
    // agree on the tenant. A mismatch is a programming error upstream and
    // must never execute.
    if (trusted.businessId !== agent.business.id) {
      throw AppError.forbidden("Tenant context mismatch", { reason: "tenant_mismatch" });
    }
    if (trusted.agentVersionId && agent.agentVersionId && trusted.agentVersionId !== agent.agentVersionId) {
      throw AppError.forbidden("Agent version mismatch", { reason: "version_mismatch" });
    }

    // `now` is the turn's business time (injectable for deterministic
    // tests); deadlines and timings always use the wall clock.
    const now = input.now ?? this.clock();
    const startedAt = Date.now();
    const deadlineAt = startedAt + this.policy.turnTimeoutMs;
    const events = new TurnEvents(trusted, this.sink, this.clock);
    const limits = this.policy.contextLimits;
    const userMessage = input.userMessage;
    const degraded: RuntimeDegradation = { provider: false, knowledge: false, state: false, systemActions: false };
    const capabilities = describeCapabilities(this.deps.llm);
    const signal = input.signal;
    // Committed = at least one action succeeded this turn. From then on the
    // turn completes regardless of cancellation (see cancellation.ts).
    let committed = false;
    const checkpoint = (stage: string) => {
      if (signal?.aborted && !committed) throw new RuntimeCancelledError(stage);
    };

    events.emit("runtime.started", {
      channel: channel.id,
      agentVersion: agent.agentVersion,
      promptComposerVersion: PROMPT_COMPOSER_VERSION,
      provider: this.deps.llm.name,
      streaming: capabilities.streaming && typeof this.deps.onDelta === "function",
    });

    try {
      checkpoint("start");
      // ---- state + history ------------------------------------------------
      const contextStart = Date.now();
      let state: ConversationState = emptyConversationState();
      try {
        state =
          (await withTimeout(
            this.deps.stateStore.load(trusted.conversationId, trusted.businessId),
            this.policy.stateTimeoutMs,
            "conversation state load",
          )) ?? state;
      } catch (error) {
        degraded.state = true;
        log.warn("conversation state load failed, continuing with empty state", {
          conversationId: trusted.conversationId,
          error,
        });
      }
      const history = conversationalHistory(
        await this.deps.conversations.loadHistory(trusted.conversationId, trusted.businessId, limits.maxHistoryFetch),
      );

      checkpoint("history");
      // ---- knowledge --------------------------------------------------------
      const retrievalStart = Date.now();
      let knowledge = emptyKnowledge();
      try {
        knowledge = await this.deps.knowledge.resolve({
          businessId: trusted.businessId,
          collectionIds: agent.config.knowledge.collectionIds,
          history,
          userMessage,
          limits: { maxSnippets: limits.maxKnowledgeSnippets, maxChars: limits.maxKnowledgeChars },
        });
      } catch (error) {
        degraded.knowledge = true;
        log.warn("knowledge resolution failed, continuing without context", { error });
      }
      const retrievalMs = Date.now() - retrievalStart;
      events.emit("knowledge.retrieved", {
        resolver: this.deps.knowledge.name,
        snippets: knowledge.snippets.length,
        chars: knowledge.charsUsed,
        truncated: knowledge.truncated,
        degraded: degraded.knowledge,
        latencyMs: retrievalMs,
      });
      const knowledgeGap = knowledge.snippets.length === 0 && isSubstantiveQuestion(userMessage);

      checkpoint("knowledge");
      // ---- system actions (act before narrate) ------------------------------
      const actionsStart = Date.now();
      const systemSections: string[] = [];
      const actions: ActionRecord[] = [];
      for (const provider of this.systemActions) {
        try {
          const outcome = await provider.prepare({
            trusted,
            business: agent.business,
            history,
            userMessage,
            state,
            now,
          });
          if (!outcome) continue;
          systemSections.push(...outcome.sections);
          for (const action of outcome.actions) {
            actions.push(action);
            events.emit(action.status === "succeeded" ? "action.executed" : "action.failed", {
              source: "system",
              provider: provider.name,
              name: action.name,
              claims: action.claimsPermitted,
            });
          }
          if (outcome.statePatch) state = applyStatePatch(state, outcome.statePatch);
        } catch (error) {
          degraded.systemActions = true;
          log.warn("system action provider failed, continuing without it", { provider: provider.name, error });
        }
      }
      let actionsMs = Date.now() - actionsStart;
      committed = actions.some((a) => a.status === "succeeded");
      checkpoint("system_actions");

      // ---- tool selection (capability-aware) -------------------------------
      const execution: ToolExecutionContext = {
        trusted,
        business: agent.business,
        state,
        channel,
        userMessage,
        now,
      };
      const selected = selectTools({
        registry: this.registry,
        grantedToolIds: agent.config.tools.grantedToolIds,
        channel,
        providerSupportsTools: capabilities.tools,
        execution,
      });
      if (selected.downgraded) {
        events.emit("tool.capability_downgraded", {
          provider: this.deps.llm.name,
          granted: agent.config.tools.grantedToolIds.length,
        });
      }

      // ---- context + prompt --------------------------------------------------
      const context = buildConversationContext({
        trusted,
        agent,
        channel,
        state,
        history,
        knowledge,
        tools: selected.descriptors,
        systemSections,
        verifiedActions: actions,
        customer: input.customer ?? null,
        limits,
      });
      const composed = composePrompt({
        business: agent.business,
        agentName: context.agent.name,
        promptTemplate: context.agent.promptTemplate,
        customInstructions: context.agent.customInstructions,
        language: context.agent.language,
        channel,
        state: context.state,
        summary: context.summary,
        knowledge: context.knowledge.snippets,
        tools: context.tools,
        systemSections: context.systemSections,
        customer: context.customer,
        doctrine: this.doctrine(agent, channel),
      });
      const contextMs = Date.now() - contextStart - retrievalMs - actionsMs;
      events.emit("context.built", {
        recentMessages: context.recentMessages.length,
        summaryChars: context.summary.length,
        knowledgeSnippets: context.knowledge.snippets.length,
        tools: context.tools.map((t) => t.name),
        systemSections: context.systemSections.length,
        promptChars: composed.text.length,
        totalChars: context.budget.totalChars,
        trimmed: context.budget.trimmed,
        latencyMs: contextMs,
      });

      // ---- bounded model / tool loop -----------------------------------------
      const modelOptions = {
        temperature: agent.model?.temperature ?? this.policy.defaultTemperature,
        maxTokens: agent.model?.maxTokens ?? this.policy.defaultMaxTokens,
      };
      const messages: LLMMessage[] = [...context.recentMessages, { role: "user", content: userMessage }];
      const offeredNames = context.tools.map((t) => t.name);
      const executedKeys = new Set<string>();
      const toolIntents: ToolIntent[] = [];
      const toolResults: ToolResult[] = [];
      const toolRecords: ToolTranscriptRecord[] = [];
      const usageCalls: ModelCallUsage[] = [];
      let toolRounds = 0;
      let replyDraft = "";
      let providerFailed = false;
      let modelMs = 0;

      for (let round = 0; round <= this.policy.maxToolRounds; round++) {
        // The final round never offers tools: the model must narrate.
        const toolsThisRound = round < this.policy.maxToolRounds ? context.tools : [];
        events.emit("model.requested", {
          round,
          purpose: round === 0 ? "reply" : "tool_round",
          tools: toolsThisRound.map((t) => t.name),
          messages: messages.length,
        });
        checkpoint(`model_round_${round}`);
        let invocation;
        try {
          invocation = await invokeModel({
            provider: this.deps.llm,
            systemPrompt: composed.text,
            messages,
            options: modelOptions,
            tools: toolsThisRound.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
            deadlineAt,
            purpose: round === 0 ? "reply" : "tool_round",
            retry: this.policy.modelRetry,
            onDelta: this.deps.onDelta,
            signal: committed ? undefined : signal,
          });
        } catch (error) {
          if (isRuntimeCancelled(error) && !committed) throw error;
          providerFailed = true;
          events.emit("model.failed", {
            round,
            code: isAppError(error) ? error.code : error instanceof Error ? error.name : "unknown",
          });
          log.error("model call failed, degrading to fallback reply", {
            businessId: trusted.businessId,
            conversationId: trusted.conversationId,
            provider: this.deps.llm.name,
            code: isAppError(error) ? error.code : undefined,
            error,
          });
          break;
        }
        usageCalls.push(invocation.usage);
        modelMs += invocation.usage.latencyMs;
        const calls = invocation.result.toolCalls ?? [];
        events.emit("model.completed", {
          round,
          latencyMs: invocation.usage.latencyMs,
          streamed: invocation.usage.streamed,
          toolCalls: calls.length,
          inputTokens: invocation.usage.inputTokens ?? null,
          outputTokens: invocation.usage.outputTokens ?? null,
          finishReason: invocation.result.finishReason ?? null,
        });

        if (calls.length === 0 || toolsThisRound.length === 0) {
          replyDraft = invocation.result.content;
          break;
        }

        toolRounds += 1;
        const roundStart = Date.now();
        const roundResults: ToolResult[] = [];
        const accepted = calls.slice(0, this.policy.maxIntentsPerRound);
        for (const extra of calls.slice(this.policy.maxIntentsPerRound)) {
          const result: ToolResult = {
            intentId: extra.id,
            name: String(extra.name).slice(0, 64),
            status: "rejected",
            summary: "Too many actions requested at once; only the first few were considered.",
            claimsPermitted: [],
            rejection: "budget_exhausted",
          };
          toolResults.push(result);
          roundResults.push(result);
          events.emit("tool.intent_rejected", { name: result.name, reason: "budget_exhausted", round });
        }
        for (const call of accepted) {
          const converted = toToolIntent({ call, registry: this.registry, turnId: trusted.turnId, round });
          if ("rejected" in converted) {
            toolResults.push(converted.rejected);
            roundResults.push(converted.rejected);
            events.emit("tool.intent_rejected", {
              name: converted.rejected.name,
              reason: converted.rejected.rejection ?? "unknown_tool",
              round,
            });
            continue;
          }
          const intent = converted.intent;
          toolIntents.push(intent);
          events.emit("tool.intent_proposed", { name: intent.name, round, idempotencyKey: intent.idempotencyKey });
          const auth = authorizeIntent({
            intent,
            registry: this.registry,
            offered: offeredNames,
            channel,
            state,
            userMessage,
            executedKeys,
            execution: { ...execution, state },
          });
          let result: ToolResult;
          if (!auth.allowed) {
            result = rejectionResult(intent, auth);
            events.emit("tool.intent_rejected", { name: intent.name, reason: auth.reason, round });
            if (auth.reason === "confirmation_required") {
              state = applyStatePatch(state, {
                pendingConfirmation: {
                  toolName: intent.name,
                  arguments: Object.fromEntries(
                    Object.entries(intent.arguments)
                      .filter(([k, v]) => /^[a-z][a-z0-9_]{0,39}$/.test(k) && typeof v === "string")
                      .map(([k, v]) => [k, String(v).slice(0, 240)]),
                  ),
                  requestedAt: now.toISOString(),
                },
              });
            }
          } else {
            const definition = this.registry.definition(intent.name)!;
            const executor = this.registry.executor(intent.name)!;
            executedKeys.add(intent.idempotencyKey);
            result = await executeIntent({ intent, definition, executor, execution: { ...execution, state } });
            events.emit(result.status === "succeeded" ? "action.executed" : "action.failed", {
              source: "tool",
              name: intent.name,
              round,
              claims: result.claimsPermitted,
              errorCode: result.error?.code ?? null,
            });
            actions.push({
              source: "tool",
              name: intent.name,
              status: result.status === "succeeded" ? "succeeded" : "failed",
              claimsPermitted: result.claimsPermitted,
              summary: result.summary,
            });
            if (result.status === "succeeded") committed = true;
            if (result.statePatch) state = applyStatePatch(state, result.statePatch);
            state = applyStatePatch(state, {
              lastToolIntent: {
                name: intent.name,
                correlationId: intent.correlationId,
                status: result.status,
                at: now.toISOString(),
              },
              ...(result.status === "succeeded" && state.pendingConfirmation?.toolName === intent.name
                ? { pendingConfirmation: null }
                : {}),
            });
          }
          toolResults.push(result);
          roundResults.push(result);
          toolRecords.push({ intent, result });
        }
        actionsMs += Date.now() - roundStart;

        messages.push({ role: "assistant", content: invocation.result.content ?? "", toolCalls: calls });
        for (const result of roundResults) {
          messages.push({
            role: "tool",
            toolCallId: result.intentId,
            content: JSON.stringify({
              status: result.status,
              summary: result.summary,
              ...(result.data ? { data: result.data } : {}),
            }),
          });
        }
      }

      checkpoint("validation");
      // ---- validation (act-then-narrate) ------------------------------------
      const validationStart = Date.now();
      let reply: string;
      let validation: ValidationOutcome;
      if (providerFailed) {
        degraded.provider = true;
        reply = this.policy.providerFallbackReply;
        validation = { ok: true, violations: [], regenerated: false, fallbackUsed: false };
      } else {
        let verdict = validateReply({ reply: replyDraft, channel, actions });
        let regenerated = false;
        let fallbackUsed = false;
        if (verdict.needsRegeneration && this.policy.maxRegenerations > 0) {
          try {
            const repair = await invokeModel({
              provider: this.deps.llm,
              systemPrompt: `${composed.text}\n\n${correctiveInstruction(verdict.violations)}`,
              messages,
              options: modelOptions,
              deadlineAt,
              purpose: "repair",
              retry: { ...this.policy.modelRetry, attempts: 1 },
              signal: committed ? undefined : signal,
            });
            regenerated = true;
            usageCalls.push(repair.usage);
            modelMs += repair.usage.latencyMs;
            const second = validateReply({ reply: repair.result.content, channel, actions });
            if (second.needsRegeneration) fallbackUsed = true;
            // Keep every violation found (for telemetry); the delivered reply
            // and its verdict come from the repair attempt.
            verdict = { ...second, violations: [...verdict.violations, ...second.violations] };
          } catch (error) {
            if (isRuntimeCancelled(error) && !committed) throw error;
            fallbackUsed = true;
            log.warn("repair generation failed, using safe fallback", { error });
          }
        } else if (verdict.needsRegeneration) {
          fallbackUsed = true;
        }
        reply = fallbackUsed ? safeFallbackReply(verdict.violations) : verdict.reply;
        validation = {
          // ok = the DELIVERED reply passed (possibly after one repair).
          ok: !fallbackUsed && !verdict.needsRegeneration,
          violations: verdict.violations,
          regenerated,
          fallbackUsed,
        };
      }
      const validationMs = Date.now() - validationStart;
      events.emit("response.validated", {
        ok: validation.ok,
        violations: validation.violations.map((v) => v.kind),
        regenerated: validation.regenerated,
        fallbackUsed: validation.fallbackUsed,
        replyChars: reply.length,
        latencyMs: validationMs,
      });

      // ---- escalation ---------------------------------------------------------
      const unansweredThisTurn = knowledgeGap && actions.length === 0 && !providerFailed;
      const escalation: EscalationDecision = decideEscalation({
        userMessage,
        state,
        actions,
        toolResults,
        guardrailTriggers: agent.config.guardrails.escalationTriggers,
        unansweredStreak: unansweredThisTurn ? state.unansweredStreak + 1 : 0,
        validationFallbackUsed: validation.fallbackUsed,
      });
      if (escalation.escalate && state.escalation.status !== "triggered") {
        events.emit("escalation.triggered", {
          reason: escalation.reason ?? null,
          priority: escalation.priority,
          recommendedAction: escalation.recommendedAction,
        });
      }

      // ---- memory ------------------------------------------------------------
      const memory = updateMemory({
        state,
        history,
        recentWindow: limits.maxRecentMessages,
        escalation,
        unanswered: unansweredThisTurn,
        now,
      });
      state = memory.state;
      events.emit("memory.updated", {
        summarized: memory.summarized,
        foldedMessages: memory.foldedMessages,
        summaryChars: state.summary.text.length,
        turnCount: state.turnCount,
        slots: Object.keys(state.slots).length,
      });

      // Last cancellation point: after this the turn is persisted.
      checkpoint("persistence");
      // ---- persistence ---------------------------------------------------------
      const transcript: ChatMessage[] = [
        { role: "user", content: userMessage },
        { role: "assistant", content: reply },
      ];
      await this.deps.conversations.appendMessages(trusted.conversationId, trusted.businessId, transcript);
      if (toolRecords.length > 0 && this.deps.conversations.appendToolRecords) {
        await this.deps.conversations
          .appendToolRecords(trusted.conversationId, trusted.businessId, toolRecords)
          .catch((error) => log.warn("tool transcript persistence failed", { error }));
      }
      try {
        await withTimeout(
          this.deps.stateStore.save(trusted.conversationId, trusted.businessId, state),
          this.policy.stateTimeoutMs,
          "conversation state save",
        );
      } catch (error) {
        degraded.state = true;
        log.warn("conversation state save failed", { conversationId: trusted.conversationId, error });
      }

      // ---- output ----------------------------------------------------------------
      const totalMs = Date.now() - startedAt;
      const output: RuntimeOutput = {
        reply,
        turnId: trusted.turnId,
        state,
        actions,
        toolIntents,
        toolResults,
        validation,
        escalation,
        usage: aggregateUsage(this.deps.llm.name, agent.model?.model, usageCalls, toolRounds),
        events: events.events,
        timings: { contextMs, retrievalMs, modelMs, actionsMs, validationMs, totalMs },
        degraded,
        transcript,
        knowledgeGap,
      };

      for (const hook of this.hooks) {
        try {
          await hook.afterTurn({ trusted, agent, context, output, transcript: [...history, ...transcript] });
        } catch (error) {
          log.warn("turn hook failed", { hook: hook.name, error });
        }
      }

      events.emit("runtime.completed", {
        totalMs: Date.now() - startedAt,
        modelCalls: usageCalls.length,
        toolRounds,
        toolIntents: toolIntents.length,
        escalated: escalation.escalate,
        degradedProvider: degraded.provider,
        degradedKnowledge: degraded.knowledge,
        degradedState: degraded.state,
        degradedSystemActions: degraded.systemActions,
      });
      return output;
    } catch (error) {
      if (isRuntimeCancelled(error)) {
        events.emit("runtime.cancelled", { stage: error.stage, totalMs: Date.now() - startedAt });
        throw error;
      }
      events.emit("runtime.failed", {
        code: isAppError(error) ? error.code : error instanceof Error ? error.name : "unknown",
        totalMs: Date.now() - startedAt,
      });
      throw error;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function aggregateUsage(
  provider: string,
  configuredModel: string | undefined,
  calls: ModelCallUsage[],
  toolRounds: number,
): UsageMetadata {
  const withTokens = calls.filter((c) => c.totalTokens !== undefined);
  const sum = (pick: (c: ModelCallUsage) => number | undefined) =>
    withTokens.reduce((n, c) => n + (pick(c) ?? 0), 0);
  return {
    provider,
    model: calls.find((c) => c.model)?.model ?? configuredModel ?? "",
    modelCalls: calls.length,
    ...(withTokens.length > 0
      ? {
          inputTokens: sum((c) => c.inputTokens),
          outputTokens: sum((c) => c.outputTokens),
          totalTokens: sum((c) => c.totalTokens),
        }
      : {}),
    modelLatencyMs: calls.reduce((n, c) => n + c.latencyMs, 0),
    toolRounds,
    calls,
  };
}
