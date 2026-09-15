/**
 * Port for speech capabilities. This interface is consumed CLIENT-SIDE by
 * the widget and the dashboard playground. The Phase 1 implementation wraps
 * the browser Web Speech APIs; a server-backed implementation (Whisper,
 * Deepgram, ElevenLabs) can replace it without changing widget logic.
 */

export interface SpeechRecognitionSession {
  stop(): void;
}

export interface SpeechRecognitionCallbacks {
  onResult(transcript: string, isFinal: boolean): void;
  onEnd(): void;
  onError(error: string): void;
}

/**
 * Outcome of an explicit microphone permission request. "unavailable" means
 * the environment can't answer (no getUserMedia) — callers should proceed
 * and let recognition itself surface any real failure.
 */
export type MicAccessResult = "granted" | "denied" | "no-mic" | "unavailable";

export interface SpeechProvider {
  readonly name: string;
  isRecognitionSupported(): boolean;
  isSynthesisSupported(): boolean;
  /**
   * Optional pre-flight permission request (getUserMedia in the browser).
   * Distinguishes "blocked" from "no device" before recognition starts, and
   * surfaces the permission prompt at a predictable moment (the mic tap).
   */
  requestMicAccess?(): Promise<MicAccessResult>;
  startRecognition(language: string, callbacks: SpeechRecognitionCallbacks): SpeechRecognitionSession;
  speak(text: string, language: string, onEnd?: () => void): void;
  cancelSpeech(): void;
}
