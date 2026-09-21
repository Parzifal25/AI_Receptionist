import { vi } from "vitest";
import type { CallTranscriptTurn } from "@halo/core/domain/voice";
import { RemoteVoiceSession } from "@halo/voice/pipecat/remote-session";
import type { PipecatCommand, VoiceSessionIdentity } from "@halo/voice/pipecat/protocol";
import {
  DEFAULT_VOICE_SESSION_CONFIG,
  type VoiceSessionConfig,
  type VoiceSessionEvent,
  type VoiceSessionState,
  type VoiceSessionSummary,
} from "@halo/voice/voice-session";
import { ScriptedTurnHandler, TEST_PROMPTS } from "./voice-harness";

/**
 * Simulates the Pipecat worker for tests: it obeys `speak` / `stop_playback`
 * / `hangup`, plays out chunks on the fake clock, and cuts playback on caller
 * speech exactly as a real worker's interruption handling would — then
 * reports what it actually played.
 *
 * It is deliberately a little adversarial about ordering (the cut is reported
 * *after* `speech_started`), because that is the order a real worker produces
 * and the order HALO must survive.
 */
export class SimulatedPipecatWorker {
  readonly commands: PipecatCommand[] = [];
  readonly spoken: string[] = [];
  hangups = 0;
  /** Milliseconds before first audio, and per character of synthesis. */
  constructor(
    private readonly timing: { firstAudioMs: number; msPerChar: number } = { firstAudioMs: 120, msPerChar: 8 },
  ) {}

  private session: RemoteVoiceSession | null = null;
  private active: { id: string; chunks: string[]; played: number; interruptible: boolean } | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];

  bind(session: RemoteVoiceSession): void {
    this.session = session;
  }

  send(command: PipecatCommand): void {
    this.commands.push(command);
    if (command.type === "speak") {
      this.spoken.push(command.chunks.join(" "));
      this.startPlayback(command);
      return;
    }
    if (command.type === "stop_playback") {
      this.cut(command.playbackId);
      return;
    }
    if (command.type === "hangup") this.hangups += 1;
  }

  get playing(): boolean {
    return this.active !== null;
  }

  private startPlayback(command: Extract<PipecatCommand, { type: "speak" }>): void {
    this.clearTimers();
    this.active = { id: command.playbackId, chunks: command.chunks, played: 0, interruptible: command.interruptible };
    const id = command.playbackId;
    this.at(this.timing.firstAudioMs, () => this.emit({ type: "playback", playbackId: id, phase: "first_audio" }));
    let elapsed = this.timing.firstAudioMs;
    command.chunks.forEach((chunk, index) => {
      elapsed += chunk.length * this.timing.msPerChar;
      const at = elapsed;
      this.at(at, () => {
        if (!this.active || this.active.id !== id) return;
        this.active.played = index + 1;
        this.emit({ type: "playback", playbackId: id, phase: "chunk_played", chunkIndex: index });
        if (index === command.chunks.length - 1) {
          const audioMs = at;
          this.active = null;
          this.emit({ type: "playback", playbackId: id, phase: "stopped", reason: "completed", audioMs });
        }
      });
    });
  }

  /** Caller spoke over the agent: the worker cuts locally, then reports. */
  bargeIn(): void {
    if (!this.active || !this.active.interruptible) return;
    this.cut(this.active.id);
  }

  private cut(playbackId: string): void {
    if (!this.active || this.active.id !== playbackId) return;
    const played = this.active.played;
    this.active = null;
    this.clearTimers();
    this.emit({ type: "playback", playbackId, phase: "stopped", reason: "interrupted", audioMs: played * 100 });
  }

  private at(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private emit(event: Parameters<RemoteVoiceSession["receiveControl"]>[0]): void {
    this.session?.receiveControl(event);
  }
}

export const TEST_IDENTITY: VoiceSessionIdentity = Object.freeze({
  tenantId: "biz-a",
  agentId: "agent-a",
  agentVersionId: "av-a-3",
  agentVersion: 3,
  callId: "call-1",
  sessionId: "call-1",
  conversationId: "conv-1",
  correlationId: "corr-1",
});

export function buildRemoteSession(
  opts: {
    handler?: ScriptedTurnHandler;
    config?: Partial<VoiceSessionConfig>;
    transfer?: (reason: string) => Promise<boolean>;
    identity?: VoiceSessionIdentity;
    timing?: { firstAudioMs: number; msPerChar: number };
  } = {},
) {
  const handler = opts.handler ?? new ScriptedTurnHandler();
  const worker = new SimulatedPipecatWorker(opts.timing);
  const events: VoiceSessionEvent[] = [];
  const states: VoiceSessionState[] = [];
  const ended: VoiceSessionSummary[] = [];
  const transcript: CallTranscriptTurn[] = [];
  const transferReasons: string[] = [];

  const session = new RemoteVoiceSession({
    identity: opts.identity ?? TEST_IDENTITY,
    turns: handler,
    commands: { send: (command) => worker.send(command) },
    hooks: {
      onEvent: (e) => events.push(e),
      onStateChange: (s) => states.push(s),
      onTranscriptTurn: (t) => transcript.push(t),
      onTransferRequested: async (reason) => {
        transferReasons.push(reason);
        return opts.transfer ? opts.transfer(reason) : true;
      },
      onEnded: (s) => ended.push(s),
    },
    config: {
      ...DEFAULT_VOICE_SESSION_CONFIG,
      language: "te-IN",
      prompts: TEST_PROMPTS,
      endpointer: { sampleRate: 8000, speechThreshold: 0.05, minSpeechMs: 100, endHangoverMs: 400 },
      ...opts.config,
    },
  });
  worker.bind(session);

  let utterances = 0;
  const caller = {
    /** Start speaking. A real worker cuts any interruptible playback first. */
    async startSpeaking() {
      worker.bargeIn();
      session.receiveControl({ type: "speech_started" });
      await vi.advanceTimersByTimeAsync(1);
    },
    async stopSpeaking() {
      session.receiveControl({ type: "speech_stopped" });
      await vi.advanceTimersByTimeAsync(1);
    },
    async transcribe(text: string, o: { confidence?: number | null; language?: string | null } = {}) {
      session.receiveControl({
        type: "transcript",
        final: true,
        text,
        utteranceId: `u-${++utterances}`,
        language: o.language ?? "te-IN",
        confidence: o.confidence ?? 0.9,
      });
      await vi.advanceTimersByTimeAsync(1);
    },
    /** Speak, be transcribed, and fall silent — one complete caller utterance. */
    async say(text: string, o: { confidence?: number | null; language?: string | null } = {}) {
      await this.startSpeaking();
      await vi.advanceTimersByTimeAsync(200);
      await this.transcribe(text, o);
      await this.stopSpeaking();
      await vi.advanceTimersByTimeAsync(10);
    },
  };

  const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const eventsOf = (type: VoiceSessionEvent["type"]) => events.filter((e) => e.type === type);
  return { session, worker, handler, events, states, ended, transcript, transferReasons, caller, settle, eventsOf };
}
