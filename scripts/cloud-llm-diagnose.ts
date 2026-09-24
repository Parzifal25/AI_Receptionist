/** Bounded synthetic probes. Output is an allowlist, never raw provider bodies. */
import { writeFileSync } from "node:fs";
import type { LLMCompletionOptions, LLMMessage, LLMProvider } from "@halo/ports/llm-provider";
import { providerErrorDetails } from "@halo/providers/llm/provider-error";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { CollectingEventSink } from "@halo/runtime/events";
import { SalesCallAssembly } from "../src/core/services/voice/sales-call";
import { arunodhayaSalesCallConfig } from "../src/core/services/voice/arunodhaya-call";
import { FakeConversationStore, emptyKnowledgeProvider } from "../tests/mocks/runtime-fakes";
import { context } from "./cloud-llm-smoke";

process.loadEnvFile(".env.local");

async function main() {
  let captured: { system: string; messages: LLMMessage[]; options: LLMCompletionOptions } | undefined;
  const capture: LLMProvider = {
    name: "capture", capabilities: () => ({ streaming: false, tools: true, jsonMode: true, usage: true }),
    isHealthy: async () => true,
    async complete(system, messages, options = {}) {
      captured = { system, messages, options };
      return { model: "capture", content: "మీ పేరు చెప్తారా?" };
    },
  };
  const assembly = new SalesCallAssembly({ config: arunodhayaSalesCallConfig(), llm: capture,
    knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()), conversations: new FakeConversationStore(),
    stateStore: new InMemoryConversationStateStore(), events: new CollectingEventSink() });
  const handler = assembly.createTurnHandler(context("diagnostic-synthetic"));
  await handler.handleTurn({ utterance: "Hello, I want to know about solar panels.", language: "te-IN",
    sttConfidence: 0.95, turnIndex: 0, signal: new AbortController().signal });
  await handler.close();
  if (!captured) throw new Error("No prompt captured");
  const full = { messages: [{ role: "system", content: captured.system }, ...captured.messages],
    temperature: captured.options.temperature, max_tokens: captured.options.maxTokens,
    tools: captured.options.tools?.map((t) => ({ type: "function", function: t })), tool_choice: "auto" };
  const records: unknown[] = [];
  const record = (data: unknown) => { records.push(data); console.log(JSON.stringify(data)); };
  const key = process.env.OPENROUTER_LLM_API_KEY!;
  for (const endpoint of ["key", "credits"]) {
    const response = await fetch(`https://openrouter.ai/api/v1/${endpoint}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const { data = {} } = await response.json();
    record({ kind: endpoint, status: response.status, limit: data.limit, remaining: data.limit_remaining,
      usage: data.usage, freeTier: data.is_free_tier, totalCredits: data.total_credits, totalUsage: data.total_usage });
  }
  const specs = [
    ["groq", "https://api.groq.com/openai/v1", process.env.GROQ_LLM_API_KEY!, ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]],
    ["openrouter", "https://openrouter.ai/api/v1", key, ["anthropic/claude-sonnet-4.6", "qwen/qwen3.8-27b"]],
  ] as const;
  for (const [provider, url, credential, models] of specs) {
    const list = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(15_000) });
    const catalog = await list.json();
    record({ kind: "models", provider, status: list.status,
      models: models.map((model) => ({ model, available: catalog.data?.some((m: { id: string }) => m.id === model) ?? false })) });
    for (const model of models) {
      for (const size of ["short", "full"] as const) {
        const started = Date.now();
        const request = size === "short" ? { messages: [{ role: "user", content: "Say hello." }], max_tokens: 400 } : full;
        const response = await fetch(`${url}/chat/completions`, { method: "POST",
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, ...request }), signal: AbortSignal.timeout(25_000) });
        const body = await response.json();
        // Extract only documented error dimensions. Messages may contain account identifiers.
        const message: string = typeof body.error?.message === "string" ? body.error.message : "";
        record({ kind: "completion", provider, model, size, status: response.status, latencyMs: Date.now() - started,
          promptChars: size === "full" ? captured.system.length : null, maxTokens: request.max_tokens,
          usage: body.usage ? { input: body.usage.prompt_tokens, output: body.usage.completion_tokens,
            total: body.usage.total_tokens } : null,
          error: body.error ? providerErrorDetails(response.status, body, response.headers) : null,
          evidence: body.error ? {
            mentionsCredits: /credits|balance/i.test(message), mentionsMaxTokens: /max_tokens/i.test(message),
            mentionsAffordability: /afford|insufficient|enough credits/i.test(message),
            tokenLimit: /Limit\s*[:=]\s*(\d+)/i.exec(message)?.[1],
            tokensUsed: /Used\s*[:=]\s*([\d.]+)/i.exec(message)?.[1],
            tokensRequested: /Requested\s*[:=]\s*(\d+)/i.exec(message)?.[1],
          } : null,
          headers: Object.fromEntries([...response.headers].filter(([name]) => name.startsWith("x-ratelimit-") || name === "retry-after")),
        });
        if (response.status === 429) break;
      }
    }
  }
  writeFileSync("docs/CLOUD_LLM_DIAGNOSTICS.json", JSON.stringify({ at: new Date().toISOString(), records }, null, 2) + "\n");
}

void main().catch((error) => { console.error(JSON.stringify({ failed: true, error: error instanceof Error ? error.name : "unknown" })); process.exitCode = 1; });
