import type {
  MicAccessResult,
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
    // Browsers hard-fail recognition on insecure origins (http:// embeds get
    // an instant "not-allowed") — treat that as unsupported so the widget
    // stays chat-only instead of showing a mic that can never work.
    // localhost counts as a secure context, so development is unaffected.
    if (typeof window !== "undefined" && window.isSecureContext === false) return false;
    return getRecognitionCtor() !== null;
  }

  isSynthesisSupported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  async requestMicAccess(): Promise<MicAccessResult> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return "unavailable";
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Only the permission mattered — release the device immediately so
      // recognition can claim it.
      for (const track of stream.getTracks()) track.stop();
      return "granted";
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") return "denied";
      if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") {
        return "no-mic";
      }
      return "unavailable";
    }
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
    if (!this.isSynthesisSupported() || !text.trim()) {
      onEnd?.();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    utterance.rate = 1.0;
    if (onEnd) {
      // onEnd must fire exactly once whatever happens — the voice loop's
      // "listen again after speaking" depends on it. Errors (including the
      // "interrupted" error a cancel() raises) count as the end of speech.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        onEnd();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
    }
    window.speechSynthesis.speak(utterance);
    // Chrome quirk: the synthesis queue can be left paused (e.g. after a
    // cancel() or tab visibility change) and speak() then never starts.
    // resume() is a no-op when not paused, so always nudge it.
    window.speechSynthesis.resume();
  }

  cancelSpeech(): void {
    if (this.isSynthesisSupported()) window.speechSynthesis.cancel();
  }
}
