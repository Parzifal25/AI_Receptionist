import { describe, expect, it } from "vitest";
import type { SttEvent } from "@halo/ports/streaming-stt-provider";
import { TtsError } from "@halo/ports/streaming-tts-provider";
import { floatToMulaw, LocalSpeechConfigError, mulawToFloat, splitClauses, splitScriptRuns } from "@halo/providers/voice-vendors/local-speech-engine";
import { LocalSttProvider } from "@halo/providers/voice-vendors/local-stt-provider";
import { LocalTtsProvider } from "@halo/providers/voice-vendors/local-tts-provider";
import { linearToMulaw, mulawToLinear } from "@halo/voice/audio";
import { StandInSpeechEngine } from "../../mocks/local-speech";

const pcm8k = { encoding: "pcm16le" as const, sampleRate: 8000, channels: 1 as const };
const sttOptions = { language: "te-IN", alternativeLanguages: ["en-IN"], format: pcm8k, interimResults: false, phraseHints: [] };
const tone = (ms: number, level: number) => { const pcm = new Uint8Array((8000 * ms) / 1000 * 2); new DataView(pcm.buffer).setInt16(0, 0, true);
  for (let i = 0; i < pcm.length / 2; i++) new DataView(pcm.buffer).setInt16(i * 2, i % 2 ? level : -level, true); return pcm; };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
async function speak(engine: StandInSpeechEngine, text: string, language = "te-IN", format: typeof pcm8k | { encoding: "mulaw"; sampleRate: 8000; channels: 1 } = pcm8k) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of new LocalTtsProvider(engine).synthesize({ text, language, format }, new AbortController().signal)) chunks.push(chunk);
  return chunks;
}

describe("local STT", () => {
  it("emits one final per finalized utterance and invents neither confidence nor language", async () => {
    const engine = new StandInSpeechEngine(), events: SttEvent[] = [];
    const stream = new LocalSttProvider(engine).open(sttOptions, event => events.push(event));
    stream.write(tone(1000, 8000)); stream.finalize();
    stream.write(tone(600, 8000)); stream.finalize();
    await settle();
    expect(events).toEqual([
      { type: "final", utteranceId: "local-1", text: "నమస్కారం", confidence: null, language: null },
      { type: "final", utteranceId: "local-2", text: "నమస్కారం", confidence: null, language: null },
    ]);
    expect(engine.heard).toEqual([{ samples: 8000, sampleRate: 8000 }, { samples: 4800, sampleRate: 8000 }]);
    await stream.close();
    expect(events.at(-1)).toEqual({ type: "closed" });
  });

  it("does not decode the silence before the caller speaks", async () => {
    const engine = new StandInSpeechEngine();
    const stream = new LocalSttProvider(engine).open(sttOptions, () => {});
    for (let i = 0; i < 100; i++) stream.write(tone(100, 0)); // ten silent seconds, in media-sized frames
    stream.write(tone(1000, 8000)); stream.finalize();
    await settle();
    expect(engine.heard[0].samples).toBe(8000 + 4000); // the utterance plus the pre-roll
  });

  it("reports an overlong utterance instead of silently decoding only its tail", async () => {
    const engine = new StandInSpeechEngine(), events: SttEvent[] = [];
    const stream = new LocalSttProvider(engine).open(sttOptions, event => events.push(event));
    stream.write(tone(31_000, 8000)); stream.finalize();
    await settle();
    expect(engine.heard).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "too_long", retryable: false })]);
  });

  it("reports an inference fault as retryable and a broken installation as not", async () => {
    for (const [failure, retryable] of [[new Error("onnx fault"), true], [new LocalSpeechConfigError("addon missing"), false]] as const) {
      const engine = new StandInSpeechEngine(), events: SttEvent[] = [];
      engine.failure = failure;
      const stream = new LocalSttProvider(engine).open(sttOptions, event => events.push(event));
      stream.write(tone(1000, 8000)); stream.finalize();
      await settle();
      expect(events).toEqual([expect.objectContaining({ type: "error", code: "provider", retryable })]);
    }
  });
});

describe("local TTS", () => {
  it("speaks each script with its own voice, in order, at the requested rate", async () => {
    const engine = new StandInSpeechEngine();
    const chunks = await speak(engine, "మీ office timings ఏంటి?");
    expect(engine.spoken).toEqual([{ language: "te", text: "మీ" }, { language: "en", text: "office timings" }, { language: "te", text: "ఏంటి?" }]);
    // Three runs of two half-second sentences each, 8 kHz PCM16.
    expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(3 * 8000 * 2);
    expect(splitScriptRuns("appointmentకి 10 గంటలకు", "te", ["en", "te"])).toEqual([{ language: "en", text: "appointment" }, { language: "te", text: "కి 10 గంటలకు" }]);
  });

  it("speaks a long sentence clause by clause, dropping and reordering nothing", () => {
    expect(splitClauses("Hello, how can I help you today?")).toEqual(["Hello, how can I help you today?"]);
    const long = "We repair washing machines, refrigerators and air conditioners, and we are open Monday to Saturday.";
    const clauses = splitClauses(long);
    expect(clauses.length).toBeGreaterThan(1);
    expect(clauses.join(" ")).toBe(long);
  });

  it("refuses text no installed voice can speak instead of reading out letter names", async () => {
    const engine = new StandInSpeechEngine();
    engine.voiceLanguages = ["en"];
    const failure = await speak(engine, "నమస్కారం", "en-IN").catch(error => error);
    expect(failure).toBeInstanceOf(TtsError);
    expect(failure).toMatchObject({ code: "unsupported_language", retryable: false });
    expect(engine.spoken).toEqual([]);
  });

  it("encodes telephony μ-law exactly like the media loop's codec", async () => {
    const samples = Float32Array.from([-1, -0.5, -0.01, 0, 0.01, 0.25, 0.999]);
    expect(Array.from(floatToMulaw(samples))).toEqual(Array.from(samples, s => linearToMulaw(Math.round(s * 32767))));
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(mulawToFloat(bytes), v => v + 0)).toEqual(Array.from(bytes, b => mulawToLinear(b) / 32768 + 0)); // + 0 folds -0
    const chunks = await speak(new StandInSpeechEngine(), "hello", "en-IN", { encoding: "mulaw", sampleRate: 8000, channels: 1 });
    expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(8000);
  });
});
