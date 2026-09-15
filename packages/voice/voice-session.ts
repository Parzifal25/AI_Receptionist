import type {
  CallEndReason,
  CallEventType,
  CallTranscriptTurn,
  TranscriptDelivery,
} from "@halo/core/domain/voice";
import type { AudioFormat, SttEvent, SttStream, StreamingSttProvider } from "@halo/ports/streaming-stt-provider";
import type { StreamingTtsProvider } from "@halo/ports/streaming-tts-provider";
import { audioDurationMs, BoundedAudioQueue, mulawToPcm16, pcm16ToMulaw } from "./audio";
import { DEFAULT_ENDPOINTER_CONFIG, Endpointer, type EndpointerConfig } from "./endpointer";
import { chunkForSpeech } from "./sentence-chunker";
import { isTurnCancelled, type VoiceDirective, type VoiceTurnHandler, type VoiceTurnResult } from "./turn-handler";

/**
 * HALO Phase 3 — server-side voice session state machine (plan §P5.1, §P5.6).
 *
 * The seed is `widget/src/voice-session.ts` (generation counters that
 * invalidate stale async callbacks, silence budget, watchdog, fatal vs
 * transient errors). What changes on the phone: the session is FULL DUPLEX
 * (caller audio keeps flowing to STT and the endpointer while the agent
 * speaks), so true barge-in is possible.
 *
 *   idle ─start─▶ speaking(greeting) ─▶ listening ⇄ user_speaking ─endpoint+final─▶ thinking
 *                     ▲                    │                                         │
 *                     │                    └─silence─▶ speaking(reprompt)            ▼
 *                     └───────────────────────────────────────────────────────── speaking(reply)
 *   barge-in: speaking ─caller speech─▶ user_speaking  (TTS aborted, provider buffer cleared)
 *             thinking ─caller speech─▶ user_speaking  (turn aborted; utterances merged if uncommitted)
 *   any ─end()─▶ ending ─▶ ended
 *
 * Guarantees:
 *   - turns are strictly serialized: a new turn never starts until the
 *     previous handler call has settled, so runtime state stays consistent;
 *   - every async continuation checks a generation, so a cancelled TTS
 *     stream, an aborted turn or a late STT event can never drive a newer
 *     phase;
 *   - `interrupt()` and `end()` are idempotent;
 *   - every buffer, retry and loop is bounded by `VoiceSessionConfig`;
 *   - failure never produces a success narration: the session only ever
 *     speaks handler replies or deterministic policy prompts.
 */

export type VoiceSessionState = "idle" | "listening" | "user_speaking" | "thinking" | "speaking" | "ending" | "ended";

export interface VoicePrompts {
  /** Opening line: identity + AI disclosure (spoken before any data is collected). */
  greeting: string;
  /** Spoken after a silence timeout. */
  reprompt: string;
  /** Spoken before a policy-initiated hang-up. */
  goodbye: string;
  /** Spoken when a turn failed (caller should repeat). */
  turnFailure: string;
  /** Spoken when a requested transfer could not be completed. */
  transferFailed: string;
  /** Spoken immediately before bridging the caller to a human. */
  transferAnnounce: string;
}

export interface VoiceSessionConfig {
  language: string;
  alternativeLanguages: string[];
  phraseHints: string[];
  voiceId?: string;
  speakingRate?: number;
  prompts: VoicePrompts;
  endpointer: EndpointerConfig;
  bargeIn: { enabled: boolean; minSpeechMs: number };
  silence: { timeoutMs: number; maxReprompts: number };
  /** A final after speech ended but before any endpoint signal commits after this grace. */
  finalCommitGraceMs: number;
  /** After an endpoint with no final yet, wait this long for STT before treating it as noise. */
  finalWaitMs: number;
  turnTimeoutMs: number;
  maxConsecutiveTurnFailures: number;
  maxUtteranceChars: number;
  maxCallDurationMs: number;
  maxTranscriptTurns: number;
  /** Audio buffered while STT reconnects. */
  maxReconnectBufferBytes: number;
  maxSttReconnects: number;
  /** Extra wait for a playback mark beyond the audio's own duration. */
  markGraceMs: number;
}

export const DEFAULT_VOICE_SESSION_CONFIG: Omit<VoiceSessionConfig, "language" | "prompts"> = Object.freeze({
  alternativeLanguages: [],
  phraseHints: [],
  endpointer: DEFAULT_ENDPOINTER_CONFIG,
  bargeIn: { enabled: true, minSpeechMs: 250 },
  silence: { timeoutMs: 8_000, maxReprompts: 2 },
  finalCommitGraceMs: 400,
  finalWaitMs: 1_500,
  turnTimeoutMs: 15_000,
  maxConsecutiveTurnFailures: 2,
  maxUtteranceChars: 1_000,
  maxCallDurationMs: 15 * 60_000,
  maxTranscriptTurns: 400,
  maxReconnectBufferBytes: 16_000,
  maxSttReconnects: 1,
  markGraceMs: 1_500,
});

