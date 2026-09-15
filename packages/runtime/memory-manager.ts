import type { ChatMessage } from "@halo/core/domain/types";
import type { EscalationDecision } from "./contracts";
import { applyStatePatch, STATE_LIMITS, type ConversationState } from "./conversation-state";

/**
 * HALO Phase 2 — memory manager (Workstream 11).
 *
 * Bounded, deterministic memory:
 *   - the recent window is verbatim (context builder);
 *   - everything older is folded into a rolling recap, oldest first,
 *     capped at STATE_LIMITS.maxSummaryChars, refreshed only when enough
 *     messages have left the window;
 *   - stored text is sanitized so a past message cannot masquerade as a
 *     prompt section or a role, and the composer labels the recap as data.
 *
 * No model call is involved: the recap is an extractive compression of the
 * transcript, which is exactly as trustworthy as the transcript — never
 * more. Customer recall across conversations is not implemented here (the
 * application passes authorized CustomerContext explicitly).
 */

export const MEMORY_LIMITS = {
  /** Fold only when at least this many messages have left the window. */
  refreshMinMessages: 4,
  maxVisitorLineChars: 160,
  maxAssistantLineChars: 120,
} as const;

// Control characters (C0 + DEL) are stripped so stored text cannot carry
// terminal/markup tricks into the prompt.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001F\\u007F]+", "g");

export function sanitizeForMemory(text: string): string {
  return text
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/(^|\n)\s*#{1,6}\s*/g, "$1")
    .replace(/^\s*(?:system|assistant|user|tool)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Folds older messages into the recap; drops the oldest lines when over budget. */
export function foldSummary(previous: string, older: ChatMessage[], maxChars: number): string {
  const lines = older.map((m) => {
    const label = m.role === "user" ? "Visitor" : "Assistant";
    const max = m.role === "user" ? MEMORY_LIMITS.maxVisitorLineChars : MEMORY_LIMITS.maxAssistantLineChars;
    const content = sanitizeForMemory(m.content);
    return `${label}: ${content.length > max ? `${content.slice(0, max - 1)}...` : content}`;
  });
  let combined = [previous.trim(), ...lines].filter(Boolean);
  while (combined.join("\n").length > maxChars && combined.length > 1) combined = combined.slice(1);
  const text = combined.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export interface MemoryUpdateParams {
  state: ConversationState;
  /** Chronological conversational history BEFORE this turn (bounded fetch). */
  history: ChatMessage[];
  recentWindow: number;
  escalation: EscalationDecision;
  /** This turn was a substantive question with no grounding and no action. */
  unanswered: boolean;
  now: Date;
}

export interface MemoryUpdateResult {
  state: ConversationState;
  summarized: boolean;
  foldedMessages: number;
}

export function updateMemory(params: MemoryUpdateParams): MemoryUpdateResult {
  const { state, history, recentWindow } = params;
  const absoluteBefore = Math.max(state.messagesObserved, history.length);
  const windowStartAbs = Math.max(0, absoluteBefore - recentWindow);
  const fetchStartAbs = absoluteBefore - history.length;

  let summary = state.summary;
  let foldedMessages = 0;
  const foldFromAbs = Math.max(state.summary.throughMessageCount, fetchStartAbs);
  const foldable = windowStartAbs - foldFromAbs;
  if (foldable >= MEMORY_LIMITS.refreshMinMessages || (foldable > 0 && state.summary.text === "")) {
    const older = history.slice(foldFromAbs - fetchStartAbs, windowStartAbs - fetchStartAbs);
    summary = {
      text: foldSummary(state.summary.text, older, STATE_LIMITS.maxSummaryChars),
      throughMessageCount: windowStartAbs,
      updatedAt: params.now.toISOString(),
    };
    foldedMessages = older.length;
  }

  const escalation =
    params.escalation.escalate && state.escalation.status !== "triggered"
      ? { status: "triggered" as const, reason: params.escalation.reason ?? null, at: params.now.toISOString() }
      : state.escalation;

  const next = applyStatePatch(state, {
    summary,
    messagesObserved: absoluteBefore + 2,
    turnCount: state.turnCount + 1,
    unansweredStreak: params.unanswered ? state.unansweredStreak + 1 : 0,
    escalation,
  });
  return { state: next, summarized: foldedMessages > 0, foldedMessages };
}
