import type { AgentVersion } from "@halo/core/domain/agents";
import type { CallDisposition } from "@halo/core/domain/voice";
import type { LLMResult } from "@halo/ports/llm-provider";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import type { RuntimeOutput } from "@halo/runtime/contracts";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import type { InboundRoute } from "@halo/voice/call-store";
import type { VoiceCallContext } from "@halo/voice/gateway";
import type { VoiceSessionSummary } from "@halo/voice/voice-session";
import { requireArunodhaya } from "@/content/tenants/arunodhaya";
import { arunodhayaSalesCallConfig } from "@/core/services/voice/arunodhaya-call";
import { SalesCallAssembly } from "@/core/services/voice/sales-call";
import {
  BUSINESS_A,
  FakeConversationStore,
  ScriptedLLM,
  emptyKnowledgeProvider,
  type ScriptStep,
} from "../../mocks/runtime-fakes";
import type { GoldenConversation, GoldenResult, TurnFinding } from "./types";

/**
 * Runs a golden conversation through the REAL pipeline: the Arunodhaya
 * configuration, the generic sales-call assembly, the unchanged Agent
 * Runtime, the real qualification and negotiation engines, the real tool
 * registry and the real response validator. Only the model, the transcript
 * store and knowledge retrieval are fakes.
 *
 * Everything asserted is therefore a property of the system, not of a mock.
 */

function versionFor(): AgentVersion {
  const { config } = requireArunodhaya();
  return {
    id: "av-arunodhaya-1",
    agentId: "agent-arunodhaya",
    businessId: BUSINESS_A.id,
    version: 1,
    config,
    promptTemplate: config.instructions.promptTemplate,
    promptVersion: "2026-09-21.1",
    model: {},
    publishedAt: "2026-09-21T00:00:00Z",
    createdBy: null,
    createdAt: "2026-09-21T00:00:00Z",
  };
}

function callContext(conversationId: string, handoffNumber: string | null): VoiceCallContext {
  const version = versionFor();
  const route: InboundRoute = {
    phoneNumberId: "pn-arunodhaya",
    business: BUSINESS_A,
    agentId: "agent-arunodhaya",
    agentStatus: "active",
    version,
    handoffNumber,
  };
  return {
    call: {
      id: conversationId,
      businessId: BUSINESS_A.id,
      agentId: "agent-arunodhaya",
      agentVersionId: version.id,
      conversationId,
      phoneNumberId: "pn-arunodhaya",
      direction: "inbound",
      provider: "fake",
      providerCallId: `pc-${conversationId}`,
      fromNumber: "+919800000001",
      toNumber: "+914000000001",
      state: "in_conversation",
      correlationId: `corr-${conversationId}`,
    },
    route,
    conversationId,
    correlationId: `corr-${conversationId}`,
    handoffNumber,
  };
}

const SUMMARY: VoiceSessionSummary = {
  endReason: "caller_hangup",
  transcript: [],
  turns: 0,
  bargeIns: 0,
  inboundAudioMs: 0,
  outboundAudioMs: 0,
  ttsCharacters: 0,
  modelCalls: 0,
  transferRequested: false,
  transferred: false,
  lastDirective: null,
  consecutiveLowConfidence: 0,
};

export interface RunOptions {
  /** A tenant-configured transfer target exists (live handoff possible). */
  handoffNumber?: string | null;
}

