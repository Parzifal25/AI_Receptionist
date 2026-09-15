import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MicAccessResult,
  SpeechProvider,
  SpeechRecognitionCallbacks,
  SpeechRecognitionSession,
} from "@halo/ports/speech-provider";
import {
  VoiceSession,
  type VoiceFallbackReason,
  type VoiceState,
} from "../../widget/src/voice-session";

/** Scriptable recognition: tests drive results/end/error by hand. */
class FakeRecognition implements SpeechRecognitionSession {
  stopped = false;
  constructor(readonly callbacks: SpeechRecognitionCallbacks) {}
  stop(): void {
    this.stopped = true;
  }
  hearFinal(text: string): void {
    this.callbacks.onResult(text, true);
  }
  hearInterim(text: string): void {
    this.callbacks.onResult(text, false);
  }
  end(): void {
    this.callbacks.onEnd();
  }
  fail(error: string): void {
    this.callbacks.onError(error);
  }
}

class FakeSpeechProvider implements SpeechProvider {
  readonly name = "fake";
  recognitionSupported = true;
  synthesisSupported = true;
  recognitions: FakeRecognition[] = [];
  spoken: Array<{ text: string; onEnd?: () => void }> = [];
  cancelCount = 0;
  /** Tests opt in to the pre-flight by assigning this. */
  requestMicAccess?: () => Promise<MicAccessResult>;

  isRecognitionSupported(): boolean {
    return this.recognitionSupported;
  }
  isSynthesisSupported(): boolean {
    return this.synthesisSupported;
  }
  startRecognition(
    _language: string,
    callbacks: SpeechRecognitionCallbacks,
  ): SpeechRecognitionSession {
    const recognition = new FakeRecognition(callbacks);
    this.recognitions.push(recognition);
    return recognition;
  }
  speak(text: string, _language: string, onEnd?: () => void): void {
    this.spoken.push({ text, onEnd });
  }
  cancelSpeech(): void {
    this.cancelCount += 1;
  }
  current(): FakeRecognition {
    const last = this.recognitions[this.recognitions.length - 1];
    if (!last) throw new Error("no recognition started");
    return last;
  }
}

function createSession(
  speech: FakeSpeechProvider,
  overrides: {
    maxSilentAttempts?: number;
    maxErrorRetries?: number;
    listenTimeoutMs?: number;
    errorRetryDelayMs?: number;
  } = {},
) {
  const events = {
    states: [] as VoiceState[],
    transcripts: [] as Array<{ text: string; isFinal: boolean }>,
    utterances: [] as string[],
    fallbacks: [] as VoiceFallbackReason[],
    autoPauses: 0,
  };
  const session = new VoiceSession(speech, {
    language: "en",
    onStateChange: (state) => events.states.push(state),
    onTranscript: (text, isFinal) => events.transcripts.push({ text, isFinal }),
    onUserUtterance: (text) => events.utterances.push(text),
    onFallbackToChat: (reason) => events.fallbacks.push(reason),
    onAutoPause: () => (events.autoPauses += 1),
    // Immediate retries by default keep unrelated tests synchronous; the
    // backoff behaviour itself is covered with fake timers below.
    errorRetryDelayMs: 0,
    ...overrides,
  });
  return { session, events };
}

