import type { AudioFormat } from "@halo/ports/streaming-stt-provider";
import { TtsError, type StreamingTtsProvider, type TtsCapabilities, type TtsRequest } from "@halo/ports/streaming-tts-provider";
import { floatToMulaw, floatToPcm16, LocalSpeechConfigError, splitClauses, splitScriptRuns, UnspeakableTextError, type LocalSpeechEngine } from "./local-speech-engine";

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
 * Audio is released a sentence at a time. Aborting the signal stops
 * iteration at once and abandons the remaining sentences.
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
    let runs: { language: string; text: string }[];
    try {
      runs = splitScriptRuns(request.text, this.engine.voiceLanguages.includes(base) ? base : null, this.engine.voiceLanguages)
        .flatMap(run => splitClauses(run.text).map(text => ({ language: run.language, text })));
    } catch (error) {
      if (error instanceof UnspeakableTextError) throw new TtsError("unsupported_language", "local-tts has no voice for this text", false);
      throw error;
    }
    const speed = Math.min(2, Math.max(0.5, request.speakingRate ?? 1));
    const started = Date.now(), pieceSamples = Math.round((format.sampleRate * PIECE_MS) / 1000);
    let firstAudioMs: number | null = null, audioMs = 0;
    const metric = (event: "synthesized" | "error", code?: string) =>
      this.options.onMetric?.({ event, chars: request.text.length, firstAudioMs, totalMs: Date.now() - started, audioMs, ...(code ? { code } : {}) });
    try {
      for (const run of runs) {
        // Sentences arrive on a callback while the consumer pulls: a small queue joins the two.
        const ready: Float32Array[] = [];
        let wake: () => void = () => {}, done = false, failure: unknown;
        const signalled = () => { const resume = wake; wake = () => {}; resume(); };
        const timer = setTimeout(() => { failure = new TtsError("provider", "local-tts timed out", true); signalled(); }, this.options.timeoutMs ?? 20_000);
        void this.engine.synthesize(run.language, run.text, speed, (samples, rate) => {
          if (signal.aborted || failure) return false;
          ready.push(this.engine.resample(samples, rate, format.sampleRate));
          signalled();
          return true;
        }).then(() => { done = true; }, error => { failure ??= error; }).finally(signalled);
        const onAbort = () => signalled();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          for (;;) {
            if (signal.aborted) return;
            const samples = ready.shift();
            if (samples) {
              for (let offset = 0; offset < samples.length; offset += pieceSamples) {
                if (signal.aborted) return;
                const piece = samples.subarray(offset, offset + pieceSamples);
                firstAudioMs ??= Date.now() - started;
                audioMs += (piece.length / format.sampleRate) * 1000;
                yield format.encoding === "mulaw" ? floatToMulaw(piece) : floatToPcm16(piece);
              }
              continue;
            }
            if (failure) throw failure;
            if (done) break;
            await new Promise<void>(resolve => { wake = resolve; });
          }
        } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
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
}
