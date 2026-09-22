import { describe, expect, it } from "vitest";
import { ARUNODHAYA_FACTS } from "@/content/tenants/arunodhaya/knowledge";
import { pendingFacts } from "@/content/tenants/arunodhaya/supplied";
import { SMOKE_CATEGORIES, VOICE_SMOKE_UTTERANCES } from "../../fixtures/voice-smoke-utterances";

/**
 * The smoke set is read by a person during a live call, which means nothing
 * stops it drifting — except this. Two properties are worth pinning:
 *
 *   1. it still covers the eight things a caller does;
 *   2. it still invents no business fact.
 *
 * The second is the one that matters. Every Arunodhaya fact is currently
 * `supplied_pending`, so a smoke utterance that quietly asserted a price or
 * a subsidy would be the exact failure `supplied.ts` exists to prevent —
 * and it would look like documentation rather than like a bug.
 */

const TELUGU = /[ఀ-౿]/;

describe("voice smoke-test set", () => {
  it("covers every category a caller actually uses, exactly once", () => {
    expect(VOICE_SMOKE_UTTERANCES.map((u) => u.category).sort()).toEqual([...SMOKE_CATEGORIES].sort());
  });

  it("gives all three language varieties for every category", () => {
    for (const utterance of VOICE_SMOKE_UTTERANCES) {
      expect(utterance.english.trim(), utterance.category).not.toBe("");
      expect(utterance.telugu.trim(), utterance.category).not.toBe("");
      expect(utterance.tenglish.trim(), utterance.category).not.toBe("");
    }
  });

  it("writes Telugu in Telugu script and Tenglish in Latin script", () => {
    for (const utterance of VOICE_SMOKE_UTTERANCES) {
      expect(TELUGU.test(utterance.telugu), `${utterance.category}: telugu must be Telugu script`).toBe(true);
      // Tenglish is Telugu spoken with Latin letters — that is the point of
      // having it as a separate variety from the Telugu-script line.
      expect(TELUGU.test(utterance.tenglish), `${utterance.category}: tenglish must be Latin script`).toBe(false);
    }
  });

  it("states no business fact, because this repository has none verified", () => {
    // Guard the premise first: if a fact were ever verified, this test's
    // reasoning would need revisiting rather than silently still passing.
    expect(pendingFacts(ARUNODHAYA_FACTS).length).toBe(ARUNODHAYA_FACTS.length);

    // A caller ASKING about a price is the point of the price utterance; an
    // utterance ANSWERING with one is the failure. Currency amounts and
    // percentages in the caller's own words are fine (a caller stating their
    // own bill), so the check is on the expectation text, which is what an
    // operator might mistake for a specification of the right answer.
    for (const utterance of VOICE_SMOKE_UTTERANCES) {
      expect(utterance.expect, `${utterance.category}: expectation must not assert a figure`).not.toMatch(
        /(₹|rs\.?\s*\d|\d+\s*(%|percent|lakh|crore|year warranty|years warranty))/i,
      );
    }
  });

  it("says where every non-English line came from, so it can be checked", () => {
    for (const utterance of VOICE_SMOKE_UTTERANCES) {
      expect(utterance.source.trim(), utterance.category).not.toBe("");
    }
  });

  it("quotes the repository's own text where it claims to", () => {
    const priceFact = ARUNODHAYA_FACTS.find((f) => f.id === "price_per_kw");
    const price = VOICE_SMOKE_UTTERANCES.find((u) => u.category === "price")!;
    expect(price.telugu).toBe(priceFact!.question["te-IN"]);
  });

  it("keeps understanding and speaking as separate judgements", () => {
    // The price utterance is the one that catches an invented fact, so its
    // expectation must say so in terms an operator cannot misread.
    const price = VOICE_SMOKE_UTTERANCES.find((u) => u.category === "price")!;
    expect(price.expect).toMatch(/FAILURE/);
    const appointment = VOICE_SMOKE_UTTERANCES.find((u) => u.category === "appointment")!;
    expect(appointment.expect).toMatch(/ACT-THEN-NARRATE/);
  });
});
