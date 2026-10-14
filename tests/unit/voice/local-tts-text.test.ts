import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardinal, normalizeForSpeech, ordinal, PAUSE_MS, pauseSamples, planSpeech, trimAndFade, UnspeakableTextError } from "@halo/providers/voice-vendors/local-tts-text";

/**
 * The local TTS text pipeline. The cases are shared with the Python worker
 * (services/pipecat-worker/test_local_tts_text.py): both implementations must
 * say exactly the same words for the same line.
 */
interface Fixture {
  available: string[];
  cases: { text: string; base: string | null; normalized: string; segments: [string, string, string][] }[];
  errors: { text: string; base: string | null; available: string[] }[];
  cardinals: Record<string, Record<string, string>>;
  ordinals: Record<string, Record<string, string>>;
}
const fixture: Fixture = JSON.parse(readFileSync(join(__dirname, "../../fixtures/local-tts-text-cases.json"), "utf8"));

describe("local TTS text pipeline (shared fixture)", () => {
  it.each(fixture.cases)("normalizes and segments %#: $text", ({ text, base, normalized, segments }) => {
    expect(normalizeForSpeech(text, base, fixture.available)).toBe(normalized);
    expect(planSpeech(text, base, fixture.available).map(s => [s.language, s.text, s.pause])).toEqual(segments);
  });

  it("refuses text no installed voice can speak, as before", () => {
    for (const { text, base, available } of fixture.errors) expect(() => planSpeech(text, base, available)).toThrow(UnspeakableTextError);
  });

  it("writes cardinals and ordinals in Telugu and Indian English", () => {
    for (const language of ["te", "en"]) {
      for (const [n, words] of Object.entries(fixture.cardinals[language])) expect(cardinal(Number(n), language)).toBe(words);
      for (const [n, words] of Object.entries(fixture.ordinals[language])) expect(ordinal(Number(n), language)).toBe(words);
    }
  });
});

describe("local TTS text pipeline (invariants)", () => {
  it("leaves no digit for espeak to read as one long cardinal", () => {
    for (const { text, base } of fixture.cases) expect(normalizeForSpeech(text, base, fixture.available)).not.toMatch(/[0-9]/);
  });

  it("leaves no slash, currency sign or bracket for espeak to read as a word", () => {
    for (const { text, base } of fixture.cases) expect(normalizeForSpeech(text, base, fixture.available)).not.toMatch(/[/$₹()]/);
  });

  it("spells a booking code in one English segment, whatever the line's language", () => {
    for (const line of ["మీ బుకింగ్ కోడ్ AR-2041.", "Your booking code is AR-2041."]) {
      const segments = planSpeech(line, line.startsWith("Your") ? "en" : "te", fixture.available);
      expect(segments.filter(s => s.text.includes("ay ar, two zero four one"))).toEqual([expect.objectContaining({ language: "en" })]);
    }
  });

  it("keeps a phone number and a date inside one segment", () => {
    const segments = planSpeech("మీ ఫోన్ నంబర్ 9876543210, దయచేసి ఇది సరైనదేనా అని ఒకసారి చెప్పండి.", "te", fixture.available);
    expect(segments.filter(s => s.text.includes("తొమ్మిది ఎనిమిది ఏడు ఆరు ఐదు, నాలుగు మూడు రెండు ఒకటి సున్నా"))).toHaveLength(1);
    expect(planSpeech("We will visit you on Mar. 24, 2026 between ten and eleven in the morning, okay?", "en", fixture.available)
      .some(s => s.text.includes("March twenty fourth, two thousand twenty six"))).toBe(true);
  });

  it("does not split at an abbreviation's dot", () => {
    expect(planSpeech("Dr. Rao will call you.", "en", fixture.available)).toEqual([{ language: "en", text: "Doctor Rao will call you.", pause: "sentence" }]);
  });
});

describe("local TTS segment joining", () => {
  const rate = 1000;
  it("trims each segment's own silence, keeps a margin, and fades both edges", () => {
    const samples = new Float32Array(300);
    samples.fill(0.5, 100, 200);
    const shaped = trimAndFade(samples, rate, { keepMs: 10, fadeMs: 5 });
    expect(shaped.length).toBe(120);
    expect(shaped[0]).toBe(0);
    expect(shaped[shaped.length - 1]).toBe(0);
    expect(shaped[60]).toBe(0.5);
  });

  it("leaves a silent segment alone instead of dropping it", () => {
    const silence = new Float32Array(50);
    expect(trimAndFade(silence, rate)).toBe(silence);
  });

  it("inserts the pause for how a segment ends", () => {
    expect(pauseSamples("sentence", 8000).length).toBe((8000 * PAUSE_MS.sentence) / 1000);
    expect(pauseSamples("switch", 8000, { sentence: 0, clause: 0, switch: 20 }).length).toBe(160);
  });
});
