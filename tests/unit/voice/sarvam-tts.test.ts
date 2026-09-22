import { describe, expect, it } from "vitest";
import type { AudioFormat } from "@halo/ports/streaming-stt-provider";
import { TtsError } from "@halo/ports/streaming-tts-provider";
import { SarvamTtsProvider } from "@halo/providers/voice-vendors/sarvam-tts-provider";
import { socketHarness, type ScriptedSocket, type SocketHarness } from "../../mocks/vendor-socket";

/**
 * Protocol tests for the real TTS adapter, offline through the injected
 * socket seam. The contract that matters most on a phone call is
 * cancellation: barge-in must stop the vendor promptly, and abort must end
 * the iterator without throwing at the media loop.
 *
 * Nothing here is a claim about how the Telugu voice SOUNDS. That is a
 * native-listener judgement on real audio (docs/KNOWN_LIMITATIONS.md).
 */

const MULAW_8K: AudioFormat = { encoding: "mulaw", sampleRate: 8000, channels: 1 };
const PCM16_8K: AudioFormat = { encoding: "pcm16le", sampleRate: 8000, channels: 1 };

function provider(harness: SocketHarness) {
  return new SarvamTtsProvider({ apiKey: "test-key", defaultSpeaker: "anushka", connect: harness.factory });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function audioFrame(bytes: number[]): Record<string, unknown> {
  return { type: "audio", data: { request_id: "r1", audio: Buffer.from(bytes).toString("base64") } };
}

const FINAL = { type: "event", data: { event_type: "final" } };

/** Drains a synthesis while a vendor script drives the socket alongside it. */
async function collect(
  iterable: AsyncIterable<Uint8Array>,
  harness: SocketHarness,
  script: (socket: ScriptedSocket) => void | Promise<void>,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const drain = (async () => {
    for await (const chunk of iterable) chunks.push(chunk);
  })();
  await flush();
  await script(harness.last);
  await drain;
  return chunks;
}

describe("SarvamTtsProvider", () => {
  it("declares the telephony format it can actually emit", () => {
    const caps = provider(socketHarness()).capabilities();
    expect(caps.languages).toContain("te-IN");
    expect(caps.languages).toContain("en-IN");
    expect(caps.formats).toContainEqual(MULAW_8K);
    expect(caps.voices).toEqual(["anushka"]);
  });

  it("refuses to construct without a credential or a voice", () => {
    expect(() => new SarvamTtsProvider({ apiKey: "", defaultSpeaker: "anushka" })).toThrow(/API key/i);
    expect(() => new SarvamTtsProvider({ apiKey: "k", defaultSpeaker: "" })).toThrow(/speaker/i);
  });

  it("configures the vendor for the requested language, voice and telephony audio", async () => {
    const harness = socketHarness();
    const chunks = await collect(
      provider(harness).synthesize({ text: "నమస్కారం", language: "te-IN", format: MULAW_8K, speakingRate: 1.1 }, new AbortController().signal),
      harness,
      (socket) => {
        socket.emit(audioFrame([0xff, 0xfe]));
        socket.emit(FINAL);
      },
    );
    expect(chunks).toHaveLength(1);

    const socket = harness.last;
    expect(socket.headers["api-subscription-key"]).toBe("test-key");
    expect(socket.url).not.toContain("test-key");
    expect(new URL(socket.url).searchParams.get("send_completion_event")).toBe("true");

    const [config, text, flushFrame] = socket.frames;
    expect(config.type).toBe("config");
    expect(config.data).toMatchObject({
      target_language_code: "te-IN",
      speaker: "anushka",
      output_audio_codec: "mulaw",
      speech_sample_rate: "8000",
      pace: 1.1,
      enable_preprocessing: false,
    });
    expect(text).toEqual({ type: "text", data: { text: "నమస్కారం" } });
    expect(flushFrame).toEqual({ type: "flush" });
  });

  it("prefers the agent's configured voice over the deployment default", async () => {
    const harness = socketHarness();
    await collect(
      provider(harness).synthesize({ text: "hello", language: "en-IN", format: MULAW_8K, voiceId: "tenant-voice" }, new AbortController().signal),
      harness,
      (socket) => {
        socket.emit(audioFrame([1]));
        socket.emit(FINAL);
      },
    );
    expect((harness.last.frames[0].data as Record<string, unknown>).speaker).toBe("tenant-voice");
  });

  it("synthesizes English, Telugu and mixed Telugu/English text the same way", async () => {
    for (const text of ["What is your electricity bill?", "మీ కరెంటు బిల్లు ఎంత?", "Mee bill enta unnadi sir, monthly?"]) {
      const harness = socketHarness();
      const chunks = await collect(
        provider(harness).synthesize({ text, language: "te-IN", format: MULAW_8K }, new AbortController().signal),
        harness,
        (socket) => {
          socket.emit(audioFrame([1, 2, 3]));
          socket.emit(FINAL);
        },
      );
      expect(chunks).toHaveLength(1);
      expect(harness.last.frames[1]).toEqual({ type: "text", data: { text } });
    }
  });

  it("yields nothing — and opens no socket — for empty text or an aborted signal", async () => {
    const harness = socketHarness();
    const aborted = new AbortController();
    aborted.abort();
    const out: Uint8Array[] = [];
    for await (const chunk of provider(harness).synthesize({ text: "   ", language: "en-IN", format: MULAW_8K }, new AbortController().signal)) out.push(chunk);
    for await (const chunk of provider(harness).synthesize({ text: "hello", language: "en-IN", format: MULAW_8K }, aborted.signal)) out.push(chunk);
    expect(out).toHaveLength(0);
    expect(harness.sockets).toHaveLength(0);
  });

  it("emits whole samples only, carrying a split 16-bit sample across frames", async () => {
    const harness = socketHarness();
    const chunks = await collect(
      provider(harness).synthesize({ text: "hello", language: "en-IN", format: PCM16_8K }, new AbortController().signal),
      harness,
      (socket) => {
        socket.emit(audioFrame([1, 2, 3])); // odd: the 3rd byte is half a sample
        socket.emit(audioFrame([4, 5]));
        socket.emit(FINAL);
      },
    );
    for (const chunk of chunks) expect(chunk.length % 2).toBe(0);
    expect(Array.from(Buffer.concat(chunks.map((c) => Buffer.from(c))))).toEqual([1, 2, 3, 4]);
  });

  it("passes μ-law bytes through untouched — every byte is a whole sample", async () => {
    const harness = socketHarness();
    const chunks = await collect(
      provider(harness).synthesize({ text: "hello", language: "en-IN", format: MULAW_8K }, new AbortController().signal),
      harness,
      (socket) => {
        socket.emit(audioFrame([0xff, 0x7f, 0x01]));
        socket.emit(FINAL);
      },
    );
    expect(Array.from(chunks[0])).toEqual([0xff, 0x7f, 0x01]);
  });

  it("stops promptly on mid-stream abort, without throwing and without pulling more audio", async () => {
    const harness = socketHarness();
    const controller = new AbortController();
    const iterable = provider(harness).synthesize({ text: "a long reply the caller interrupts", language: "en-IN", format: MULAW_8K }, controller.signal);

    const chunks: Uint8Array[] = [];
    const drain = (async () => {
      for await (const chunk of iterable) {
        chunks.push(chunk);
        controller.abort();
      }
    })();
    await flush();
    harness.last.emit(audioFrame([1, 2]));
    harness.last.emit(audioFrame([3, 4]));
    harness.last.emit(audioFrame([5, 6]));
    await drain;

    expect(chunks).toHaveLength(1);
    // Barge-in must release the vendor, not leave a synthesis running.
    expect(harness.last.closed).toBe(true);
  });

  it("surfaces a provider error as a typed TtsError with an honest retryable flag", async () => {
    const harness = socketHarness();
    const iterable = provider(harness).synthesize({ text: "hello", language: "en-IN", format: MULAW_8K }, new AbortController().signal);
    const drain = (async () => {
      for await (const _ of iterable) void _;
    })();
    await flush();
    harness.last.emit({ type: "error", data: { code: "rate_limited", message: "quota exceeded" } });
    await expect(drain).rejects.toMatchObject({ name: "TtsError", code: "quota", retryable: true });
  });

  it("does not retry a rejected credential", async () => {
    const harness = socketHarness();
    const iterable = provider(harness).synthesize({ text: "hello", language: "en-IN", format: MULAW_8K }, new AbortController().signal);
    const drain = (async () => {
      for await (const _ of iterable) void _;
    })();
    await flush();
    harness.last.refuse(401, "Unauthorized");
    await expect(drain).rejects.toMatchObject({ name: "TtsError", code: "auth", retryable: false });
  });

  it("fails loudly when the vendor closes before producing any audio", async () => {
    const harness = socketHarness();
    const iterable = provider(harness).synthesize({ text: "hello", language: "en-IN", format: MULAW_8K }, new AbortController().signal);
    const drain = (async () => {
      for await (const _ of iterable) void _;
    })();
    await flush();
    harness.last.dropped(1000, "bye");
    await expect(drain).rejects.toBeInstanceOf(TtsError);
  });

  it("times out a vendor that accepts the text and never speaks", async () => {
    const harness = socketHarness();
    const slow = new SarvamTtsProvider({ apiKey: "k", defaultSpeaker: "anushka", connect: harness.factory, firstAudioTimeoutMs: 5 });
    const drain = (async () => {
      for await (const _ of slow.synthesize({ text: "hello", language: "en-IN", format: MULAW_8K }, new AbortController().signal)) void _;
    })();
    await expect(drain).rejects.toMatchObject({ name: "TtsError", code: "network", retryable: true });
  });

  it("ignores malformed vendor frames rather than cutting the reply short", async () => {
    const harness = socketHarness();
    const chunks = await collect(
      provider(harness).synthesize({ text: "hello", language: "en-IN", format: MULAW_8K }, new AbortController().signal),
      harness,
      (socket) => {
        socket.emit("}{ not json");
        socket.emit({ type: "audio", data: {} });
        socket.emit({ type: "something_new" });
        socket.emit(audioFrame([7, 8]));
        socket.emit(FINAL);
      },
    );
    expect(Array.from(chunks[0])).toEqual([7, 8]);
  });

  it("refuses a format it cannot produce instead of emitting the wrong audio", async () => {
    const harness = socketHarness();
    const drain = (async () => {
      for await (const _ of provider(harness).synthesize(
        { text: "hello", language: "en-IN", format: { encoding: "mulaw", sampleRate: 16000, channels: 1 } },
        new AbortController().signal,
      )) void _;
    })();
    await expect(drain).rejects.toBeInstanceOf(TtsError);
    expect(harness.sockets).toHaveLength(0);
  });
});
