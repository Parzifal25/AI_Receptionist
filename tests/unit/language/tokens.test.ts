import { describe, expect, it } from "vitest";
import {
  bytesPerChar,
  classifyCodePoint,
  DEFAULT_TOKEN_WEIGHTS,
  estimateTokens,
  estimatedTokenCount,
  TOKEN_ESTIMATOR_ID,
  utf8Bytes,
} from "@halo/language/tokens";
import { truncateChars, truncateToEstimatedTokens } from "@halo/language/truncate";

/**
 * HALO Phase 4.5 Sprint 2 — the multilingual token estimate.
 *
 * The property these tests exist to defend is one-directional: the estimator
 * may over-count a non-Latin prompt, and must never under-count one. An
 * over-estimate drops a knowledge snippet; an under-estimate lets a call
 * overrun a real context window with nothing reporting a problem, which is
 * exactly the failure the character-only budget had.
 */

const ENGLISH = "I want to know about solar, my monthly bill keeps going up every month.";
const TELUGU = "నాకు సోలార్ గురించి తెలుసుకోవాలి, నెల బిల్లు ఎక్కువ వస్తోంది.";
const TENGLISH = "naaku solar gurinchi telusukovali, nela bill ekkuva vastondi";
const MIXED = "నా bill నెలకి 3500 rupees వస్తోంది, 5 kW system kaavali.";
const PUNCTUATED = "సరే...! అవునా? ఇది — నిజంగా, చాలా (చాలా) ఎక్కువ; కదా?!";

describe("token estimation (Phase 4.5 Sprint 2)", () => {
  it("counts English at roughly four characters per token", () => {
    const e = estimateTokens(ENGLISH);
    expect(e.charsPerToken).toBeGreaterThan(3.5);
    expect(e.charsPerToken).toBeLessThanOrEqual(4.1);
    expect(e.scripts.latin).toBe(e.chars);
    expect(e.estimator).toBe(TOKEN_ESTIMATOR_ID);
  });

  it("counts Telugu far above the English rate, never below it", () => {
    const telugu = estimateTokens(TELUGU);
    const english = estimateTokens(ENGLISH);
    // The regression this whole module exists for: Telugu must never be
    // budgeted as though it were Latin text of the same length.
    expect(telugu.estimatedTokens).toBeGreaterThan(telugu.chars / 2);
    expect(telugu.charsPerToken).toBeLessThan(english.charsPerToken / 2);
    expect(telugu.scripts.indic).toBeGreaterThan(0);
  });

  it("charges Tenglish at the Latin rate, because Latin script is what is sent", () => {
    // Romanized Telugu is Latin codepoints. It reads as Telugu and tokenizes
    // as English, and the estimator must not confuse the two.
    const e = estimateTokens(TENGLISH);
    expect(e.scripts.indic).toBe(0);
    expect(e.charsPerToken).toBeGreaterThan(3.5);
  });

  it("prices a Telugu + English + digits sentence between the two rates", () => {
    const e = estimateTokens(MIXED);
    expect(e.scripts.indic).toBeGreaterThan(0);
    expect(e.scripts.latin).toBeGreaterThan(0);
    expect(e.charsPerToken).toBeGreaterThan(1);
    expect(e.charsPerToken).toBeLessThan(4);
    // Digits are Latin codepoints and are charged as such.
    expect(classifyCodePoint("3".codePointAt(0)!)).toBe("latin");
  });

  it("handles punctuation-heavy Telugu without charging punctuation as Telugu", () => {
    const e = estimateTokens(PUNCTUATED);
    expect(e.estimatedTokens).toBeGreaterThan(0);
    expect(e.estimatedTokens).toBeLessThan(e.chars);
    // The em dash and the ASCII marks are cheap; the Telugu letters are not.
    expect(classifyCodePoint("—".codePointAt(0)!)).toBe("latin");
    expect(classifyCodePoint("స".codePointAt(0)!)).toBe("indic");
  });

  it("scales linearly across a long Telugu conversation", () => {
    const long = Array.from({ length: 200 }, () => TELUGU).join(" ");
    const one = estimateTokens(TELUGU).estimatedTokens;
    const many = estimateTokens(long).estimatedTokens;
    expect(many).toBeGreaterThan(one * 190);
    expect(many).toBeLessThan(one * 210);
    // And it stays far above what a chars/4 budget would have claimed.
    expect(many).toBeGreaterThan(long.length / 4);
  });

  it("handles Unicode edge cases without throwing or losing codepoints", () => {
    const emoji = estimateTokens("ok 👍🏽");
    expect(emoji.scripts.astral).toBeGreaterThan(0);
    expect(emoji.estimatedTokens).toBeGreaterThan(0);

    // Counted in codepoints, not UTF-16 code units.
    expect(estimateTokens("👍").chars).toBe(1);
    expect("👍".length).toBe(2);

    // Zero-width joiner, decomposed Telugu and CJK all classify.
    expect(estimateTokens("क्ष‍").estimatedTokens).toBeGreaterThan(0);
    expect(estimateTokens("東京").scripts.cjk).toBe(2);
    expect(utf8Bytes("ఇ")).toBe(3);
    expect(utf8Bytes("a")).toBe(1);
  });

  it("returns zero for empty input and one token for anything non-empty", () => {
    expect(estimateTokens("").estimatedTokens).toBe(0);
    expect(estimateTokens("").charsPerToken).toBe(0);
    expect(estimateTokens("").chars).toBe(0);
    expect(estimatedTokenCount("a")).toBe(1);
    expect(estimatedTokenCount(" ")).toBe(1);
    expect(bytesPerChar("")).toBe(0);
  });

  it("is deterministic and configurable", () => {
    expect(estimateTokens(MIXED)).toEqual(estimateTokens(MIXED));
    const doubled = estimateTokens(TELUGU, { ...DEFAULT_TOKEN_WEIGHTS, indic: 2 });
    expect(doubled.estimatedTokens).toBeGreaterThan(estimateTokens(TELUGU).estimatedTokens);
  });

  it("reports bytes per character, the cheap alarm for a Latin-blind budget", () => {
    expect(bytesPerChar(ENGLISH)).toBeCloseTo(1, 1);
    expect(bytesPerChar(TELUGU)).toBeGreaterThan(2.5);
  });
});

