import type { LLMDelta } from "@halo/ports/llm-provider";
import type {
  ActionRecord,
  ChannelProfile,
  SpeechFallbackReason,
  SpeechRetractReason,
  SpeechSink,
  SpeechStreamOutcome,
  ValidationViolation,
} from "./contracts";
import { SentenceAssembler } from "./response-assembler";
import { validateSegment, type ActionClaimPhrases } from "./response-validator";

/**
 * HALO Phase 4.5 Sprint 3 — safe speech streaming for one turn.
 *
 *   LLM deltas → SentenceAssembler → validateSegment → SpeechSink
 *
 * Raw tokens never reach the sink. What reaches it is a complete sentence
 * that passed the response validator over everything said before it.
 *
 * RELEASE POLICY — the part that keeps act-then-narrate intact:
 *
 *   - A model round that is offered NO tools (the narration round after a
 *     tool ran, or an agent with no tools) cannot call one. Its segments are
 *     heard as soon as they validate.
 *   - A model round that is offered ANY tool might follow its text with a
 *     tool call, and "I'll connect you now" must not be heard before the
 *     handoff has run. Its segments are emitted HELD: the channel may
 *     prepare them (synthesize audio) but nobody hears them. They are
 *     released only when the round ended with no tool call AND the whole
 *     reply passed `validateReply` — the complete-response gate, unchanged.
 *     Otherwise they are retracted, unheard. "Any tool", not "side-effecting
 *     tool": `request_human_handoff` is declared non-side-effecting and still
 *     decides whether the caller is about to be transferred.
 *
 * Once anything has been heard it is never retracted and never repeated. A
 * later failure (a rejected segment, a dead stream, a barge-in) truncates:
 * the turn's reply becomes exactly the heard prefix, and the transcript says
 * so. Before anything is heard, every failure falls back to the complete path.
 */

export interface SafeSpeechStreamParams {
  sink: SpeechSink;
  turnId: string;
  channel: ChannelProfile;
  claimPhrases: ActionClaimPhrases;
  /** Live view of this turn's verified actions: permitted claims grow as tools succeed. */
  actions: () => ActionRecord[];
  /** Wall-clock ms at turn start, for the T5 marks. */
  startedAt: number;
  now?: () => number;
}

export class SafeSpeechStream {
  private assembler: SentenceAssembler | null = null;
  private roundHeld = false;
  private roundProducedText = false;
  private readonly heldSegments: string[] = [];
  private readonly releasedSegments: string[] = [];
  private revoked = false;
  private capped = false;
  private emitted = 0;
  private retracted = 0;
  private toolRetractions = 0;
  private truncatedFlag = false;
  private fallback: SpeechFallbackReason | null = null;
  private firstSegmentAt: number | null = null;
  private firstReleaseAt: number | null = null;
  /** Segment-level violations (what was stopped from being said). */
  readonly violations: ValidationViolation[] = [];
  private readonly now: () => number;

  constructor(private readonly params: SafeSpeechStreamParams) {
    this.now = params.now ?? Date.now;
  }

  /** Still streaming this turn (not revoked by a failure or a rejection). */
  get active(): boolean {
    return !this.revoked;
  }

  /** Something has been released for the caller to hear. */
  get hasReleased(): boolean {
    return this.releasedSegments.length > 0;
  }

  /** Validated segments are waiting on this round's outcome. */
  get hasHeld(): boolean {
    return this.heldSegments.length > 0;
  }

  /** The current round has produced model text (used to judge a stream failure). */
  get producedText(): boolean {
    return this.roundProducedText;
  }

  /** Exactly what the caller may have heard, in order. */
  get releasedText(): string {
    return this.releasedSegments.join(" ");
  }

  /** A model round starts. `offersTools` → its segments are held. */
  beginRound(offersTools: boolean): void {
    if (this.revoked) return;
    this.assembler = new SentenceAssembler();
    this.roundHeld = offersTools;
    this.roundProducedText = false;
  }

  onDelta(delta: LLMDelta): void {
    if (this.revoked || !this.assembler || delta.type !== "text") return;
    if (delta.text) this.roundProducedText = true;
    for (const segment of this.assembler.push(delta.text)) this.accept(segment);
  }

  /**
   * The round's stream completed. With tool calls, a held round's text was a
   * tool preamble: retract it unheard. Otherwise the unfinished tail is now
   * known to be complete and is flushed.
   */
  endRound(toolCalls: number): void {
    if (this.revoked || !this.assembler) return;
    if (toolCalls > 0 && this.roundHeld) {
      this.assembler = null;
      if (this.heldSegments.length > 0) this.toolRetractions += 1;
      this.retract("tool_call");
      return;
    }
    for (const segment of this.assembler.flush()) this.accept(segment);
    this.assembler = null;
  }

