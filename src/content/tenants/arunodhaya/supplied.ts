/**
 * Arunodhaya Phase 4 — the ⟨SUPPLIED⟩ discipline.
 *
 * Every factual claim a solar sales agent could make — price per kW, subsidy
 * amount, payback period, panel warranty, installation lead time, generation
 * estimates — is a claim about a real business that a customer will act on.
 * None of it exists in this repository, and none of it may be guessed.
 *
 * So each fact is declared here with a status:
 *
 *   verified        — the business supplied it and someone confirmed it.
 *                     The agent may state it.
 *   supplied_pending — the business has NOT supplied it yet. The agent is
 *                     told the question exists, told explicitly that it has
 *                     no answer, and told to offer a person. It is never
 *                     rendered as an answer, and never filled with a
 *                     plausible-looking number.
 *
 * The point is that a missing fact is VISIBLE — in the config, in the prompt
 * and in a test — rather than quietly becoming whatever the model believes
 * about solar panels in India.
 */

export type FactStatus = "verified" | "supplied_pending";

export interface BusinessFact {
  id: string;
  /** What a customer would ask, in the agent's language. */
  question: Record<string, string>;
  /** The verified answer, in the agent's language. Empty while pending. */
  answer: Record<string, string>;
  status: FactStatus;
  /** Who confirmed it and when; required before a fact may be `verified`. */
  source: string;
}

export function verifiedFacts(facts: BusinessFact[]): BusinessFact[] {
  return facts.filter((f) => f.status === "verified" && Object.values(f.answer).some((a) => a.trim()));
}

export function pendingFacts(facts: BusinessFact[]): BusinessFact[] {
  return facts.filter((f) => f.status !== "verified" || !Object.values(f.answer).some((a) => a.trim()));
}

/**
 * A fact declared `verified` with no answer, or with no source, is a
 * configuration bug — it would let an unconfirmed claim reach a customer.
 * The bundle refuses to load when this returns anything.
 */
export function factConfigurationErrors(facts: BusinessFact[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const fact of facts) {
    if (ids.has(fact.id)) errors.push(`duplicate fact id "${fact.id}"`);
    ids.add(fact.id);
    if (fact.status === "verified") {
      if (!Object.values(fact.answer).some((a) => a.trim())) errors.push(`fact "${fact.id}" is marked verified but has no answer`);
      if (!fact.source.trim()) errors.push(`fact "${fact.id}" is marked verified but names no source`);
    }
    if (!Object.values(fact.question).some((q) => q.trim())) errors.push(`fact "${fact.id}" has no question text`);
  }
  return errors;
}
