import { it, expect, vi } from "vitest";
import { SelfHostedSttProvider, SelfHostedTtsProvider } from "@halo/providers/voice-vendors/self-hosted-speech";
const format = { encoding: "pcm16le" as const, sampleRate: 16000, channels: 1 as const };
const options = { language: "te-IN", alternativeLanguages: [], interimResults: false, phraseHints: [], format };
it("verifies returned TTS sample rate before releasing any audio", async () => {
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0, 0]), { headers: { "content-type": "audio/pcm", "x-audio-sample-rate": "8000" } }));
  const tts = new SelfHostedTtsProvider({ baseUrl: "http://localhost:9900", fetchImpl });
  const result = tts.synthesize({ text: "hello", language: "en", format }, new AbortController().signal)[Symbol.asyncIterator]();
  await expect(result.next()).rejects.toThrow("contract mismatch");
});
it("synthesizes requested PCM without assuming one global sample rate", async () => {
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/pcm", "x-audio-sample-rate": "16000" } }));
  const tts = new SelfHostedTtsProvider({ baseUrl: "http://localhost:9900", fetchImpl });
  const chunks = []; for await (const chunk of tts.synthesize({ text: "hello", language: "en", format }, new AbortController().signal)) chunks.push([...chunk]);
  expect(chunks).toEqual([[1, 2]]);
});
it("queues bounded finalized utterances in order with stable distinct IDs", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ text: "transcribed" }));
  const events: unknown[] = [];
  const stream = new SelfHostedSttProvider({ baseUrl: "http://localhost:9900", fetchImpl }).open(options, event => events.push(event));
  stream.write(new Uint8Array([0, 0])); stream.finalize(); stream.finalize();
  stream.write(new Uint8Array([1, 2])); stream.finalize();
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(events).toHaveLength(2));
  expect(events).toEqual([expect.objectContaining({ utteranceId: "self-hosted-1", confidence: null }), expect.objectContaining({ utteranceId: "self-hosted-2" })]);
  await stream.close();
});
it("close aborts pending transcription and prevents late finals", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ text: "late" }));
  const events: unknown[] = [];
  const stream = new SelfHostedSttProvider({ baseUrl: "http://localhost:9900", fetchImpl }).open(options, e => events.push(e));
  stream.write(new Uint8Array([0, 0])); stream.finalize(); await stream.close();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(events).toEqual([{ type: "closed" }]); expect(fetchImpl).not.toHaveBeenCalled();
});
