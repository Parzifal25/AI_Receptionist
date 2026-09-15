import { vi } from "vitest";
import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTtsProvider, type FakeTtsOptions } from "@halo/providers/voice-fakes/fake-tts-provider";
import { audioDurationMs, pcm16ToMulaw } from "@halo/voice/audio";
import type { VoiceTurnHandler, VoiceTurnRequest, VoiceTurnResult } from "@halo/voice/turn-handler";
import { TurnCancelledError } from "@halo/voice/turn-handler";
import {
  DEFAULT_VOICE_SESSION_CONFIG,
  VoiceSession,
  type VoiceOutput,
  type VoiceSessionConfig,
  type VoiceSessionEvent,
  type VoiceSessionState,
  type VoiceSessionSummary,
} from "@halo/voice/voice-session";
import type { TranscriptDelivery } from "@halo/core/domain/voice";

export const FRAME_MS = 20;

export function mulawFrame(amplitude: number, ms = FRAME_MS): Uint8Array {
  const samples = Math.round((ms / 1000) * 8000);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin((i / 8000) * 2 * Math.PI * 300) * amplitude * 32767), true);
  }
  return pcm16ToMulaw(pcm);
}

const SPEECH = mulawFrame(0.3);
const SILENCE = mulawFrame(0);

/**
 * Simulates the provider's playout buffer: audio plays in real (or fake)
 * time from the first byte; marks are acknowledged when the audio before
 * them has played; `clear()` drops everything queued.
 */
export class SimulatedPlayout implements VoiceOutput {
  readonly format = { encoding: "mulaw", sampleRate: 8000, channels: 1 } as const;
  readonly supportsMarks: boolean;
  sentBytes = 0;
  clears = 0;
  marks: string[] = [];
  private queuedMs = 0;
  private playStartedAt: number | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  onMark: (name: string) => void = () => {};

  constructor(opts: { supportsMarks?: boolean } = {}) {
    this.supportsMarks = opts.supportsMarks ?? true;
  }

  sendAudio(audio: Uint8Array): void {
    this.sentBytes += audio.length;
    const now = Date.now();
    if (this.playStartedAt === null || now - this.playStartedAt >= this.queuedMs) {
      this.playStartedAt = now;
      this.queuedMs = 0;
    }
    this.queuedMs += audioDurationMs(audio.length, "mulaw", 8000);
  }

  clear(): void {
    this.clears += 1;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.queuedMs = 0;
    this.playStartedAt = null;
  }

  mark(name: string): void {
    this.marks.push(name);
    const elapsed = this.playStartedAt === null ? 0 : Date.now() - this.playStartedAt;
    const wait = Math.max(0, this.queuedMs - elapsed);
    this.timers.push(setTimeout(() => this.onMark(name), wait));
  }
}

type Reply = Partial<VoiceTurnResult> & { reply: string };

export class ScriptedTurnHandler implements VoiceTurnHandler {
  readonly requests: VoiceTurnRequest[] = [];
  readonly deliveries: Array<{ turnId: string; status: TranscriptDelivery; deliveredText: string }> = [];
  closed = 0;
  private script: Array<(req: VoiceTurnRequest) => Promise<Reply> | Reply> = [];

  /** Queue replies; a function receives the request (and its abort signal). */
  then(...steps: Array<Reply | ((req: VoiceTurnRequest) => Promise<Reply> | Reply)>): this {
    for (const step of steps) this.script.push(typeof step === "function" ? step : () => step);
    return this;
  }

  async handleTurn(request: VoiceTurnRequest): Promise<VoiceTurnResult> {
    this.requests.push(request);
    const step = this.script.shift();
    if (!step) throw new Error("scripted handler: no reply queued");
    const r = await step(request);
    return {
      turnId: r.turnId ?? `turn-${this.requests.length}`,
      reply: r.reply,
      directive: r.directive ?? { kind: "continue" },
      usage: r.usage ?? { modelCalls: 1, inputTokens: 10, outputTokens: 5 },
      degraded: r.degraded ?? false,
    };
  }

  async recordDelivery(turnId: string, delivery: { status: TranscriptDelivery; deliveredText: string }) {
    this.deliveries.push({ turnId, ...delivery });
  }

  async close() {
    this.closed += 1;
  }
}

/** A handler step that waits until aborted and then cancels (nothing committed). */
export const waitForAbort = (req: VoiceTurnRequest): Promise<Reply> =>
  new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new TurnCancelledError()), { once: true }));

export const TEST_PROMPTS = {
  greeting: "Hello, this is an automated assistant.",
  reprompt: "Are you still there?",
  goodbye: "Thank you for calling, goodbye.",
  turnFailure: "Sorry, could you say that again?",
  transferFailed: "I could not connect you right now.",
  transferAnnounce: "Please hold while I connect you.",
};

export function buildSession(opts: {
  handler?: ScriptedTurnHandler;
  config?: Partial<VoiceSessionConfig>;
  tts?: FakeTtsOptions;
  supportsMarks?: boolean;
  transfer?: (reason: string) => Promise<boolean>;
} = {}) {
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider({ msPerChar: 20, chunkMs: 100, ...opts.tts });
  const handler = opts.handler ?? new ScriptedTurnHandler();
  const output = new SimulatedPlayout({ supportsMarks: opts.supportsMarks });
  const events: VoiceSessionEvent[] = [];
  const states: VoiceSessionState[] = [];
  const ended: VoiceSessionSummary[] = [];
  const transferReasons: string[] = [];
  const session = new VoiceSession({
    stt,
    tts,
    turns: handler,
    output,
    inputFormat: { encoding: "mulaw", sampleRate: 8000, channels: 1 },
    hooks: {
      onEvent: (e) => events.push(e),
      onStateChange: (s) => states.push(s),
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
  output.onMark = (name) => session.receiveMark(name);

  const caller = {
    /** Push `ms` of speech energy (in real frames). */
    async speak(ms: number) {
      for (let t = 0; t < ms; t += FRAME_MS) {
        session.receiveAudio(SPEECH);
        await vi.advanceTimersByTimeAsync(FRAME_MS);
      }
    },
    async silence(ms: number) {
      for (let t = 0; t < ms; t += FRAME_MS) {
        session.receiveAudio(SILENCE);
        await vi.advanceTimersByTimeAsync(FRAME_MS);
      }
    },
    /** Speak, have STT produce a final, then fall silent long enough to endpoint. */
    async say(text: string, o: { confidence?: number | null; language?: string | null; speechMs?: number } = {}) {
      await this.speak(o.speechMs ?? 400);
      stt.current.final(text, { confidence: o.confidence, language: o.language });
      await this.silence(600);
    },
  };

  const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const eventsOf = (type: VoiceSessionEvent["type"]) => events.filter((e) => e.type === type);
  return { session, stt, tts, handler, output, events, states, ended, transferReasons, caller, settle, eventsOf };
}
