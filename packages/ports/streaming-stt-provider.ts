/**
 * HALO Phase 3 — streaming speech-to-text port (plan §P5.2).
 *
 * Server-side, real-time transcription for the phone channel. Distinct from
 * `speech-provider.ts`, which is the CLIENT-SIDE browser speech accessory
 * and is never used on a phone call.
 *
 * Contract every adapter must honour (asserted by tests/contracts):
 *   - `open()` never throws for a runtime/network problem; failures arrive
 *     as an `error` event with `retryable` set honestly;
 *   - events are delivered in order; after `closed` nothing else is emitted;
 *   - `write()` after close is a silent no-op (the media loop may race);
 *   - `final` carries a stable `utteranceId`; a provider that re-sends the
 *     same final must reuse the id so the session can de-duplicate;
 *   - confidence is reported only when the vendor provides it — never
 *     invented (null otherwise).
 */

export type AudioEncoding = "pcm16le" | "mulaw";

export interface AudioFormat {
  encoding: AudioEncoding;
  sampleRate: number;
  channels: 1;
}

/** G.711 μ-law, 8 kHz mono — the PSTN media-stream format. */
export const TELEPHONY_AUDIO_FORMAT: AudioFormat = Object.freeze({ encoding: "mulaw", sampleRate: 8000, channels: 1 });
/** Linear PCM 16-bit little-endian, 8 kHz mono — the internal working format. */
export const PCM16_8K_FORMAT: AudioFormat = Object.freeze({ encoding: "pcm16le", sampleRate: 8000, channels: 1 });

export interface SttStreamOptions {
  /** Primary language, e.g. "te-IN". */
  language: string;
  /** Additional languages the vendor may auto-detect between (code switching). */
  alternativeLanguages: string[];
  format: AudioFormat;
  interimResults: boolean;
  /** Bounded phrase hints (product terms, place names). Adapters may ignore. */
  phraseHints: string[];
}

export type SttErrorCode = "network" | "auth" | "quota" | "unsupported_language" | "bad_audio" | "provider";

export type SttEvent =
  | { type: "speech_started" }
  | { type: "partial"; text: string; language: string | null }
  | {
      type: "final";
      utteranceId: string;
      text: string;
      confidence: number | null;
      language: string | null;
    }
  /** Provider-detected end of speech (when the vendor endpoints). */
  | { type: "endpoint" }
  | { type: "error"; code: SttErrorCode; message: string; retryable: boolean }
  | { type: "closed" };

export interface SttStream {
  write(audio: Uint8Array): void;
  /** Ask the vendor to finalize the current utterance now (local endpointing fired). */
  finalize(): void;
  close(): Promise<void>;
}

export interface SttCapabilities {
  languages: string[];
  formats: AudioFormat[];
  interimResults: boolean;
  /** The vendor emits `endpoint` events itself. */
  providerEndpointing: boolean;
  reportsConfidence: boolean;
}

export interface StreamingSttProvider {
  readonly name: string;
  capabilities(): SttCapabilities;
  open(options: SttStreamOptions, listener: (event: SttEvent) => void): SttStream;
}
