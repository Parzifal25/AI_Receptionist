import { describe, expect, it } from "vitest";
import {
  audioDurationMs,
  BoundedAudioQueue,
  linearToMulaw,
  mulawToLinear,
  mulawToPcm16,
  pcm16Rms,
  pcm16ToMulaw,
} from "@halo/voice/audio";
import { Endpointer } from "@halo/voice/endpointer";

function pcmFrame(ms: number, amplitude: number, sampleRate = 8000): Uint8Array {
  const samples = Math.round((ms / 1000) * sampleRate);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * amplitude * 32767), true);
  }
  return out;
}

describe("G.711 μ-law codec", () => {
  it("matches reference vectors", () => {
    expect(linearToMulaw(0)).toBe(0xff);
    expect(mulawToLinear(0xff)).toBe(0);
    expect(mulawToLinear(0x80)).toBe(32124);
    expect(mulawToLinear(0x00)).toBe(-32124);
    expect(linearToMulaw(32767)).toBe(0x80);
    expect(linearToMulaw(-32768)).toBe(0x00);
  });

  it("round-trips every μ-law code to itself", () => {
    for (let b = 0; b < 256; b++) {
      // 0x7f and 0xff both decode to 0 (G.711 has two zero codes).
      if (b === 0x7f) continue;
      expect(linearToMulaw(mulawToLinear(b))).toBe(b);
    }
  });

  it("converts buffers with bounded quantization error", () => {
    const pcm = pcmFrame(20, 0.5);
    const back = mulawToPcm16(pcm16ToMulaw(pcm));
    expect(back.length).toBe(pcm.length);
    const a = new DataView(pcm.buffer);
    const b = new DataView(back.buffer);
    for (let i = 0; i < pcm.length / 2; i++) {
      const x = a.getInt16(i * 2, true);
      expect(Math.abs(x - b.getInt16(i * 2, true))).toBeLessThanOrEqual(Math.max(64, Math.abs(x) * 0.1));
    }
  });

  it("computes durations and RMS", () => {
    expect(audioDurationMs(8000, "mulaw", 8000)).toBe(1000);
    expect(audioDurationMs(320, "pcm16le", 8000)).toBe(20);
    expect(pcm16Rms(pcmFrame(20, 0))).toBe(0);
    expect(pcm16Rms(pcmFrame(20, 0.5))).toBeGreaterThan(0.3);
  });
});

describe("BoundedAudioQueue", () => {
  it("drops the oldest audio beyond the ceiling and counts it", () => {
    const q = new BoundedAudioQueue(10);
    q.push(new Uint8Array(6).fill(1));
    q.push(new Uint8Array(6).fill(2));
    expect(q.size).toBe(6);
    expect(q.droppedBytes).toBe(6);
    expect(q.drain()[0][0]).toBe(2);
    expect(q.size).toBe(0);
  });

  it("keeps the newest tail of an oversized chunk", () => {
    const q = new BoundedAudioQueue(4);
    q.push(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    expect(Array.from(q.drain()[0])).toEqual([3, 4, 5, 6]);
    expect(q.droppedBytes).toBe(2);
  });

  it("rejects a non-positive ceiling", () => {
    expect(() => new BoundedAudioQueue(0)).toThrow();
  });
});

describe("Endpointer", () => {
  const config = { sampleRate: 8000, speechThreshold: 0.05, minSpeechMs: 100, endHangoverMs: 300 };

  it("detects speech start after the minimum run and end after the hangover", () => {
    const ep = new Endpointer(config);
    const signals = [];
    for (let i = 0; i < 5; i++) signals.push(ep.push(pcmFrame(20, 0)));
    for (let i = 0; i < 25; i++) signals.push(ep.push(pcmFrame(20, 0.4)));
    for (let i = 0; i < 20; i++) signals.push(ep.push(pcmFrame(20, 0)));
    const real = signals.filter(Boolean);
    expect(real).toHaveLength(2);
    expect(real[0]).toMatchObject({ type: "speech_start", atMs: 100 });
    expect(real[1]).toMatchObject({ type: "speech_end", atMs: 600, speechMs: 500 });
  });

  it("ignores clicks shorter than the minimum speech run", () => {
    const ep = new Endpointer(config);
    const signals = [ep.push(pcmFrame(40, 0.5)), ep.push(pcmFrame(200, 0)), ep.push(pcmFrame(40, 0.5))];
    expect(signals.filter(Boolean)).toHaveLength(0);
    expect(ep.inSpeech).toBe(false);
  });

  it("does not end speech on a pause shorter than the hangover", () => {
    const ep = new Endpointer(config);
    for (let i = 0; i < 10; i++) ep.push(pcmFrame(20, 0.4));
    for (let i = 0; i < 10; i++) expect(ep.push(pcmFrame(20, 0))).toBeNull();
    ep.push(pcmFrame(20, 0.4));
    expect(ep.inSpeech).toBe(true);
  });
});
