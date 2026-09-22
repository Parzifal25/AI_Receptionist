import type { TranscriptDelivery } from "@halo/core/domain/voice";

/**
 * HALO Phase 3 — the seam between the media loop and conversation
 * orchestration.
 *
 * The voice session knows audio, timing and interruption; it knows nothing
 * about agents, prompts, tools or tenants. It hands a finished caller
 * utterance to a `VoiceTurnHandler` and gets back text to speak plus a
 * deterministic directive. The production handler
 * (`phone-channel-adapter.ts`) runs the HALO Agent Runtime; tests inject
 * scripted handlers. Audio transport stays separate from conversation logic.
 */

export interface VoiceTurnRequest {
  /** The caller's utterance (merged with a superseded one after a cancelled turn). */
  utterance: string;
  /** Language reported by STT for the final(s), if any. */
  language: string | null;
  /** Lowest confidence across the utterance's finals; null when the vendor reports none. */
  sttConfidence: number | null;
  turnIndex: number;
  /** Aborted on barge-in, turn timeout or session end. */
  signal: AbortSignal;
}

export type VoiceDirective =
  | { kind: "continue" }
  /** Hand the caller to the tenant-configured human after this reply is spoken. */
  | { kind: "transfer"; reason: string }
  /** The conversation reached its end; hang up after this reply is spoken. */
  | { kind: "end_call"; reason: string };

/**
 * Phase 4.5 — the inside of a turn, in media-loop terms.
 *
 * `agent_turn` is a single number covering retrieval, context assembly,
 * every model call and validation, which is not enough to tell a slow
 * prompt from a slow model. These four fill that hole without the media
 * loop learning anything about prompts, tools or tenants.
 */
export interface VoiceTurnTimings {
  /** Handler entry → model context ready (retrieval + assembly + system actions). */
  contextReadyMs: number;
  /**
   * Handler entry → first usable model output. `null` means the provider did
   * not stream, so there is no first-token signal to report — never zero,
   * which would read as "instant".
   */
  firstTokenMs: number | null;
  /** Time inside model calls, all rounds. */
  modelMs: number;
  /** Time validating the draft reply (act-then-narrate and the repair ladder). */
  validationMs: number;
}

export interface VoiceTurnResult {
  /** Runtime correlation id; also the key for `recordDelivery`. */
  turnId: string;
  reply: string;
  directive: VoiceDirective;
  usage: { modelCalls: number; inputTokens?: number; outputTokens?: number };
  /** The runtime degraded (provider fallback, knowledge/state failure). */
  degraded: boolean;
  /** Optional: handlers that cannot break a turn down simply omit it. */
  timings?: VoiceTurnTimings;
}

/** Thrown by a handler whose turn was aborted before it committed anything. */
export class TurnCancelledError extends Error {
  constructor(message = "voice turn cancelled before commit") {
    super(message);
    this.name = "TurnCancelledError";
  }
}

export function isTurnCancelled(error: unknown): boolean {
  return error instanceof TurnCancelledError || (error instanceof Error && error.name === "TurnCancelledError");
}

export interface VoiceTurnHandler {
  handleTurn(request: VoiceTurnRequest): Promise<VoiceTurnResult>;
  /**
   * Exactly once per completed turn, after playback settles: what the caller
   * actually heard. Lets the transcript tell the model the truth next turn.
   */
  recordDelivery(turnId: string, delivery: { status: TranscriptDelivery; deliveredText: string }): Promise<void>;
  /** Session is over; flush anything pending. Must not throw. */
  close(): Promise<void>;
}
