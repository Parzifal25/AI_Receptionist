import { describe, expect, it, vi } from "vitest";
import { FallbackSttProvider } from "@halo/providers/voice-vendors/fallback-stt-provider";
import { FallbackTtsProvider } from "@halo/providers/voice-vendors/fallback-tts-provider";
import { ProviderCircuit } from "@halo/providers/voice-vendors/provider-circuit";
import { VoiceProfiles } from "@halo/providers/voice-vendors/profiles";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import type { StreamingSttProvider, SttEvent } from "@halo/ports/streaming-stt-provider";

const format = { encoding: "pcm16le" as const, sampleRate: 8000, channels: 1 as const };
const request = { text: "hello", language: "te-IN", format };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function clock() { let at = 0; return { now: () => at, advance: (ms: number) => { at += ms; } }; }

describe("provider circuit", () => {
  it("opens after the threshold, probes once after the cooldown and closes on success", () => {
    const time = clock(), circuit = new ProviderCircuit({ failureThreshold: 2, cooldownMs: 1_000, now: time.now });
    expect(circuit.acquire()).toBe(true); circuit.failure();
    expect(circuit.state).toBe("closed");
    expect(circuit.acquire()).toBe(true); circuit.failure();
    expect(circuit.state).toBe("open");
    time.advance(999); expect(circuit.acquire()).toBe(false);
    time.advance(1); expect(circuit.acquire()).toBe(true);
    expect(circuit.acquire()).toBe(false); // one probe at a time
    circuit.success();
    expect(circuit.state).toBe("closed"); expect(circuit.acquire()).toBe(true);
  });
  it("backs off a failed probe up to the cap and forgets it after a recovery", () => {
    const time = clock(), changes: number[] = [];
    const circuit = new ProviderCircuit({ failureThreshold: 1, cooldownMs: 1_000, maxCooldownMs: 3_000, now: time.now, onChange: c => { if (c.state === "open") changes.push(c.cooldownMs); } });
    circuit.acquire(); circuit.failure();
    for (const wait of [1_000, 2_000, 3_000]) { time.advance(wait - 1); expect(circuit.acquire()).toBe(false); time.advance(1); expect(circuit.acquire()).toBe(true); circuit.failure(); }
    expect(changes).toEqual([1_000, 2_000, 3_000, 3_000]);
    time.advance(3_000); circuit.acquire(); circuit.success(); circuit.acquire(); circuit.failure();
    expect(changes.at(-1)).toBe(1_000);
  });
  it("a success resets the count, an abandoned probe stays available, a late failure is ignored", () => {
    const time = clock(), circuit = new ProviderCircuit({ failureThreshold: 2, cooldownMs: 1_000, now: time.now });
    circuit.failure(); circuit.success(); circuit.failure();
    expect(circuit.state).toBe("closed");
    circuit.failure(); time.advance(1_000);
    expect(circuit.acquire()).toBe(true); circuit.release();
    expect(circuit.state).toBe("open");
    circuit.failure(); // a request that began before the circuit opened
    expect(circuit.acquire()).toBe(true);
  });
  it("rejects a configuration that could never open or never probe", () => {
    expect(() => new ProviderCircuit({ failureThreshold: 0 })).toThrow();
    expect(() => new ProviderCircuit({ cooldownMs: 0 })).toThrow();
  });
});

