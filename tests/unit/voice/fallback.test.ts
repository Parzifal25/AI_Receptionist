import { it, expect, vi } from "vitest";
import { FallbackTtsProvider } from "@halo/providers/voice-vendors/fallback-tts-provider";
import { FallbackSttProvider } from "@halo/providers/voice-vendors/fallback-stt-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import type { StreamingSttProvider, SttEvent } from "@halo/ports/streaming-stt-provider";
const format = { encoding: "pcm16le" as const, sampleRate: 8000, channels: 1 as const };
const request = { text: "hello", language: "en-IN", format };
async function collect(provider: FallbackTtsProvider, signal = new AbortController().signal) {
  const chunks = []; for await (const chunk of provider.synthesize(request, signal)) chunks.push(chunk); return chunks;
}
it("falls back before audio and preserves the requested sample rate", async () => {
  const primary = new FakeTtsProvider(), secondary = new FakeTtsProvider(); primary.failNext();
  expect((await collect(new FallbackTtsProvider([{ provider: primary }, { provider: secondary }]))).length).toBeGreaterThan(0);
  expect(secondary.requests[0].format).toEqual(format);
});
it("never replays speech after partial audio", async () => {
  const primary = new FakeTtsProvider(), secondary = new FakeTtsProvider();
  primary.synthesize = async function* () { yield new Uint8Array([0, 0]); throw new Error("partial failure"); };
  await expect(collect(new FallbackTtsProvider([{ provider: primary }, { provider: secondary }]))).rejects.toThrow("partial failure");
  expect(secondary.requests).toHaveLength(0);
});
it("does not open any TTS provider after cancellation", async () => {
  const primary = new FakeTtsProvider(); const abort = new AbortController(); abort.abort();
  expect(await collect(new FallbackTtsProvider([{ provider: primary }]), abort.signal)).toEqual([]);
  expect(primary.requests).toHaveLength(0);
});
function stt() {
  let emit: (e: SttEvent) => void = () => {};
  const stream = { write: vi.fn(), finalize: vi.fn(), close: vi.fn(async () => {}) };
  const provider: StreamingSttProvider = { name: "test", capabilities: () => ({ languages: ["en"], formats: [format], interimResults: true, providerEndpointing: true, reportsConfidence: false }),
    open: vi.fn((_options, listener) => { emit = listener; return stream; }) };
  return { provider, stream, emit: (e: SttEvent) => emit(e) };
}
const options = { language: "en", alternativeLanguages: [], format, interimResults: true, phraseHints: [] };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
it("replays bounded startup audio and ignores the old recognizer", async () => {
  const a = stt(), b = stt(), events: SttEvent[] = [];
  const stream = new FallbackSttProvider([a.provider, b.provider]).open(options, e => events.push(e));
  stream.write(new Uint8Array([1, 2])); await tick();
  a.emit({ type: "error", code: "network", message: "offline", retryable: true }); await tick();
  expect(b.stream.write).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  a.emit({ type: "final", utteranceId: "late", text: "yes", confidence: null, language: "en" });
  b.emit({ type: "final", utteranceId: "1", text: "hello", confidence: null, language: "en" }); await tick();
  expect(events.filter(e => e.type === "final")).toEqual([expect.objectContaining({ text: "hello", utteranceId: "1:1" })]);
  await stream.close();
});
it("does not replay after a finalized utterance", async () => {
  const a = stt(), b = stt(), events: SttEvent[] = [];
  const stream = new FallbackSttProvider([a.provider, b.provider]).open(options, e => events.push(e)); await tick();
  a.emit({ type: "final", utteranceId: "1", text: "book it", confidence: null, language: "en" }); await tick();
  a.emit({ type: "error", code: "network", message: "offline", retryable: true }); await tick();
  expect(b.provider.open).not.toHaveBeenCalled(); expect(events.at(-1)?.type).toBe("closed"); await stream.close();
});
it("advertises only audio formats every fallback can serve", () => {
  const primary = new FakeTtsProvider();
  const secondary = new FakeTtsProvider({ formats: [format] });
  const provider = new FallbackTtsProvider([{ provider: primary }, { provider: secondary }]);
  expect(provider.capabilities().formats).toEqual([format]);
});
it("uses a fallback when vendor open throws synchronously", async () => {
  const a = stt(), b = stt();
  a.provider.open = () => { throw new Error("vendor startup bug"); };
  const stream = new FallbackSttProvider([a.provider, b.provider]).open(options, () => {});
  stream.write(new Uint8Array([1, 2])); await tick();
  expect(b.stream.write).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2]));
  await stream.close();
});
it("turns a throwing vendor write into a closed stream, not an uncaught callback", async () => {
  const a = stt(), events: SttEvent[] = [];
  a.stream.write.mockImplementation(() => { throw new Error("vendor write bug"); });
  const stream = new FallbackSttProvider([a.provider]).open(options, event => events.push(event));
  stream.write(new Uint8Array([1, 2])); await tick();
  expect(events.map(e => e.type)).toEqual(["error", "closed"]);
});
