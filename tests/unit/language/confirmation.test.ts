import { describe, expect, it } from "vitest";
import { classifyConfirmation, isExplicitConfirmation } from "@halo/language/confirmation";
import { TELUGU_LEXICON } from "@halo/language/lexicon";

/**
 * HALO Phase 4.5 Sprint 2 — confirmation detection.
 *
 * Read these as a table of what does and does not authorize a side-effecting
 * action. The asymmetry is deliberate: a missed yes costs the caller one more
 * question, an invented yes runs something nobody agreed to.
 */

const reading = (text: string) => classifyConfirmation(text).reading;

describe("confirmation detection — English (unchanged contract)", () => {
  it("accepts every phrase the English-only rule accepted", () => {
    for (const yes of [
      "yes", "yes please", "yeah", "yep", "yup", "sure", "ok", "okay", "OK, do that",
      "correct", "confirm", "confirmed", "please do", "go ahead", "do it",
      "that's right", "sounds good", "absolutely", "of course",
    ]) {
      expect(isExplicitConfirmation(yes)).toBe(true);
    }
  });

  it("still requires English to LEAD with the yes", () => {
    // The rule this replaces was start-anchored, and English keeps it: a
    // sentence that merely mentions a yes is not one.
    expect(isExplicitConfirmation("I said yes to the other company")).toBe(false);
    expect(isExplicitConfirmation("my colleague will say yes")).toBe(false);
  });

  it("reads rejections, hedges and questions as anything but a yes", () => {
    expect(reading("no")).toBe("rejection");
    expect(reading("no thanks")).toBe("rejection");
    expect(reading("not interested")).toBe("rejection");
    expect(reading("maybe later")).toBe("uncertain");
    expect(reading("let me think about it")).toBe("uncertain");
    expect(reading("I'm not sure")).toBe("uncertain");
    expect(reading("are you sure?")).toBe("question");
    expect(reading("hmm")).toBe("acknowledgement");
    expect(reading("the weather is nice")).toBe("none");
  });

  it("does not find a no inside an unrelated English word", () => {
    // Substring matching would read "know", "phone number" and "nothing" as
    // rejections. On a confirmation gate that is a real behaviour change.
    expect(reading("I know")).not.toBe("rejection");
    expect(reading("my phone number is nine eight")).not.toBe("rejection");
    expect(reading("yes, that is my phone number")).toBe("affirmative");
  });
});

describe("confirmation detection — Telugu", () => {
  it("accepts the ordinary spoken yes", () => {
    for (const yes of ["సరే", "సరేనండి", "అవును", "అవునండి", "ఓకే", "అవును, చేయండి", "చేసేయండి"]) {
      expect(isExplicitConfirmation(yes)).toBe(true);
    }
  });

  it("accepts a verb-final confirmation, which is how Telugu actually says it", () => {
    // The authorizing verb is the LAST word. A start-anchored rule misses
    // every one of these, which is how a Telugu caller ends up unable to
    // confirm anything at all.
    expect(isExplicitConfirmation("మీరు చెప్పినట్టు చేయండి")).toBe(true);
    expect(classifyConfirmation("మీరు చెప్పినట్టు చేయండి").rule).toBe("anywhere");
  });

  it("refuses rejection, hedging, not-knowing and the question form", () => {
    expect(reading("వద్దు")).toBe("rejection");
    expect(reading("వద్దండి")).toBe("rejection");
    expect(reading("నాకు ఆసక్తి లేదు")).toBe("rejection");
    expect(reading("ఇంకా ఆలోచిస్తాను")).toBe("uncertain");
    expect(reading("తెలియదు")).toBe("uncertain");
    expect(reading("సరే చూద్దాం")).toBe("uncertain");
    expect(reading("సరేనా?")).toBe("question");
    expect(reading("సరేనా")).toBe("question");
    expect(reading("అవునా")).toBe("question");
    expect(reading("అలాగా")).toBe("acknowledgement");
    for (const notYes of ["వద్దు", "ఇంకా ఆలోచిస్తాను", "తెలియదు", "సరే చూద్దాం", "సరేనా?", "అలాగా"]) {
      expect(isExplicitConfirmation(notYes)).toBe(false);
    }
  });

  it("reads a negated Telugu verb as a rejection even though it is one word", () => {
    // Telugu carries the negation inside the word: "చెప్పలేదు" contains
    // "లేదు", so agglutination fails closed rather than open.
    expect(reading("నేను చేయండి అని చెప్పలేదు")).toBe("rejection");
  });

  it("does NOT treat every Telugu affirmative as authorization", () => {
    // The general intent lexicon calls these affirmative, and in conversation
    // they are. None of them is consent to book, cancel or transfer anything.
    for (const weak of ["ఉంది", "కావాలి", "చెప్పండి"]) {
      expect(TELUGU_LEXICON.affirm).toContain(weak);
      expect(isExplicitConfirmation(weak)).toBe(false);
    }
  });
});

describe("confirmation detection — Tenglish", () => {
  it("accepts romanized Telugu, in the spellings transliteration actually produces", () => {
    for (const yes of ["sare", "avunu", "avnu", "cheyyandi", "cheyandi", "sare cheyyandi", "meeru cheppinatlu cheyyandi"]) {
      expect(isExplicitConfirmation(yes)).toBe(true);
    }
  });

  it("refuses the romanized rejections and hedges", () => {
    expect(reading("vaddu")).toBe("rejection");
    expect(reading("cheyyakandi")).toBe("rejection");
    expect(reading("naaku asakti ledu")).toBe("rejection");
    expect(reading("teliyadu")).toBe("uncertain");
    expect(reading("tarvatha cheyyandi")).toBe("uncertain");
    expect(reading("sare chuddam")).toBe("uncertain");
    expect(reading("sarena")).toBe("question");
  });

  it("handles a code-mixed confirmation", () => {
    expect(isExplicitConfirmation("ok sir, cheyyandi")).toBe(true);
    expect(isExplicitConfirmation("ok but tarvatha")).toBe(false);
  });
});

describe("confirmation detection — shape and determinism", () => {
  it("treats empty, whitespace and punctuation-only input as no answer", () => {
    for (const nothing of ["", "   ", "\n", "..."]) {
      expect(reading(nothing)).toBe("none");
      expect(isExplicitConfirmation(nothing)).toBe(false);
    }
  });

  it("is deterministic and reports what decided it", () => {
    expect(classifyConfirmation("సరే")).toEqual(classifyConfirmation("సరే"));
    expect(classifyConfirmation("సరే")).toEqual({ reading: "affirmative", matched: "సరే", rule: "anywhere" });
    expect(classifyConfirmation("yes please")).toEqual({
      reading: "affirmative",
      matched: "yes",
      rule: "start_anchored",
    });
  });

  it("checks rejection, hedging and question forms BEFORE agreement", () => {
    // Each of these contains a yes and is not one. Order is the safety rule.
    expect(reading("సరే కానీ వద్దు")).toBe("rejection");
    expect(reading("yes but not now")).toBe("uncertain");
    expect(reading("ok?")).toBe("question");
  });

  it("survives mixed script, digits and zero-width joiners", () => {
    expect(isExplicitConfirmation("అవును, 9 గంటలకి")).toBe(true);
    expect(isExplicitConfirmation("స‍రే")).toBe(true);
    expect(reading("వ‌ద్దు")).toBe("rejection");
  });
});
