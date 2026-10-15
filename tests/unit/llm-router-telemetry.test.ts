import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@halo/core/errors/app-error";
import type { LLMDelta, LLMProvider, LLMResult } from "@halo/ports/llm-provider";
import { FallbackLLMRouter } from "@halo/providers/llm/fallback-router";

/**
 * W7.1 / G3.3 — the LLM router is the one dependency path that bypassed
 * telemetry: its route events reached only an optional in-process callback.
 * Each candidate attempt now emits exactly one allowlisted `llm.attempt`, and
 * fallbacks, cooldowns and exhaustion are counted, with no payloads.
 */

const SECRET_MODEL = "private-model-name-x";
const SECRET_PROMPT = "private prompt text about Ravi at +91 98765 43210";
const SECRET_ERROR = "private upstream error body";

beforeEach(() => vi.stubEnv("HALO_TELEMETRY", "stdout"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function capture() {
  const sink = vi.spyOn(console, "log").mockImplementation(() => {});
  const records = () => sink.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((x) => x.telemetry).map((x) => x.telemetry);
  return { sink, records, llm: () => records().filter((r) => String(r.event).startsWith("llm.")) };
}

const failure = (category: string, extra: Record<string, unknown> = {}) => AppError.provider(SECRET_ERROR, { category, ...extra });
const answer: LLMResult = { content: "ok", model: SECRET_MODEL, usage: { promptTokens: 5, completionTokens: 2 } };

function provider(name: string, outcomes: Array<LLMResult | Error>): LLMProvider {
  return {
    name,
    capabilities: () => ({ streaming: true, tools: true, jsonMode: true, usage: true }),
    isHealthy: async () => true,
    async complete() {
      const next = outcomes.shift() ?? answer;
      if (next instanceof Error) throw next;
      return next;
    },
    async *stream(): AsyncIterable<LLMDelta> {
      const next = outcomes.shift() ?? answer;
      yield { type: "text", text: "partial" };
      if (next instanceof Error) throw next;
      yield { type: "text", text: " more" };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

describe("LLM router telemetry (W7.1)", () => {
  it("emits one attempt per candidate plus the fallback, labelled by provider family and failure class only", async () => {
    const { sink, llm } = capture();
    const router = new FallbackLLMRouter([
      { model: SECRET_MODEL, provider: provider("groq", [failure("rate_limit")]) },
      { model: SECRET_MODEL, provider: provider("openrouter", [answer]) },
    ]);
    await router.complete(SECRET_PROMPT, [{ role: "user", content: SECRET_PROMPT }], { timeoutMs: 5_000 });

    expect(llm().map((r) => [r.event, r.labels])).toEqual([
      ["llm.attempt", { component: "llm", provider: "groq", outcome: "error", category: "rate_limit" }],
      ["llm.fallback", { component: "llm", operation: "fallback", provider: "openrouter", category: "rate_limit" }],
      ["llm.attempt", { component: "llm", provider: "openrouter", outcome: "ok" }],
    ]);
    const output = JSON.stringify(sink.mock.calls);
    for (const secret of [SECRET_MODEL, "Ravi", "98765", SECRET_ERROR]) expect(output).not.toContain(secret);
    for (const record of llm()) {
      expect(record.labels).not.toHaveProperty("correlationId");
      expect(record).not.toHaveProperty("model");
    }
  });

  it("counts a cooldown skip, then exhaustion, without re-calling a cooled-down provider", async () => {
    const { llm } = capture();
    let now = 1_000_000;
    const router = new FallbackLLMRouter(
      [{ model: SECRET_MODEL, provider: provider("groq", [failure("rate_limit", { retryAfterMs: 30_000 })]) }],
      { clock: () => now, maxWaitMs: 0 },
    );
    await expect(router.complete("p", [{ role: "user", content: "q" }])).rejects.toThrow();
    now += 1_000;
    await expect(router.complete("p", [{ role: "user", content: "q" }])).rejects.toThrow();

    expect(llm().map((r) => [r.event, r.labels.operation ?? r.labels.outcome])).toEqual([
      ["llm.attempt", "error"],
      ["llm.exhausted", undefined],
      ["llm.cooldown", "skip"],
      ["llm.exhausted", undefined],
    ]);
    expect(llm().filter((r) => r.event === "llm.attempt")).toHaveLength(1);
    expect(llm()[2].durationMs).toBe(29_000);
  });

  it("records a cooldown the router waits out, with its duration", async () => {
    const { llm } = capture();
    let now = 5_000_000;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    const router = new FallbackLLMRouter(
      [{ model: SECRET_MODEL, provider: provider("ollama", [failure("rate_limit", { retryAfterMs: 1_500 }), answer]) }],
      { clock: () => now, sleep, maxWaitMs: 2_000 },
    );
    await expect(router.complete("p", [{ role: "user", content: "q" }])).rejects.toThrow();
    await router.complete("p", [{ role: "user", content: "q" }]);

    const cooldown = llm().find((r) => r.event === "llm.cooldown");
    expect(cooldown).toMatchObject({ labels: { component: "llm", operation: "wait", provider: "ollama", category: "rate_limit" }, durationMs: 1_500 });
    expect(sleep).toHaveBeenCalledWith(1_500);
    expect(llm().filter((r) => r.event === "llm.attempt").map((r) => r.labels.outcome)).toEqual(["error", "ok"]);
  });

  it("classifies a timeout and drops an unknown provider name instead of exporting it", async () => {
    const { sink, llm } = capture();
    const router = new FallbackLLMRouter([{ model: SECRET_MODEL, provider: provider("tenant-private-gateway", [failure("timeout")]) }]);
    await expect(router.complete("p", [{ role: "user", content: "q" }])).rejects.toThrow();
    expect(llm()[0]).toMatchObject({ event: "llm.attempt", labels: { component: "llm", outcome: "timeout", category: "timeout" } });
    expect(llm()[0].labels).not.toHaveProperty("provider");
    expect(JSON.stringify(sink.mock.calls)).not.toContain("tenant-private-gateway");
  });

  it("records exactly one attempt for a stream the consumer abandons", async () => {
    const { llm } = capture();
    const router = new FallbackLLMRouter([{ model: SECRET_MODEL, provider: provider("groq", [answer]) }]);
    for await (const delta of router.stream("p", [{ role: "user", content: "q" }], { liveStream: true })) {
      if (delta.type === "text") break;
    }
    expect(llm().map((r) => [r.event, r.labels.outcome])).toEqual([["llm.attempt", "cancelled"]]);
  });

  it("records each attempt once on a streamed fallback", async () => {
    const { llm } = capture();
    const router = new FallbackLLMRouter([
      { model: SECRET_MODEL, provider: provider("groq", [failure("provider_5xx")]) },
      { model: SECRET_MODEL, provider: provider("openrouter", [answer]) },
    ]);
    const deltas: LLMDelta[] = [];
    for await (const delta of router.stream("p", [{ role: "user", content: "q" }])) deltas.push(delta);
    expect(deltas.some((d) => d.type === "done")).toBe(true);
    expect(llm().map((r) => [r.event, r.labels.provider, r.labels.outcome])).toEqual([
      ["llm.attempt", "groq", "error"],
      ["llm.fallback", "openrouter", undefined],
      ["llm.attempt", "openrouter", "ok"],
    ]);
  });

  it("exports nothing when telemetry is disabled", async () => {
    vi.stubEnv("HALO_TELEMETRY", "disabled");
    const { sink } = capture();
    const router = new FallbackLLMRouter([{ model: SECRET_MODEL, provider: provider("groq", [answer]) }]);
    await router.complete("p", [{ role: "user", content: "q" }]);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("voice turns never wait out a cooldown (W4.6)", () => {
  async function cooledRouter(maxCooldownWaitMs: number | undefined) {
    let now = 9_000_000;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    const second = vi.fn(async () => answer);
    const router = new FallbackLLMRouter([
      { model: SECRET_MODEL, provider: provider("groq", [failure("rate_limit", { retryAfterMs: 1_000 }), answer]) },
      { model: SECRET_MODEL, provider: { ...provider("openrouter", []), complete: second } },
    ], { clock: () => now, sleep, maxWaitMs: 2_000 });
    // First request puts groq into a 1 s cooldown and falls over to openrouter.
    await router.complete("p", [{ role: "user", content: "q" }]);
    second.mockClear();
    await router.complete("p", [{ role: "user", content: "q" }], maxCooldownWaitMs === undefined ? {} : { maxCooldownWaitMs });
    return { sleep, second };
  }

  it("a zero cooldown wait fails over immediately instead of sleeping", async () => {
    const { sleep, second } = await cooledRouter(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("without the option the router keeps its configured wait", async () => {
    const { sleep, second } = await cooledRouter(undefined);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(second).not.toHaveBeenCalled();
  });
});
