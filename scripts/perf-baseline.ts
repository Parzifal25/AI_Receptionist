/**
 * HALO Phase 2 — Agent Runtime performance baseline (workstream 16).
 *
 * Measures the runtime's OWN overhead per turn with in-memory fakes and a
 * scripted model, so the numbers isolate what the runtime adds on top of
 * provider latency: context building, retrieval plumbing, prompt
 * composition, validation, memory and persistence. Model latency is
 * injectable (default 0 ms) because no live provider is assumed; the
 * report says so explicitly rather than inventing a model number.
 *
 * Usage:
 *   npm run perf:baseline                  # 300 turns per scenario, 0 ms model
 *   MODEL_LATENCY_MS=800 npm run perf:baseline
 */
import { performance } from "node:perf_hooks";
import type { KnowledgeSnippet } from "../packages/core/domain/types";
import type { LLMResult } from "../packages/ports/llm-provider";
import { AgentRuntime } from "../packages/runtime/agent-runtime";
import { WEB_CHAT_PROFILE } from "../packages/runtime/channel-profile";
import { InMemoryConversationStateStore } from "../packages/runtime/conversation-state";
import { ProviderKnowledgeResolver } from "../packages/runtime/knowledge-resolver";
import { BUILTIN_TOOLS, ToolRegistry } from "../packages/runtime/tools/registry";
import type { RuntimeOutput } from "../packages/runtime/contracts";
import {
  emptyKnowledgeProvider,
  FakeConversationStore,
  makeAgent,
  makeTrusted,
  reply,
  ScriptedLLM,
} from "../tests/mocks/runtime-fakes";

