import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@halo/core/errors/app-error";
import { describeCapabilities, type LLMDelta, type LLMProvider } from "@halo/ports/llm-provider";
import { invokeModel, ModelDeadlineError, normalizeUsage } from "@halo/runtime/llm-adapter";
import { reply, ScriptedLLM } from "../../mocks/runtime-fakes";

const base = { systemPrompt: "sys", messages: [{ role: "user" as const, content: "hi" }], options: { temperature: 0.3, maxTokens: 100 }, purpose: "reply" as const };

describe("LLM adapter — capabilities and fallback (Phase 2, WS7)", () => {
  afterEach(() => vi.useRealTimers());

  it("legacy providers without capabilities() are treated conservatively", () => {
    const legacy: LLMProvider = { name: "legacy", async complete() { return reply("x"); }, async isHealthy() { return true; } };
    expect(describeCapabilities(legacy)).toEqual({ streaming: false, tools: false, jsonMode: false, usage: false });
  });

  it("uses completion when no delta consumer is present, even if the provider can stream", async () => {
    const llm = new ScriptedLLM([reply("streamed? no")], { streaming: true, tools: true, jsonMode: true, usage: true });
    const out = await invokeModel({ ...base, provider: llm, deadlineAt: Date.now() + 5000 });
    expect(llm.calls).toHaveLength(1);
    expect(llm.streamCalls).toHaveLength(0);
    expect(out.usage.streamed).toBe(false);
  });

  it("streams when the provider supports it and a consumer is present; falls back to completion otherwise", async () => {
    const deltas: LLMDelta[] = [];
    const streaming = new ScriptedLLM([reply("hello world")], { streaming: true, tools: true, jsonMode: true, usage: true });
    const out = await invokeModel({ ...base, provider: streaming, deadlineAt: Date.now() + 5000, onDelta: (d) => deltas.push(d) });
    expect(streaming.streamCalls).toHaveLength(1);
    expect(out.result.content).toBe("hello world");
    expect(deltas.filter((d) => d.type === "text")).toHaveLength(2);
    expect(out.usage).toMatchObject({ streamed: true, inputTokens: 100, outputTokens: 20, totalTokens: 120 });

    const nonStreaming = new ScriptedLLM([reply("plain")], { streaming: false, tools: false, jsonMode: true, usage: true });
    const fallback = await invokeModel({ ...base, provider: nonStreaming, deadlineAt: Date.now() + 5000, onDelta: (d) => deltas.push(d) });
    expect(nonStreaming.streamCalls).toHaveLength(0);
    expect(fallback.usage.streamed).toBe(false);
  });

  it("never sends native tools to a provider that cannot take them, and reports the downgrade", async () => {
    const llm = new ScriptedLLM([reply("ok")], { streaming: false, tools: false, jsonMode: true, usage: true });
    const out = await invokeModel({ ...base, provider: llm, deadlineAt: Date.now() + 5000, tools: [{ name: "t", description: "d", parameters: {} }] });
    expect(out.toolsDowngraded).toBe(true);
    expect(llm.calls[0].options.tools).toBeUndefined();

    const capable = new ScriptedLLM([reply("ok")]);
    const out2 = await invokeModel({ ...base, provider: capable, deadlineAt: Date.now() + 5000, tools: [{ name: "t", description: "d", parameters: {} }] });
    expect(out2.toolsDowngraded).toBe(false);
    expect(capable.calls[0].options.tools).toHaveLength(1);
  });

  it("abandons a call at the turn deadline regardless of provider behaviour", async () => {
    vi.useFakeTimers();
    const hanging: LLMProvider = { name: "hang", complete: () => new Promise(() => {}), async isHealthy() { return true; } };
    const pending = invokeModel({ ...base, provider: hanging, deadlineAt: Date.now() + 1000 });
    const assertion = expect(pending).rejects.toBeInstanceOf(ModelDeadlineError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it("retries only transient provider errors, never timeouts, and only as many times as policy allows", async () => {
    const flaky = new ScriptedLLM([AppError.provider("AI service returned an error"), reply("recovered")]);
    const out = await invokeModel({ ...base, provider: flaky, deadlineAt: Date.now() + 5000, retry: { attempts: 2, delayMs: 0, sleep: async () => {} } });
    expect(out.result.content).toBe("recovered");
    expect(flaky.calls).toHaveLength(2);

    const timeouts = new ScriptedLLM([AppError.provider("AI service took too long to respond"), reply("never")]);
    await expect(invokeModel({ ...base, provider: timeouts, deadlineAt: Date.now() + 5000, retry: { attempts: 3, delayMs: 0, sleep: async () => {} } })).rejects.toThrow(/too long/);
    expect(timeouts.calls).toHaveLength(1);

    const noRetry = new ScriptedLLM([AppError.provider("AI service returned an error"), reply("never")]);
    await expect(invokeModel({ ...base, provider: noRetry, deadlineAt: Date.now() + 5000 })).rejects.toThrow();
    expect(noRetry.calls).toHaveLength(1);
  });

  it("never fabricates usage when the provider reports none", () => {
    const usage = normalizeUsage("p", { content: "x", model: "m" }, 12, "reply", false);
    expect(usage).toEqual({ provider: "p", model: "m", purpose: "reply", latencyMs: 12, streamed: false });
    const full = normalizeUsage("p", { content: "x", model: "m", usage: { promptTokens: 3, completionTokens: 4 } }, 1, "reply", false);
    expect(full.totalTokens).toBe(7);
  });
});