describe("VoiceSession", () => {
  let speech: FakeSpeechProvider;

  beforeEach(() => {
    speech = new FakeSpeechProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("browser support", () => {
    it("falls back to chat when recognition is unsupported", () => {
      speech.recognitionSupported = false;
      const { session, events } = createSession(speech);
      session.start();
      expect(events.fallbacks).toEqual(["unsupported"]);
      expect(session.getState()).toBe("idle");
      expect(speech.recognitions).toHaveLength(0);
    });

    it("reports support from the provider", () => {
      const { session } = createSession(speech);
      expect(session.isSupported()).toBe(true);
      speech.recognitionSupported = false;
      expect(session.isSupported()).toBe(false);
    });
  });

  describe("hands-free conversation loop", () => {
    it("runs listen → utterance → speak → listen again", () => {
      const { session, events } = createSession(speech);

      session.start();
      expect(session.getState()).toBe("listening");

      speech.current().hearFinal("I want an appointment tomorrow at 10 AM");
      expect(session.getState()).toBe("processing");
      expect(events.utterances).toEqual(["I want an appointment tomorrow at 10 AM"]);

      session.speakReply("Certainly. One moment while I check the calendar.");
      expect(session.getState()).toBe("speaking");
      expect(speech.spoken[0]?.text).toContain("Certainly");

      // The receptionist finishes speaking → automatically listening again.
      speech.spoken[0]?.onEnd?.();
      expect(session.getState()).toBe("listening");
      expect(speech.recognitions).toHaveLength(2);
    });

    it("forwards interim transcripts for live preview", () => {
      const { session, events } = createSession(speech);
      session.start();
      speech.current().hearInterim("I want an");
      speech.current().hearInterim("I want an appointment");
      expect(events.transcripts).toEqual([
        { text: "I want an", isFinal: false },
        { text: "I want an appointment", isFinal: false },
      ]);
      expect(session.getState()).toBe("listening");
    });

    it("ignores results that arrive after the session stopped", () => {
      const { session, events } = createSession(speech);
      session.start();
      const recognition = speech.current();
      session.stop();
      recognition.hearFinal("too late");
      expect(events.utterances).toEqual([]);
      expect(session.getState()).toBe("idle");
    });
  });

  describe("silence detection", () => {
    it("quietly restarts listening on the first silences", () => {
      const { session, events } = createSession(speech);
      session.start();
      speech.current().end(); // silent listen #1
      expect(session.getState()).toBe("listening");
      speech.current().end(); // silent listen #2
      expect(session.getState()).toBe("listening");
      expect(speech.recognitions).toHaveLength(3);
      expect(events.autoPauses).toBe(0);
    });

    it("pauses itself after repeated silence instead of holding the mic open", () => {
      const { session, events } = createSession(speech);
      session.start();
      speech.current().end();
      speech.current().end();
      speech.current().end(); // third silent listen — visitor walked away
      expect(session.getState()).toBe("idle");
      expect(events.autoPauses).toBe(1);
    });

    it("treats a no-speech error as silence, not a failure", () => {
      const { session, events } = createSession(speech);
      session.start();
      speech.current().fail("no-speech");
      expect(session.getState()).toBe("listening");
      expect(events.fallbacks).toEqual([]);
    });

    it("resets the silence counter once the visitor speaks", () => {
      const { session, events } = createSession(speech);
      session.start();
      speech.current().end();
      speech.current().end();
      speech.current().hearFinal("hello");
      session.speakReply("Hi there!");
      speech.spoken[0]?.onEnd?.();
      // Two more silences should NOT pause (counter restarted).
      speech.current().end();
      speech.current().end();
      expect(session.getState()).toBe("listening");
      expect(events.autoPauses).toBe(0);
    });

    it("recovers from a hung recognition via the watchdog", () => {
      vi.useFakeTimers();
      const { session, events } = createSession(speech, { listenTimeoutMs: 5000 });
      session.start();
      // The engine never fires another event; the watchdog must take over.
      vi.advanceTimersByTime(5000);
      expect(session.getState()).toBe("listening");
      expect(speech.recognitions).toHaveLength(2);
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(5000);
      expect(session.getState()).toBe("idle");
      expect(events.autoPauses).toBe(1);
    });
  });

  describe("microphone permissions and failures", () => {
    it("falls back to chat when the mic is blocked", () => {
      const { session, events } = createSession(speech);
      session.start();
      speech.current().fail("not-allowed");
      expect(events.fallbacks).toEqual(["mic-blocked"]);
      expect(session.getState()).toBe("idle");
    });

    it("falls back to chat when no microphone is available", () => {
      const { session, events } = createSession(speech);
      session.start();
      speech.current().fail("audio-capture");
      expect(events.fallbacks).toEqual(["no-mic"]);
      expect(session.getState()).toBe("idle");
    });

    it("retries transient errors before giving up", () => {
      const { session, events } = createSession(speech, { maxErrorRetries: 2 });
      session.start();
      speech.current().fail("bad-grammar");
      expect(session.getState()).toBe("listening"); // retry #1
      speech.current().fail("bad-grammar");
      expect(session.getState()).toBe("listening"); // retry #2
      speech.current().fail("bad-grammar");
      expect(session.getState()).toBe("idle");
      expect(events.fallbacks).toEqual(["failed"]);
    });

    it("waits between retries instead of burning the budget instantly", () => {
      vi.useFakeTimers();
      const { session, events } = createSession(speech, {
        maxErrorRetries: 2,
        errorRetryDelayMs: 750,
      });
      session.start();
      speech.current().fail("network");
      // Still in the voice session, but no new engine until the delay passes.
      expect(session.getState()).toBe("listening");
      expect(speech.recognitions).toHaveLength(1);
      vi.advanceTimersByTime(750);
      expect(speech.recognitions).toHaveLength(2);
      expect(events.fallbacks).toEqual([]);
    });

    it("a stale onEnd from the failed engine cannot cancel the scheduled retry", () => {
      vi.useFakeTimers();
      const { session } = createSession(speech, { errorRetryDelayMs: 750 });
      session.start();
      const failed = speech.current();
      failed.fail("network");
      failed.end(); // Chrome fires onend right after onerror
      expect(speech.recognitions).toHaveLength(1);
      vi.advanceTimersByTime(750);
      expect(speech.recognitions).toHaveLength(2);
      expect(session.getState()).toBe("listening");
    });

    it("reports a network-specific fallback when the speech service is unreachable", () => {
      const { session, events } = createSession(speech, { maxErrorRetries: 1 });
      session.start();
      speech.current().fail("network");
      speech.current().fail("network");
      expect(session.getState()).toBe("idle");
      expect(events.fallbacks).toEqual(["network"]);
    });

    it("a successful utterance resets the error budget", () => {
      const { session, events } = createSession(speech, { maxErrorRetries: 1 });
      session.start();
      speech.current().fail("network");
      speech.current().hearFinal("hi");
      session.speakReply("Hello!");
      speech.spoken[0]?.onEnd?.();
      speech.current().fail("network");
      expect(session.getState()).toBe("listening");
      expect(events.fallbacks).toEqual([]);
    });
  });

  describe("microphone pre-flight", () => {
    /** Provider variant with an explicit permission request. */
    function withMicAccess(result: "granted" | "denied" | "no-mic" | "unavailable") {
      let resolve!: (r: typeof result) => void;
      const promise = new Promise<typeof result>((r) => (resolve = r));
      speech.requestMicAccess = () => promise;
      return { resolveMic: () => resolve(result), flush: () => promise.then(() => undefined) };
    }

    it("starts listening only after permission is granted", async () => {
      const { resolveMic, flush } = withMicAccess("granted");
      const { session } = createSession(speech);
      session.start();
      expect(session.getState()).toBe("listening"); // prompt is open
      expect(speech.recognitions).toHaveLength(0); // engine not started yet
      resolveMic();
      await flush();
      expect(speech.recognitions).toHaveLength(1);
    });

    it("falls back to chat when the visitor denies the permission prompt", async () => {
      const { resolveMic, flush } = withMicAccess("denied");
      const { session, events } = createSession(speech);
      session.start();
      resolveMic();
      await flush();
      expect(events.fallbacks).toEqual(["mic-blocked"]);
      expect(session.getState()).toBe("idle");
      expect(speech.recognitions).toHaveLength(0);
    });

    it("reports a missing device from the pre-flight", async () => {
      const { resolveMic, flush } = withMicAccess("no-mic");
      const { session, events } = createSession(speech);
      session.start();
      resolveMic();
      await flush();
      expect(events.fallbacks).toEqual(["no-mic"]);
      expect(speech.recognitions).toHaveLength(0);
    });

    it("proceeds when the environment cannot answer the pre-flight", async () => {
      const { resolveMic, flush } = withMicAccess("unavailable");
      const { session } = createSession(speech);
      session.start();
      resolveMic();
      await flush();
      expect(speech.recognitions).toHaveLength(1);
    });

    it("ignores a permission grant that resolves after the session stopped", async () => {
      const { resolveMic, flush } = withMicAccess("granted");
      const { session } = createSession(speech);
      session.start();
      session.stop();
      resolveMic();
      await flush();
      expect(speech.recognitions).toHaveLength(0);
      expect(session.getState()).toBe("idle");
    });
  });

  describe("interruptions", () => {
    it("tap while speaking cancels speech and listens immediately", () => {
      const { session } = createSession(speech);
      session.start();
      speech.current().hearFinal("hello");
      session.speakReply("A long-winded reply the visitor wants to cut off…");
      expect(session.getState()).toBe("speaking");

      session.handleTap();
      expect(speech.cancelCount).toBeGreaterThan(0);
      expect(session.getState()).toBe("listening");

      // The cancelled utterance's end-callback still fires later — it must
      // not restart another listen on top of the current one.
      const before = speech.recognitions.length;
      speech.spoken[0]?.onEnd?.();
      expect(speech.recognitions).toHaveLength(before);
      expect(session.getState()).toBe("listening");
    });

    it("tap while idle starts, tap while listening stops", () => {
      const { session } = createSession(speech);
      session.handleTap();
      expect(session.getState()).toBe("listening");
      session.handleTap();
      expect(session.getState()).toBe("idle");
    });
  });

  describe("shutdown", () => {
    it("stop() cancels speech, stops recognition and returns to idle", () => {
      const { session } = createSession(speech);
      session.start();
      const recognition = speech.current();
      session.stop();
      expect(recognition.stopped).toBe(true);
      expect(speech.cancelCount).toBe(1);
      expect(session.getState()).toBe("idle");
    });

    it("speakReply after stop is a no-op", () => {
      const { session } = createSession(speech);
      session.start();
      speech.current().hearFinal("hello");
      session.stop();
      session.speakReply("should not be spoken");
      expect(speech.spoken).toHaveLength(0);
      expect(session.getState()).toBe("idle");
    });

    it("a stale onEnd from a stopped recognition never revives the loop", () => {
      const { session, events } = createSession(speech);
      session.start();
      const recognition = speech.current();
      session.stop();
      recognition.end();
      recognition.fail("aborted");
      expect(session.getState()).toBe("idle");
      expect(speech.recognitions).toHaveLength(1);
      expect(events.fallbacks).toEqual([]);
    });
  });
});
