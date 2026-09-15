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

export interface VoiceTurnResult {
  /** Runtime correlation id; also the key for `recordDelivery`. */
  turnId: string;
  reply: string;
  directive: VoiceDirective;
  usage: { modelCalls: number; inputTokens?: number; outputTokens?: number };
  /** The runtime degraded (provider fallback, knowledge/state failure). */
  degraded: boolean;
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
