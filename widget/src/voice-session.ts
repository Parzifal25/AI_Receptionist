import type { SpeechProvider, SpeechRecognitionSession } from "@halo/ports/speech-provider";

/**
 * Voice conversation state machine. DOM-free and provider-agnostic so it is
 * fully unit-testable and survives a swap from the browser Web Speech APIs
 * to a server-backed provider (Deepgram, OpenAI Realtime, ElevenLabs…)
 * without any changes here or in the widget.
 *
 * The loop: listening → (final transcript) → processing → speaking → listening.
 *
 * Design notes:
 * - Recognition is OFF while the receptionist speaks: with the free browser
 *   APIs there is no echo cancellation, so full-duplex listening would hear
 *   the receptionist's own voice. Interruption is tap-to-interrupt instead
 *   (interrupt() cancels speech and listens immediately). A server provider
 *   with echo cancellation can enable true barge-in behind this same API.
 * - Silence: each listen that ends without a final transcript counts as a
 *   silent attempt. The first ones restart listening quietly; after
 *   maxSilentAttempts the session pauses itself (onAutoPause) rather than
 *   holding the mic open forever.
 * - Errors: fatal ones (mic blocked, no mic, unsupported) fall back to chat
 *   via onFallbackToChat; transient ones (network, aborted) retry up to
 *   maxErrorRetries before falling back.
 */

export type VoiceState = "idle" | "listening" | "processing" | "speaking";

export type VoiceFallbackReason = "unsupported" | "mic-blocked" | "no-mic" | "network" | "failed";

export interface VoiceSessionOptions {
  language: string;
  /** Fired on every state transition; drive UI from this only. */
  onStateChange(state: VoiceState): void;
  /** Live transcript preview (interim and final). */
  onTranscript(text: string, isFinal: boolean): void;
  /** A completed visitor utterance, ready to send to the receptionist. */
  onUserUtterance(text: string): void;
  /** Voice can't continue — the widget should tell the visitor to type. */
  onFallbackToChat(reason: VoiceFallbackReason): void;
  /** Session paused itself after repeated silence (visitor walked away). */
  onAutoPause(): void;
  /** Listens ending with no speech before the session pauses itself. */
  maxSilentAttempts?: number;
  /** Transient recognition errors tolerated before falling back to chat. */
  maxErrorRetries?: number;
  /** Watchdog: a listen may never hang longer than this without ending. */
  listenTimeoutMs?: number;
  /**
   * Pause before retrying a failed listen. Engines that fail instantly
   * (Chrome's cloud recognition reports "network" within milliseconds when
   * its service is unreachable) would otherwise burn the whole retry budget
   * in under a second — the delay gives transient conditions time to clear.
   */
  errorRetryDelayMs?: number;
}

const DEFAULT_MAX_SILENT_ATTEMPTS = 3;
const DEFAULT_MAX_ERROR_RETRIES = 2;
const DEFAULT_LISTEN_TIMEOUT_MS = 20_000;
const DEFAULT_ERROR_RETRY_DELAY_MS = 750;

const FATAL_ERRORS: Record<string, VoiceFallbackReason> = {
  "not-allowed": "mic-blocked",
  "service-not-allowed": "mic-blocked",
  "audio-capture": "no-mic",
  "speech-recognition-unsupported": "unsupported",
};

export class VoiceSession {
  private state: VoiceState = "idle";
  private recognition: SpeechRecognitionSession | null = null;
  private listenWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Did the current listen produce a final transcript? */
  private gotFinalResult = false;
  /**
   * Monotonic listen id. Browser recognition callbacks fire asynchronously,
   * so a torn-down recognition's onEnd/onError can arrive after a new listen
   * started — stale callbacks must never drive the current one.
   */
  private listenGeneration = 0;
  /** Same idea for speech synthesis end-callbacks. */
  private speakGeneration = 0;
  private silentAttempts = 0;
  private errorRetries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly maxSilentAttempts: number;
  private readonly maxErrorRetries: number;
  private readonly listenTimeoutMs: number;
  private readonly errorRetryDelayMs: number;

  constructor(
    private readonly speech: SpeechProvider,
    private readonly options: VoiceSessionOptions,
  ) {
    this.maxSilentAttempts = options.maxSilentAttempts ?? DEFAULT_MAX_SILENT_ATTEMPTS;
    this.maxErrorRetries = options.maxErrorRetries ?? DEFAULT_MAX_ERROR_RETRIES;
    this.listenTimeoutMs = options.listenTimeoutMs ?? DEFAULT_LISTEN_TIMEOUT_MS;
    this.errorRetryDelayMs = options.errorRetryDelayMs ?? DEFAULT_ERROR_RETRY_DELAY_MS;
  }

  getState(): VoiceState {
    return this.state;
  }

  isActive(): boolean {
    return this.state !== "idle";
  }

  isSupported(): boolean {
    return this.speech.isRecognitionSupported();
  }