describe("TTS fallback outage memory", () => {
  async function speak(provider: FallbackTtsProvider, signal = new AbortController().signal) {
    let bytes = 0; for await (const chunk of provider.synthesize(request, signal)) bytes += chunk.byteLength; return bytes;
  }
  function setup(options: { failureThreshold?: number } = {}) {
    const time = clock(), primary = new FakeTtsProvider(), secondary = new FakeTtsProvider(), changes: string[] = [];
    const provider = new FallbackTtsProvider([{ provider: primary }, { provider: secondary }],
      { failureThreshold: 2, cooldownMs: 30_000, now: time.now, onChange: c => changes.push(`${c.provider}:${c.state}`), ...options });
    return { time, primary, secondary, provider, changes };
  }
  it("stops asking a provider that is down, then returns to it when a probe succeeds", async () => {
    const { time, primary, secondary, provider, changes } = setup();
    for (let i = 0; i < 2; i++) { primary.failNext("network", true); expect(await speak(provider)).toBeGreaterThan(0); }
    expect(primary.requests).toHaveLength(2);
    for (let i = 0; i < 5; i++) expect(await speak(provider)).toBeGreaterThan(0);
    expect(primary.requests).toHaveLength(2); // skipped: no timeout paid
    expect(secondary.requests).toHaveLength(7);
    time.advance(30_000);
    expect(await speak(provider)).toBeGreaterThan(0); // the probe; the primary is healthy again
    expect(await speak(provider)).toBeGreaterThan(0);
    expect(primary.requests).toHaveLength(4); expect(secondary.requests).toHaveLength(7);
    expect(changes).toEqual(["fake-tts:open", "fake-tts:half_open", "fake-tts:closed"]);
  });
  it("a probe that fails still speaks through the fallback and waits twice as long", async () => {
    const { time, primary, secondary, provider } = setup({ failureThreshold: 1 });
    primary.failNext("network", true); await speak(provider);
    time.advance(30_000); primary.failNext("network", true);
    expect(await speak(provider)).toBeGreaterThan(0);
    time.advance(30_000); await speak(provider);
    expect(primary.requests).toHaveLength(2);
    time.advance(30_000); await speak(provider);
    expect(primary.requests).toHaveLength(3); expect(secondary.requests).toHaveLength(3);
  });
  it("one transient failure does not move later lines off the primary", async () => {
    const { primary, secondary, provider } = setup();
    primary.failNext("network", true); await speak(provider); await speak(provider); primary.failNext("network", true); await speak(provider); await speak(provider);
    expect(primary.requests).toHaveLength(4); expect(secondary.requests).toHaveLength(2);
  });
  it("does not count a rejected credential, a defect or a barge-in as an outage", async () => {
    const { time, primary, secondary, provider } = setup({ failureThreshold: 1 });
    primary.failNext("auth", false); await expect(speak(provider)).rejects.toThrow();
    const original = primary.synthesize.bind(primary);
    primary.synthesize = () => { throw new TypeError("adapter bug"); }; await expect(speak(provider)).rejects.toThrow("adapter bug");
    primary.synthesize = original;
    const abort = new AbortController();
    for await (const chunk of provider.synthesize(request, abort.signal)) { expect(chunk.byteLength).toBeGreaterThan(0); abort.abort(); }
    expect(await speak(provider)).toBeGreaterThan(0);
    expect(secondary.requests).toHaveLength(0);
    // A probe cut short by a barge-in leaves the next line free to probe.
    primary.failNext("network", true); await speak(provider); time.advance(30_000);
    const cut = new AbortController(); primary.synthesize = (_request, signal) => ({ async *[Symbol.asyncIterator]() { cut.abort(); if (!signal.aborted) yield new Uint8Array(2); } });
    expect(await speak(provider, cut.signal)).toBe(0);
    primary.synthesize = original; const before = primary.requests.length;
    await speak(provider);
    expect(primary.requests).toHaveLength(before + 1);
  });
  it("never skips the only provider that can serve the requested format", async () => {
    const time = clock(), primary = new FakeTtsProvider(), secondary = new FakeTtsProvider({ formats: [{ ...format, sampleRate: 16000 }] });
    const provider = new FallbackTtsProvider([{ provider: primary }, { provider: secondary }], { failureThreshold: 1, now: time.now });
    primary.failNext("network", true); await expect(speak(provider)).rejects.toThrow();
    expect(await speak(provider)).toBeGreaterThan(0);
    expect(primary.requests).toHaveLength(2); expect(secondary.requests).toHaveLength(0);
  });
});