  /**
   * The round's stream failed. The assembler's buffer is an unfinished
   * sentence of a failed stream and is dropped, never flushed. Held
   * segments are retracted.
   */
  failRound(): void {
    this.assembler = null;
    this.retract("stream_failed");
  }

  /** The whole reply passed validation: every held segment may now be heard. */
  commit(): boolean {
    if (this.revoked || this.heldSegments.length === 0) return false;
    this.releasedSegments.push(...this.heldSegments.splice(0));
    this.firstReleaseAt ??= this.now();
    this.params.sink({ type: "release", turnId: this.params.turnId });
    return true;
  }

  /**
   * Stop streaming for the rest of the turn. Held segments are retracted;
   * released ones stand. `reason` is recorded when the turn falls back.
   */
  revoke(reason: SpeechFallbackReason, retractReason: SpeechRetractReason = reasonToRetract(reason)): void {
    if (this.revoked) return;
    this.revoked = true;
    this.assembler = null;
    this.fallback ??= reason;
    this.retract(retractReason);
  }

  /**
   * Heard speech was cut short (the stream failed or the caller barged in
   * after segments were released). The reply is the heard prefix.
   */
  truncate(reason: SpeechFallbackReason | null): void {
    this.truncatedFlag = true;
    if (reason) this.fallback ??= reason;
    this.revoked = true;
    this.assembler = null;
    this.retract("stream_failed");
  }

  outcome(): SpeechStreamOutcome {
    const streamed = this.releasedSegments.length > 0;
    return {
      attempted: true,
      streamed,
      fallbackReason: this.fallback,
      segmentsEmitted: this.emitted,
      segmentsReleased: this.releasedSegments.length,
      segmentsRetracted: this.retracted,
      toolRoundsRetracted: this.toolRetractions,
      truncated: this.truncatedFlag,
      firstSegmentMs: this.firstSegmentAt === null ? null : Math.max(0, this.firstSegmentAt - this.params.startedAt),
      firstReleaseMs: this.firstReleaseAt === null ? null : Math.max(0, this.firstReleaseAt - this.params.startedAt),
    };
  }

  private accept(candidate: string): void {
    if (this.revoked || this.capped) return;
    const prior = [...this.releasedSegments, ...this.heldSegments].join(" ");
    const verdict = validateSegment({
      segment: candidate,
      priorText: prior,
      channel: this.params.channel,
      actions: this.params.actions(),
      claimPhrases: this.params.claimPhrases,
    });
    if (!verdict.ok) {
      this.violations.push(...verdict.violations);
      if (this.releasedSegments.length > 0) {
        // Earlier sentences were heard; this one never will be.
        this.truncatedFlag = true;
        this.revoked = true;
        this.fallback ??= "segment_rejected";
        this.assembler = null;
        this.retract("segment_rejected");
      } else {
        this.revoke("segment_rejected");
      }
      return;
    }
    // Reply length is capped on the running total, at a sentence boundary —
    // the streaming form of the whole-reply `max_length` trim.
    const length = prior ? prior.length + 1 + verdict.segment.length : verdict.segment.length;
    if (length > this.params.channel.maxReplyChars) {
      this.capped = true;
      this.violations.push({ kind: "max_length", detail: `stopped at ${prior.length} chars`, repairable: "transform" });
      return;
    }
    this.firstSegmentAt ??= this.now();
    this.emitted += 1;
    const index = this.emitted - 1;
    if (this.roundHeld) {
      this.heldSegments.push(verdict.segment);
      this.params.sink({ type: "segment", turnId: this.params.turnId, index, text: verdict.segment, held: true });
    } else {
      this.releasedSegments.push(verdict.segment);
      this.firstReleaseAt ??= this.now();
      this.params.sink({ type: "segment", turnId: this.params.turnId, index, text: verdict.segment, held: false });
    }
  }

  private retract(reason: SpeechRetractReason): void {
    if (this.heldSegments.length === 0) return;
    this.retracted += this.heldSegments.length;
    this.heldSegments.length = 0;
    this.params.sink({ type: "retract", turnId: this.params.turnId, reason });
  }
}

function reasonToRetract(reason: SpeechFallbackReason): SpeechRetractReason {
  switch (reason) {
    case "segment_rejected":
    case "reply_rejected":
    case "stream_failed":
    case "provider_failed":
      return reason;
    default:
      return "cancelled";
  }
}
