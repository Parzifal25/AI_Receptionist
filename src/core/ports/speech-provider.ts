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

export interface SpeechProvider {
  readonly name: string;
  isRecognitionSupported(): boolean;
  isSynthesisSupported(): boolean;
  startRecognition(language: string, callbacks: SpeechRecognitionCallbacks): SpeechRecognitionSession;
  speak(text: string, language: string, onEnd?: () => void): void;
  cancelSpeech(): void;
}