const TURNS = Number(process.env.PERF_TURNS ?? 300);
const MODEL_LATENCY_MS = Number(process.env.MODEL_LATENCY_MS ?? 0);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function snippets(n: number, chars: number): KnowledgeSnippet[] {
  return Array.from({ length: n }, (_, i) => ({
    source: "chunk",
    refId: `c${i}`,
    title: `Document ${i}`,
    content: `Paragraph ${i}. ${"Details about services, hours and policies. ".repeat(Math.ceil(chars / 45))}`.slice(0, chars),
    score: 1 - i * 0.1,
  }));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

interface Scenario {
  name: string;
  historyMessages: number;
  knowledgeSnippets: number;
  toolRound: boolean;
}

async function runScenario(scenario: Scenario) {
  const knowledge = emptyKnowledgeProvider(snippets(scenario.knowledgeSnippets, 800));
  const conversations = new FakeConversationStore();
  conversations.seed(
    "conv-perf",
    "biz-a",
    Array.from({ length: scenario.historyMessages }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Earlier message ${i} with a sentence or two of typical visitor text about a service.`,
    })),
  );
  const text = "Thanks for asking — we're open Monday to Friday, nine to five, and I'd be happy to help you book a visit.";
  const script = scenario.toolRound
    ? [
        async (): Promise<LLMResult> => {
          await sleep(MODEL_LATENCY_MS);
          return reply("", { toolCalls: [{ id: "c1", name: "request_human_handoff", arguments: { reason: "perf" } }], finishReason: "tool_calls" });
        },
        async (): Promise<LLMResult> => {
          await sleep(MODEL_LATENCY_MS);
          return reply(text);
        },
      ]
    : [
        async (): Promise<LLMResult> => {
          await sleep(MODEL_LATENCY_MS);
          return reply(text);
        },
      ];
  const llm = new ScriptedLLM(script);
  const registry = new ToolRegistry(BUILTIN_TOOLS, {
    request_human_handoff: async () => ({ ok: true, summary: "recorded", claimsPermitted: [] }),
  });
  const runtime = new AgentRuntime({
    llm,
    knowledge: new ProviderKnowledgeResolver(knowledge),
    conversations,
    stateStore: new InMemoryConversationStateStore(),
    registry,
    events: { emit() {} },
  });
  const agent = makeAgent();
  if (scenario.toolRound) agent.config.tools.grantedToolIds = ["request_human_handoff"];

  const totals: number[] = [];
  const stages = { contextMs: [] as number[], retrievalMs: [] as number[], modelMs: [] as number[], validationMs: [] as number[], actionsMs: [] as number[] };
  let last: RuntimeOutput | null = null;
  let promptChars = 0;
  for (let i = 0; i < TURNS; i++) {
    // Reset the scripted model per turn so the tool scenario repeats.
    (llm as unknown as { index: number }).index = 0;
    const start = performance.now();
    last = await runtime.run({
      trusted: makeTrusted({ conversationId: "conv-perf", turnId: `perf-${i}` }),
      agent,
      channel: WEB_CHAT_PROFILE,
      userMessage: "Do you offer weekend appointments and how much is a standard visit?",
    });
    totals.push(performance.now() - start);
    stages.contextMs.push(last.timings.contextMs);
    stages.retrievalMs.push(last.timings.retrievalMs);
    stages.modelMs.push(last.timings.modelMs);
    stages.validationMs.push(last.timings.validationMs);
    stages.actionsMs.push(last.timings.actionsMs);
    promptChars = llm.calls[llm.calls.length - 1]?.systemPrompt.length ?? 0;
    // Keep the transcript bounded so the scenario stays stationary.
    conversations.messages.set("conv-perf", conversations.messages.get("conv-perf")!.slice(-scenario.historyMessages));
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    scenario: scenario.name,
    turns: TURNS,
    totalMs: { p50: percentile(totals, 50), p95: percentile(totals, 95), mean: mean(totals) },
    stagesMeanMs: {
      context: mean(stages.contextMs),
      retrieval: mean(stages.retrievalMs),
      model: mean(stages.modelMs),
      actions: mean(stages.actionsMs),
      validation: mean(stages.validationMs),
    },
    modelCallsPerTurn: last?.usage.modelCalls ?? 0,
    toolRounds: last?.usage.toolRounds ?? 0,
    promptChars,
    promptTokensApprox: Math.round(promptChars / 4),
    contextTotalChars: last ? JSON.stringify(last.transcript).length : 0,
    replyChars: last?.reply.length ?? 0,
    recentMessages: Math.min(scenario.historyMessages, 16),
    knowledgeSnippets: scenario.knowledgeSnippets,
  };
}

async function main() {
  const scenarios: Scenario[] = [
    { name: "short conversation, no knowledge", historyMessages: 2, knowledgeSnippets: 0, toolRound: false },
    { name: "typical FAQ (6 snippets, 16-message window)", historyMessages: 20, knowledgeSnippets: 6, toolRound: false },
    { name: "long conversation (40 fetched, recap active)", historyMessages: 40, knowledgeSnippets: 6, toolRound: false },
    { name: "one tool round (2 model calls)", historyMessages: 10, knowledgeSnippets: 3, toolRound: true },
  ];
  const results = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario));

  console.log(`\nHALO Agent Runtime baseline — ${TURNS} turns per scenario, model latency ${MODEL_LATENCY_MS} ms (scripted, not a live provider)\n`);
  console.log("| Scenario | total p50 ms | total p95 ms | context ms | retrieval ms | model ms | actions ms | validation ms | model calls | tool rounds | prompt chars | ~tokens | reply chars |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of results) {
    console.log(
      `| ${r.scenario} | ${r.totalMs.p50.toFixed(2)} | ${r.totalMs.p95.toFixed(2)} | ${r.stagesMeanMs.context.toFixed(2)} | ${r.stagesMeanMs.retrieval.toFixed(2)} | ${r.stagesMeanMs.model.toFixed(2)} | ${r.stagesMeanMs.actions.toFixed(2)} | ${r.stagesMeanMs.validation.toFixed(2)} | ${r.modelCallsPerTurn} | ${r.toolRounds} | ${r.promptChars} | ${r.promptTokensApprox} | ${r.replyChars} |`,
    );
  }
  console.log("\nJSON:");
  console.log(JSON.stringify({ turns: TURNS, modelLatencyMs: MODEL_LATENCY_MS, node: process.version, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
