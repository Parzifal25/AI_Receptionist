/** Live, synthetic Arunodhaya evaluation. Uses local keys; never prints them or full transcripts. */
import type { AgentVersion } from "@halo/core/domain/agents";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { FallbackLLMRouter } from "@halo/providers/llm/fallback-router";
import { OpenAICompatibleProvider } from "@halo/providers/llm/openai-compatible-provider";
import { AppError } from "@halo/core/errors/app-error";
import type { LLMProvider } from "@halo/ports/llm-provider";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import type { RuntimeOutput } from "@halo/runtime/contracts";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { invokeModel } from "@halo/runtime/llm-adapter";
import type { InboundRoute } from "@halo/voice/call-store";
import type { VoiceCallContext } from "@halo/voice/gateway";
import { requireArunodhaya } from "../src/content/tenants/arunodhaya";
import { arunodhayaSalesCallConfig } from "../src/core/services/voice/arunodhaya-call";
import { SalesCallAssembly } from "../src/core/services/voice/sales-call";
import { BUSINESS_A, FakeConversationStore, emptyKnowledgeProvider } from "../tests/mocks/runtime-fakes";

export const cases = [
  ["english", "Hello, I want to know about solar panels."],
  ["telugu", "సోలార్ పెట్టుకుంటే కరెంట్ బిల్ తగ్గుతుందా?"],
  ["tenglish", "Solar pettukunte current bill thagguthunda?"],
  ["mixed", "Anna, solar పెట్టుకుంటే bill entha reduce avuthundi?"],
  ["objection", "Price chala ekkuva undi."],
  ["discount", "Price konchem ekkuva undi, discount emaina istara?"],
  ["negotiation", "₹20,000 discount isthe ippude book chestha."],
  ["greeting", "Namaste."],
  ["qualification", "I own a house and want rooftop solar."],
  ["discovery", "What details do you need before suggesting a system?"],
  ["explanation", "How do solar panels work for a home?"],
  ["appointment", "Can you book a site visit tomorrow?"],
  ["handoff", "Please connect me to a human."],
  ["tool_request", "Please record my contact details: my name is Ravi."],
  ["unauthorized_concession", "Please give me a ₹20,000 discount now."],
  ["changed_mind", "Actually I do not want solar anymore."],
  ["telugu_yes", "సరే"],
  ["telugu_hedge", "సరే చూద్దాం"],
  ["unrelated", "What is the weather in London?"],
] as const;

export function context(id: string): VoiceCallContext {
  const bundle = requireArunodhaya();
  const business = { ...BUSINESS_A, name: "Arunodhaya Solar", slug: "arunodhaya", industry: "solar" };
  const version: AgentVersion = {
    id: "smoke-version", agentId: "smoke-agent", businessId: business.id, version: 1,
    config: bundle.config, promptTemplate: bundle.config.instructions.promptTemplate,
    promptVersion: "smoke", model: {}, publishedAt: "2026-09-21T00:00:00Z",
    createdBy: null, createdAt: "2026-09-21T00:00:00Z",
  };
  const route: InboundRoute = { phoneNumberId: "smoke-number", business, agentId: version.agentId,
    agentStatus: "active", version, handoffNumber: null };
  return { call: { id, businessId: business.id, agentId: version.agentId,
    agentVersionId: version.id, conversationId: id, phoneNumberId: "smoke-number", direction: "inbound",
    provider: "fake", providerCallId: id, fromNumber: "+919800000001", toNumber: "+914000000001",
    state: "in_conversation", correlationId: id }, route, conversationId: id, correlationId: id,
    handoffNumber: null };
}

