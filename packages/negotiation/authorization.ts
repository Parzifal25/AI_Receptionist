import type { Concession, NegotiationPolicy } from "./policy";

/**
 * HALO Phase 4 — the authorization decision (brief §8).
 *
 * Pure, synchronous, and the ONLY thing that may say yes. It sees the
 * policy, what qualification has actually captured, and what has already
 * been offered on this call; it never sees model text and never asks a
 * model anything.
 *
 * The refusal reasons are deliberately specific, because the agent is told
 * which one applies and what it may say instead. "No" with a reason is
 * usable in a conversation; a bare "no" makes the model improvise.
 */

export type ConcessionDenial =
  /** No such concession in the policy. */
  | "unknown"
  /** The business has not supplied a verified value for it. */
  | "no_authorized_value"
  /** Qualification has not established the conditions it depends on. */
  | "condition_unmet"
  /** Already offered as many times as the policy allows. */
  | "already_offered"
  /** Above a configured floor or approval threshold: a person must decide. */
  | "needs_human_approval";

export interface AuthorizedOffer {
  id: string;
  type: Concession["type"];
  /** The authorized magnitude. Never larger than the policy's own value. */
  value: number | null;
  /** The tenant's exact wording for this offer, in the caller's language. */
  script: string;
  label: string;
}

export type ConcessionDecision =
  | { allowed: true; offer: AuthorizedOffer }
  | { allowed: false; reason: ConcessionDenial; concessionId: string; detail: string };

export interface NegotiationSnapshot {
  /** Captured qualification values, as stored (`qualificationSlots`). */
  fields: Record<string, string>;
  /** Concession id → times already offered on this conversation. */
  offered: Record<string, number>;
  /** How many times the customer has pushed for a better deal. */
  requests: number;
}

export function emptyNegotiationSnapshot(): NegotiationSnapshot {
  return { fields: {}, offered: {}, requests: 0 };
}

export interface AuthorizeInput {
  policy: NegotiationPolicy;
  snapshot: NegotiationSnapshot;
  concessionId: string;
  /** Language tag for the returned script; falls back to the policy language. */
  language?: string;
}

export function authorizeConcession(input: AuthorizeInput): ConcessionDecision {
  const { policy, snapshot, concessionId } = input;
  const concession = policy.concessions.find((c) => c.id === concessionId);
  if (!concession) {
    return {
      allowed: false,
      reason: "unknown",
      concessionId,
      detail: "this is not something the business has authorized",
    };
  }
  // A null value is an UNSET business decision, never an open one.
  if (concession.value === null && concession.type !== "free_addon") {
    return {
      allowed: false,
      reason: "no_authorized_value",
      concessionId,
      detail: "the business has not set a figure for this yet",
    };
  }
  for (const condition of concession.conditions) {
    const captured = snapshot.fields[condition.field];
    if (captured === undefined || !condition.in.includes(captured)) {
      return {
        allowed: false,
        reason: "condition_unmet",
        concessionId,
        detail: `it depends on ${condition.field}, which has not been established`,
      };
    }
  }
  if ((snapshot.offered[concessionId] ?? 0) >= concession.maxPerConversation) {
    return {
      allowed: false,
      reason: "already_offered",
      concessionId,
      detail: "it has already been offered on this call",
    };
  }
  if (concession.requiresApproval) {
    return {
      allowed: false,
      reason: "needs_human_approval",
      concessionId,
      detail: "a member of the team has to approve this one",
    };
  }
  const threshold = policy.escalation.humanApprovalAbovePercent;
  if (
    concession.type === "discount_percent" &&
    threshold !== null &&
    concession.value !== null &&
    concession.value > threshold
  ) {
    return {
      allowed: false,
      reason: "needs_human_approval",
      concessionId,
      detail: `a discount above ${threshold}% has to be approved by a person`,
    };
  }
  const maxDiscount = policy.floors.maxDiscountPercent;
  if (concession.type === "discount_percent" && maxDiscount !== null && concession.value !== null && concession.value > maxDiscount) {
    // Refused rather than clamped: silently offering less than the
    // configuration says would make the policy untrustworthy in both
    // directions. `parseNegotiationPolicy` already rejects this at load.
    return {
      allowed: false,
      reason: "needs_human_approval",
      concessionId,
      detail: "it is outside what may be offered without approval",
    };
  }

  const language = input.language ?? policy.language;
  return {
    allowed: true,
    offer: {
      id: concession.id,
      type: concession.type,
      value: concession.value,
      script: pick(concession.script, language, policy.language),
      label: pick(concession.label, language, policy.language),
    },
  };
}

/** Everything the agent may offer right now, in policy order. */
export function availableConcessions(
  policy: NegotiationPolicy,
  snapshot: NegotiationSnapshot,
  language?: string,
): AuthorizedOffer[] {
  const offers: AuthorizedOffer[] = [];
  for (const concession of policy.concessions) {
    const decision = authorizeConcession({ policy, snapshot, concessionId: concession.id, ...(language ? { language } : {}) });
    if (decision.allowed) offers.push(decision.offer);
  }
  return offers;
}

/** Concessions a person could still approve, so the agent can offer to ask. */
export function approvableConcessions(policy: NegotiationPolicy, snapshot: NegotiationSnapshot): string[] {
  return policy.concessions
    .filter((c) => {
      const decision = authorizeConcession({ policy, snapshot, concessionId: c.id });
      return !decision.allowed && decision.reason === "needs_human_approval";
    })
    .map((c) => c.id);
}

/** Whether this call has pushed past what the agent may handle alone. */
export function shouldEscalate(policy: NegotiationPolicy, snapshot: NegotiationSnapshot, unlistedRequest = false): boolean {
  if (unlistedRequest && policy.escalation.escalateOnUnlistedRequest) return true;
  return snapshot.requests >= policy.escalation.requestsBeforeHuman && availableConcessions(policy, snapshot).length === 0;
}

/** Verified figures the agent may actually state, given the disclosure mode. */
export function disclosableQuotes(policy: NegotiationPolicy, language?: string): Array<{ label: string; amount: number; unit: string }> {
  if (policy.priceDisclosure === "none") return [];
  return policy.quotes
    .filter((q): q is typeof q & { amount: number } => q.amount !== null)
    .map((q) => ({ label: pick(q.label, language ?? policy.language, policy.language), amount: q.amount, unit: q.unit }));
}

function pick(text: Record<string, string>, language: string, fallback: string): string {
  return text[language] ?? text[fallback] ?? Object.values(text)[0] ?? "";
}