describe("safe truncation (Phase 4.5 Sprint 2)", () => {
  it("never splits a surrogate pair", () => {
    const text = "ok 👍👍👍";
    for (let i = 0; i <= text.length; i++) {
      const cut = truncateChars(text, i);
      expect(cut).toBe([...cut].join(""));
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
    }
  });

  it("never orphans a Telugu vowel sign or virama from its base letter", () => {
    // ఇల్లు is ఇ + ల + virama + ల + vowel sign ు. A `slice` at 3 leaves a
    // trailing virama (a promise of a consonant that never arrives) and at 4
    // tears ు off its base, producing a word no reader recognises. Only the
    // cluster boundaries are legal cut points.
    const word = "ఇల్లు";
    const produced = new Set(Array.from({ length: word.length + 1 }, (_, i) => truncateChars(word, i)));
    expect([...produced].sort()).toEqual(["", "ఇ", "ఇల", "ఇల్లు"].sort());
    for (const cut of produced) {
      expect(word.startsWith(cut)).toBe(true);
      expect(cut).toBe(cut.normalize("NFC"));
    }
  });

  it("cuts a Telugu sentence only where a reader could too", () => {
    const sentence = "నెల బిల్లు ఎక్కువ";
    for (let i = 0; i <= sentence.length; i++) {
      const cut = truncateChars(sentence, i);
      expect(sentence.startsWith(cut)).toBe(true);
      if (cut.length > 0 && cut.length < sentence.length) {
        // Never ends on a virama or a joiner...
        const last = cut.codePointAt(cut.length - 1)!;
        expect(last === 0x0c4d || last === 0x200c || last === 0x200d).toBe(false);
        // ...and never cuts immediately before a combining mark.
        const next = sentence.codePointAt(cut.length)!;
        expect(next >= 0x0c3e && next <= 0x0c4d).toBe(false);
      }
    }
  });

  it("prefers a word boundary when one is close by", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(truncateChars(text, 18)).toBe("the quick brown");
    expect(truncateChars(text, text.length)).toBe(text);
    expect(truncateChars(text, 0)).toBe("");
  });

  it("never returns more characters than asked for", () => {
    for (const text of [ENGLISH, TELUGU, TENGLISH, MIXED, PUNCTUATED]) {
      for (let i = 0; i <= 40; i++) expect(truncateChars(text, i).length).toBeLessThanOrEqual(i);
    }
  });

  it("truncates to an estimated token budget, deterministically", () => {
    const long = Array.from({ length: 50 }, () => TELUGU).join(" ");
    const cut = truncateToEstimatedTokens(long, 100);
    expect(estimatedTokenCount(cut)).toBeLessThanOrEqual(100);
    expect(cut.length).toBeGreaterThan(0);
    expect(truncateToEstimatedTokens(long, 100)).toBe(cut);
    expect(truncateToEstimatedTokens(TELUGU, 10_000)).toBe(TELUGU);
    expect(truncateToEstimatedTokens(TELUGU, 0)).toBe("");
  });
});
