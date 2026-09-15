import type { AudioFormat } from "./streaming-stt-provider";

/**
 * HALO Phase 3 — streaming text-to-speech port (plan §P5.2).
 *
 * Chunked synthesis with mid-utterance cancellation. Barge-in depends on
 * cancellation, so it is not optional: aborting `signal` must end the
 * iteration promptly (no further chunks) and release vendor resources.
 *
 * Contract (asserted by tests/contracts):
 *   - chunks are raw audio in exactly the requested `format`;
 *   - an already-aborted signal yields nothing;
 *   - abort mid-stream stops iteration without throwing to the consumer
 *     (the iterator simply completes);
 *   - vendor failures throw a `TtsError` with an honest `retryable` flag;
 *   - empty/whitespace text yields nothing.
 */

export interface TtsRequest {
  text: string;
  language: string;
  voiceId?: string;
  /** 0.5–2.0; adapters clamp to what the vendor supports. */
  speakingRate?: number;
  format: AudioFormat;
}

export type TtsErrorCode = "network" | "auth" | "quota" | "unsupported_language" | "unsupported_voice" | "provider";

export class TtsError extends Error {
  constructor(
    readonly code: TtsErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export interface TtsCapabilities {
  languages: string[];
  formats: AudioFormat[];
  voices: string[];
}

export interface StreamingTtsProvider {
  readonly name: string;
  capabilities(): TtsCapabilities;
  synthesize(request: TtsRequest, signal: AbortSignal): AsyncIterable<Uint8Array>;
}
