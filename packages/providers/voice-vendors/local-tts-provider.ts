import type { AudioFormat } from "@halo/ports/streaming-stt-provider";
import { TtsError, type StreamingTtsProvider, type TtsCapabilities, type TtsRequest } from "@halo/ports/streaming-tts-provider";
import { floatToMulaw, floatToPcm16, LocalSpeechConfigError, type LocalSpeechEngine } from "./local-speech-engine";
import { DEFAULT_SPEED, PAUSE_MS, planSpeech, trimAndFade, UnspeakableTextError, type SpeechSegment } from "./local-tts-text";

/**
 * HALO Phase B — local TTS behind `StreamingTtsProvider`.
 *
 * Piper voices, one per language, chosen by the SCRIPT of the text: a
 * Telugu line with English words in Latin letters is spoken by two voices,
 * because the Telugu voice mispronounces those words. `voiceId` is therefore
 * not honoured — a vendor speaker name has no meaning here — and a line with
 * no installed voice fails as `unsupported_language` instead of being read
 * out as letter names.
 *
 * The line is first written out for speech and cut into segments
 * (local-tts-text.ts: numbers, dates, times and prices as words; one segment
 * per sentence, clause or script run). Each segment's own edge silence is
 * trimmed and the pause for how it ends is inserted after it, so a voice
 * switch mid-phrase does not leave a gap. Audio is released a segment at a
 * time; aborting the signal stops iteration at once and abandons the rest.
 */

const PCM_RATES = [8000, 16000, 22050, 24000];
const FORMATS: AudioFormat[] = [
  { encoding: "mulaw", sampleRate: 8000, channels: 1 },
  ...PCM_RATES.map(sampleRate => ({ encoding: "pcm16le" as const, sampleRate, channels: 1 as const })),
];
/** Released piece size: small enough that an abort is honoured promptly. */
const PIECE_MS = 100;

export interface LocalTtsOptions {
  timeoutMs?: number;
  onMetric?: (metric: { event: "synthesized" | "error"; chars: number; firstAudioMs: number | null; totalMs: number; audioMs: number; code?: string }) => void;
}

export class LocalTtsProvider implements StreamingTtsProvider {
  readonly name = "local-tts";

  constructor(private readonly engine: LocalSpeechEngine, private readonly options: LocalTtsOptions = {}) {}

  capabilities(): TtsCapabilities {
    return { languages: this.engine.voiceLanguages.map(language => `${language}-IN`), formats: FORMATS, voices: [...this.engine.voiceIds] };
  }

  async *synthesize(request: TtsRequest, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (signal.aborted || !request.text.trim()) return;
    const { format } = request;
    if (!FORMATS.some(f => f.encoding === format.encoding && f.sampleRate === format.sampleRate && f.channels === format.channels)) {
      throw new TtsError("provider", `local-tts cannot produce ${format.encoding}@${format.sampleRate}Hz mono`, false);
    }
    const base = request.language.split("-")[0].toLowerCase();
    let segments: SpeechSegment[];
    try {
      segments = planSpeech(request.text, this.engine.voiceLanguages.includes(base) ? base : null, this.engine.voiceLanguages);
    } catch (error) {
      if (error instanceof UnspeakableTextError) throw new TtsError("unsupported_language", "local-tts has no voice for this text", false);
      throw error;
    }
    const started = Date.now(), pieceSamples = Math.round((format.sampleRate * PIECE_MS) / 1000);
    let firstAudioMs: number | null = null, audioMs = 0;
    const metric = (event: "synthesized" | "error", code?: string) =>
      this.options.onMetric?.({ event, chars: request.text.length, firstAudioMs, totalMs: Date.now() - started, audioMs, ...(code ? { code } : {}) });
    try {
      for (const segment of segments) {
        const speed = Math.min(2, Math.max(0.5, request.speakingRate ?? DEFAULT_SPEED[segment.language] ?? 1));
        const audio = await this.synthesizeSegment(segment, speed, signal);
        if (signal.aborted) return;
        if (!audio) continue;
        const shaped = this.engine.resample(trimAndFade(audio.samples, audio.rate), audio.rate, format.sampleRate);
        const samples = new Float32Array(shaped.length + Math.round((format.sampleRate * PAUSE_MS[segment.pause]) / 1000));
        samples.set(shaped);
        for (let offset = 0; offset < samples.length; offset += pieceSamples) {
          if (signal.aborted) return;
          const piece = samples.subarray(offset, offset + pieceSamples);
          firstAudioMs ??= Date.now() - started;
          audioMs += (piece.length / format.sampleRate) * 1000;
          yield format.encoding === "mulaw" ? floatToMulaw(piece) : floatToPcm16(piece);
        }
      }
      metric("synthesized");
    } catch (error) {
      if (signal.aborted) return;
      const typed = error instanceof TtsError ? error
        : error instanceof UnspeakableTextError ? new TtsError("unsupported_language", "local-tts has no voice for this text", false)
        // A missing model or addon is a deployment fault: not retryable, so no fallback hides it.
        : error instanceof LocalSpeechConfigError ? new TtsError("provider", "local-tts is not installed correctly", false)
        : new TtsError("provider", "local-tts inference failed", true);
      metric("error", typed.code);
      throw typed;
    }
  }

  /** One segment's audio at the voice's rate; null when it produced none or the signal aborted. */
  private synthesizeSegment(segment: SpeechSegment, speed: number, signal: AbortSignal): Promise<{ samples: Float32Array; rate: number } | null> {
    return new Promise((resolve, reject) => {
      const pieces: Float32Array[] = [];
      let rate = 0, settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        outcome();
      };
      const onAbort = () => finish(() => resolve(null));
      const timer = setTimeout(() => finish(() => reject(new TtsError("provider", "local-tts timed out", true))), this.options.timeoutMs ?? 20_000);
      signal.addEventListener("abort", onAbort, { once: true });
      this.engine.synthesize(segment.language, segment.text, speed, (samples, sampleRate) => {
        if (signal.aborted || settled) return false;
        pieces.push(samples);
        rate = sampleRate;
        return true;
      }).then(() => finish(() => {
        if (!pieces.length) return resolve(null);
        const samples = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
        let offset = 0;
        for (const piece of pieces) { samples.set(piece, offset); offset += piece.length; }
        resolve({ samples, rate });
      }), error => finish(() => reject(error)));
    });
  }
}
