import type {
  SpeechProvider,
  SpeechRecognitionCallbacks,
  SpeechRecognitionSession,
} from "@/core/ports/speech-provider";

/* Minimal typings for the vendor-prefixed Web Speech API. */
interface WebSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: WebSpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface WebSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type RecognitionCtor = new () => WebSpeechRecognition;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * SpeechProvider backed by the browser's Web Speech APIs. Free, zero-latency
 * to set up, and good enough for Phase 1. A server-side STT/TTS provider
 * (Whisper, Deepgram, ElevenLabs) replaces this class without touching any
 * consumer.
 */
export class BrowserSpeechProvider implements SpeechProvider {
  readonly name = "browser";

  isRecognitionSupported(): boolean {
    return getRecognitionCtor() !== null;
  }

  isSynthesisSupported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  startRecognition(
    language: string,
    callbacks: SpeechRecognitionCallbacks,
  ): SpeechRecognitionSession {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      callbacks.onError("speech-recognition-unsupported");
      return { stop: () => undefined };
    }

    const recognition = new Ctor();
    recognition.lang = language;
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (final) callbacks.onResult(final.trim(), true);
      else if (interim) callbacks.onResult(interim.trim(), false);
    };
    recognition.onend = () => callbacks.onEnd();
    recognition.onerror = (event) => callbacks.onError(event.error);

    recognition.start();
    return { stop: () => recognition.stop() };
  }

  speak(text: string, language: string, onEnd?: () => void): void {
    if (!this.isSynthesisSupported()) {
      onEnd?.();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    utterance.rate = 1.0;
    if (onEnd) utterance.onend = onEnd;
    window.speechSynthesis.speak(utterance);
  }

  cancelSpeech(): void {
    if (this.isSynthesisSupported()) window.speechSynthesis.cancel();
  }
}
