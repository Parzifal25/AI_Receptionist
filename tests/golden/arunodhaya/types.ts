import type { CallDisposition } from "@halo/core/domain/voice";

/**
 * HALO Phase 4 — the golden conversation format (brief §13).
 *
 * A golden conversation is a scripted CALLER plus a scripted MODEL. Scripting
 * the model is the point, not a limitation: it lets the corpus contain a
 * model that behaves badly — inventing a discount, claiming a booking that
 * never happened, promising a subsidy — and assert that the deterministic
 * layer stops it. Those are the failures that cost a business money, and
 * they are exactly the ones a real-model eval cannot reproduce on demand.
 *
 * What this corpus CANNOT score is how good the Telugu actually sounds, or
 * whether a real model would phrase the question naturally. That needs a
 * real model and native reviewers and is tracked separately (P4-12).
 */

export type GoldenCategory =
  | "telugu"
  | "tenglish"
  | "objection"
  | "negotiation"
  | "qualification"
  | "appointment"
  | "handoff"
  | "failure";

export interface GoldenToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface GoldenTurn {
  /** What the caller says (as STT would deliver it). */
  say: string;
  /** STT confidence for this utterance; low values force a read-back. */
  confidence?: number;
  /** What the model returns this turn. May be deliberately non-compliant. */
  model?: { content: string; toolCalls?: GoldenToolCall[] };
  /** A second model response, for the turn that follows a tool round. */
  modelAfterTool?: { content: string };
  expect?: {
    /** Substrings the assembled system prompt must contain this turn. */
    promptContains?: string[];
    /** Substrings that must NOT be in the prompt. */
    promptNotContains?: string[];
    /** The reply actually delivered to the caller. */
    replyIs?: string;
    /** The delivered reply must not match this (e.g. a fabricated figure). */
    replyNotMatching?: RegExp;
    /** Qualification values captured so far. */
    qualification?: Record<string, string>;
    /** Expected outcome per tool this turn. */
    toolStatus?: Record<string, "succeeded" | "failed" | "rejected">;
    escalates?: boolean;
    /** Validation violation kinds the runtime must have raised. */
    violations?: string[];
    /** The runtime fell back to the honest canned reply. */
    fallbackUsed?: boolean;
  };
}

export interface GoldenConversation {
  id: string;
  category: GoldenCategory;
  /** One line on what this conversation is actually testing. */
  intent: string;
  turns: GoldenTurn[];
  /** The deterministic business outcome after the call ends. */
  expectDisposition?: CallDisposition;
  expectDoNotCall?: boolean;
}

export interface TurnFinding {
  conversation: string;
  turn: number;
  check: string;
  detail: string;
}

export interface GoldenResult {
  conversation: string;
  category: GoldenCategory;
  intent: string;
  passed: boolean;
  findings: TurnFinding[];
  disposition: CallDisposition | null;
  /** Assembled system prompt size per turn, in characters. */
  promptChars: number[];
}
