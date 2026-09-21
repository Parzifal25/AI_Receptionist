import type { AnyToolExecutor } from "@halo/runtime/tools/registry";
import { authorizeConcession, type NegotiationSnapshot } from "./authorization";
import type { NegotiationPolicy } from "./policy";

/**
 * HALO Phase 4 — the executor behind `offer_concession` (brief §8, §9).
 *
 * The model proposes an id. This re-checks it against the policy — the same
 * check that produced the prompt section, run again at execution time — and
 * either records the offer or refuses with a usable reason.
 *
 * Two things make this the real control rather than a formality:
 *   1. a refusal returns `claimsPermitted: []`, so the response validator
 *      rejects a reply that claims the concession anyway;
 *   2. the offer is recorded in the snapshot, so `maxPerConversation` is
 *      enforced across turns even if the model forgets it already offered.
 *
 * It never invents a value and never negotiates: the number can only ever be
 * the one the business configured.
 */

export interface ConcessionExecutorDeps {
  policy: NegotiationPolicy;
  snapshot(): NegotiationSnapshot;
  /** Called only after an authorized offer, so counters stay truthful. */
  recordOffer(concessionId: string): void;
  language?: string;
}

export function concessionExecutor(deps: ConcessionExecutorDeps): AnyToolExecutor {
  return async (args: { concessionId: string; reason?: string }) => {
    const decision = authorizeConcession({
      policy: deps.policy,
      snapshot: deps.snapshot(),
      concessionId: args.concessionId,
      ...(deps.language ? { language: deps.language } : {}),
    });
    if (!decision.allowed) {
      const escalate = decision.reason === "needs_human_approval" || decision.reason === "unknown";
      return {
        ok: false,
        summary:
          `Not authorized: ${decision.detail}. Do not offer it, do not hint at it, and do not offer anything ` +
          (escalate
            ? "similar of your own. You may say you will have a member of the team confirm what is possible."
            : "similar of your own."),
        claimsPermitted: [],
        error: { code: decision.reason, message: decision.detail },
        ...(escalate
          ? { escalation: { reason: "unsupported_request" as const, priority: "normal" as const } }
          : {}),
      };
    }
    deps.recordOffer(decision.offer.id);
    return {
      ok: true,
      summary:
        `Authorized and recorded. Offer it in exactly these words: "${decision.offer.script}". ` +
        "Do not improve on it, round it, or add anything to it.",
      data: {
        concessionId: decision.offer.id,
        type: decision.offer.type,
        ...(decision.offer.value !== null ? { value: decision.offer.value } : {}),
        currency: deps.policy.currency,
      },
      claimsPermitted: ["concession.offered"],
      statePatch: { slots: { last_concession: decision.offer.id } },
    };
  };
}