  /** Begin (or resume) the hands-free loop. */
  start(): void {
    if (this.state !== "idle") return;
    if (!this.speech.isRecognitionSupported()) {
      this.options.onFallbackToChat("unsupported");
      return;
    }
    this.silentAttempts = 0;
    this.errorRetries = 0;

    // Pre-flight the mic permission when the provider can: the prompt
    // appears at the moment of the tap, and "blocked" vs "no device" are
    // known before recognition ever starts.
    const preflight = this.speech.requestMicAccess?.();
    if (!preflight) {
      this.listen();
      return;
    }
    this.setState("listening");
    const generation = ++this.listenGeneration;
    void preflight.then((result) => {
      // stop()/a newer listen invalidated this preflight while the prompt
      // was open — whatever the visitor answered, it's no longer ours.
      if (generation !== this.listenGeneration || this.state !== "listening") return;
      if (result === "denied" || result === "no-mic") {
        this.stop();
        this.options.onFallbackToChat(result === "denied" ? "mic-blocked" : "no-mic");
        return;
      }
      this.listen();
    });
  }

  /** Full stop back to idle. Safe to call in any state. */
  stop(): void {
    this.teardownRecognition();
    this.speech.cancelSpeech();
    this.setState("idle");
  }

  /**
   * The visitor cut in while the receptionist was speaking: drop the rest of
   * the reply and listen right away.
   */
  interrupt(): void {
    if (this.state !== "speaking") return;
    this.speech.cancelSpeech();
    this.silentAttempts = 0;
    this.listen();
  }

  /** One tap of the mic button, whatever the current state. */
  handleTap(): void {
    switch (this.state) {
      case "idle":
        this.start();
        break;
      case "speaking":
        this.interrupt();
        break;
      default:
        this.stop();
    }
  }

  /**
   * Speak the receptionist's reply, then automatically listen again.
   * Call after onUserUtterance once the reply has arrived.
   */
  speakReply(text: string): void {
    if (this.state === "idle") return;
    this.setState("speaking");
    const generation = ++this.speakGeneration;
    this.speech.speak(text, this.options.language, () => {
      // Only resume the loop if nothing (stop, interrupt, a newer reply)
      // happened meanwhile — a cancelled utterance still ends asynchronously.
      if (generation === this.speakGeneration && this.state === "speaking") {
        this.silentAttempts = 0;
        this.listen();
      }
    });
  }

  private listen(): void {
    this.teardownRecognition();
    this.gotFinalResult = false;
    this.setState("listening");

    const generation = ++this.listenGeneration;

    // A recognition that neither results nor ends is a hung engine; the
    // watchdog abandons it and takes the silence path so the loop recovers
    // even if the engine never fires another event.
    this.listenWatchdog = setTimeout(() => {
      this.teardownRecognition();
      this.handleSilence();
    }, this.listenTimeoutMs);

    this.recognition = this.speech.startRecognition(this.options.language, {
      onResult: (transcript, isFinal) => {
        if (generation !== this.listenGeneration || this.state !== "listening") return;
        this.options.onTranscript(transcript, isFinal);
        if (isFinal && transcript) {
          this.gotFinalResult = true;
          this.silentAttempts = 0;
          this.errorRetries = 0;
          this.clearWatchdog();
          this.setState("processing");
          this.options.onUserUtterance(transcript);
        }
      },
      onEnd: () => {
        if (generation !== this.listenGeneration) return;
        this.clearWatchdog();
        if (this.state !== "listening") return;
        // Ended without hearing anything — the browser gave up on silence.
        this.handleSilence();
      },
      onError: (error) => {
        if (generation !== this.listenGeneration) return;
        this.clearWatchdog();
        this.handleError(error);
      },
    });
  }

  private handleSilence(): void {
    if (this.gotFinalResult) return;
    this.silentAttempts += 1;
    if (this.silentAttempts >= this.maxSilentAttempts) {
      this.teardownRecognition();
      this.setState("idle");
      this.options.onAutoPause();
      return;
    }
    this.listen();
  }

  private handleError(error: string): void {
    const fatal = FATAL_ERRORS[error];
    if (fatal) {
      this.stop();
      this.options.onFallbackToChat(fatal);
      return;
    }
    if (error === "no-speech") {
      // Some engines report silence as an error rather than a quiet end.
      this.handleSilence();
      return;
    }
    // Transient (network, aborted, anything unknown): retry, then give up.
    this.errorRetries += 1;
    if (this.errorRetries > this.maxErrorRetries) {
      this.stop();
      // "network" is Chrome's cloud speech service being unreachable — a
      // materially different situation than a generic failure, so tell the
      // visitor what's actually wrong.
      this.options.onFallbackToChat(error === "network" ? "network" : "failed");
      return;
    }
    if (this.state === "listening") {
      if (this.errorRetryDelayMs <= 0) {
        this.listen();
        return;
      }
      // Delay instead of hammering: instant-failure engines would otherwise
      // exhaust every retry within milliseconds. The failed listen is torn
      // down first — engines fire onEnd after onError, and that stale onEnd
      // must not restart listening underneath the scheduled retry.
      this.teardownRecognition();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.state === "listening") this.listen();
      }, this.errorRetryDelayMs);
    }
  }

  private teardownRecognition(): void {
    this.clearWatchdog();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // Invalidate this listen's callbacks before stopping — engines fire a
    // final onEnd (sometimes an "aborted" onError) on stop().
    this.listenGeneration++;
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
  }

  private clearWatchdog(): void {
    if (this.listenWatchdog !== null) {
      clearTimeout(this.listenWatchdog);
      this.listenWatchdog = null;
    }
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange(state);
  }
}
