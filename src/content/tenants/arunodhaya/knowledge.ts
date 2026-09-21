import type { BusinessFact } from "./supplied";

/**
 * Arunodhaya Phase 4 — the knowledge structure (brief §11).
 *
 * Deliberately separated, because these change at different rates and have
 * different authority:
 *
 *   PRODUCT / INSTALLATION  — slow-moving, technical, answered from facts.
 *   COMMERCIAL              — prices, subsidies, payback. Fast-moving and
 *                             legally consequential: these live in the
 *                             negotiation POLICY (configuration), not in a
 *                             prompt, so changing a price is a config change
 *                             and a new agent version, not a prompt edit.
 *   NEGOTIATION POLICY      — what may be offered. See negotiation.ts.
 *   ESCALATION POLICY       — when a person takes over. See escalation.ts.
 *
 * EVERYTHING commercially or technically specific below is
 * `supplied_pending`. Arunodhaya has supplied no verified figures, so the
 * agent's honest behaviour is to say it will have someone confirm. That is
 * not a limitation to be worked around; it is the correct output of this
 * configuration until real answers arrive.
 */

const te = (question: string) => ({ "te-IN": question });

export const ARUNODHAYA_FACTS: BusinessFact[] = [
  // --- product ------------------------------------------------------------
  {
    id: "panel_brands",
    question: te("మీరు ఏ కంపెనీ ప్యానెల్స్ వాడతారు?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  {
    id: "panel_warranty",
    question: te("ప్యానెల్స్ మీద వారంటీ ఎన్ని సంవత్సరాలు?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  {
    id: "system_types",
    question: te("ఆన్-గ్రిడ్, ఆఫ్-గ్రిడ్ — ఏవి పెడతారు?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  // --- installation -------------------------------------------------------
  {
    id: "installation_duration",
    question: te("ఇన్‌స్టలేషన్‌కి ఎన్ని రోజులు పడుతుంది?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  {
    id: "roof_requirement",
    question: te("ఎంత స్థలం కావాలి?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  {
    id: "service_areas",
    question: te("మీరు ఏ ప్రాంతాల్లో సర్వీస్ చేస్తారు?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  {
    id: "maintenance",
    question: te("మెయింటెనెన్స్ ఎలా ఉంటుంది?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  // --- commercial (answered from policy, never from the model) ------------
  {
    id: "price_per_kw",
    question: te("ఒక కిలోవాట్‌కి ఎంత ఖర్చు అవుతుంది?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  {
    id: "subsidy",
    question: te("గవర్నమెంట్ సబ్సిడీ ఎంత వస్తుంది?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  {
    id: "payback_facts",
    question: te("ఖర్చు ఎన్ని సంవత్సరాల్లో తిరిగి వస్తుంది?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  {
    id: "financing_availability",
    question: te("లోన్ లేదా EMI సౌకర్యం ఉందా?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
  {
    id: "site_visit_cost",
    question: te("సర్వేకి ఏమైనా ఛార్జీ ఉంటుందా?"),
    answer: {},
    status: "supplied_pending",
    source: "",
  },
];

/**
 * The prompt section describing what the agent must NOT answer from its own
 * knowledge. Rendered from `supplied_pending` facts, so it shrinks
 * automatically as the business supplies real answers — nobody has to
 * remember to delete a line.
 */
export function pendingFactGuidance(facts: BusinessFact[], language: string): string {
  const pending = facts.filter((f) => f.status !== "verified");
  if (pending.length === 0) return "";
  const lines = [
    "Questions you do NOT have a verified answer for (system):",
    "You may recognise these questions. You must not answer them from general knowledge, from what is",
    "typical in the industry, or from anything you were trained on. Say plainly that you will have someone",
    "from the team confirm the exact answer, and continue the conversation.",
  ];
  for (const fact of pending) {
    const question = fact.question[language] ?? Object.values(fact.question)[0];
    if (question) lines.push(`- ${question}`);
  }
  return lines.join("\n");
}
