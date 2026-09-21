import type {
  CallEndReason,
  CallEventType,
  CallTranscriptTurn,
  TranscriptDelivery,
} from "@halo/core/domain/voice";
import type { VoiceMediaSession } from "../media-session";
import { chunkForSpeech } from "../sentence-chunker";
import { isTurnCancelled, type VoiceDirective, type VoiceTurnHandler, type VoiceTurnResult } from "../turn-handler";
import type {
  VoiceSessionConfig,
  VoiceSessionEvent,
  VoiceSessionHooks,
  VoiceSessionState,
  VoiceSessionSummary,
} from "../voice-session";
import type { PipecatCommand, PipecatEvent, RemoteVoiceConfig, VoiceSessionIdentity } from "./protocol";

/**
 * HALO Phase 4 — the voice session whose media loop lives in Pipecat.
 *
 * This is the SECOND implementation of the `VoiceMediaSession` seam. The
 * Phase 3 `VoiceSession` runs STT, TTS and energy VAD in this process and
 * derives everything from audio. This one derives everything from reported
 * facts: Pipecat says when the caller started and stopped speaking, what was
 * transcribed, which reply chunks actually played out, and when playback was
 * cut. HALO still decides what happens next.
 *
 * What moved to Pipecat, and why that is the right line:
 *
 *   - barge-in is CUT LOCALLY by Pipecat and REPORTED here. Asking HALO for
 *     permission would put a network round trip in the one path where
 *     milliseconds are audible. HALO learns which chunks the caller actually
 *     heard and records the truth (§P5.6), which is the part that has to be
 *     right — not the part that has to be fast.
 *   - VAD, endpointing, synthesis and audio transport are gone from here
 *     entirely; there is no audio math and no codec in this file.
 *
 * What did NOT move, and must not:
 *
 *   - turn serialization. A new turn never starts while one is in flight, so
 *     a business action can never run twice for one caller utterance.
 *   - the handoff window. `transferring` owns the session for the whole
 *     bridge, exactly as in Phase 3 (PHASE3_REPORT §5.1).
 *   - the single-playback invariant: `speak()` preempts an unsettled
 *     playback, so two lines can never be queued at the caller at once.
 *   - delivery truth, transcript rows, silence policy, failure policy and the
 *     deterministic spoken lines, all of which are tenant content HALO owns.
 *
 * Behavioural parity with `VoiceSession` is pinned by a shared conformance
 * suite (`tests/contracts/media-session-contracts.ts`) that runs the same
 * scenarios against both engines, so the two cannot drift in the behaviours
 * that matter.
 */

/** A lost `stopped` report must not wedge the call; it must not lie either. */
const DEFAULT_PLAYBACK_TIMEOUT_MS = 60_000;

/** How long an aborted handler may keep running before the turn is treated as settled. */
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

interface RemotePlayback {
  id: string;
  kind: "reply" | "policy";
  turnId: string | null;
  text: string;
  chunks: string[];
  acked: number;
  firstAudioAt: number | null;
  startedAt: number;
  settled: boolean;
  directive: VoiceDirective;
  speechEndedAt?: number;
  resolveDone: () => void;
}

/** Where control frames go. The transport owns framing; this owns meaning. */
export interface RemoteCommandSink {
  send(command: PipecatCommand): void;
}

export interface RemoteVoiceSessionDeps {
  identity: VoiceSessionIdentity;
  turns: VoiceTurnHandler;
  config: VoiceSessionConfig;
  hooks: VoiceSessionHooks;
  commands: RemoteCommandSink;
  now?: () => number;
  playbackTimeoutMs?: number;
}

export class RemoteVoiceSession implements VoiceMediaSession {
  /** Trusted, server-resolved identity for this call. Never set from a frame. */
  readonly identity: VoiceSessionIdentity;
  private state: VoiceSessionState = "idle";
  private readonly now: () => number;
  private readonly config: VoiceSessionConfig;
  private readonly playbackTimeoutMs: number;

