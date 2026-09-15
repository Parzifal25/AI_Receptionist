import type { AudioFormat } from "@halo/ports/streaming-stt-provider";
import { TtsError, type StreamingTtsProvider, type TtsCapabilities, type TtsRequest } from "@halo/ports/streaming-tts-provider";

/**
 * Deterministic streaming TTS fake (HALO Phase 3).
 *
 * Produces `msPerChar` milliseconds of audio per character, emitted in
 * `chunkMs` pieces, optionally paced with real timers (`firstChunkDelayMs`,
 * `interChunkDelayMs`) so latency and barge-in paths are exercised with fake
 * or real clocks. Abort ends iteration promptly without throwing. Failures
 * are injected per request.
 */

export interface FakeTtsOptions {
  msPerChar?: number;
  chunkMs?: number;
  firstChunkDelayMs?: number;
  interChunkDelayMs?: number;
  formats?: AudioFormat[];
  languages?: string[];
}

export class FakeTtsProvider implements StreamingTtsProvider {
  readonly name = "fake-tts";
  readonly requests: TtsRequest[] = [];
  aborted = 0;
  private failures: TtsError[] = [];

  constructor(private readonly opts: FakeTtsOptions = {}) {}

  capabilities(): TtsCapabilities {
    return {
      languages: this.opts.languages ?? ["te-IN", "en-IN"],
      formats: this.opts.formats ?? [
        { encoding: "mulaw", sampleRate: 8000, channels: 1 },
        { encoding: "pcm16le", sampleRate: 8000, channels: 1 },
      ],
      voices: ["fake-voice"],
    };
  }

  /** The next synthesize() call throws this error (queue). */
  failNext(code: TtsError["code"] = "provider", retryable = false): void {
    this.failures.push(new TtsError(code, "fake tts failure", retryable));
  }

  synthesize(request: TtsRequest, signal: AbortSignal): AsyncIterable<Uint8Array> {
    this.requests.push(request);
    const failure = this.failures.shift();
    const opts = this.opts;
    const countAbort = () => {
      this.aborted += 1;
    };
    return {
      async *[Symbol.asyncIterator]() {
        if (signal.aborted || !request.text.trim()) return;
        if (failure) throw failure;
        const msPerChar = opts.msPerChar ?? 60;
        const chunkMs = opts.chunkMs ?? 100;
        const bytesPerMs = (request.format.encoding === "pcm16le" ? 2 : 1) * (request.format.sampleRate / 1000);
        let remainingMs = request.text.length * msPerChar;
        let first = true;
        while (remainingMs > 0) {
          const delay = first ? (opts.firstChunkDelayMs ?? 0) : (opts.interChunkDelayMs ?? 0);
          if (delay > 0) {
            const completed = await sleep(delay, signal);
            if (!completed) {
              countAbort();
              return;
            }
          }
          if (signal.aborted) {
            countAbort();
            return;
          }
          first = false;
          const ms = Math.min(chunkMs, remainingMs);
          remainingMs -= ms;
          const bytes = Math.round(ms * bytesPerMs);
          yield new Uint8Array(request.format.encoding === "pcm16le" ? bytes - (bytes % 2) : bytes).fill(
            request.format.encoding === "mulaw" ? 0xff : 0,
          );
        }
      },
    };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
