import type { AudioFormat, SttCapabilities, SttEvent, SttStream, SttStreamOptions, StreamingSttProvider } from "@halo/ports/streaming-stt-provider";
import { LocalSpeechConfigError, mulawToFloat, pcm16ToFloat, type LocalSpeechEngine } from "./local-speech-engine";

/**
 * HALO Phase B — local STT behind `StreamingSttProvider`.
 *
 * The model is an OFFLINE recognizer, so this adapter is honest about what
 * that means on the port: no interim results, no provider endpointing and no
 * confidence. Audio is buffered until the session's own endpointer calls
 * `finalize()`, then the utterance is decoded once and a single `final` is
 * emitted. An utterance that produces no text emits nothing, exactly like a
 * vendor that heard silence.
 *
 * Accuracy is below the Sarvam reference, markedly for Telugu and worst on
 * spoken digits (docs/LOCAL_SPEECH.md). Nothing here compensates for that.
 */

const FORMATS: AudioFormat[] = [
  { encoding: "mulaw", sampleRate: 8000, channels: 1 },
  { encoding: "pcm16le", sampleRate: 8000, channels: 1 },
  { encoding: "pcm16le", sampleRate: 16000, channels: 1 },
];
/** RMS (0..1) above which audio counts as the caller having started. */
const SPEECH_RMS = 0.01;
/** Audio kept from before speech starts, so a soft onset is not clipped. */
const PRE_ROLL_MS = 500;
/** Kept while nothing has crossed SPEECH_RMS; a quiet speaker is still decoded. */
const QUIET_WINDOW_MS = 5_000;
const MAX_UTTERANCE_MS = 30_000;
const MIN_UTTERANCE_MS = 250;

export interface LocalSttOptions {
  timeoutMs?: number;
  /** Structured telemetry sink; transcript text is never passed to it. */
  onMetric?: (metric: { event: "final" | "error"; audioMs: number; decodeMs: number; chars: number; code?: string }) => void;
}

export class LocalSttProvider implements StreamingSttProvider {
  readonly name = "local-stt";
  private sequence = 0;

  constructor(private readonly engine: LocalSpeechEngine, private readonly options: LocalSttOptions = {}) {}

  capabilities(): SttCapabilities {
    return { languages: [...this.engine.sttLanguages], formats: FORMATS, interimResults: false, providerEndpointing: false, reportsConfidence: false };
  }

  open(options: SttStreamOptions, listener: (event: SttEvent) => void): SttStream {
    const { format } = options;
    let closed = false, speech = false, oversized = false, samples = 0, decoding: Promise<void> = Promise.resolve();
    let chunks: Float32Array[] = [];
    const emit = (event: SttEvent) => { if (!closed) listener(event); };
    const supported = FORMATS.some(f => f.encoding === format.encoding && f.sampleRate === format.sampleRate && f.channels === format.channels);
    if (!supported) queueMicrotask(() => emit({ type: "error", code: "bad_audio", message: "local-stt cannot accept this audio format", retryable: false }));
    const limit = (ms: number) => Math.round((format.sampleRate * ms) / 1000);
    const trim = (keep: number) => {
      while (chunks.length > 1 && samples - chunks[0].length >= keep) samples -= chunks.shift()!.length;
    };
    return {
      write: (audio: Uint8Array) => {
        if (closed || !supported || oversized || !audio.length) return;
        const frame = format.encoding === "mulaw" ? mulawToFloat(audio) : pcm16ToFloat(audio);
        chunks.push(frame); samples += frame.length;
        if (!speech) {
          let energy = 0;
          for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
          if (Math.sqrt(energy / Math.max(1, frame.length)) >= SPEECH_RMS) { speech = true; trim(limit(PRE_ROLL_MS) + frame.length); }
          else trim(limit(QUIET_WINDOW_MS));
        }
        // Do not keep a rolling window here: that would make the recognizer
        // return a plausible transcript for only the tail of the caller's
        // request. The Pipecat worker drops overlong segments as well.
        if (speech && samples > limit(MAX_UTTERANCE_MS)) {
          oversized = true;
          chunks = [];
          samples = 0;
        }
      },
      finalize: () => {
        if (closed || !supported) return;
        const utterance = chunks, length = samples;
        chunks = []; samples = 0; speech = false;
        if (oversized) {
          oversized = false;
          const audioMs = MAX_UTTERANCE_MS;
          this.options.onMetric?.({ event: "error", audioMs, decodeMs: 0, chars: 0, code: "too_long" });
          emit({ type: "error", code: "too_long", message: `local-stt utterance exceeds ${MAX_UTTERANCE_MS / 1000} seconds`, retryable: false });
          return;
        }
        const audioMs = (length / format.sampleRate) * 1000;
        if (audioMs < MIN_UTTERANCE_MS) return;
        const utteranceId = `local-${++this.sequence}`;
        // Utterances decode strictly in order, so finals cannot overtake each other.
        decoding = decoding.then(async () => {
          if (closed) return;
          const joined = new Float32Array(length);
          let offset = 0;
          for (const chunk of utterance) { joined.set(chunk, offset); offset += chunk.length; }
          const started = Date.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const text = await Promise.race([
              this.engine.transcribe(joined, format.sampleRate),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), this.options.timeoutMs ?? 20_000); }),
            ]);
            this.options.onMetric?.({ event: "final", audioMs, decodeMs: Date.now() - started, chars: text.length });
            // language and confidence stay null: the model reports neither.
            if (text) emit({ type: "final", utteranceId, text, confidence: null, language: null });
          } catch (error) {
            // A missing model or addon is a deployment fault, not something a retry or a fallback should hide.
            const config = error instanceof LocalSpeechConfigError, timeout = error instanceof Error && error.message === "timeout";
            this.options.onMetric?.({ event: "error", audioMs, decodeMs: Date.now() - started, chars: 0, code: config ? "config" : timeout ? "timeout" : "inference" });
            emit({ type: "error", code: "provider", message: config ? "local-stt is not installed correctly" : timeout ? "local-stt timed out" : "local-stt inference failed", retryable: !config });
          } finally { clearTimeout(timer); }
        });
      },
      close: async () => {
        if (closed) return;
        closed = true; chunks = []; samples = 0;
        listener({ type: "closed" });
      },
    };
  }
}
