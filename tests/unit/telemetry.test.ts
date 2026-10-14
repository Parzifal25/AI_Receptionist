import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { observe, telemetryId, telemetryStatus, withTelemetryContext } from "@halo/platform/telemetry";
import { withRetry } from "@halo/platform/retry";
import { withErrorHandling } from "@/lib/api/respond";
import { createLogger } from "@halo/platform/logger";
import { executeIntent } from "@halo/runtime/tools/boundary";

beforeEach(() => vi.stubEnv("HALO_TELEMETRY", "stdout"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function capture() {
  const sink = vi.spyOn(console, "log").mockImplementation(() => {});
  return { sink, records: () => sink.mock.calls.map(c => JSON.parse(String(c[0]))).filter(x => x.telemetry).map(x => x.telemetry) };
}
describe("local telemetry", () => {
  it("allowlists keys and values; IDs never become metric labels", () => {
    const { sink, records } = capture();
    observe("http.request", { component: "api", status: 503, outcome: "error", provider: "private-secret", phone: "private-secret", name: "private-secret", audio: "private-secret", transcript: "private-secret", authorization: "private-secret", payload: { secret: "private-secret" } }, 12.25, "private-secret");
    expect(JSON.stringify(sink.mock.calls)).not.toContain("private-secret");
    expect(records()[0]).toMatchObject({ count: 1, durationMs: 12.25, labels: { component: "api", status: 503, outcome: "error" } });
    expect(records()[0].labels).not.toHaveProperty("correlationId");
    observe("private-secret", {});
    expect(records()).toHaveLength(1);
  });
  it("isolates concurrent contexts and correlates nested observations", async () => {
    const { records } = capture();
    const ids = await Promise.all([1, 2].map(() => withTelemetryContext(async () => {
      const id = telemetryId();
      await Promise.resolve();
      observe("tool.outcome", { outcome: "ok" });
      expect(await withTelemetryContext(async () => telemetryId())).toBe(id);
      return id;
    })));
    expect(new Set(ids).size).toBe(2);
    expect(records().map(r => r.correlationId).sort()).toEqual(ids.sort());
  });
  it.each(["", "disabled", "otlp", "https://external.example"])("does not export with %s", value => {
    const { sink } = capture(); vi.stubEnv("HALO_TELEMETRY", value);
    observe("http.request", { outcome: "ok" });
    expect(sink).not.toHaveBeenCalled(); expect(telemetryStatus().enabled).toBe(false);
  });
  it("contains exporter and logger failures including cyclic metadata", async () => {
    vi.spyOn(console, "log").mockImplementation(() => { throw new Error("sink unavailable"); });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => observe("tool.outcome", { outcome: "ok" })).not.toThrow();
    expect(() => createLogger().info("safe static event", cycle)).not.toThrow();
    expect(await withRetry(async () => 42)).toBe(42);
  });
  it("records retry attempts, timeout classification and unchanged errors", async () => {
    const { records } = capture();
    const error = new DOMException("private-secret", "TimeoutError");
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(42);
    await expect(withRetry(fn, { sleep: async () => {}, telemetryProvider: "google" })).resolves.toBe(42);
    expect(records().map(r => [r.event, r.labels.outcome])).toEqual([["dependency.attempt", "timeout"], ["dependency.retry", undefined], ["dependency.attempt", "ok"]]);
    await expect(withRetry(async () => { throw error; }, { attempts: 1 })).rejects.toBe(error);
    expect(JSON.stringify(records())).not.toContain("private-secret");
  });
  it("records successful and failed API requests and returns generated IDs", async () => {
    const { records } = capture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await withErrorHandling("health", async () => NextResponse.json({ ok: true }))();
    const failure = await withErrorHandling("health", async () => { throw new Error("private-secret"); })();
    expect(response.status).toBe(200); expect(failure.status).toBe(500);
    expect(records().map(r => r.labels.status)).toEqual([200, 500]);
    expect(response.headers.get("x-request-id")).toBe(records()[0].correlationId);
    expect(failure.headers.get("x-request-id")).toBe(records()[1].correlationId);
    expect(JSON.stringify(records())).not.toContain("private-secret");
  });
  it("records tool failure without arguments or exception text", async () => {
    const { records } = capture();
    const result = await executeIntent({ intent: { id: "id", name: "private-secret", arguments: { phone: "private-secret" } }, executor: async () => { throw new Error("private-secret"); } } as unknown as Parameters<typeof executeIntent>[0]);
    expect(result.status).toBe("failed");
    expect(records()[0]).toMatchObject({ event: "tool.outcome", labels: { outcome: "error" } });
    expect(JSON.stringify(records())).not.toContain("private-secret");
  });
});

describe("instrumented workflows", () => {
  it("emits a correlated voice lifecycle without caller speech", async () => {
    const { buildSession, ScriptedTurnHandler } = await import("../mocks/voice-harness");
    vi.useFakeTimers();
    const { records } = capture();
    const handler = new ScriptedTurnHandler().then({ reply: "Synthetic reply." });
    const original = handler.handleTurn.bind(handler);
    handler.handleTurn = async request => {
      observe("tool.outcome", { outcome: "ok" });
      return original(request);
    };
    const h = buildSession({ handler });
    try {
      h.session.start();
      await h.settle(2000);
      await h.caller.say("private-secret", { confidence: 0.9 });
      await h.settle(3000);
      await h.session.end("caller_hangup");
      const events = records();
      expect(events.map(e => e.event)).toEqual(expect.arrayContaining(["voice.stt", "voice.tts", "voice.audio", "voice.processing", "voice.state", "voice.session", "tool.outcome"]));
      expect(new Set(events.map(e => e.correlationId)).size).toBe(1);
      expect(events.filter(e => e.event === "voice.session").map(e => e.labels.outcome)).toEqual(["started", "completed"]);
      expect(events.find(e => e.labels.reason === "caller_hangup")).toBeDefined();
      expect(JSON.stringify(events)).not.toContain("private-secret");
    } finally {
      await h.session.end("gateway_shutdown");
      vi.useRealTimers();
    }
  });
  it("records booking rejection and repository failure without booking input", async () => {
    const { createSchedulingFakes } = await import("../mocks/in-memory-scheduling");
    const { BookingService } = await import("@halo/scheduling/booking-service");
    const { records } = capture();
    const input = { business: { id: "private-secret" }, slot: {}, visitorName: "private-secret", visitorPhone: "private-secret" } as Parameters<InstanceType<typeof BookingService>["book"]>[0];
    const { service } = createSchedulingFakes({ bookingEnabled: false });
    expect((await service.book(input)).ok).toBe(false);
    const unavailable = new BookingService({ getSettings: async () => { throw new Error("private-secret"); } } as unknown as ConstructorParameters<typeof BookingService>[0], {} as ConstructorParameters<typeof BookingService>[1]);
    await expect(unavailable.book(input)).rejects.toThrow("private-secret");
    expect(records().map(e => e.labels.outcome)).toEqual(["rejected", "error"]);
    expect(JSON.stringify(records())).not.toContain("private-secret");
  });
  it("records real TTS fallback selection while preserving output", async () => {
    const { FallbackTtsProvider } = await import("@halo/providers/voice-vendors/fallback-tts-provider");
    const { FakeTtsProvider } = await import("@halo/providers/voice-fakes/fake-tts-provider");
    const { records } = capture();
    const primary = new FakeTtsProvider(), secondary = new FakeTtsProvider();
    primary.failNext("network", true);
    const provider = new FallbackTtsProvider([{ provider: primary }, { provider: secondary }]);
    let bytes = 0;
    for await (const audio of provider.synthesize({ text: "private-secret", language: "en-IN", format: { encoding: "pcm16le", sampleRate: 8000, channels: 1 } }, new AbortController().signal)) bytes += audio.length;
    expect(bytes).toBeGreaterThan(0);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ event: "voice.fallback", labels: { operation: "tts" } });
    expect(JSON.stringify(records())).not.toContain("private-secret");
  });
  it("does not misclassify non-speech provider failures as TTS failures", async () => {
    const { observeVoiceEvent } = await import("@halo/voice/telemetry");
    const { records } = capture();
    observeVoiceEvent("", "provider_error", 12, { component: "agent", message: "private-secret" }, "pipecat");
    expect(records()[0]).toMatchObject({ event: "voice.failure", labels: { engine: "pipecat", outcome: "error" } });
    expect(records()[0].labels).not.toHaveProperty("operation");
    expect(JSON.stringify(records())).not.toContain("private-secret");
  });
});
