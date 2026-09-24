/** Sequential, resumable synthetic evaluation; no database or real customer records. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { FallbackLLMRouter } from "@halo/providers/llm/fallback-router";
import { OpenAICompatibleProvider } from "@halo/providers/llm/openai-compatible-provider";
import { providerErrorDetails } from "@halo/providers/llm/provider-error";
import { estimateTokens } from "@halo/language/tokens";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { CollectingEventSink } from "@halo/runtime/events";
import type { RuntimeOutput } from "@halo/runtime/contracts";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { SalesCallAssembly } from "../src/core/services/voice/sales-call";
import { arunodhayaSalesCallConfig } from "../src/core/services/voice/arunodhaya-call";
import { requireArunodhaya } from "../src/content/tenants/arunodhaya";
import { FakeConversationStore, emptyKnowledgeProvider } from "../tests/mocks/runtime-fakes";
import { cases, context } from "./cloud-llm-smoke";
import { assessArunodhayaReply, FINANCIAL_CASES } from "./evaluation/arunodhaya-factuality";

export const FACT_CASES = [
  ["savings_english", "How much will my electricity bill reduce?"],
  ["savings_telugu", "సోలార్ పెట్టుకుంటే బిల్ ఎంత తగ్గుతుంది?"],
  ["savings_tenglish", "Solar pettukunte bill entha thagguthundi?"],
] as const;

type RecordData = Record<string, unknown>;

async function main() {
  process.loadEnvFile(".env.local");
  const candidate = process.argv.find((a) => a.startsWith("--candidate="))?.slice(12) ?? "route";
  const specs = {
    "groq-gpt": ["groq", "https://api.groq.com/openai/v1", process.env.GROQ_LLM_API_KEY!, "openai/gpt-oss-120b"],
    "groq-qwen": ["groq", "https://api.groq.com/openai/v1", process.env.GROQ_LLM_API_KEY!, "qwen/qwen3.8-27b"],
    "openrouter-claude": ["openrouter", "https://openrouter.ai/api/v1", process.env.OPENROUTER_LLM_API_KEY!, "anthropic/claude-sonnet-4.6"],
    "openrouter-qwen": ["openrouter", "https://openrouter.ai/api/v1", process.env.OPENROUTER_LLM_API_KEY!, "qwen/qwen3.8-27b"],
  } as const;
  if (candidate !== "route" && !(candidate in specs)) throw new Error("Unknown evaluation candidate");
  const spec = candidate === "route" ? undefined : specs[candidate as keyof typeof specs];
  const llm = spec
    ? new FallbackLLMRouter([{ model: spec[3],
        provider: new OpenAICompatibleProvider(spec[0], spec[1], spec[2], spec[3], 25_000) }])
    : getLLMProvider();
  const selected: ReadonlyArray<readonly [string, string]> = spec
    ? [...FACT_CASES, cases.find(([name]) => name === "negotiation")!, cases.find(([name]) => name === "handoff")!]
    : [...cases, ...FACT_CASES];
  const file = `docs/CLOUD_LLM_EVALUATION_${candidate.toUpperCase().replaceAll("-", "_")}.json`;
  const fingerprint = createHash("sha256").update(JSON.stringify({ selected, config: requireArunodhaya().config,
    sales: arunodhayaSalesCallConfig(), policy: "sequential-65s-groq-v1", candidate })).digest("hex");
  const results: RecordData[] = [];
  // --rescore never issues provider calls; it implies resume from the stored artifact.
  const rescore = process.argv.includes("--rescore");
  if ((rescore || process.argv.includes("--resume")) && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.fingerprint !== fingerprint) throw new Error("Evaluation configuration changed; start a new run");
    results.push(...saved.results);
  }
  const persist = () => writeFileSync(file, JSON.stringify({ candidate, fingerprint,
    syntheticOnly: true, updatedAt: new Date().toISOString(), results }, null, 2) + "\n");
  if (rescore) {
    for (const record of results) {
      if (typeof record.syntheticReply !== "string" || record.availability !== "success") continue;
      record.quality = assessArunodhayaReply(record.syntheticReply, FINANCIAL_CASES.has(String(record.case)));
    }
    persist();
    console.log(JSON.stringify({ rescored: true, candidate, artifact: file }));
    return;
  }
  let requests: RecordData[] = [];
  let nextGroqAt = results.length ? Date.now() + 65_000 : 0;
  let nextOtherAt = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const provider = url.hostname === "api.groq.com" ? "groq" : url.hostname === "openrouter.ai" ? "openrouter" : "unknown";
    if (provider === "unknown") throw new Error("Evaluation only permits the configured inference hosts");
    const body = JSON.parse(String(init?.body ?? "{}"));
    const start = Date.now();
    try {
      const response = await originalFetch(input, init);
      const error = !response.ok ? providerErrorDetails(response.status, await response.clone().json().catch(() => ({})), response.headers) : null;
      const prompt = (body.messages ?? []).map((m: { content?: string }) => m.content ?? "").join("\n");
      const schemas = JSON.stringify(body.tools ?? []);
      requests.push({ provider, model: body.model, httpStatus: response.status, headersLatencyMs: Date.now() - start,
        promptChars: prompt.length, estimatedInputTokens: estimateTokens(prompt + schemas).estimatedTokens,
        error });
      if (provider === "groq") nextGroqAt = Date.now() + Math.max(65_000, error?.retryAfterMs ?? 0);
      else nextOtherAt = Date.now() + Math.max(2_000, error?.retryAfterMs ?? 0);
      return response;
    } catch (error) {
      requests.push({ provider, model: body.model, httpStatus: null, error: { category: "connection_or_timeout" } });
      throw error;
    }
  };
  try {
    let accountBlocked = results.some((r) => r.availability === "account_blocked");
    for (const [name, utterance] of selected) {
      if (results.some((r) => r.case === name)) continue;
      if (spec && accountBlocked) {
        results.push({ case: name, availability: "not_run_account_blocked", quality: "not_evaluated" });
        persist(); continue;
      }
      const waitMs = Math.max(0, (spec?.[0] === "openrouter" ? nextOtherAt : nextGroqAt) - Date.now());
      if (waitMs > 0) console.log(JSON.stringify({ waitingMs: waitMs, case: name, candidate }));
      for (let remaining = waitMs; remaining > 0; remaining -= 30_000) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, remaining)));
      }
      requests = [];
      const outputs: RuntimeOutput[] = [];
      const assembly = new SalesCallAssembly({ config: arunodhayaSalesCallConfig(), llm,
        knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()), conversations: new FakeConversationStore(),
        stateStore: new InMemoryConversationStateStore(), events: new CollectingEventSink(),
        onTurnOutput: (_ctx, output) => outputs.push(output) });
      const handler = assembly.createTurnHandler(context(`evaluation-${candidate}-${name}`));
      try {
        const turn = await handler.handleTurn({ utterance, language: "te-IN", sttConfidence: 0.95,
          turnIndex: 0, signal: new AbortController().signal });
        const out = outputs.at(-1)!;
        const attempts = out.events.filter((e) => e.type.startsWith("llm."))
          .map((e) => ({ type: e.type, at: e.at, ...e.data }) as RecordData);
        accountBlocked = attempts.some((e) => e.failureCategory === "billing_limit");
        const availability = out.degraded.provider ? accountBlocked ? "account_blocked" : "provider_failed" : "success";
        const financial = FINANCIAL_CASES.has(name);
        const quality = availability === "success" ? assessArunodhayaReply(turn.reply, financial) : null;
        const result = { case: name, availability, quality, validation: out.validation,
          usage: out.usage, timings: out.timings, requests: [...requests], attempts,
          tools: out.toolResults.map((t) => ({ name: t.name, status: t.status, rejection: t.rejection ?? null })),
          // Synthetic model response for factuality/language review; never a customer transcript.
          syntheticReply: availability === "success" ? turn.reply : null,
          escalation: out.escalation.escalate };
        results.push(result); persist();
        console.log(JSON.stringify({ case: name, candidate, availability, quality: quality?.status ?? "not_evaluated",
          provider: out.usage.provider, model: out.usage.model, calls: out.usage.calls.length,
          findings: quality?.findings ?? [], latencyMs: out.timings.totalMs }));
      } catch (error) {
        results.push({ case: name, availability: "runtime_failed", quality: "not_evaluated", requests: [...requests],
          error: error instanceof Error ? error.name : "unknown" }); persist();
      } finally { await handler.close(); }
    }
  } finally { globalThis.fetch = originalFetch; }
  console.log(JSON.stringify({ completed: results.length, candidate, artifact: file }));
  if (results.some((r) => r.availability !== "success" || (r.quality as { status?: string } | null)?.status !== "screen_pass")) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("cloud-llm-evaluate.ts")) {
  void main().catch((error) => { console.error(JSON.stringify({ failed: true, error: error instanceof Error ? error.name : "unknown" })); process.exitCode = 1; });
}