/** Where synthesized audio goes (the provider media socket, via its codec). */
export interface VoiceOutput {
  readonly format: AudioFormat;
  readonly supportsMarks: boolean;
  sendAudio(audio: Uint8Array): void;
  clear(): void;
  mark(name: string): void;
}

export interface VoiceSessionEvent {
  type: CallEventType;
  at: string;
  latencyMs: number | null;
  /** Tenant-safe: counts, codes, durations. Never transcript text. */
  detail: Record<string, string | number | boolean | null>;
}

export interface VoiceSessionSummary {
  endReason: CallEndReason;
  transcript: CallTranscriptTurn[];
  turns: number;
  bargeIns: number;
  inboundAudioMs: number;
  outboundAudioMs: number;
  ttsCharacters: number;
  modelCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  /** A transfer was requested by the conversation (whether or not it succeeded). */
  transferRequested: boolean;
  transferred: boolean;
  lastDirective: VoiceDirective["kind"] | null;
  consecutiveLowConfidence: number;
}

export interface VoiceSessionHooks {
  onEvent(event: VoiceSessionEvent): void;
  onStateChange?(state: VoiceSessionState): void;
  /** Perform the provider transfer. Resolve true only when the provider accepted it. */
  onTransferRequested(reason: string): Promise<boolean>;
  /** Called once, after cleanup, with the final summary. */
  onEnded(summary: VoiceSessionSummary): void;
}

export interface VoiceSessionDeps {
  stt: StreamingSttProvider;
  tts: StreamingTtsProvider;
  turns: VoiceTurnHandler;
  output: VoiceOutput;
  /** Format of audio passed to receiveAudio (the media codec's format). */
  inputFormat: AudioFormat;
  hooks: VoiceSessionHooks;
  config: VoiceSessionConfig;
  now?: () => number;
}

/** How long an aborted handler may keep running before the session stops waiting for it. */
const ABANDON_GRACE_MS = 1_000;

class TurnAbandonedError extends Error {
  constructor() {
    super("voice turn handler did not settle after abort");
    this.name = "TurnAbandonedError";
  }
}

interface PendingFinal {
  utteranceId: string;
  text: string;
  confidence: number | null;
  language: string | null;
}

interface Playback {
  generation: number;
  controller: AbortController;
  kind: "reply" | "policy";
  turnId: string | null;
  text: string;
  chunks: string[];
  /** Cumulative audio end (ms) per chunk index, for time-based delivery estimation. */
  chunkEndMs: number[];
  audioMs: number;
  acked: number;
  firstAudioAt: number | null;
  startedAt: number;
  synthesisDone: boolean;
  settled: boolean;
  directive: VoiceDirective;
  resolveDone: () => void;
}

export class VoiceSession {
  private state: VoiceSessionState = "idle";
  private readonly now: () => number;
  private readonly config: VoiceSessionConfig;
  private readonly endpointer: Endpointer;

  private sttStream: SttStream | null = null;
  private sttGeneration = 0;
  private sttReconnects = 0;
  private sttReconnecting = false;
  private readonly reconnectBuffer: BoundedAudioQueue;
  private sttAcceptsMulaw = false;

  private finals: PendingFinal[] = [];
  private readonly seenUtteranceIds = new Set<string>();
  private speechEndedAt: number | null = null;
  private speechStartedAt: number | null = null;
  private finalWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private finalGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackWatchdog: ReturnType<typeof setTimeout> | null = null;

  private turnGeneration = 0;
  private turnController: AbortController | null = null;
  private turnInFlight: Promise<void> | null = null;
  private supersededUtterance = "";
  private turnIndex = 0;
  private consecutiveFailures = 0;
  private consecutiveLowConfidence = 0;

  private playGeneration = 0;
  private playback: Playback | null = null;

  private silentReprompts = 0;
  private transcript: CallTranscriptTurn[] = [];
  private transcriptOverflow = 0;
  private bargeIns = 0;
  private inboundAudioMs = 0;
  private outboundAudioMs = 0;
  private ttsCharacters = 0;
  private modelCalls = 0;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private transferRequested = false;
  private transferred = false;
  private lastDirective: VoiceDirective["kind"] | null = null;
  private endPromise: Promise<VoiceSessionSummary> | null = null;

  constructor(private readonly deps: VoiceSessionDeps) {
    this.now = deps.now ?? Date.now;
    this.config = deps.config;
    this.endpointer = new Endpointer({ ...deps.config.endpointer, sampleRate: deps.inputFormat.sampleRate });
    this.reconnectBuffer = new BoundedAudioQueue(deps.config.maxReconnectBufferBytes);
    if (deps.inputFormat.sampleRate !== deps.output.format.sampleRate) {
      throw new Error("voice session: input and output sample rates must match (no resampling)");
    }
  }