  private finals: PendingFinal[] = [];
  private readonly seenUtteranceIds = new Set<string>();
  private supersededUtterance = "";
  private speechStartedAt: number | null = null;
  private speechEndedAt: number | null = null;
  private inSpeech = false;

  private turnIndex = 0;
  private turnGeneration = 0;
  private turnController: AbortController | null = null;
  private turnInFlight: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private consecutiveLowConfidence = 0;

  private playback: RemotePlayback | null = null;
  private playbackSeq = 0;

  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private finalWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private finalGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackWatchdog: ReturnType<typeof setTimeout> | null = null;
  private silentReprompts = 0;

  private readonly transcript: CallTranscriptTurn[] = [];
  private transcriptSeq = 0;
  private inboundAudioMs = 0;
  private outboundAudioMs = 0;
  /** Characters HALO asked to be spoken; superseded by Pipecat's own count. */
  private requestedTtsCharacters = 0;
  private reportedTtsCharacters: number | null = null;
  private modelCalls = 0;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private bargeIns = 0;
  private transferRequested = false;
  private transferred = false;
  private lastDirective: VoiceDirective["kind"] | null = null;
  private endPromise: Promise<VoiceSessionSummary> | null = null;
  private summary: VoiceSessionSummary | null = null;

  constructor(private readonly deps: RemoteVoiceSessionDeps) {
    this.identity = deps.identity;
    this.now = deps.now ?? Date.now;
    this.config = deps.config;
    this.playbackTimeoutMs = deps.playbackTimeoutMs ?? DEFAULT_PLAYBACK_TIMEOUT_MS;
  }

  getState(): VoiceSessionState {
    return this.state;
  }

  /** The media parameters Pipecat needs. Carries no tenant-authored speech. */
  remoteConfig(): RemoteVoiceConfig {
    return {
      language: this.config.language,
      alternativeLanguages: this.config.alternativeLanguages,
      phraseHints: this.config.phraseHints.slice(0, 50),
      ...(this.config.voiceId ? { voiceId: this.config.voiceId } : {}),
      ...(this.config.speakingRate ? { speakingRate: this.config.speakingRate } : {}),
      vad: { minSpeechMs: this.config.endpointer.minSpeechMs, endHangoverMs: this.config.endpointer.endHangoverMs },
      bargeIn: { ...this.config.bargeIn },
      maxCallDurationMs: this.config.maxCallDurationMs,
    };
  }

  start(): void {
    if (this.state !== "idle") return;
    this.maxDurationTimer = setTimeout(() => {
      void this.speakPolicyThenEnd(this.config.prompts.goodbye, "max_duration");
    }, this.config.maxCallDurationMs);
    this.emit("session_started", null, { language: this.config.language, engine: "pipecat" });
    this.deps.commands.send({
      type: "ready",
      protocol: "1.0",
      session: this.deps.identity,
      voice: this.remoteConfig(),
    });
    void this.speak({ kind: "policy", text: this.config.prompts.greeting, turnId: null, directive: { kind: "continue" } });
  }

  /** Audio never reaches HALO on this path. Present only to satisfy the seam. */
  receiveAudio(): void {}

  /** Playback acknowledgement arrives as a `playback` control event instead. */
  receiveMark(): void {}

