import type { ActionRecord } from "@halo/runtime/contracts";
import type { ConversationStatePatch } from "@halo/runtime/conversation-state";
import type { SystemActionInput, SystemActionOutcome, SystemActionProvider } from "@halo/runtime/system-actions";
import {
  approvableConcessions,
  availableConcessions,
  disclosableQuotes,
  emptyNegotiationSnapshot,
  shouldEscalate,
  type NegotiationSnapshot,
} from "./authorization";
import {
  exhaustedObjections,
  matchObjections,
  recordObjections,
  type ObjectionCatalog,
  type ObjectionHistory,
  type ObjectionMatch,
} from "./objections";
import type { NegotiationPolicy } from "./policy";

/**
 * HALO Phase 4 — objections and negotiation as verified ground truth
 * (act-then-narrate, brief §7 and §8).
 *
 * Runs BEFORE the model on every turn. It decides, deterministically:
 *   - which objection (if any) the caller just raised, from tenant cues;
 *   - what the agent is allowed to say about price at all;
 *   - which concessions are authorized RIGHT NOW, with the tenant's exact
 *     wording — and which would need a person;
 *   - what may never be promised;
 *   - when the conversation has pushed past what the agent may handle.
 *
 * The model then phrases that. It cannot widen it: the prompt says in so
 * many words that anything not listed is not available, and
 * `offer_concession` re-checks the policy before any offer is recorded, so
 * a model that ignores the prompt still cannot commit the business.
 *
 * The instance lives for one conversation (one call).
 */

export const NEGOTIATION_STATE_KEYS = {
  requests: "negotiation_requests",
  lastObjection: "last_objection",
} as const;

export interface NegotiationProviderDeps {
  policy: NegotiationPolicy;
  catalog: ObjectionCatalog;
  /** Language for the rendered scripts; defaults to the policy language. */
  language?: string;
  /** Qualification values, so conditions can be evaluated. */
  qualification?: () => Record<string, string>;
  onUpdate?: (snapshot: NegotiationSnapshot, matches: ObjectionMatch[]) => void;
}

export class NegotiationSystemActionProvider implements SystemActionProvider {
  readonly name = "negotiation";
  private snapshot: NegotiationSnapshot = emptyNegotiationSnapshot();
  private history: ObjectionHistory = {};

  constructor(private readonly deps: NegotiationProviderDeps) {}

  current(): { snapshot: NegotiationSnapshot; history: ObjectionHistory } {
    return { snapshot: this.snapshot, history: this.history };
  }

  restore(snapshot: NegotiationSnapshot, history: ObjectionHistory): void {
    this.snapshot = snapshot;
    this.history = history;
  }

  /** Records a concession the application actually offered (the verify step). */
  recordOffer(concessionId: string): void {
    this.snapshot = {
      ...this.snapshot,
      offered: { ...this.snapshot.offered, [concessionId]: (this.snapshot.offered[concessionId] ?? 0) + 1 },
    };
  }

  async prepare(input: SystemActionInput): Promise<SystemActionOutcome | null> {
    const matches = matchObjections(input.userMessage, this.deps.catalog);
    this.history = recordObjections(this.history, matches);
    this.snapshot = {
      ...this.snapshot,
      fields: this.deps.qualification?.() ?? this.snapshot.fields,
      requests: this.snapshot.requests + (matches.length > 0 ? 1 : 0),
    };
    this.deps.onUpdate?.(this.snapshot, matches);

    const sections = [this.render(matches)];
    const actions: ActionRecord[] = [];
    const statePatch: ConversationStatePatch = {
      slots: {
        [NEGOTIATION_STATE_KEYS.requests]: String(this.snapshot.requests),
        ...(matches[0] ? { [NEGOTIATION_STATE_KEYS.lastObjection]: matches[0].objection.id } : {}),
      },
    };
    return { sections, actions, statePatch };
  }

