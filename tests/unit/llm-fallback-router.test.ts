import { describe, expect, it } from "vitest";
import { AppError } from "@halo/core/errors/app-error";
import type { LLMCompletionOptions, LLMDelta, LLMProvider, LLMResult, LLMRouteEvent } from "@halo/ports/llm-provider";
import { FallbackLLMRouter } from "@halo/providers/llm/fallback-router";
import { invokeModel } from "@halo/runtime/llm-adapter";

const transient = (category: string, extra: Record<string, unknown> = {}) =>
  AppError.provider("provider failed", { category, ...extra });

function fake(name: string, model: string, outcome: LLMResult | Error, seen: LLMCompletionOptions[]): LLMProvider {
  return {
    name,
    capabilities: () => ({ streaming: true, tools: true, jsonMode: true, usage: true }),
    isHealthy: async () => true,
    async complete(_prompt, _messages, options = {}) {
      seen.push(options);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async *stream(_prompt, _messages, options = {}): AsyncIterable<LLMDelta> {
      seen.push(options);
      yield { type: "text", text: "partial" };
      if (outcome instanceof Error) throw outcome;
      yield { type: "usage", usage: outcome.usage! };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

const answer = (model: string): LLMResult => ({ content: "ok", model, usage: { promptTokens: 11, completionTokens: 3 } });
const base = { systemPrompt: "same authorized context", messages: [{ role: "user" as const, content: "సరే" }],
  options: { maxTokens: 100 }, purpose: "reply" as const };

describe("ordered cloud LLM fallback", () => {
  it("tries Groq's second model, then OpenRouter's first model, preserving tools and metadata", async () => {
    const seen: LLMCompletionOptions[][] = [[], [], [], []];
    const events: LLMRouteEvent[] = [];
    const router = new FallbackLLMRouter([
      { model: "gpt", provider: fake("groq", "gpt", transient("rate_limit"), seen[0]) },
      { model: "qwen", provider: fake("groq", "qwen", transient("provider_5xx"), seen[1]) },
      { model: "claude", provider: fake("openrouter", "claude", answer("claude"), seen[2]) },
      { model: "qwen", provider: fake("openrouter", "qwen", answer("qwen"), seen[3]) },
    ]);
    const out = await invokeModel({ ...base, provider: router, deadlineAt: Date.now() + 5000,
      tools: [{ name: "request_human_handoff", description: "handoff", parameters: { type: "object" } }],
      onRouteEvent: (e) => events.push(e) });
    expect(seen.map((s) => s.length)).toEqual([1, 1, 1, 0]);
    expect(seen[0][0].tools).toEqual(seen[2][0].tools);
    expect(out.usage).toMatchObject({ provider: "openrouter", model: "claude", attempt: 3,
      fallbackCount: 2, inputTokens: 11, outputTokens: 3, totalTokens: 14 });
    expect(events.filter((e) => e.type === "fallback")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "completed", provider: "openrouter", model: "claude" });
  });

  it("stops on non-provider errors and does not retry the same candidate", async () => {
    const first: LLMCompletionOptions[] = [];
    const second: LLMCompletionOptions[] = [];
    const router = new FallbackLLMRouter([
      { model: "gpt", provider: fake("groq", "gpt", AppError.validation("bad tool arguments"), first) },
      { model: "qwen", provider: fake("groq", "qwen", answer("qwen"), second) },
    ]);
    await expect(router.complete(base.systemPrompt, base.messages)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("does not treat an account billing limit as a transient model failure", async () => {
    const next: LLMCompletionOptions[] = [];
    const router = new FallbackLLMRouter([
      { model: "claude", provider: fake("openrouter", "claude", transient("billing_limit"), []) },
      { model: "qwen", provider: fake("openrouter", "qwen", answer("qwen"), next) },
    ]);
    await expect(router.complete(base.systemPrompt, base.messages)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(next).toHaveLength(0);
  });

  it("moves past a timeout and an unavailable model without repeating either request", async () => {
    const counts: LLMCompletionOptions[][] = [[], [], []];
    const router = new FallbackLLMRouter([
      { model: "gpt", provider: fake("groq", "gpt", transient("timeout"), counts[0]) },
      { model: "qwen", provider: fake("groq", "qwen", transient("model_unavailable"), counts[1]) },
      { model: "claude", provider: fake("openrouter", "claude", answer("claude"), counts[2]) },
    ]);
    const result = await router.complete(base.systemPrompt, base.messages, { timeoutMs: 12_000 });
    expect(result.route).toMatchObject({ provider: "openrouter", model: "claude", fallbackCount: 2 });
    expect(counts.map((c) => c.length)).toEqual([1, 1, 1]);
    expect(counts[0][0].timeoutMs).toBeLessThanOrEqual(4_000);
  });

  it("uses OpenRouter Qwen only after all three earlier candidates fail transiently", async () => {
    const events: LLMRouteEvent[] = [];
    const router = new FallbackLLMRouter([
      { model: "gpt", provider: fake("groq", "gpt", transient("rate_limit"), []) },
      { model: "qwen", provider: fake("groq", "qwen", transient("rate_limit"), []) },
      { model: "claude", provider: fake("openrouter", "claude", transient("provider_5xx"), []) },
      { model: "qwen", provider: fake("openrouter", "qwen", answer("qwen"), []) },
    ]);
    const result = await router.complete(base.systemPrompt, base.messages, { onRouteEvent: (e) => events.push(e) });
    expect(result.route).toMatchObject({ provider: "openrouter", model: "qwen", attempt: 4, fallbackCount: 3 });
    expect(events.map((e) => `${e.type}:${e.attempt}`)).toEqual([
      "requested:1", "started:1", "failed:1", "fallback:2", "started:2", "failed:2",
      "fallback:3", "started:3", "failed:3", "fallback:4", "started:4", "completed:4",
    ]);
  });

  it("does not hammer a rate-limited provider on the next request and skips its candidates", async () => {
    let clockMs = Date.now();
    const groqSeen: LLMCompletionOptions[] = [];
    const orSeen: LLMCompletionOptions[] = [];
    const router = new FallbackLLMRouter([
      { model: "gpt", provider: fake("groq", "gpt", transient("rate_limit", { retryAfterMs: 30_000 }), groqSeen) },
      { model: "claude", provider: fake("openrouter", "claude", answer("claude"), orSeen) },
    ], { clock: () => clockMs });
    // First request: Groq returns a 429 with a 30s Retry-After; OpenRouter answers.
    const first = await router.complete(base.systemPrompt, base.messages, { timeoutMs: 30_000 });
    expect(first.route).toMatchObject({ provider: "openrouter", model: "claude" });
    expect(groqSeen).toHaveLength(1);
    clockMs += 1;
    // Second request must not call Groq again while the cooldown is active.
    const out = await invokeModel({ ...base, provider: router, deadlineAt: clockMs + 30_000 });
    expect(out.usage).toMatchObject({ provider: "openrouter", model: "claude" });
    expect(groqSeen).toHaveLength(1);
    expect(orSeen).toHaveLength(2);
  });

  it("emits llm.exhausted after every candidate fails and the runtime serves its safe outage reply", async () => {
    const events: LLMRouteEvent[] = [];
    const router = new FallbackLLMRouter([
      { model: "gpt", provider: fake("groq", "gpt", transient("connection"), []) },
      { model: "claude", provider: fake("openrouter", "claude", transient("provider_5xx"), []) },
    ]);
    await expect(router.complete(base.systemPrompt, base.messages, { onRouteEvent: (e) => events.push(e) }))
      .rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(events.at(-1)).toMatchObject({ type: "exhausted", failureCategory: "provider_5xx" });
  });

  it("discards a failed partial stream before yielding the successful model's output", async () => {
    const router = new FallbackLLMRouter([
      { model: "gpt", provider: fake("groq", "gpt", transient("connection"), []) },
      { model: "qwen", provider: fake("groq", "qwen", answer("qwen"), []) },
    ]);
    const received: LLMDelta[] = [];
    const out = await invokeModel({ ...base, provider: router, deadlineAt: Date.now() + 5000,
      onDelta: (delta) => received.push(delta) });
    expect(received.filter((d) => d.type === "text")).toEqual([{ type: "text", text: "partial" }]);
    expect(out.usage).toMatchObject({ provider: "groq", model: "qwen", attempt: 2,
      fallbackCount: 1, streamed: true, inputTokens: 11, outputTokens: 3 });
    expect(out.usage.timeToFirstTokenMs).toBeTypeOf("number");
  });
});
