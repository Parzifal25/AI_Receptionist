import { describe, expect, it, vi } from "vitest";
import type { SttEvent, SttStreamOptions } from "@halo/ports/streaming-stt-provider";
import { SarvamSttProvider } from "@halo/providers/voice-vendors/sarvam-stt-provider";
import { socketHarness, type SocketHarness } from "../../mocks/vendor-socket";

/**
 * Protocol tests for the real STT adapter, run entirely offline through the
 * injected socket seam. They assert what HALO depends on: ordered events,
 * honest confidence, stable utterance ids, typed errors and a stream that
 * goes quiet after `closed`.
 *
 * They do NOT assert transcription quality. No audio is transcribed here and
 * none of these tests says anything about Telugu accuracy — that needs the
 * live endpoint and real speech (docs/KNOWN_LIMITATIONS.md).
 */

const MULAW_8K = { encoding: "mulaw", sampleRate: 8000, channels: 1 } as const;

function streamOptions(overrides: Partial<SttStreamOptions> = {}): SttStreamOptions {
  return {
    language: "te-IN",
    alternativeLanguages: [],
    format: MULAW_8K,
    interimResults: true,
    phraseHints: [],
    ...overrides,
  };
}

function open(options: Partial<SttStreamOptions> = {}, harness: SocketHarness = socketHarness()) {
  const events: SttEvent[] = [];
  const provider = new SarvamSttProvider({ apiKey: "test-key", connect: harness.factory });
  const stream = provider.open(streamOptions(options), (event) => events.push(event));
  return { events, stream, harness };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SarvamSttProvider", () => {
  it("declares capabilities honestly — telephony audio in, no invented confidence", () => {
    const caps = new SarvamSttProvider({ apiKey: "k" }).capabilities();
    expect(caps.languages).toContain("te-IN");
    expect(caps.languages).toContain("en-IN");
    expect(caps.formats).toContainEqual({ encoding: "mulaw", sampleRate: 8000, channels: 1 });
    expect(caps.interimResults).toBe(true);
    expect(caps.providerEndpointing).toBe(true);
    // The endpoint emits no transcript confidence. Claiming otherwise would
    // silently enable HALO's read-back of misheard names on false evidence.
    expect(caps.reportsConfidence).toBe(false);
  });

  it("refuses to construct without a credential", () => {
    expect(() => new SarvamSttProvider({ apiKey: "" })).toThrow(/API key/i);
  });

  it("sends the telephony format, the language and the key in a header — never in the URL", async () => {
    const { harness } = open({ language: "te-IN", phraseHints: ["Arunodhaya", "kilowatt"] });
    const socket = harness.last;
    const url = new URL(socket.url);
    expect(url.searchParams.get("encoding")).toBe("mulaw");
    expect(url.searchParams.get("sample_rate")).toBe("8000");
    expect(url.searchParams.get("language_code")).toBe("te-IN");
    expect(url.searchParams.get("endpointing")).toBe("vad");
    expect(url.searchParams.get("keyterms")).toBe("Arunodhaya,kilowatt");
    expect(socket.headers["api-subscription-key"]).toBe("test-key");
    expect(socket.url).not.toContain("test-key");
    await flush();
  });

  it("asks for auto-detection when the session declares alternative languages", () => {
    const { harness } = open({ language: "te-IN", alternativeLanguages: ["en-IN"] });
    expect(new URL(harness.last.url).searchParams.get("language_code")).toBe("auto");
  });

  it("buffers audio written before the socket opens, then flushes it in order", async () => {
    const harness = socketHarness({ autoOpen: false });
    const { stream } = open({}, harness);
    stream.write(Uint8Array.from([1, 2, 3]));
    stream.write(Uint8Array.from([4, 5, 6]));
    expect(harness.last.sent).toHaveLength(0);

    harness.last.open();
    const audio = harness.last.frames;
    expect(audio.map((f) => f.event)).toEqual(["audio_input", "audio_input"]);
    expect(audio[0].audio).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(audio[1].audio).toBe(Buffer.from([4, 5, 6]).toString("base64"));
  });

  it("drops the oldest buffered audio rather than growing without bound", async () => {
    const harness = socketHarness({ autoOpen: false });
    const provider = new SarvamSttProvider({ apiKey: "k", connect: harness.factory, maxPendingBytes: 300 });
    const stream = provider.open(streamOptions(), () => {});
    for (let i = 0; i < 10; i++) stream.write(new Uint8Array(100).fill(i));
    harness.last.open();
    const frames = harness.last.frames;
    expect(frames.length).toBeLessThanOrEqual(4);
    // The NEWEST audio survives: it is the audio the caller is speaking now.
    const lastPayload = Buffer.from(String(frames[frames.length - 1].audio), "base64");
    expect(lastPayload[0]).toBe(9);
  });

  it("carries a partial through to a final with a stable utterance id and null confidence", async () => {
    const { events, harness } = open();
    await flush();
    harness.last.emit({ event: "session.begin", request_id: "req-1" });
    harness.last.emit({ event: "vad.speech_start" });
    harness.last.emit({ event: "transcript.partial", utterance_idx: 0, text: "నమస్", language: "te-IN" });
    harness.last.emit({ event: "transcript.final", utterance_idx: 0, text: "నమస్కారం", language: "te-IN", language_confidence: "0.95" });

    expect(events).toEqual([
      { type: "speech_started" },
      { type: "partial", text: "నమస్", language: "te-IN" },
      { type: "final", utteranceId: "req-1:0", text: "నమస్కారం", confidence: null, language: "te-IN" },
    ]);
  });

  it("keeps utterance ids distinct across utterances so the session can de-duplicate", async () => {
    const { events, harness } = open();
    await flush();
    harness.last.emit({ event: "session.begin", request_id: "req-9" });
    harness.last.emit({ event: "transcript.final", utterance_idx: 0, text: "first" });
    harness.last.emit({ event: "transcript.final", utterance_idx: 1, text: "second" });
    const ids = events.filter((e) => e.type === "final").map((e) => (e as { utteranceId: string }).utteranceId);
    expect(ids).toEqual(["req-9:0", "req-9:1"]);
  });

  it("transcribes a Tenglish final without altering the text", async () => {
    const { events, harness } = open({ language: "te-IN", alternativeLanguages: ["en-IN"] });
    await flush();
    const tenglish = "Meeru solar panel price cheppagalara?";
    harness.last.emit({ event: "transcript.final", utterance_idx: 0, text: tenglish, language: "en-IN" });
    expect(events).toContainEqual({ type: "final", utteranceId: "sarvam:0", text: tenglish, confidence: null, language: "en-IN" });
  });

  it("maps provider endpointing to an endpoint event", async () => {
    const { events, harness } = open();
    await flush();
    harness.last.emit({ event: "vad.speech_end" });
    expect(events).toEqual([{ type: "endpoint" }]);
  });

  it("asks the vendor to finalize when the session endpoints locally", async () => {
    const { stream, harness } = open();
    await flush();
    stream.finalize();
    expect(harness.last.frames.map((f) => f.event)).toContain("flush");
  });

  it("maps a non-fatal provider error to a retryable event and keeps the stream alive", async () => {
    const { events, harness } = open();
    await flush();
    harness.last.emit({ event: "error", code: "quota_exceeded", message: "rate limit", is_fatal: false });
    expect(events).toEqual([{ type: "error", code: "quota", message: "rate limit", retryable: true }]);
    expect(events.some((e) => e.type === "closed")).toBe(false);
  });

  it("never marks a rejected credential retryable, and closes on a fatal error", async () => {
    const { events, harness } = open();
    await flush();
    harness.last.emit({ event: "error", code: "unauthorized", message: "invalid subscription key", is_fatal: true });
    expect(events[0]).toMatchObject({ type: "error", code: "auth", retryable: false });
    expect(events[1]).toEqual({ type: "closed" });
  });

  it("classifies a refused upgrade by its HTTP status", async () => {
    const { events, harness } = open();
    harness.last.refuse(401, "Unauthorized");
    expect(events[0]).toMatchObject({ type: "error", code: "auth", retryable: false });
  });

  it("reports a dropped socket as retryable so the session can reconnect", async () => {
    const { events, harness } = open();
    await flush();
    harness.last.dropped(1006, "abnormal");
    expect(events[0]).toMatchObject({ type: "error", code: "network", retryable: true });
    expect(events[1]).toEqual({ type: "closed" });
  });

  it("times out a connection that never opens", async () => {
    vi.useFakeTimers();
    try {
      const harness = socketHarness({ autoOpen: false });
      const { events } = open({}, harness);
      vi.advanceTimersByTime(6_000);
      expect(events[0]).toMatchObject({ type: "error", code: "network", retryable: true });
      expect(events[1]).toEqual({ type: "closed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores malformed provider frames instead of ending the call", async () => {
    const { events, harness } = open();
    await flush();
    harness.last.emit("not json at all");
    harness.last.emit({ event: "transcript.final" }); // no text
    harness.last.emit({ event: "something_new_the_vendor_added" });
    harness.last.emit({ event: "transcript.final", utterance_idx: 2, text: "still working" });
    expect(events).toEqual([{ type: "final", utteranceId: "sarvam:2", text: "still working", confidence: null, language: null }]);
  });

  it("emits nothing after closed, and write/close after close are no-ops", async () => {
    const { events, stream, harness } = open();
    await flush();
    const socket = harness.last;
    await stream.close();
    await stream.close();
    expect(() => stream.write(Uint8Array.from([1]))).not.toThrow();
    socket.emit({ event: "transcript.final", utterance_idx: 0, text: "too late" });
    socket.dropped();
    expect(events).toEqual([{ type: "closed" }]);
  });

  it("tells the vendor the session is over so it releases resources", async () => {
    const { stream, harness } = open();
    await flush();
    await stream.close();
    expect(harness.last.frames.map((f) => f.event)).toContain("end");
    expect(harness.last.closed).toBe(true);
  });

  it("redacts credential-shaped text out of provider messages", async () => {
    const { events, harness } = open();
    await flush();
    harness.last.emit({ event: "error", code: "provider", message: "rejected key [REDACTED_TEST_KEY]", is_fatal: false });
    expect((events[0] as { message: string }).message).not.toContain("0123456789abcdefghijklmn");
    expect((events[0] as { message: string }).message).toContain("[redacted]");
  });
});