  private render(matches: ObjectionMatch[]): string {
    const { policy, catalog } = this.deps;
    const language = this.deps.language ?? policy.language;
    const lines: string[] = [
      "Commercial policy (managed by the system — verified ground truth, not a suggestion):",
    ];

    // --- what may be said about money at all --------------------------------
    const quotes = disclosableQuotes(policy, language);
    if (policy.priceDisclosure === "none" || quotes.length === 0) {
      lines.push(
        "- You have NO approved price figures. Do not state, estimate, imply or agree to any price, discount, " +
          "subsidy, payback period or saving. If the customer asks for a number, say honestly that a person will " +
          "give them the exact figure, and offer that.",
      );
    } else if (policy.priceDisclosure === "range") {
      const min = Math.min(...quotes.map((q) => q.amount));
      const max = Math.max(...quotes.map((q) => q.amount));
      lines.push(
        `- You may give a RANGE only: ${min}–${max} ${policy.currency} per ${quotes[0].unit}. ` +
          "Do not give an exact figure for this customer; a person confirms that.",
      );
    } else {
      lines.push(
        `- Approved figures you may state exactly: ${quotes.map((q) => `${q.label} — ${q.amount} ${policy.currency} per ${q.unit}`).join("; ")}. ` +
          "No other figure exists. Do not compute, adjust or extrapolate one.",
      );
    }

    // --- the objection on the table ----------------------------------------
    const spent = exhaustedObjections(this.history, catalog).map((o) => o.id);
    for (const match of matches) {
      const objection = match.objection;
      const raised = this.history[objection.id] ?? 1;
      const acknowledge = objection.acknowledge[language] ?? objection.acknowledge[catalog.language];
      lines.push(`- The customer raised "${objection.id}" (${raised} time(s) on this call).`);
      if (acknowledge) lines.push(`  Acknowledge it first, like this: "${acknowledge}"`);
      if (spent.includes(objection.id)) {
        lines.push(
          "  They have raised this more than once and your answer is not landing. Stop re-explaining. " +
            "Acknowledge that, and offer to have a person call them.",
        );
        continue;
      }
      if (objection.evidence.length > 0) {
        lines.push(
          `  Answer using ONLY these verified sources: ${objection.evidence.join(", ")}. ` +
            "If the knowledge section above does not contain the answer, say you will have it confirmed — do not fill the gap yourself.",
        );
      } else {
        lines.push(
          "  There is no verified information configured for this objection. Say honestly that you will have " +
            "someone confirm it, rather than answering from general knowledge.",
        );
      }
      const followUp = objection.followUp?.[language] ?? objection.followUp?.[catalog.language];
      if (followUp) lines.push(`  Then ask exactly one question: "${followUp}"`);
      if (objection.endsQualification) {
        lines.push("  This means 'not now'. Close warmly, do not push, and do not ask further qualification questions.");
      }
    }
    if (matches.length === 0) {
      lines.push("- No objection was detected this turn. Continue the conversation normally.");
    }

    // --- what may actually be offered --------------------------------------
    const offers = availableConcessions(policy, this.snapshot, language);
    if (offers.length > 0) {
      lines.push("- Authorized right now (say it in these words, and never more than this):");
      for (const offer of offers) lines.push(`  • ${offer.label}: "${offer.script}"`);
    } else {
      lines.push(
        "- Nothing is authorized for you to offer on this call. Do not invent a discount, a free extra, a " +
          "payment plan or a held price to keep the conversation going.",
      );
    }
    const approvable = approvableConcessions(policy, this.snapshot);
    if (approvable.length > 0) {
      lines.push(
        `- A person could still approve: ${approvable.join(", ")}. You may offer to ASK. You may not say it has been agreed.`,
      );
    }
    const financing = policy.financing.filter((f) => f.verified);
    if (financing.length > 0) {
      lines.push(
        `- Verified options you may mention: ${financing
          .map((f) => `${f.label[language] ?? f.label[policy.language]} — ${f.description[language] ?? f.description[policy.language]}`)
          .join("; ")}.`,
      );
    }

    // --- hard prohibitions and escalation ----------------------------------
    if (policy.prohibitedPromises.length > 0) {
      lines.push("- Never say any of the following, in any wording:");
      for (const promise of policy.prohibitedPromises) lines.push(`  • ${promise}`);
    }
    if (shouldEscalate(policy, this.snapshot)) {
      lines.push(
        "- This has gone past what you may settle. Offer to have a member of the team call them, and use the " +
          "handoff capability rather than continuing to negotiate.",
      );
    }
    lines.push(
      "- Never pressure, never imply an offer expires unless the policy above says so, and never agree to " +
        "something because the customer insists. An unauthorized 'yes' is worse than an honest 'let me check'.",
    );
    return lines.join("\n");
  }
}
