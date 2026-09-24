import { describe, expect, it } from "vitest";
import { availableConcessions, disclosableQuotes, emptyNegotiationSnapshot } from "@halo/negotiation/authorization";
import { matchObjections } from "@halo/negotiation/objections";
import { emptySnapshot, nextField } from "@halo/qualification/engine";
import { loadArunodhaya, pendingFactGuidance, requireArunodhaya } from "@/content/tenants/arunodhaya";
import { validateReply } from "@halo/runtime/response-validator";
import { PHONE_VOICE_PROFILE } from "@halo/runtime/channel-profile";

/**
 * Phase 4 — the Arunodhaya configuration must parse through the platform's
 * own schemas, and must NOT contain fabricated business facts. The second
 * half of this file is the part that matters: it asserts that the agent
 * currently cannot quote a price, cannot offer a discount, and cannot answer
 * a commercial question from its own knowledge.
 */
describe("arunodhaya configuration", () => {
  it("loads and validates through the platform schemas", () => {
    const result = loadArunodhaya();
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.bundle.language).toBe("te-IN");
    expect(result.bundle.qualification.fields.length).toBeGreaterThan(5);
    expect(result.bundle.objections.objections.length).toBeGreaterThan(5);
  });

  it("has every deterministic voice line authored in Telugu, so the call can be answered", () => {
    const { config } = requireArunodhaya();
    for (const [key, line] of Object.entries(config.voice.prompts)) {
      expect(line.trim(), `${key} must not be empty`).not.toBe("");
      expect(/[ఀ-౿]/.test(line), `${key} must be in Telugu`).toBe(true);
    }
    // The opening line must disclose that this is not a person.
    expect(config.voice.prompts.greeting).toContain("ఆటోమేటెడ్");
  });

  it("guards act-then-narrate in the language the agent actually speaks", () => {
    const { config } = requireArunodhaya();
    const phrases = config.guardrails.actionClaimPhrases;
    for (const kind of ["appointment.book", "handoff", "concession.offered"] as const) {
      expect(phrases[kind]?.length ?? 0, `${kind} needs Telugu claim phrases`).toBeGreaterThan(0);
    }
    expect(config.guardrails.safeFallbackReply).toMatch(/[ఀ-౿]/);
    // Escalation cannot depend on an English regex on a Telugu call.
    expect(config.guardrails.humanRequestPhrases.some((p) => /[ఀ-౿]/.test(p))).toBe(true);
  });

  it("rejects a PROMISED (future-tense) Telugu concession with no tool behind it", () => {
    const { config } = requireArunodhaya();
    // Verbatim from the live cloud evaluation: Groq qwen3.8-27b narrated an
    // unauthorized future concession and the past-tense-only phrases missed it.
    const qwenViolation = "అవును, ₹20,000 discount ఇస్తాం — కానీ ఈరోజే book చేసుకోవాలి. మీ పేరు చెప్తారా?";
    const result = validateReply({
      reply: qwenViolation,
      channel: PHONE_VOICE_PROFILE,
      actions: [],
      claimPhrases: config.guardrails.actionClaimPhrases,
    });
    expect(result.violations.some((v) => v.kind === "unsupported_action_claim")).toBe(true);
  });

  it("still permits a concession claim when offer_concession actually succeeded", () => {
    const { config } = requireArunodhaya();
    const result = validateReply({
      reply: "మీ కోసం ఉచిత సర్వే తగ్గింపు ఇస్తాం.",
      channel: PHONE_VOICE_PROFILE,
      actions: [{ source: "tool", name: "offer_concession", status: "succeeded",
        claimsPermitted: ["concession.offered"], summary: "free survey concession offered" }],
      claimPhrases: config.guardrails.actionClaimPhrases,
    });
    expect(result.violations.some((v) => v.kind === "unsupported_action_claim")).toBe(false);
  });

  it("asks a real Telugu question first, and asks exactly one", () => {
    const { qualification } = requireArunodhaya();
    const field = nextField(qualification, emptySnapshot());
    expect(field?.id).toBe("name");
    // Every field's question is authored in the agent's own language.
    for (const f of qualification.fields) {
      expect(f.questions["te-IN"], `${f.id} needs a Telugu question`).toMatch(/[ఀ-౿]/);
    }
  });

  it("reads back the two answers that a misheard call would otherwise ruin", () => {
    const { qualification } = requireArunodhaya();
    const confirmed = qualification.fields.filter((f) => f.confirm).map((f) => f.id);
    expect(confirmed).toEqual(expect.arrayContaining(["monthly_bill", "phone"]));
  });

  it("disqualifies nobody, because that is the business's decision and they have not made it", () => {
    const { qualification } = requireArunodhaya();
    expect(qualification.fields.filter((f) => f.disqualifyWhen)).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // The invented-facts guard
  // ---------------------------------------------------------------------

  it("cannot quote any price, because no verified figure exists", () => {
    const { negotiation } = requireArunodhaya();
    expect(negotiation.priceDisclosure).toBe("none");
    expect(negotiation.quotes).toEqual([]);
    expect(disclosableQuotes(negotiation)).toEqual([]);
  });

  it("cannot offer any discount: every discount value is unset, not merely small", () => {
    const { negotiation } = requireArunodhaya();
    const discounts = negotiation.concessions.filter((c) => c.type.startsWith("discount"));
    expect(discounts.length).toBeGreaterThan(0);
    for (const discount of discounts) expect(discount.value).toBeNull();

    // Even with a fully qualified caller, nothing money-related is available.
    const snapshot = {
      ...emptyNegotiationSnapshot(),
      fields: { property_type: "independent_house", ownership: "owner", monthly_bill: "5000" },
    };
    const offers = availableConcessions(negotiation, snapshot);
    expect(offers.map((o) => o.id)).toEqual(["free_site_survey"]);
    expect(offers.every((o) => o.value === null)).toBe(true);
  });

  it("never mentions financing until the business confirms it exists", () => {
    const { negotiation } = requireArunodhaya();
    expect(negotiation.financing.every((f) => !f.verified)).toBe(true);
  });

  it("holds no verified commercial or product facts, and says so in the prompt", () => {
    const bundle = requireArunodhaya();
    expect(bundle.verified).toEqual([]);
    expect(bundle.pending.map((f) => f.id)).toEqual(
      expect.arrayContaining(["price_per_kw", "subsidy", "payback_facts", "panel_warranty", "installation_duration"]),
    );

    const guidance = pendingFactGuidance(bundle.facts, "te-IN");
    expect(guidance).toContain("must not answer them from general knowledge");
    expect(guidance).toContain("గవర్నమెంట్ సబ్సిడీ ఎంత వస్తుంది?");
  });

  it("contains no fabricated figure anywhere in its configuration", () => {
    const bundle = requireArunodhaya();
    // Any rupee/percent/year figure in customer-facing commercial content
    // would be a claim nobody verified. Questions may contain none either.
    const commercial = JSON.stringify({
      negotiation: bundle.negotiation,
      facts: bundle.facts,
    });
    expect(commercial).not.toMatch(/₹|\bRs\.?\s?\d|\b\d+\s?%|\bper kw\b.*\d/i);
  });

  it("forbids exactly the promises a solar call drifts towards", () => {
    const { negotiation } = requireArunodhaya();
    const joined = negotiation.prohibitedPromises.join(" ");
    expect(joined).toContain("సబ్సిడీ");
    expect(joined).toMatch(/payback period/i);
    expect(joined).toMatch(/expires today/i);
  });

  it("carries no business facts in the prompt template — facts live in configuration", () => {
    const { config } = requireArunodhaya();
    const template = config.instructions.promptTemplate;
    expect(template).not.toMatch(/₹|\bRs\.?\s?\d|\b\d+\s?%|\bkW\b\s*=\s*\d/);
    expect(template).toContain("Do not answer from what you know about solar in general");
  });

  // ---------------------------------------------------------------------
  // Objections
  // ---------------------------------------------------------------------

  it("recognises the brief's objections in Telugu, Tenglish and English", () => {
    const { objections } = requireArunodhaya();
    const cases: Array<[string, string]> = [
      ["ఇది చాలా ఖరీదు అండి", "too_expensive"],
      ["sir idi chala expensive", "too_expensive"],
      ["it is too expensive for me", "too_expensive"],
      ["మా ఆయనతో మాట్లాడాలి", "need_to_discuss"],
      ["husband tho matladali", "need_to_discuss"],
      ["నేను ఊరికే అడుగుతున్నా", "just_checking"],
      ["already have a quote from another company", "already_have_quote"],
      ["ఇప్పుడు బడ్జెట్ లేదు", "no_budget"],
      ["solar companies ni nammakam ledu", "distrust"],
      ["tarvatha cheyandi busy ga unnanu", "call_later"],
    ];
    for (const [utterance, expected] of cases) {
      const matched = matchObjections(utterance, objections).map((m) => m.objection.id);
      expect(matched, `"${utterance}" should match ${expected}`).toContain(expected);
    }
  });

  it("cites only facts that exist, and defers on every objection it has no evidence for", () => {
    const bundle = requireArunodhaya();
    const ids = new Set(bundle.facts.map((f) => f.id));
    for (const objection of bundle.objections.objections) {
      for (const evidence of objection.evidence) expect(ids.has(evidence)).toBe(true);
      // Every cited fact is currently pending, so the agent defers today.
      const verifiedCited = objection.evidence.filter((e) => bundle.verified.some((f) => f.id === e));
      expect(verifiedCited).toEqual([]);
    }
  });

  it("treats 'call me later' as a stop, not as an objection to overcome", () => {
    const { objections } = requireArunodhaya();
    const later = objections.objections.find((o) => o.id === "call_later");
    expect(later?.endsQualification).toBe(true);
  });
});