  getState(): VoiceSessionState {
    return this.state;
  }

  /** Open STT, arm the call-duration ceiling and speak the greeting. */
  start(): void {
    if (this.state !== "idle") return;
    const sttCaps = this.deps.stt.capabilities();
    this.sttAcceptsMulaw = sttCaps.formats.some(
      (f) => f.encoding === "mulaw" && f.sampleRate === this.deps.inputFormat.sampleRate,
    );
    this.openStt();
    this.maxDurationTimer = setTimeout(() => {
      void this.speakPolicyThenEnd(this.config.prompts.goodbye, "max_duration");
    }, this.config.maxCallDurationMs);
    this.emit("session_started", null, { language: this.config.language, stt: this.deps.stt.name, tts: this.deps.tts.name });
    void this.play({ kind: "policy", text: this.config.prompts.greeting, turnId: null, directive: { kind: "continue" } });
  }

  // ---------------------------------------------------------------------------
  // Inbound media
  // ---------------------------------------------------------------------------

  /** Caller audio in `inputFormat`. Safe to call in any state. */
  receiveAudio(audio: Uint8Array): void {
    if (this.state === "idle" || this.state === "ended" || audio.length === 0) return;
    const encoding = this.deps.inputFormat.encoding;
    this.inboundAudioMs += audioDurationMs(audio.length, encoding, this.deps.inputFormat.sampleRate);
    const pcm = encoding === "mulaw" ? mulawToPcm16(audio) : audio;
    const forStt = encoding === "mulaw" && this.sttAcceptsMulaw ? audio : pcm;

    if (this.sttReconnecting || !this.sttStream) this.reconnectBuffer.push(forStt);
    else this.sttStream.write(forStt);

    if (this.state === "ending") return;
    const signal = this.endpointer.push(pcm);
    if (signal?.type === "speech_start") this.onSpeechStart();
    else if (signal?.type === "speech_end") this.onSpeechEnd("local_vad");

    if (this.endpointer.inSpeech) this.maybeBargeIn();
  }

  /** A playback mark we sent was reached by the provider. */
  receiveMark(name: string): void {
    const playback = this.playback;
    if (!playback) return;
    const [gen, index] = name.split(":").map(Number);
    if (gen !== playback.generation || !Number.isInteger(index)) return;
    playback.acked = Math.max(playback.acked, index + 1);
    if (playback.synthesisDone && playback.acked >= playback.chunks.length) this.finishPlayback(playback, "complete");
  }

