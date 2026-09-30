import type { StreamingSttProvider, SttStreamOptions, SttEvent } from "@halo/ports/streaming-stt-provider";
import { TtsError, type StreamingTtsProvider, type TtsRequest } from "@halo/ports/streaming-tts-provider";

/** HALO's self-hosted speech contract, NOT a claim that model weights ran.
 * An operator-owned inference endpoint wraps IndicConformerASR / IndicF5.
 * URLs and credentials are trusted deployment settings, never tool arguments. */
export interface SelfHostedSpeechOptions {
  baseUrl: string;
  apiKey?: string;
  sampleRates?: number[];
  languages?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
function endpoint(options: SelfHostedSpeechOptions, path: string): string {
  const url = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid speech endpoint");
  return `${url.href.replace(/\/$/, "")}/${path}`;
}
function headers(options: SelfHostedSpeechOptions) {
  return { "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) };
}
function formats(options: SelfHostedSpeechOptions) {
  return (options.sampleRates ?? [8000, 16000, 22050, 24000]).map(sampleRate => ({ encoding: "pcm16le" as const, sampleRate, channels: 1 as const }));
}
async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("Empty speech response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maxBytes) throw new Error("Speech response exceeds limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}
export class SelfHostedTtsProvider implements StreamingTtsProvider {
  readonly name = "self-hosted-tts";
  constructor(private readonly options: SelfHostedSpeechOptions) { endpoint(options, "synthesize"); }
  capabilities() { return { languages: this.options.languages ?? [], voices: [], formats: formats(this.options) }; }
  async *synthesize(request: TtsRequest, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (signal.aborted || !request.text.trim()) return;
    if (!this.capabilities().formats.some(f => f.sampleRate === request.format.sampleRate && f.encoding === request.format.encoding)) {
      throw new TtsError("provider", "Unsupported self-hosted audio format", false);
    }
    try {
      const response = await (this.options.fetchImpl ?? fetch)(endpoint(this.options, "synthesize"), {
        method: "POST", redirect: "error", headers: headers(this.options), body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 15000)]),
      });
      if (!response.ok) throw new TtsError(response.status === 401 ? "auth" : "provider", "Self-hosted synthesis failed", response.status >= 500);
      if (response.headers.get("content-type")?.split(";")[0] !== "audio/pcm" || Number(response.headers.get("x-audio-sample-rate")) !== request.format.sampleRate) {
        throw new TtsError("provider", "Self-hosted audio contract mismatch", false);
      }
      const audio = await boundedBody(response, request.format.sampleRate * 2 * 60);
      if (audio.byteLength % 2) throw new TtsError("provider", "Invalid PCM audio length", false);
      // Buffer one bounded utterance before releasing; failure never leaks partial audio.
      for (let offset = 0; offset < audio.length && !signal.aborted; offset += 4096) yield audio.slice(offset, offset + 4096);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof TtsError) throw error;
      throw new TtsError("network", "Self-hosted synthesis unavailable", true);
    }
  }
}
export class SelfHostedSttProvider implements StreamingSttProvider {
  readonly name = "self-hosted-stt";
  constructor(private readonly options: SelfHostedSpeechOptions) { endpoint(options, "transcribe"); }
  capabilities() { return { languages: this.options.languages ?? [], formats: formats(this.options), interimResults: false, providerEndpointing: false, reportsConfidence: false }; }
  open(options: SttStreamOptions, listener: (event: SttEvent) => void) {
    let closed = false, sequence = 0, queued = 0, size = 0, overflow = false;
    let chain = Promise.resolve();
    let audio: Uint8Array[] = [];
    const abort = new AbortController();
    const emit = (event: SttEvent) => { if (!closed) listener(event); };
    const supported = options.format.encoding === "pcm16le" && formats(this.options).some(f => f.sampleRate === options.format.sampleRate);
    if (!supported) queueMicrotask(() => emit({ type: "error", code: "bad_audio", message: "Unsupported self-hosted audio format", retryable: false }));
    return {
      write: (chunk: Uint8Array) => {
        if (closed || !supported || overflow) return;
        if (size + chunk.length > options.format.sampleRate * 2 * 30) {
          audio = []; size = 0; overflow = true; emit({ type: "error", code: "bad_audio", message: "Utterance exceeds buffer limit", retryable: false }); return;
        }
        audio.push(chunk.slice()); size += chunk.length;
      },
      finalize: () => {
        if (closed || !supported) return;
        if (overflow) { overflow = false; return; }
        if (size === 0) return;
        if (queued >= 2) { audio = []; size = 0; emit({ type: "error", code: "provider", message: "Transcription queue full", retryable: false }); return; }
        const body = Buffer.concat(audio); audio = []; size = 0; queued++;
        const utteranceId = `self-hosted-${++sequence}`;
        chain = chain.then(async () => {
          if (closed) { queued--; return; }
          try {
            const response = await (this.options.fetchImpl ?? fetch)(endpoint(this.options, "transcribe"), {
              method: "POST", redirect: "error", headers: headers(this.options),
              body: JSON.stringify({ audio: body.toString("base64"), format: options.format, language: options.language }),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(this.options.timeoutMs ?? 15000)]),
            });
            if (!response.ok) throw new Error("Transcription failed");
            const result: unknown = JSON.parse(new TextDecoder().decode(await boundedBody(response, 16000)));
            if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string" || result.text.length > 4000) throw new Error("Invalid transcript response");
            emit({ type: "final", utteranceId, text: result.text, confidence: null, language: options.language });
          } catch { if (!closed) emit({ type: "error", code: "provider", message: "Self-hosted transcription unavailable", retryable: true }); }
          finally { queued--; }
        });
      },
      close: async () => { if (closed) return; closed = true; abort.abort(); audio = []; listener({ type: "closed" }); },
    };
  }
}