describe("STT fallback outage memory", () => {
  const options = { language: "te-IN", alternativeLanguages: [], format, interimResults: true, phraseHints: [] };
  function stt(name: string) {
    const emits: ((e: SttEvent) => void)[] = [];
    const provider: StreamingSttProvider = { name, capabilities: () => ({ languages: ["te"], formats: [format], interimResults: true, providerEndpointing: true, reportsConfidence: false }),
      open: vi.fn((_options, listener) => { emits.push(listener); return { write: vi.fn(), finalize: vi.fn(), close: vi.fn(async () => {}) }; }) };
    return { provider, emit: (e: SttEvent) => emits.at(-1)!(e), opens: () => (provider.open as ReturnType<typeof vi.fn>).mock.calls.length };
  }
  const down: SttEvent = { type: "error", code: "network", message: "offline", retryable: true };
  const final = (text: string): SttEvent => ({ type: "final", utteranceId: "1", text, confidence: null, language: "te" });
  function setup(failureThreshold = 2) {
    const time = clock(), a = stt("primary"), b = stt("fallback"), changes: string[] = [];
    const provider = new FallbackSttProvider([a.provider, b.provider], undefined, { failureThreshold, cooldownMs: 30_000, now: time.now, onChange: c => changes.push(`${c.provider}:${c.state}`) });
    const open = async () => { const events: SttEvent[] = []; const stream = provider.open(options, e => events.push(e)); await tick(); return { events, stream }; };
    return { time, a, b, provider, open, changes };
  }
  it("opens new streams straight on the fallback during an outage and replays nothing twice", async () => {
    const { a, b, open } = setup();
    for (let i = 0; i < 2; i++) { const call = await open(); a.emit(down); await tick(); await call.stream.close(); }
    expect(a.opens()).toBe(2); expect(b.opens()).toBe(2);
    const call = await open(); call.stream.write(new Uint8Array([1, 2])); await tick();
    expect(a.opens()).toBe(2); expect(b.opens()).toBe(3);
    b.emit(final("నమస్కారం")); await tick();
    expect(call.events.filter(e => e.type === "final")).toEqual([expect.objectContaining({ text: "నమస్కారం", utteranceId: "1:1" })]);
    await call.stream.close();
  });
  it("probes the primary after the cooldown and stays on it once it answers", async () => {
    const { time, a, b, open, changes } = setup(1);
    const first = await open(); a.emit(down); await tick(); await first.stream.close();
    time.advance(30_000);
    const probe = await open(); expect(a.opens()).toBe(2);
    const during = await open(); expect(a.opens()).toBe(2); expect(b.opens()).toBe(2); // only one probe at a time
    a.emit({ type: "partial", text: "నమ", language: "te" }); await tick();
    const after = await open(); expect(a.opens()).toBe(3);
    expect(changes).toEqual(["primary:open", "primary:half_open", "primary:closed"]);
    for (const call of [probe, during, after]) await call.stream.close();
  });
  it("a stream the primary drops mid-call counts, so the reconnect is not sent back into the outage", async () => {
    const { a, b, open } = setup();
    const call = await open(); a.emit(final("book it")); await tick();
    a.emit(down); await tick();
    expect(call.events.at(-1)?.type).toBe("closed"); expect(b.opens()).toBe(0); // no replay after a final
    const reconnect = await open(); a.emit(down); await tick(); // the session's one reconnect
    expect(b.opens()).toBe(1);
    const next = await open(); expect(a.opens()).toBe(2); expect(b.opens()).toBe(2);
    await reconnect.stream.close(); await next.stream.close();
  });
  it("does not count a rejected credential or a silent call as an outage", async () => {
    const { time, a, b, open } = setup(1);
    const rejected = await open(); a.emit({ type: "error", code: "auth", message: "rejected", retryable: false }); await tick();
    expect(rejected.events.map(e => e.type)).toEqual(["error", "closed"]);
    const healthy = await open(); expect(a.opens()).toBe(2); expect(b.opens()).toBe(0); await healthy.stream.close();
    const failed = await open(); a.emit(down); await tick(); await failed.stream.close();
    time.advance(30_000);
    const silent = await open(); expect(a.opens()).toBe(4); await silent.stream.close(); // probe ended with no verdict
    const again = await open(); expect(a.opens()).toBe(5); await again.stream.close();
  });
});

describe("tenant profile providers", () => {
  it("are built once per profile so outage memory outlives a call", () => {
    const wire = { encoding: "mulaw" as const, sampleRate: 8000, channels: 1 as const };
    const speech = { sampleRate: 8000, stt: { provider: "fake", fallback: { provider: "fake" } }, tts: { provider: "fake", fallback: { provider: "fake" } } };
    const profiles = new VoiceProfiles(JSON.stringify({ alpha: { main: speech, other: speech }, beta: { main: speech } }));
    const first = profiles.resolve("alpha", "main", wire);
    expect(profiles.resolve("alpha", "main", wire).tts).toBe(first.tts);
    expect(profiles.resolve("alpha", "main", wire).stt).toBe(first.stt);
    expect(profiles.resolve("alpha", "other", wire).tts).not.toBe(first.tts);
    expect(profiles.resolve("beta", "main", wire).tts).not.toBe(first.tts);
  });
});