export async function runGoldenConversation(
  conversation: GoldenConversation,
  options: RunOptions = {},
): Promise<GoldenResult> {
  const findings: TurnFinding[] = [];
  const promptChars: number[] = [];
  const add = (turn: number, check: string, detail: string) =>
    findings.push({ conversation: conversation.id, turn, check, detail });

  // The scripted model: one step per model call. A turn with a tool call
  // needs two steps (the proposal, then the narration after the result).
  const script: ScriptStep[] = [];
  for (const turn of conversation.turns) {
    const content = turn.model?.content ?? "సరే.";
    const toolCalls = (turn.model?.toolCalls ?? []).map((call, i) => ({
      id: `tc-${script.length}-${i}`,
      name: call.name,
      arguments: call.arguments,
    }));
    const step: LLMResult = {
      content,
      model: "scripted",
      usage: { promptTokens: 100, completionTokens: 20 },
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    script.push(step);
    if (toolCalls.length > 0) {
      script.push({
        content: turn.modelAfterTool?.content ?? content,
        model: "scripted",
        usage: { promptTokens: 120, completionTokens: 20 },
      });
    }
  }

  const llm = new ScriptedLLM(script);
  const conversations = new FakeConversationStore();
  const outputs: RuntimeOutput[] = [];
  const assembly = new SalesCallAssembly({
    config: arunodhayaSalesCallConfig(),
    llm,
    knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()),
    conversations,
    stateStore: new InMemoryConversationStateStore(),
    onTurnOutput: (_ctx, output) => outputs.push(output),
  });

  const ctx = callContext(conversation.id, options.handoffNumber ?? null);
  const handler = assembly.createTurnHandler(ctx);

  let turnIndex = 0;
  let transferRequested = false;
  for (const turn of conversation.turns) {
    const before = llm.calls.length;
    const controller = new AbortController();
    let result;
    try {
      result = await handler.handleTurn({
        utterance: turn.say,
        language: "te-IN",
        sttConfidence: turn.confidence ?? 0.9,
        turnIndex,
        signal: controller.signal,
      });
    } catch (error) {
      add(turnIndex, "turn_failed", error instanceof Error ? error.message : String(error));
      break;
    }
    await handler.recordDelivery(result.turnId, { status: "complete", deliveredText: result.reply });
    if (result.directive.kind === "transfer") transferRequested = true;

    const prompt = llm.calls[before]?.systemPrompt ?? "";
    promptChars.push(prompt.length);
    const expect = turn.expect;
    if (expect) {
      for (const needle of expect.promptContains ?? []) {
        if (!prompt.includes(needle)) add(turnIndex, "prompt_contains", `missing: ${needle}`);
      }
      for (const needle of expect.promptNotContains ?? []) {
        if (prompt.includes(needle)) add(turnIndex, "prompt_not_contains", `present: ${needle}`);
      }
      if (expect.replyIs !== undefined && result.reply !== expect.replyIs) {
        add(turnIndex, "reply_is", `got: ${result.reply}`);
      }
      if (expect.replyNotMatching && expect.replyNotMatching.test(result.reply)) {
        add(turnIndex, "reply_not_matching", `reply matched a forbidden pattern: ${result.reply}`);
      }
      const output = outputs[outputs.length - 1];
      if (expect.escalates !== undefined) {
        const escalated = result.directive.kind === "transfer" || (output?.escalation.escalate ?? false);
        if (escalated !== expect.escalates) add(turnIndex, "escalates", `expected ${expect.escalates}, got ${escalated}`);
      }
      if (expect.qualification && output) {
        for (const [field, value] of Object.entries(expect.qualification)) {
          const actual = output.state.qualification[field];
          if (actual !== value) add(turnIndex, "qualification", `${field}: expected ${value}, got ${actual ?? "(unset)"}`);
        }
      }
      if (expect.toolStatus && output) {
        for (const [name, status] of Object.entries(expect.toolStatus)) {
          const actual = output.toolResults.find((r) => r.name === name)?.status;
          if (actual !== status) add(turnIndex, "tool_status", `${name}: expected ${status}, got ${actual ?? "(not called)"}`);
        }
      }
      if (expect.violations && output) {
        const kinds = output.validation.violations.map((v) => v.kind);
        for (const kind of expect.violations) {
          if (!kinds.includes(kind as (typeof kinds)[number])) {
            add(turnIndex, "violation", `expected ${kind}, got [${kinds.join(", ")}]`);
          }
        }
      }
      if (expect.fallbackUsed !== undefined && output && output.validation.fallbackUsed !== expect.fallbackUsed) {
        add(turnIndex, "fallback", `expected fallbackUsed=${expect.fallbackUsed}`);
      }
    }
    turnIndex += 1;
  }

  await handler.close();

  const outcome = assembly.computeOutcome(ctx, {
    ...SUMMARY,
    turns: turnIndex,
    transferRequested,
    transferred: transferRequested && options.handoffNumber !== null && options.handoffNumber !== undefined,
  });

  if (conversation.expectDisposition && outcome.disposition !== conversation.expectDisposition) {
    add(turnIndex, "disposition", `expected ${conversation.expectDisposition}, got ${outcome.disposition}`);
  }
  if (conversation.expectDoNotCall !== undefined && outcome.doNotCall !== conversation.expectDoNotCall) {
    add(turnIndex, "do_not_call", `expected ${conversation.expectDoNotCall}`);
  }

  return {
    conversation: conversation.id,
    category: conversation.category,
    intent: conversation.intent,
    passed: findings.length === 0,
    findings,
    disposition: outcome.disposition as CallDisposition,
    promptChars,
  };
}
