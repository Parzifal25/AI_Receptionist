import { audioDurationMs, pcm16Rms } from "./audio";

/**
 * HALO Phase 3 — energy-based voice activity detection and endpointing.
 *
 * Deterministic, tunable per agent version (plan §P5.6): a frame is speech
 * when its RMS exceeds `speechThreshold`; speech STARTS after `minSpeechMs`
 * of consecutive speech frames (rejecting clicks and line noise) and ENDS
 * after `endHangoverMs` of consecutive non-speech following a start.
 *
 * This is the local fallback and the barge-in detector. When the STT vendor
 * endpoints itself, the session takes whichever end-of-speech signal comes
 * first. The endpointer is fed caller audio only — the PSTN leg does not
 * loop our TTS back at speech level, and barge-in additionally requires
 * `minBargeInMs` of sustained speech to reject residual echo.
 */

export interface EndpointerConfig {
  sampleRate: number;
  /** RMS (0..1) above which a frame counts as speech. */
  speechThreshold: number;
  minSpeechMs: number;
  endHangoverMs: number;
}

export const DEFAULT_ENDPOINTER_CONFIG: EndpointerConfig = Object.freeze({
  sampleRate: 8000,
  speechThreshold: 0.02,
  minSpeechMs: 120,
  endHangoverMs: 700,
});

export type EndpointerSignal =
  | { type: "speech_start"; atMs: number }
  | { type: "speech_end"; atMs: number; speechMs: number };

export class Endpointer {
  private speaking = false;
  private speechRunMs = 0;
  private silenceRunMs = 0;
  private speechStartMs = 0;
  /** Stream-relative time of the end of the last processed frame. */
  private streamMs = 0;

  constructor(private readonly config: EndpointerConfig = DEFAULT_ENDPOINTER_CONFIG) {}

  get inSpeech(): boolean {
    return this.speaking;
  }

  /** Sustained speech so far in the current speech run (for barge-in gating). */
  get currentSpeechMs(): number {
    return this.speaking ? this.streamMs - this.speechStartMs : this.speechRunMs;
  }

  /** Feed one PCM16LE frame; returns at most one signal. */
  push(pcmFrame: Uint8Array): EndpointerSignal | null {
    const frameMs = audioDurationMs(pcmFrame.length, "pcm16le", this.config.sampleRate);
    const isSpeech = pcm16Rms(pcmFrame) >= this.config.speechThreshold;
    const frameStart = this.streamMs;
    this.streamMs += frameMs;

    if (!this.speaking) {
      if (isSpeech) {
        if (this.speechRunMs === 0) this.speechStartMs = frameStart;
        this.speechRunMs += frameMs;
        if (this.speechRunMs >= this.config.minSpeechMs) {
          this.speaking = true;
          this.silenceRunMs = 0;
          return { type: "speech_start", atMs: this.speechStartMs };
        }
      } else {
        this.speechRunMs = 0;
      }
      return null;
    }

    if (isSpeech) {
      this.silenceRunMs = 0;
      return null;
    }
    this.silenceRunMs += frameMs;
    if (this.silenceRunMs >= this.config.endHangoverMs) {
      const endAt = this.streamMs - this.silenceRunMs;
      const speechMs = endAt - this.speechStartMs;
      this.reset();
      return { type: "speech_end", atMs: endAt, speechMs };
    }
    return null;
  }

  reset(): void {
    this.speaking = false;
    this.speechRunMs = 0;
    this.silenceRunMs = 0;
  }
}
