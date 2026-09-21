import { describe, expect, it } from "vitest";
import {
  PIPECAT_PROTOCOL_VERSION,
  encodeCommand,
  parsePipecatEvent,
  parsePipecatHello,
} from "@halo/voice/pipecat/protocol";

/**
 * Phase 4 — the control-plane wire format is a validated boundary, not a
 * convention. Everything a worker sends is untrusted input.
 */
describe("pipecat protocol", () => {
  const hello = {
    type: "hello",
    protocol: PIPECAT_PROTOCOL_VERSION,
    providerCallId: "CA-1",
    from: "+919800000001",
    to: "+914000000001",
    token: "1780000000.deadbeef",
  };

  it("accepts a well-formed hello", () => {
    const parsed = parsePipecatHello(JSON.stringify(hello));
    expect(parsed.ok).toBe(true);
  });

  it("refuses a hello from an incompatible major protocol version", () => {
    const parsed = parsePipecatHello(JSON.stringify({ ...hello, protocol: "2.0" }));
    expect(parsed).toEqual({ ok: false, error: "unsupported_protocol:2.0" });
  });

  it("accepts a compatible minor version", () => {
    expect(parsePipecatHello(JSON.stringify({ ...hello, protocol: "1.7" })).ok).toBe(true);
  });

  it("refuses a hello missing the call identity or the token", () => {
    expect(parsePipecatHello(JSON.stringify({ ...hello, providerCallId: "" })).ok).toBe(false);
    const { token: _token, ...noToken } = hello;
    expect(parsePipecatHello(JSON.stringify(noToken)).ok).toBe(false);
  });

  it("refuses malformed JSON without throwing", () => {
    expect(parsePipecatHello("{")).toEqual({ ok: false, error: "malformed_json" });
    expect(parsePipecatEvent("nope")).toEqual({ ok: false, error: "malformed_json" });
  });

  it("parses each event the worker may send", () => {
    const frames = [
      { type: "speech_started" },
      { type: "speech_stopped" },
      { type: "transcript", final: false, text: "naaku", language: "te-IN", confidence: null },
      { type: "transcript", final: true, text: "naaku solar kavali", utteranceId: "u1", language: "te-IN", confidence: 0.9 },
      { type: "playback", playbackId: "pb-1", phase: "first_audio" },
      { type: "playback", playbackId: "pb-1", phase: "chunk_played", chunkIndex: 0 },
      { type: "playback", playbackId: "pb-1", phase: "stopped", reason: "interrupted", audioMs: 420 },
      { type: "dtmf", digit: "1" },
      { type: "usage", inboundAudioMs: 100, outboundAudioMs: 50, ttsCharacters: 12 },
      { type: "error", component: "stt", code: "network", retryable: true },
      { type: "bye", reason: "caller_hangup" },
    ];
    for (const frame of frames) {
      const parsed = parsePipecatEvent(JSON.stringify(frame));
      expect(parsed.ok, `${frame.type} should parse`).toBe(true);
    }
  });

  it("defaults language and confidence to null rather than inventing them", () => {
    const parsed = parsePipecatEvent(JSON.stringify({ type: "transcript", final: true, text: "hi" }));
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.event.type !== "transcript") throw new Error("expected transcript");
    expect(parsed.event.language).toBeNull();
    expect(parsed.event.confidence).toBeNull();
  });

  it("refuses out-of-range, unknown and structurally wrong frames", () => {
    expect(parsePipecatEvent(JSON.stringify({ type: "transcript", final: true }))).toMatchObject({ ok: false });
    expect(parsePipecatEvent(JSON.stringify({ type: "transcript", final: true, text: "x", confidence: 7 }))).toMatchObject({ ok: false });
    expect(parsePipecatEvent(JSON.stringify({ type: "playback", playbackId: "p", phase: "nope" }))).toMatchObject({ ok: false });
    expect(parsePipecatEvent(JSON.stringify({ type: "bye", reason: "because" }))).toMatchObject({ ok: false });
    expect(parsePipecatEvent(JSON.stringify({ type: "hangup" }))).toMatchObject({ ok: false });
    // A tenant id on the wire is not a field: identity never travels upward.
    const withTenant = parsePipecatEvent(JSON.stringify({ type: "speech_started", tenantId: "other-tenant" }));
    if (!withTenant.ok) throw new Error("should still parse");
    expect(withTenant.event).toEqual({ type: "speech_started" });
  });

  it("caps transcript length so a worker cannot flood a session", () => {
    const long = "అ".repeat(2_001);
    expect(parsePipecatEvent(JSON.stringify({ type: "transcript", final: true, text: long }))).toMatchObject({ ok: false });
  });

  it("encodes commands as compact JSON", () => {
    expect(encodeCommand({ type: "hangup", reason: "agent_completed" })).toBe('{"type":"hangup","reason":"agent_completed"}');
  });
});
