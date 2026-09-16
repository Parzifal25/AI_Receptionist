import { describe, expect, it } from "vitest";
import { parseAllNumbers, parseNumber, spokenDigitSequence } from "@halo/language/parsers/numerals";

/**
 * Corpus for Telugu / Tenglish / English numerals and Indian scales.
 * Everything a solar qualification call actually hears about bills, units,
 * capacity and money.
 */
const CORPUS: Array<[string, number]> = [
  // ASCII digits and Indian grouping
  ["3000", 3000],
  ["Rs 3,000 vastundi", 3000],
  ["1,50,000 rupees", 150000],
  ["2.5", 2.5],
  ["2k", 2000],
  ["3.5k", 3500],
  // Telugu digits
  ["౩౦౦౦", 3000],
  ["నా బిల్లు ౨౫౦౦", 2500],
  // Telugu words
  ["రెండు వేలు", 2000],
  ["మూడు వేల ఐదు వందలు", 3500],
  ["ఒక లక్ష యాభై వేలు", 150000],
  ["ఐదు వందలు", 500],
  ["పది", 10],
  ["ఇరవై ఐదు", 25],
  ["రెండు లక్షలు", 200000],
  ["ఒక కోటి", 10000000],
  // Romanized Telugu
  ["rendu velu", 2000],
  ["moodu vandalu", 300],
  ["oka laksha", 100000],
  ["padi", 10],
  // English words and Indian scale words
  ["two thousand", 2000],
  ["three lakh", 300000],
  ["1.5 lakh", 150000],
  ["five hundred", 500],
  ["twenty five", 25],
  // Mixed / code-switched — the normal case for this customer
  ["రెండు thousand", 2000],
  ["2 వేలు", 2000],
  ["మా bill 3000 వస్తుంది", 3000],
  ["current bill rendu velu ki paiga", 2000],
  ["2 lakh varaku", 200000],
];

describe("numeral parsing corpus", () => {
  it.each(CORPUS)("parses %s → %i", (text, expected) => {
    const parsed = parseNumber(text);
    expect(parsed, text).not.toBeNull();
    expect(parsed!.value, text).toBe(expected);
    expect(parsed!.raw.length, text).toBeGreaterThan(0);
  });

  it("returns null when there is no number", () => {
    expect(parseNumber("నాకు తెలియదు")).toBeNull();
    expect(parseNumber("I don't know")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });

  it("finds several numbers and lowers confidence when the text is ambiguous", () => {
    const all = parseAllNumbers("bill 3000, capacity 3 kilowatt");
    expect(all.map((n) => n.value)).toEqual([3000, 3]);
    expect(parseNumber("bill 3000, capacity 3 kilowatt")!.confidence).toBeLessThanOrEqual(0.6);
  });

  it("marks the source so callers know how much to trust it", () => {
    expect(parseNumber("3000")!.source).toBe("digits");
    expect(parseNumber("రెండు వేలు")!.source).toBe("words");
    expect(parseNumber("2 వేలు")!.source).toBe("mixed");
    expect(parseNumber("రెండు వేలు")!.confidence).toBeGreaterThan(0.8);
  });

  it("reads spoken digit sequences including 'double'", () => {
    expect(spokenDigitSequence("nine eight seven six five four three two one zero")).toBe("9876543210");
    expect(spokenDigitSequence("tommidi enimidi edu")).toBe("987");
    expect(spokenDigitSequence("nine double eight seven")).toBe("9887");
    expect(spokenDigitSequence("తొమ్మిది ఎనిమిది")).toBe("98");
    expect(spokenDigitSequence("no digits here")).toBeNull();
  });
});