async function main(): Promise<void> {
  const forcedProvider: LLMProvider = { name: "groq", isHealthy: async () => false,
    capabilities: () => ({ streaming: true, tools: true, jsonMode: true, usage: true }),
    async complete() { throw AppError.provider("forced test failure", { category: "connection" }); },
    async *stream() { throw AppError.provider("forced test failure", { category: "connection" }); } };
  const openrouter = new OpenAICompatibleProvider("openrouter", "https://openrouter.ai/api/v1",
    process.env.OPENROUTER_LLM_API_KEY!, "anthropic/claude-sonnet-4.6", 25_000);
  const forced = new FallbackLLMRouter([
    { provider: forcedProvider, model: "openai/gpt-oss-120b" },
    { provider: forcedProvider, model: "qwen/qwen3.8-27b" },
    { provider: openrouter, model: "anthropic/claude-sonnet-4.6" },
  ]);
  const llm = process.argv.includes("--force-openrouter") ? forced : getLLMProvider();
  const requestedCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
  const selected = process.argv.includes("--tools") ? [] : requestedCase ? cases.filter(([name]) => name === requestedCase)
    : process.argv.includes("--all") ? cases : cases.slice(0, 7);
  for (const [name, utterance] of selected) {
    const outputs: RuntimeOutput[] = [];
    const assembly = new SalesCallAssembly({ config: arunodhayaSalesCallConfig(), llm,
      knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()),
      conversations: new FakeConversationStore(), stateStore: new InMemoryConversationStateStore(),
      onTurnOutput: (_ctx, output) => outputs.push(output) });
    const handler = assembly.createTurnHandler(context(`smoke-${name}`));
    try {
      const result = await handler.handleTurn({ utterance, language: "te-IN", sttConfidence: 0.95,
        turnIndex: 0, signal: new AbortController().signal });
      const output = outputs.at(-1)!;
      const first = output.usage.calls[0];
      const prompt = output.events.find((e) => e.type === "context.built")?.data;
      console.log(JSON.stringify({ case: name, provider: first?.provider ?? "none", model: first?.model ?? "none",
        latencyMs: first?.latencyMs ?? null, ttftMs: first?.timeToFirstTokenMs ?? null,
        promptChars: prompt?.promptChars ?? null, estimatedTokens: prompt?.promptTokensEstimated ?? null,
        inputTokens: first?.inputTokens ?? null, outputTokens: first?.outputTokens ?? null,
        totalTokens: first?.totalTokens ?? null, fallbackCount: first?.fallbackCount ?? 0,
        toolResults: output.toolResults.map((t) => `${t.name}:${t.status}`),
        failures: output.events.filter((e) => e.type === "llm.failed").map((e) => ({
          provider: e.data.provider, model: e.data.model, category: e.data.failureCategory })),
        validationOk: output.validation.ok, degraded: output.degraded.provider,
        reply: result.reply.slice(0, 220) }));
    } catch (error) {
      console.log(JSON.stringify({ case: name, error: error instanceof Error ? error.name : "unknown" }));
    } finally { await handler.close(); }
  }

  if (process.argv.includes("--tools")) {
    const specs = [
      ["groq", "https://api.groq.com/openai/v1", process.env.GROQ_LLM_API_KEY!, "openai/gpt-oss-120b"],
      ["groq", "https://api.groq.com/openai/v1", process.env.GROQ_LLM_API_KEY!, "qwen/qwen3.8-27b"],
      ["openrouter", "https://openrouter.ai/api/v1", process.env.OPENROUTER_LLM_API_KEY!, "anthropic/claude-sonnet-4.6"],
      ["openrouter", "https://openrouter.ai/api/v1", process.env.OPENROUTER_LLM_API_KEY!, "qwen/qwen3.8-27b"],
    ] as const;
    for (const [provider, url, key, model] of specs) {
      try {
        const candidate = new OpenAICompatibleProvider(provider, url, key, model, 25_000);
        const result = await candidate.complete("Request the classify_intent tool for every user input.",
          [{ role: "user", content: "I want a human." }], { maxTokens: 400,
            tools: [{ name: "classify_intent", description: "Classify a customer request; no action is executed.",
              parameters: { type: "object", properties: { intent: { type: "string" } }, required: ["intent"] } }] });
        console.log(JSON.stringify({ case: "native_tool", provider, model, toolCalled: result.toolCalls?.[0]?.name ?? null,
          argumentObject: typeof result.toolCalls?.[0]?.arguments === "object",
          inputTokens: result.usage?.promptTokens ?? null, outputTokens: result.usage?.completionTokens ?? null }));
      } catch (error) {
        const details = error instanceof AppError ? error.details as { category?: string; status?: number } : undefined;
        console.log(JSON.stringify({ case: "native_tool", provider, model,
          failureCategory: details?.category ?? "unknown", status: details?.status ?? null }));
      }
    }
    return;
  }

  const stream = await invokeModel({ provider: llm, systemPrompt: "Reply briefly and directly.",
    messages: [{ role: "user", content: "Hello" }], options: { maxTokens: 400 },
    purpose: "reply", deadlineAt: Date.now() + 60_000, onDelta: () => {} });
  console.log(JSON.stringify({ case: "stream", provider: stream.usage.provider, model: stream.usage.model,
    ttftMs: stream.usage.timeToFirstTokenMs ?? null, latencyMs: stream.usage.latencyMs,
    inputTokens: stream.usage.inputTokens ?? null, outputTokens: stream.usage.outputTokens ?? null,
    fallbackCount: stream.usage.fallbackCount ?? 0, streamed: stream.usage.streamed }));

  try {
    const fallback = await invokeModel({ provider: forced, systemPrompt: "Reply briefly and directly.",
      messages: [{ role: "user", content: "Hello" }], options: { maxTokens: 400 },
      purpose: "reply", deadlineAt: Date.now() + 60_000 });
    console.log(JSON.stringify({ case: "forced_groq_failure", provider: fallback.usage.provider,
      model: fallback.usage.model, fallbackCount: fallback.usage.fallbackCount,
      latencyMs: fallback.usage.latencyMs, inputTokens: fallback.usage.inputTokens ?? null,
      outputTokens: fallback.usage.outputTokens ?? null }));
  } catch (error) {
    const details = error instanceof AppError ? error.details as { category?: string; status?: number } : undefined;
    console.log(JSON.stringify({ case: "forced_groq_failure", failureCategory: details?.category ?? "unknown",
      status: details?.status ?? null }));
  }
}

if (process.argv[1]?.endsWith("cloud-llm-smoke.ts")) {
process.loadEnvFile(".env.local");
void main().catch((error) => {
  console.error("cloud smoke failed", error instanceof Error ? error.name : "unknown");
  process.exitCode = 1;
});
}
