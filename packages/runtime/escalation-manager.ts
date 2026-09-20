import type { ActionRecord, EscalationDecision, ToolResult } from "./contracts";
import type { ConversationState } from "./conversation-state";

/**
 * HALO Phase 2 — escalation manager (Workstream 12).
 *
 * Produces a typed, channel-neutral decision from deterministic signals.
 * It never transfers a call or pages anyone: the decision is recorded in
 * state, emitted as a runtime event and returned to the channel adapter,
 * which decides what a handoff means on its channel (Phase 5 for phone).
 */

const HUMAN_REQUEST_RE =
  /\b(?:talk|speak|chat|connect|deal)(?:ing)?\s+(?:to|with)\s+(?:a\s+|an\s+|some\s+|the\s+|your\s+)?(?:human|person|real person|someone|somebody|agent|representative|rep|staff|manager|owner|operator|live agent|real agent|actual person)\b|\b(?:a\s+)?(?:real|actual|live)\s+(?:human|person|agent)\b|\bhuman\s+(?:please|agent|support|being)\b|\b(?:transfer|escalate)\s+(?:me|this|it)\b|\bnot\s+(?:a\s+)?bot\b/i;

export const ESCALATION_LIMITS = {
  /** Consecutive unanswered substantive questions before escalating. */
  repeatedMisunderstandingStreak: 3,
} as const;

export interface EscalationInput {
  userMessage: string;
  state: ConversationState;
  actions: ActionRecord[];
  toolResults: ToolResult[];
  /** Tenant-approved trigger phrases from agent config (guardrails.escalationTriggers). */
  guardrailTriggers: string[];
  /**
   * Agent-language phrases meaning "I want a person" (guardrails.
   * humanRequestPhrases). The built-in pattern below is English only, so a
   * non-English agent MUST configure these — otherwise the detector silently
   * never fires, which is the failure mode Phase 4 exists to remove.
   */
  humanRequestPhrases?: string[];
  /** Unanswered streak INCLUDING this turn. */
  unansweredStreak: number;
  /** The validator could not produce a compliant reply; the fallback was used. */
  validationFallbackUsed: boolean;
}

const NONE: EscalationDecision = Object.freeze({
  escalate: false,
  priority: "low",
  summary: "",
  recommendedAction: "none",
});

export function decideEscalation(input: EscalationInput): EscalationDecision {
  // 1. A tool executor asked for it (e.g. request_human_handoff).
  const fromTool = input.toolResults.find((r) => r.status === "succeeded" && r.escalation);
  if (fromTool?.escalation) {
    return {
      escalate: true,
      reason: fromTool.escalation.reason,
      priority: fromTool.escalation.priority,
      summary: `Escalation requested through the ${fromTool.name} action.`,
      recommendedAction: "notify_team",
    };
  }

  // 2. Tenant-configured sensitive triggers (persisted agent config, not model output).
  const message = input.userMessage.toLowerCase();
  const trigger = input.guardrailTriggers
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3)
    .find((t) => message.includes(t));
  if (trigger) {
    return {
      escalate: true,
      reason: "sensitive_situation",
      priority: "high",
      summary: "A tenant-configured escalation trigger matched the visitor's message.",
      recommendedAction: "notify_team",
    };
  }

  // 3. The visitor explicitly wants a person (English pattern OR the agent's
  //    configured phrases, so this works in any language).
  const configuredHumanRequest = (input.humanRequestPhrases ?? [])
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length >= 3)
    .some((p) => message.includes(p));
  if (configuredHumanRequest || HUMAN_REQUEST_RE.test(input.userMessage)) {
    return {
      escalate: true,
      reason: "explicit_human_request",
      priority: "normal",
      summary: "The visitor asked to speak with a person.",
      recommendedAction: "offer_callback",
    };
  }

  // 4. A verified action failed in a way the system cannot recover alone.
  const failed = input.actions.find((a) => a.status === "failed" && a.needsHuman);
  if (failed) {
    return {
      escalate: true,
      reason: "action_failed",
      priority: "normal",
      summary: `The ${failed.name} action failed and needs a person to complete it.`,
      recommendedAction: "notify_team",
    };
  }

  // 5. The reply could not be validated; a person should check the conversation.
  if (input.validationFallbackUsed) {
    return {
      escalate: true,
      reason: "low_confidence",
      priority: "normal",
      summary: "The assistant could not produce a validated reply and used the safe fallback.",
      recommendedAction: "notify_team",
    };
  }

  // 6. The model wanted an action this agent does not have.
  if (input.toolResults.some((r) => r.rejection === "not_granted" || r.rejection === "unknown_tool")) {
    return {
      escalate: true,
      reason: "unsupported_request",
      priority: "low",
      summary: "The conversation needed an action this agent is not allowed to perform.",
      recommendedAction: "offer_callback",
    };
  }

  // 7. Repeated questions with no grounding.
  if (input.unansweredStreak >= ESCALATION_LIMITS.repeatedMisunderstandingStreak) {
    return {
      escalate: true,
      reason: "repeated_misunderstanding",
      priority: "normal",
      summary: `${input.unansweredStreak} consecutive questions could not be answered from the knowledge base.`,
      recommendedAction: "offer_callback",
    };
  }

  return NONE;
}