  receiveDtmf(digit: string): void {
    if (this.state === "ended") return;
    this.emit("dtmf", null, { digit: /^[0-9*#A-D]$/.test(digit) ? digit : "?" });
  }

  /**
   * Barge-in entry point for explicit interruption (e.g. an operator or a
   * provider-side speech event). Idempotent: returns false when there is
   * nothing to interrupt.
   */
  interrupt(reason = "external"): boolean {
    if (this.state === "speaking" && this.playback && !this.playback.settled) {
      this.cutPlayback(reason);
      return true;
    }
    if (this.state === "thinking" && this.turnController && !this.turnController.signal.aborted) {
      this.bargeIns += 1;
      this.turnController.abort();
      this.emit("barge_in", null, { during: "thinking", reason });
      this.setState("user_speaking");
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // STT
  // ---------------------------------------------------------------------------

  private openStt(): void {
    const generation = ++this.sttGeneration;
    const format: AudioFormat = this.sttAcceptsMulaw
      ? this.deps.inputFormat
      : { encoding: "pcm16le", sampleRate: this.deps.inputFormat.sampleRate, channels: 1 };
    this.sttStream = this.deps.stt.open(
      {
        language: this.config.language,
        alternativeLanguages: this.config.alternativeLanguages,
        format,
        interimResults: true,
        phraseHints: this.config.phraseHints.slice(0, 50),
      },
      (event) => {
        if (generation !== this.sttGeneration || this.state === "ended") return;
        this.onSttEvent(event);
      },
    );
    this.sttReconnecting = false;
    for (const chunk of this.reconnectBuffer.drain()) this.sttStream.write(chunk);
  }

  private onSttEvent(event: SttEvent): void {
    switch (event.type) {
      case "speech_started":
        this.emit("speech_started", null, { source: "stt" });
        return;
      case "partial":
        this.emit("stt_partial", null, { chars: event.text.length });
        if (event.text.trim()) this.maybeBargeIn(true);
        return;
      case "final": {
        if (this.seenUtteranceIds.has(event.utteranceId)) return;
        this.seenUtteranceIds.add(event.utteranceId);
        if (this.seenUtteranceIds.size > 1_000) this.seenUtteranceIds.clear();
        const text = event.text.trim();
        const latency = this.speechEndedAt !== null ? Math.max(0, this.now() - this.speechEndedAt) : null;
        this.emit("stt_final", latency, {
          chars: text.length,
          confidence: event.confidence,
          language: event.language,
        });
        if (!text || this.state === "ending") return;
        this.finals.push({ utteranceId: event.utteranceId, text, confidence: event.confidence, language: event.language });
        this.onFinal();
        return;
      }
      case "endpoint":
        this.onSpeechEnd("stt");
        return;
      case "error":
        this.emit("provider_error", null, { component: "stt", code: event.code, retryable: event.retryable });
        this.onSttFailure(event.retryable);
        return;
      case "closed":
        if (this.state !== "ending") this.onSttFailure(true);
        return;
    }
  }

  private onSttFailure(retryable: boolean): void {
    if (this.state === "ending" || this.state === "ended" || this.sttReconnecting) return;
    const stale = this.sttStream;
    this.sttStream = null;
    this.sttGeneration++;
    void stale?.close().catch(() => {});
    if (retryable && this.sttReconnects < this.config.maxSttReconnects) {
      this.sttReconnects += 1;
      this.sttReconnecting = true;
      this.emit("media_reconnected", null, { component: "stt", attempt: this.sttReconnects });
      this.openStt();
      return;
    }
    void this.speakPolicyThenEnd(this.config.prompts.goodbye, "stt_failure");
  }

  // ---------------------------------------------------------------------------
  // Endpointing + utterance assembly
  // ---------------------------------------------------------------------------

  private onSpeechStart(): void {
    this.speechStartedAt = this.now();
    this.clearTimer("silenceTimer");
    this.clearTimer("finalGraceTimer");
    this.emit("speech_started", null, { source: "local_vad" });
    if (this.state === "listening") this.setState("user_speaking");
  }

  private onSpeechEnd(source: "local_vad" | "stt"): void {
    if (this.state !== "user_speaking" && this.state !== "listening") return;
    this.speechEndedAt = this.now();
    this.emit("endpoint", source === "local_vad" ? this.config.endpointer.endHangoverMs : null, { source });
    this.sttStream?.finalize();
    if (this.finals.length > 0) {
      this.commitUtterance();
      return;
    }
    this.clearTimer("finalWaitTimer");
    this.finalWaitTimer = setTimeout(() => {
      this.finalWaitTimer = null;
      if (this.finals.length > 0) this.commitUtterance();
      else if (this.state === "user_speaking") {
        // Speech with no transcript: noise, a cough, or unintelligible audio.
        this.setState("listening");
        this.armSilence();
      }
    }, this.config.finalWaitMs);
  }

  private onFinal(): void {
    if (this.state === "thinking" || this.state === "speaking") {
      // Held until the current reply/turn settles (barge-in handles cut-in).
      return;
    }
    if (this.finalWaitTimer) {
      this.clearTimer("finalWaitTimer");
      this.commitUtterance();
      return;
    }
    if (!this.endpointer.inSpeech) {
      // Local VAD may have missed quiet speech: commit after a short grace
      // unless the caller starts talking again.
      this.clearTimer("finalGraceTimer");
      this.finalGraceTimer = setTimeout(() => {
        this.finalGraceTimer = null;
        if (!this.endpointer.inSpeech && this.finals.length > 0) {
          this.speechEndedAt ??= this.now();
          this.commitUtterance();
        }
      }, this.config.finalCommitGraceMs);
    }
  }

  private commitUtterance(): void {
    if (this.state === "ending" || this.state === "ended") return;
    if (this.turnInFlight) return; // committed when the in-flight turn settles
    const finals = this.finals;
    this.finals = [];
    this.clearTimer("finalGraceTimer");
    this.clearTimer("finalWaitTimer");
    let utterance = [this.supersededUtterance, ...finals.map((f) => f.text)].filter(Boolean).join(" ").trim();
    this.supersededUtterance = "";
    if (!utterance) {
      this.setState("listening");
      this.armSilence();
      return;
    }
    if (utterance.length > this.config.maxUtteranceChars) utterance = utterance.slice(0, this.config.maxUtteranceChars);
    const confidences = finals.map((f) => f.confidence).filter((c): c is number => c !== null);
    const confidence = confidences.length > 0 ? Math.min(...confidences) : null;
    const language = finals.find((f) => f.language)?.language ?? null;
    const startedAt = this.speechStartedAt ?? this.speechEndedAt ?? this.now();
    const endedAt = this.speechEndedAt ?? this.now();
    this.silentReprompts = 0;
    this.pushTranscript({
      turnIndex: this.turnIndex,
      speaker: "caller",
      text: utterance,
      delivery: "complete",
      language,
      sttConfidence: confidence,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      turnId: null,
      source: "caller",
    });
    this.runTurn(utterance, language, confidence, endedAt);
  }

  // ---------------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------------

  private runTurn(utterance: string, language: string | null, confidence: number | null, speechEndedAt: number): void {
    const generation = ++this.turnGeneration;
    const controller = new AbortController();
    this.turnController = controller;
    const turnIndex = this.turnIndex++;
    this.setState("thinking");
    const startedAt = this.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.turnTimeoutMs);

    // A handler that ignores its abort signal must not wedge the session:
    // shortly after an abort the turn is treated as settled regardless.
    let abandonTimer: ReturnType<typeof setTimeout> | null = null;
    const abandoned = new Promise<never>((_, reject) => {
      const onAbort = () => {
        abandonTimer = setTimeout(() => reject(new TurnAbandonedError()), ABANDON_GRACE_MS);
      };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    abandoned.catch(() => {});

    const run = (async () => {
      let result: VoiceTurnResult | null = null;
      let failure: unknown = null;
      try {
        result = await Promise.race([
          this.deps.turns.handleTurn({ utterance, language, sttConfidence: confidence, turnIndex, signal: controller.signal }),
          abandoned,
        ]);
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timeout);
        if (abandonTimer) clearTimeout(abandonTimer);
      }
      if (this.turnController === controller) this.turnController = null;
      return { result, failure };
    })();

    const tracked = run.then(({ result, failure }) => {
      if (this.turnInFlight === tracked) this.turnInFlight = null;
      // Follow-ups (speaking, ending) are deliberately NOT awaited inside the
      // tracked turn: `end()` awaits the in-flight turn, so awaiting them
      // here would be circular.
      this.afterTurn({ result, failure, generation, controller, timedOut, turnIndex, startedAt, confidence, speechEndedAt, utterance });
    });
    this.turnInFlight = tracked;
  }

  private afterTurn(params: {
    result: VoiceTurnResult | null;
    failure: unknown;
    generation: number;
    controller: AbortController;
    timedOut: boolean;
    turnIndex: number;
    startedAt: number;
    confidence: number | null;
    speechEndedAt: number;
    utterance: string;
  }): void {
    const { result, failure, generation, controller, timedOut, turnIndex, startedAt } = params;
    if (result) {
      this.modelCalls += result.usage.modelCalls;
      if (result.usage.inputTokens !== undefined) this.inputTokens = (this.inputTokens ?? 0) + result.usage.inputTokens;
      if (result.usage.outputTokens !== undefined) this.outputTokens = (this.outputTokens ?? 0) + result.usage.outputTokens;
    }
    const current = generation === this.turnGeneration && !controller.signal.aborted && this.state === "thinking";

    if (result && current) {
      this.consecutiveFailures = 0;
      this.emit("agent_turn", this.now() - startedAt, {
        turnIndex,
        replyChars: result.reply.length,
        directive: result.directive.kind,
        degraded: result.degraded,
        modelCalls: result.usage.modelCalls,
      });
      this.lastDirective = result.directive.kind;
      this.trackConfidence(params.confidence);
      void this.play({
        kind: "reply",
        text: result.reply,
        turnId: result.turnId,
        directive: result.directive,
        speechEndedAt: params.speechEndedAt,
      });
      return;
    }

    if (result) {
      // Committed by the runtime but never spoken (superseded or timed out).
      this.pushAgentTranscript(result.reply, "", "not_delivered", result.turnId, "runtime", startedAt);
      void this.safeRecordDelivery(result.turnId, "not_delivered", "");
    }

    if (!timedOut && (result || isTurnCancelled(failure) || failure instanceof TurnAbandonedError) && controller.signal.aborted) {
      this.emit("turn_cancelled", this.now() - startedAt, { turnIndex, committed: result !== null });
      // Nothing committed: the caller's next words extend this utterance.
      if (!result && this.state !== "ending" && this.state !== "ended") this.supersededUtterance = params.utterance;
      this.resumeListening();
      return;
    }

    // Genuine failure or timeout.
    this.consecutiveFailures += 1;
    this.emit("provider_error", this.now() - startedAt, {
      component: "agent",
      code: timedOut ? "timeout" : failure instanceof Error ? failure.name : "unknown",
      consecutive: this.consecutiveFailures,
    });
    if (this.state === "ending" || this.state === "ended") return;
    if (this.consecutiveFailures >= this.config.maxConsecutiveTurnFailures) {
      void this.speakPolicyThenEnd(this.config.prompts.goodbye, "agent_failure");
      return;
    }
    if (this.state === "thinking") {
      void this.play({ kind: "policy", text: this.config.prompts.turnFailure, turnId: null, directive: { kind: "continue" } });
    } else {
      this.resumeListening();
    }
  }

  /** After a turn settles without speaking: pick up caller words that arrived meanwhile. */
  private resumeListening(): void {
    if (this.state !== "listening" && this.state !== "user_speaking") return;
    if (this.finals.length > 0 && !this.endpointer.inSpeech) {
      this.speechEndedAt ??= this.now();
      this.commitUtterance();
    } else if (this.state === "listening") {
      this.armSilence();
    }
  }

  private trackConfidence(confidence: number | null): void {
    if (confidence === null) return;
    this.consecutiveLowConfidence = confidence < 0.5 ? this.consecutiveLowConfidence + 1 : 0;
  }

  // ---------------------------------------------------------------------------
  // Playback (TTS → output), barge-in
  // ---------------------------------------------------------------------------

  private async play(params: {
    kind: "reply" | "policy";
    text: string;
    turnId: string | null;
    directive: VoiceDirective;
    speechEndedAt?: number;
  }): Promise<void> {
    if (this.state === "ended") return;
    const chunks = chunkForSpeech(params.text);
    if (chunks.length === 0) {
      if (params.turnId) await this.safeRecordDelivery(params.turnId, "complete", "");
      await this.afterPlayback(params.directive);
      return;
    }
    this.clearTimer("silenceTimer");
    if (this.state !== "ending") this.setState("speaking");
    const generation = ++this.playGeneration;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const playback: Playback = {
      generation,
      controller: new AbortController(),
      kind: params.kind,
      turnId: params.turnId,
      text: params.text,
      chunks,
      chunkEndMs: [],
      audioMs: 0,
      acked: 0,
      firstAudioAt: null,
      startedAt: this.now(),
      synthesisDone: false,
      settled: false,
      directive: params.directive,
      resolveDone,
    };
    this.playback = playback;
    const outFormat = this.deps.output.format;
    const ttsCaps = this.deps.tts.capabilities();
    const ttsFormat: AudioFormat = ttsCaps.formats.some(
      (f) => f.encoding === outFormat.encoding && f.sampleRate === outFormat.sampleRate,
    )
      ? outFormat
      : { encoding: "pcm16le", sampleRate: outFormat.sampleRate, channels: 1 };
    this.emit("tts_start", null, { chunks: chunks.length, chars: params.text.length, kind: params.kind });

    void (async () => {
      try {
        for (let index = 0; index < chunks.length; index++) {
          if (playback.controller.signal.aborted) return;
          this.ttsCharacters += chunks[index].length;
          let attempt = 0;
          for (;;) {
            try {
              for await (const audio of this.deps.tts.synthesize(
                {
                  text: chunks[index],
                  language: this.config.language,
                  voiceId: this.config.voiceId,
                  speakingRate: this.config.speakingRate,
                  format: ttsFormat,
                },
                playback.controller.signal,
              )) {
                if (playback.controller.signal.aborted || playback.settled) return;
                const wire = ttsFormat.encoding === outFormat.encoding ? audio : pcm16ToMulaw(audio);
                if (wire.length === 0) continue;
                if (playback.firstAudioAt === null) {
                  playback.firstAudioAt = this.now();
                  this.emit("tts_first_byte", playback.firstAudioAt - playback.startedAt, { kind: params.kind });
                  if (params.speechEndedAt !== undefined) {
                    this.emit("turn_complete", playback.firstAudioAt - params.speechEndedAt, { stage: "speech_end_to_first_audio" });
                  }
                }
                const ms = audioDurationMs(wire.length, outFormat.encoding, outFormat.sampleRate);
                playback.audioMs += ms;
                this.outboundAudioMs += ms;
                this.deps.output.sendAudio(wire);
              }
              break;
            } catch (error) {
              if (playback.controller.signal.aborted) return;
              const retryable = (error as { retryable?: unknown }).retryable === true;
              this.emit("provider_error", null, {
                component: "tts",
                code: String((error as { code?: unknown }).code ?? "unknown"),
                retryable,
                attempt,
              });
              if (retryable && attempt < 1 && playback.firstAudioAt === null) {
                attempt += 1;
                continue;
              }
              throw error;
            }
          }
          playback.chunkEndMs[index] = playback.audioMs;
          if (this.deps.output.supportsMarks) this.deps.output.mark(`${generation}:${index}`);
        }
        playback.synthesisDone = true;
        if (playback.settled) return;
        if (this.deps.output.supportsMarks) {
          if (playback.acked >= chunks.length) this.finishPlayback(playback, "complete");
          else this.armPlaybackWatchdog(playback);
        } else {
          this.armPlaybackWatchdog(playback);
        }
      } catch {
        if (playback.settled) return;
        playback.controller.abort();
        this.settlePlayback(playback, "not_delivered");
        this.emit("tts_cancel", null, { reason: "tts_failure" });
        void this.speakPolicyThenEnd(null, "tts_failure");
      }
    })();

    await done;
  }

  private armPlaybackWatchdog(playback: Playback): void {
    const played = playback.firstAudioAt === null ? 0 : this.now() - playback.firstAudioAt;
    const remaining = Math.max(0, playback.audioMs - played);
    const wait = remaining + (this.deps.output.supportsMarks ? this.config.markGraceMs : 0);
    this.clearTimer("playbackWatchdog");
    this.playbackWatchdog = setTimeout(() => {
      this.playbackWatchdog = null;
      if (!playback.settled) this.finishPlayback(playback, "complete");
    }, wait);
  }

  private finishPlayback(playback: Playback, status: "complete"): void {
    if (playback.settled) return;
    this.clearTimer("playbackWatchdog");
    this.emit("tts_complete", this.now() - playback.startedAt, { kind: playback.kind, audioMs: Math.round(playback.audioMs) });
    this.settlePlayback(playback, status);
    playback.resolveDone();
    void this.afterPlayback(playback.directive);
  }

  /** Records delivery + transcript for a playback exactly once. */
  private settlePlayback(playback: Playback, status: TranscriptDelivery): void {
    if (playback.settled) return;
    playback.settled = true;
    if (this.playback === playback) this.playback = null;
    const heardChunks = status === "complete" ? playback.chunks.length : this.heardChunkCount(playback);
    const deliveredText = playback.chunks.slice(0, heardChunks).join(" ");
    const delivery: TranscriptDelivery =
      status === "complete" ? "complete" : heardChunks === 0 ? "not_delivered" : "interrupted";
    this.pushAgentTranscript(
      playback.text,
      deliveredText,
      delivery,
      playback.turnId,
      playback.kind === "reply" ? "runtime" : "voice_policy",
      playback.startedAt,
    );
    if (playback.turnId) void this.safeRecordDelivery(playback.turnId, delivery, deliveredText);
    if (status !== "complete") playback.resolveDone();
  }

  private heardChunkCount(playback: Playback): number {
    if (this.deps.output.supportsMarks) return Math.min(playback.acked, playback.chunks.length);
    if (playback.firstAudioAt === null) return 0;
    const played = this.now() - playback.firstAudioAt;
    let heard = 0;
    for (let i = 0; i < playback.chunkEndMs.length; i++) if (playback.chunkEndMs[i] <= played) heard = i + 1;
    return heard;
  }

  private maybeBargeIn(fromTranscript = false): void {
    if (!this.config.bargeIn.enabled || this.state === "ending") return;
    const sustained = this.endpointer.currentSpeechMs >= this.config.bargeIn.minSpeechMs;
    if (!sustained && !(fromTranscript && this.endpointer.inSpeech)) return;
    if (this.state === "speaking" && this.playback && !this.playback.settled) {
      this.cutPlayback("caller_speech");
    } else if (this.state === "thinking") {
      this.interrupt("caller_speech");
    }
  }

  private cutPlayback(reason: string): void {
    const playback = this.playback;
    if (!playback || playback.settled) return;
    const detectedAt = this.now();
    this.bargeIns += 1;
    playback.controller.abort();
    this.deps.output.clear();
    this.clearTimer("playbackWatchdog");
    this.emit("barge_in", null, { during: "speaking", reason, kind: playback.kind });
    this.settlePlayback(playback, "interrupted");
    this.emit("tts_cancel", this.now() - detectedAt, { reason });
    this.silentReprompts = 0;
    this.speechStartedAt = detectedAt;
    this.setState(this.endpointer.inSpeech ? "user_speaking" : "listening");
    if (this.state === "listening") this.armSilence();
  }

  private async afterPlayback(directive: VoiceDirective): Promise<void> {
    if (this.state === "ended") return;
    if (this.state === "ending") return;
    if (directive.kind === "end_call") {
      await this.end("agent_completed");
      return;
    }
    if (directive.kind === "transfer") {
      this.transferRequested = true;
      // Deterministic, honest announcement: the caller always hears that a
      // transfer is being attempted, whatever the model's reply said.
      await this.play({ kind: "policy", text: this.config.prompts.transferAnnounce, turnId: null, directive: { kind: "continue" } });
      // State may have moved while the announcement played (hang-up, barge-in end).
      if (this.isClosing()) return;
      let ok = false;
      try {
        ok = await this.deps.hooks.onTransferRequested(directive.reason);
      } catch {
        ok = false;
      }
      this.emit("transfer", null, { ok, reason: directive.reason.slice(0, 64) });
      if (ok) {
        this.transferred = true;
        await this.end("transferred");
        return;
      }
      await this.play({ kind: "policy", text: this.config.prompts.transferFailed, turnId: null, directive: { kind: "continue" } });
      return;
    }
    this.setState(this.endpointer.inSpeech ? "user_speaking" : "listening");
    if (this.finals.length > 0 && !this.endpointer.inSpeech && !this.turnInFlight) {
      this.speechEndedAt ??= this.now();
      this.commitUtterance();
      return;
    }
    if (this.state === "listening") this.armSilence();
  }

  private armSilence(): void {
    this.clearTimer("silenceTimer");
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.state !== "listening") return;
      this.silentReprompts += 1;
      this.emit("silence", this.config.silence.timeoutMs, { reprompt: this.silentReprompts });
      if (this.silentReprompts > this.config.silence.maxReprompts) {
        void this.speakPolicyThenEnd(this.config.prompts.goodbye, "silence_timeout");
        return;
      }
      void this.play({ kind: "policy", text: this.config.prompts.reprompt, turnId: null, directive: { kind: "continue" } });
    }, this.config.silence.timeoutMs);
  }

  private async speakPolicyThenEnd(text: string | null, reason: CallEndReason): Promise<void> {
    if (this.state === "ending" || this.state === "ended") return;
    this.turnController?.abort();
    if (this.playback && !this.playback.settled) {
      this.playback.controller.abort();
      this.deps.output.clear();
      this.settlePlayback(this.playback, "interrupted");
    }
    this.setState("ending");
    if (text && reason !== "tts_failure") {
      await this.play({ kind: "policy", text, turnId: null, directive: { kind: "continue" } });
    }
    await this.end(reason);
  }

  // ---------------------------------------------------------------------------
  // End
  // ---------------------------------------------------------------------------

  /** Tear everything down. Idempotent; resolves with the same summary every time. */
  end(reason: CallEndReason): Promise<VoiceSessionSummary> {
    if (this.endPromise) return this.endPromise;
    this.endPromise = (async () => {
      this.setState("ending");
      for (const timer of ["silenceTimer", "finalWaitTimer", "finalGraceTimer", "maxDurationTimer", "playbackWatchdog"] as const) {
        this.clearTimer(timer);
      }
      this.turnController?.abort();
      if (this.playback && !this.playback.settled) {
        this.playback.controller.abort();
        this.settlePlayback(this.playback, "interrupted");
      }
      const inFlight = this.turnInFlight;
      if (inFlight) {
        await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
      this.sttGeneration++;
      const stream = this.sttStream;
      this.sttStream = null;
      await stream?.close().catch(() => {});
      await this.deps.turns.close().catch(() => {});
      const summary: VoiceSessionSummary = {
        endReason: reason,
        transcript: this.transcript,
        turns: this.turnIndex,
        bargeIns: this.bargeIns,
        inboundAudioMs: Math.round(this.inboundAudioMs),
        outboundAudioMs: Math.round(this.outboundAudioMs),
        ttsCharacters: this.ttsCharacters,
        modelCalls: this.modelCalls,
        ...(this.inputTokens !== undefined ? { inputTokens: this.inputTokens } : {}),
        ...(this.outputTokens !== undefined ? { outputTokens: this.outputTokens } : {}),
        transferRequested: this.transferRequested,
        transferred: this.transferred,
        lastDirective: this.lastDirective,
        consecutiveLowConfidence: this.consecutiveLowConfidence,
      };
      this.emit("session_ended", null, {
        reason,
        turns: summary.turns,
        bargeIns: summary.bargeIns,
        transcriptOverflow: this.transcriptOverflow,
      });
      this.setState("ended");
      this.deps.hooks.onEnded(summary);
      return summary;
    })();
    return this.endPromise;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private async safeRecordDelivery(turnId: string, status: TranscriptDelivery, deliveredText: string): Promise<void> {
    try {
      await this.deps.turns.recordDelivery(turnId, { status, deliveredText });
    } catch {
      this.emit("provider_error", null, { component: "transcript", code: "delivery_record_failed", retryable: false });
    }
  }

  private pushAgentTranscript(
    text: string,
    deliveredText: string,
    delivery: TranscriptDelivery,
    turnId: string | null,
    source: "runtime" | "voice_policy",
    startedAt: number,
  ): void {
    this.pushTranscript({
      turnIndex: Math.max(0, this.turnIndex - (source === "runtime" ? 1 : 0)),
      speaker: "agent",
      text,
      ...(delivery === "complete" ? {} : { deliveredText }),
      delivery,
      language: this.config.language,
      sttConfidence: null,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
      turnId,
      source,
    });
  }

  private pushTranscript(turn: CallTranscriptTurn): void {
    if (this.transcript.length >= this.config.maxTranscriptTurns) {
      this.transcriptOverflow += 1;
      return;
    }
    this.transcript.push(turn);
  }

  private emit(type: CallEventType, latencyMs: number | null, detail: VoiceSessionEvent["detail"]): void {
    try {
      this.deps.hooks.onEvent({
        type,
        at: new Date(this.now()).toISOString(),
        latencyMs: latencyMs === null ? null : Math.max(0, Math.round(latencyMs)),
        detail,
      });
    } catch {
      // observability must never break the call
    }
  }

  private isClosing(): boolean {
    return this.state === "ending" || this.state === "ended";
  }

  private setState(state: VoiceSessionState): void {
    if (this.state === state || this.state === "ended") return;
    this.state = state;
    try {
      this.deps.hooks.onStateChange?.(state);
    } catch {
      // ignore
    }
  }

  private clearTimer(
    name: "silenceTimer" | "finalWaitTimer" | "finalGraceTimer" | "maxDurationTimer" | "playbackWatchdog",
  ): void {
    const timer = this[name];
    if (timer !== null) {
      clearTimeout(timer);
      this[name] = null;
    }
  }
}
