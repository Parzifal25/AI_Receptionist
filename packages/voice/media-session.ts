import type { CallEndReason } from "@halo/core/domain/voice";
import type { VoiceSession, VoiceSessionState, VoiceSessionSummary } from "./voice-session";

/**
 * HALO Phase 4 — the media-engine seam (docs/PIPECAT_INTEGRATION.md).
 *
 * Phase 3 had exactly one media engine: `VoiceSession`, which owns the audio
 * loop in-process (STT stream, TTS synthesis, energy VAD, barge-in) and
 * drives conversation policy on top of it. Phase 4 adds a second: Pipecat,
 * which owns the audio loop OUT of process and reports what happened.
 *
 * `VoiceGateway` must not care which one it is holding. Everything the
 * gateway owns — server-side routing, tenant identity, the call row, the
 * technical state machine, event/transcript persistence, outcomes, usage,
 * capacity, the transfer boundary — is engine-independent and stays written
 * exactly once. This interface is the only thing between them.
 *
 * `receiveAudio` / `receiveMark` / `receiveDtmf` exist because the in-process
 * engine is fed provider media frames. A remote engine never sees them and
 * implements them as no-ops; it is fed `receiveControl` instead. Neither
 * engine is required to implement both paths meaningfully, and the gateway
 * only calls what the transport actually delivers.
 */
export interface VoiceMediaSession {
  getState(): VoiceSessionState;
  /** Open the engine and speak the greeting. Idempotent after the first call. */
  start(): void;
  /** In-process engines only: caller audio in the provider media format. */
  receiveAudio(audio: Uint8Array): void;
  /** In-process engines only: a playback mark the provider acknowledged. */
  receiveMark(name: string): void;
  receiveDtmf(digit: string): void;
  /** Idempotent; returns false when there was nothing to interrupt. */
  interrupt(reason?: string): boolean;
  /** Idempotent; resolves with the same summary every time. */
  end(reason: CallEndReason): Promise<VoiceSessionSummary>;
}

/**
 * Compile-time proof that the Phase 3 engine satisfies the seam unchanged.
 * If `VoiceSession` ever drifts from it, this fails to typecheck rather than
 * failing at runtime on a live call.
 */
export type InProcessEngineSatisfiesSeam = VoiceSession extends VoiceMediaSession ? true : never;
const _assertInProcessEngine: InProcessEngineSatisfiesSeam = true;
void _assertInProcessEngine;