  receiveDtmf(digit: string): void {
    if (this.state === "ended") return;
    this.emit("dtmf", null, { digit: /^[0-9*#A-D]$/.test(digit) ? digit : "?" });
  }

  // ---------------------------------------------------------------------------
  // Inbound control events
  // ---------------------------------------------------------------------------

  /** One validated frame from Pipecat. Safe to call in any state. */
  receiveControl(event: PipecatEvent): void {
    if (this.state === "ended") return;
    switch (event.type) {
      case "speech_started":
        return this.onSpeechStart();
      case "speech_stopped":
        return this.onSpeechEnd();
      case "transcript":
        return this.onTranscript(event);
      case "playback":
        return this.onPlayback(event);
      case "dtmf":
        return this.receiveDtmf(event.digit);
      case "usage":
        // Media accounting is Pipecat's to measure; HALO records what it is
        // told and never estimates seconds it did not observe.
        this.inboundAudioMs = Math.max(this.inboundAudioMs, event.inboundAudioMs);
        this.outboundAudioMs = Math.max(this.outboundAudioMs, event.outboundAudioMs);
        this.reportedTtsCharacters = Math.max(this.reportedTtsCharacters ?? 0, event.ttsCharacters);
        return;
      case "error":
        this.emit("provider_error", null, { component: event.component, code: event.code, retryable: event.retryable });
        if (!event.retryable) void this.speakPolicyThenEnd(null, event.component === "stt" ? "stt_failure" : "tts_failure");
        return;
      case "bye":
        void this.end(event.reason === "caller_hangup" ? "caller_hangup" : "media_disconnected");
        return;
    }
  }

  private onSpeechStart(): void {
    this.inSpeech = true;
    this.speechStartedAt = this.now();
    this.clearTimer("silenceTimer");
    this.clearTimer("finalGraceTimer");
    this.emit("speech_started", null, { source: "remote_vad" });
    if (this.state === "listening") this.setState("user_speaking");
    // Pipecat has already gated this on its own sustained-speech threshold,
    // so a reported speech start during generation IS a barge-in. Playback
    // barge-in needs no action here: Pipecat cut it and will report it.
    else if (this.state === "thinking" && this.config.bargeIn.enabled) this.interrupt("caller_speech");
  }

  private onSpeechEnd(): void {
    this.inSpeech = false;
    if (this.state !== "user_speaking" && this.state !== "listening") return;
    this.speechEndedAt = this.now();
    this.emit("endpoint", null, { source: "remote_vad" });
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

  private onTranscript(event: Extract<PipecatEvent, { type: "transcript" }>): void {
    if (!event.final) {
      this.emit("stt_partial", null, { chars: event.text.length });
      return;
    }
    const utteranceId = event.utteranceId ?? `u-${this.transcriptSeq}-${this.finals.length}-${this.now()}`;
    if (this.seenUtteranceIds.has(utteranceId)) return;
    this.seenUtteranceIds.add(utteranceId);
    if (this.seenUtteranceIds.size > 1_000) this.seenUtteranceIds.clear();
    const text = event.text.trim();
    const latency = this.speechEndedAt !== null ? Math.max(0, this.now() - this.speechEndedAt) : null;
    this.emit("stt_final", latency, { chars: text.length, confidence: event.confidence, language: event.language });
    if (!text || this.state === "ending") return;
    this.finals.push({ utteranceId, text, confidence: event.confidence, language: event.language });
    if (this.speechEndedAt !== null && !this.inSpeech) {
      this.commitUtterance();
      return;
    }
    if (!this.inSpeech) {
      // Remote VAD may not have endpointed yet: commit after a short grace
      // unless the caller starts talking again.
      this.clearTimer("finalGraceTimer");
      this.finalGraceTimer = setTimeout(() => {
        this.finalGraceTimer = null;
        if (!this.inSpeech && this.finals.length > 0) {
          this.speechEndedAt ??= this.now();
          this.commitUtterance();
        }
      }, this.config.finalCommitGraceMs);
    }
  }

  private onPlayback(event: Extract<PipecatEvent, { type: "playback" }>): void {
    const playback = this.playback;
    if (!playback || playback.id !== event.playbackId || playback.settled) return;
    if (event.phase === "first_audio") {
      if (playback.firstAudioAt !== null) return;
      playback.firstAudioAt = this.now();
      this.emit("tts_first_byte", playback.firstAudioAt - playback.startedAt, { kind: playback.kind });
      if (playback.speechEndedAt !== undefined) {
        this.emit("turn_complete", playback.firstAudioAt - playback.speechEndedAt, { stage: "speech_end_to_first_audio" });
      }
      return;
    }
    if (event.phase === "chunk_played") {
      if (event.chunkIndex === undefined) return;
      playback.acked = Math.max(playback.acked, Math.min(event.chunkIndex + 1, playback.chunks.length));
      return;
    }
    // phase === "stopped"
    this.clearTimer("playbackWatchdog");
    const reason = event.reason ?? "completed";
    if (reason === "completed") {
      this.emit("tts_complete", this.now() - playback.startedAt, {
        kind: playback.kind,
        audioMs: Math.round(event.audioMs ?? 0),
      });
      this.settlePlayback(playback, "complete");
      playback.resolveDone();
      void this.afterPlayback(playback.directive);
      return;
    }
    if (reason === "interrupted") {
      this.bargeIns += 1;
      this.emit("barge_in", null, { during: "speaking", reason: "caller_speech", kind: playback.kind });
      this.settlePlayback(playback, "interrupted");
      this.emit("tts_cancel", null, { reason: "caller_speech" });
      this.silentReprompts = 0;
      this.speechStartedAt = this.now();
      this.setState(this.inSpeech ? "user_speaking" : "listening");
      if (this.state === "listening") this.armSilence();
      return;
    }
    // reason === "failed": synthesis or transport died mid-line. The caller
    // heard at most what was acknowledged; nothing is claimed beyond that.
    this.settlePlayback(playback, "interrupted");
    this.emit("tts_cancel", null, { reason: "tts_failure" });
    void this.speakPolicyThenEnd(null, "tts_failure");
  }

  // ---------------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------------

  private commitUtterance(): void {
    if (this.state === "ending" || this.state === "ended") return;
    // Held (not dropped): resumed by afterPlayback once the handoff resolves.
    if (this.state === "transferring") return;
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
      void this.speak({
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
      void this.speak({ kind: "policy", text: this.config.prompts.turnFailure, turnId: null, directive: { kind: "continue" } });
    } else {
      this.resumeListening();
    }
  }

  private resumeListening(): void {
    if (this.state !== "listening" && this.state !== "user_speaking") return;
    if (this.finals.length > 0 && !this.inSpeech) {
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
  // Playback
  // ---------------------------------------------------------------------------

  /**
   * Hand one utterance to Pipecat. Preempts any unsettled playback so the
   * "at most one active playback" invariant is structural here too
   * (PHASE3_REPORT §5.2) — the wire has one caller on it.
   */
  private async speak(params: {
    kind: "reply" | "policy";
    text: string;
    turnId: string | null;
    directive: VoiceDirective;
    speechEndedAt?: number;
  }): Promise<void> {
    if (this.state === "ended") return;
    const active = this.playback;
    if (active && !active.settled) {
      this.deps.commands.send({ type: "stop_playback", playbackId: active.id, reason: "superseded" });
      this.clearTimer("playbackWatchdog");
      this.settlePlayback(active, "interrupted");
      this.emit("tts_cancel", null, { reason: "superseded" });
    }
    const chunks = chunkForSpeech(params.text);
    if (chunks.length === 0) {
      if (params.turnId) await this.safeRecordDelivery(params.turnId, "complete", "");
      await this.afterPlayback(params.directive);
      return;
    }
    this.clearTimer("silenceTimer");
    if (this.state !== "ending" && this.state !== "transferring") this.setState("speaking");
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const playback: RemotePlayback = {
      id: `pb-${++this.playbackSeq}`,
      kind: params.kind,
      turnId: params.turnId,
      text: params.text,
      chunks,
      acked: 0,
      firstAudioAt: null,
      startedAt: this.now(),
      settled: false,
      directive: params.directive,
      ...(params.speechEndedAt !== undefined ? { speechEndedAt: params.speechEndedAt } : {}),
      resolveDone,
    };
    this.playback = playback;
    this.requestedTtsCharacters += params.text.length;
    this.emit("tts_start", null, { chunks: chunks.length, chars: params.text.length, kind: params.kind });
    this.deps.commands.send({
      type: "speak",
      playbackId: playback.id,
      kind: params.kind,
      turnId: params.turnId,
      chunks,
      // A handoff or hang-up line must be heard in full: it is the honest
      // account of what is about to happen to the caller.
      interruptible: this.config.bargeIn.enabled && this.state !== "transferring" && this.state !== "ending",
    });
    // A lost `stopped` report must not wedge the session forever. The
    // watchdog settles with the chunks Pipecat actually acknowledged — it
    // never upgrades an unknown delivery to "complete".
    this.playbackWatchdog = setTimeout(() => {
      this.playbackWatchdog = null;
      if (playback.settled) return;
      this.emit("provider_error", null, { component: "tts", code: "playback_report_lost", retryable: false });
      this.settlePlayback(playback, "interrupted");
      void this.afterPlayback(playback.directive);
    }, this.playbackTimeoutMs);
    await done;
  }

  /** Records delivery + transcript for a playback exactly once. */
  private settlePlayback(playback: RemotePlayback, status: TranscriptDelivery): void {
    if (playback.settled) return;
    playback.settled = true;
    if (this.playback === playback) this.playback = null;
    const heardChunks = status === "complete" ? playback.chunks.length : Math.min(playback.acked, playback.chunks.length);
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

  private async afterPlayback(directive: VoiceDirective): Promise<void> {
    if (this.state === "ended" || this.state === "ending") return;
    // Re-entrancy guard: the transfer sequence plays its own policy prompts.
    if (this.state === "transferring") return;
    if (directive.kind === "end_call") {
      this.deps.commands.send({ type: "hangup", reason: "agent_completed" });
      await this.end("agent_completed");
      return;
    }
    if (directive.kind === "transfer") {
      this.transferRequested = true;
      // Claim the session for the whole handoff BEFORE any await: a turn
      // racing the bridge could execute a business action for a caller who
      // is already talking to a human (PHASE3_REPORT §5.1).
      this.setState("transferring");
      this.clearTimer("silenceTimer");
      await this.speak({ kind: "policy", text: this.config.prompts.transferAnnounce, turnId: null, directive: { kind: "continue" } });
      if (this.isClosing()) return;
      let ok = false;
      try {
        // The bridge is performed by HALO through the telephony provider,
        // against a tenant-configured number. Pipecat is never asked, and
        // never told it succeeded unless it did.
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
      if (this.isClosing()) return;
      this.setState("listening");
      await this.speak({ kind: "policy", text: this.config.prompts.transferFailed, turnId: null, directive: { kind: "continue" } });
      return;
    }
    this.setState(this.inSpeech ? "user_speaking" : "listening");
    if (this.finals.length > 0 && !this.inSpeech && !this.turnInFlight) {
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
      void this.speak({ kind: "policy", text: this.config.prompts.reprompt, turnId: null, directive: { kind: "continue" } });
    }, this.config.silence.timeoutMs);
  }

  private async speakPolicyThenEnd(text: string | null, reason: CallEndReason): Promise<void> {
    if (this.state === "ending" || this.state === "ended") return;
    this.turnController?.abort();
    // Captured first: a worker that reports the stop synchronously settles
    // this playback (and clears `this.playback`) inside `send`.
    const live = this.playback;
    if (live && !live.settled) {
      this.deps.commands.send({ type: "stop_playback", playbackId: live.id, reason: "closing" });
      this.settlePlayback(live, "interrupted");
    }
    this.setState("ending");
    if (text && reason !== "tts_failure") {
      await this.speak({ kind: "policy", text, turnId: null, directive: { kind: "continue" } });
    }
    this.deps.commands.send({ type: "hangup", reason });
    await this.end(reason);
  }

  // ---------------------------------------------------------------------------
  // Interruption / end
  // ---------------------------------------------------------------------------

  /**
   * Explicit interruption (operator action, or a remote engine that reports
   * speech before it cuts). Idempotent. Barge-in during playback is normally
   * cut by Pipecat and arrives as `playback stopped reason=interrupted`.
   */
  interrupt(reason = "external"): boolean {
    if (this.state === "speaking" && this.playback && !this.playback.settled) {
      const playback = this.playback;
      this.deps.commands.send({ type: "stop_playback", playbackId: playback.id, reason });
      this.clearTimer("playbackWatchdog");
      this.bargeIns += 1;
      this.emit("barge_in", null, { during: "speaking", reason, kind: playback.kind });
      this.settlePlayback(playback, "interrupted");
      this.emit("tts_cancel", null, { reason });
      const next = this.inSpeech ? "user_speaking" : "listening";
      this.setState(next);
      if (next === "listening") this.armSilence();
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

  /** Tear everything down. Idempotent; resolves with the same summary every time. */
  end(reason: CallEndReason): Promise<VoiceSessionSummary> {
    if (this.endPromise) return this.endPromise;
    this.endPromise = (async () => {
      this.setState("ending");
      for (const timer of ["silenceTimer", "finalWaitTimer", "finalGraceTimer", "maxDurationTimer", "playbackWatchdog"] as const) {
        this.clearTimer(timer);
      }
      this.turnController?.abort();
      const live = this.playback;
      if (live && !live.settled) {
        this.deps.commands.send({ type: "stop_playback", playbackId: live.id, reason: "session_end" });
        this.settlePlayback(live, "interrupted");
      }
      const inFlight = this.turnInFlight;
      if (inFlight) await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      // Finalization is the one path that must always reach `onEnded`.
      try {
        await this.deps.turns.close();
      } catch {
        // already tearing down
      }
      const summary: VoiceSessionSummary = {
        endReason: reason,
        transcript: this.transcript,
        turns: this.turnIndex,
        bargeIns: this.bargeIns,
        inboundAudioMs: this.inboundAudioMs,
        outboundAudioMs: this.outboundAudioMs,
        // Pipecat did the synthesis, so its count is authoritative when it
        // reported one; otherwise we report what we asked to be spoken.
        ttsCharacters: this.reportedTtsCharacters ?? this.requestedTtsCharacters,
        modelCalls: this.modelCalls,
        ...(this.inputTokens !== undefined ? { inputTokens: this.inputTokens } : {}),
        ...(this.outputTokens !== undefined ? { outputTokens: this.outputTokens } : {}),
        transferRequested: this.transferRequested,
        transferred: this.transferred,
        lastDirective: this.lastDirective,
        consecutiveLowConfidence: this.consecutiveLowConfidence,
      };
      this.summary = summary;
      this.state = "ended";
      this.emit("session_ended", null, { reason, turns: summary.turns, bargeIns: summary.bargeIns });
      this.deps.hooks.onEnded(summary);
      return summary;
    })();
    return this.endPromise;
  }

  /** The summary once the session has ended; null while it is still live. */
  finalSummary(): VoiceSessionSummary | null {
    return this.summary;
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private isClosing(): boolean {
    return this.state === "ending" || this.state === "ended";
  }

  private setState(next: VoiceSessionState): void {
    if (this.state === "ended" || this.state === next) return;
    this.state = next;
    this.deps.hooks.onStateChange?.(next);
    this.emit("state_changed", null, { state: next });
  }

  private emit(type: CallEventType, latencyMs: number | null, detail: VoiceSessionEvent["detail"]): void {
    this.deps.hooks.onEvent({ type, at: new Date(this.now()).toISOString(), latencyMs, detail });
  }

  private pushTranscript(turn: CallTranscriptTurn): void {
    if (this.transcript.length >= this.config.maxTranscriptTurns) return;
    this.transcript.push(turn);
    this.deps.hooks.onTranscriptTurn?.(turn, this.transcriptSeq++);
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
      turnIndex: this.turnIndex,
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

  private async safeRecordDelivery(turnId: string, status: TranscriptDelivery, deliveredText: string): Promise<void> {
    try {
      await this.deps.turns.recordDelivery(turnId, { status, deliveredText });
    } catch {
      // Delivery bookkeeping must never fail a live call.
    }
  }

  private clearTimer(name: "silenceTimer" | "finalWaitTimer" | "finalGraceTimer" | "maxDurationTimer" | "playbackWatchdog"): void {
    const timer = this[name];
    if (timer) {
      clearTimeout(timer);
      this[name] = null;
    }
  }
}
