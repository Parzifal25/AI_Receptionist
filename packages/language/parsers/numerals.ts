import { normalizeForMatching } from "../normalize";

/**
 * HALO Phase 4 — deterministic numeral parsing for Telugu, romanized Telugu
 * ("Tenglish") and English, including Indian scales (plan §P3.6).
 *
 * The LLM is unreliable on exactly these, and a wrong digit in a bill amount
 * or a phone number makes a qualification call worthless — so numbers are
 * parsed by code, kept beside the caller's original words, and read back for
 * confirmation.
 *
 * Handles: ASCII and Telugu digits, Indian grouping (1,50,000), decimals,
 * "2k", lakh/crore scaling, Telugu number words (రెండు వేలు = 2000),
 * romanized words (rendu velu), English words, and mixed forms
 * (రెండు thousand). Never guesses: unparsable input returns null.
 */

export interface ParsedNumber {
  value: number;
  /** The matched fragment (normalized). The caller's ORIGINAL utterance is
   * preserved separately by the qualification layer — never replaced by this. */
  raw: string;
  confidence: number;
  source: "digits" | "words" | "mixed";
}

const UNITS: Record<string, number> = {
  // Telugu script
  "సున్నా": 0, "ఒకటి": 1, "ఒక": 1, "రెండు": 2, "మూడు": 3, "నాలుగు": 4, "ఐదు": 5, "అయిదు": 5,
  "ఆరు": 6, "ఏడు": 7, "ఎనిమిది": 8, "తొమ్మిది": 9, "పది": 10, "పదకొండు": 11, "పన్నెండు": 12,
  "పదమూడు": 13, "పద్నాలుగు": 14, "పదిహేను": 15, "పదహారు": 16, "పదిహేడు": 17, "పద్దెనిమిది": 18,
  "పంతొమ్మిది": 19, "ఇరవై": 20, "ముప్పై": 30, "ముప్పయి": 30, "నలభై": 40, "నలభయి": 40,
  "యాభై": 50, "యాభయి": 50, "అరవై": 60, "డెబ్బై": 70, "ఎనభై": 80, "తొంభై": 90,
  // Romanized Telugu
  okati: 1, oka: 1, rendu: 2, moodu: 3, mudu: 3, muudu: 3, nalugu: 4, naalugu: 4, aidu: 5, ayidu: 5,
  aaru: 6, aru: 6, edu: 7, eedu: 7, enimidi: 8, tommidi: 9, padi: 10, iravai: 20, iravay: 20,
  muppai: 30, muppay: 30, nalabhai: 40, nalabai: 40, yabhai: 50, yabai: 50, aravai: 60,
  debbai: 70, enabhai: 80, tombhai: 90,
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const SCALES: Record<string, number> = {
  "వంద": 100, "వందలు": 100, "వందల": 100,
  "వెయ్యి": 1_000, "వేయి": 1_000, "వేలు": 1_000, "వేల": 1_000, "వెయ్యిల": 1_000,
  "లక్ష": 100_000, "లక్షలు": 100_000, "లక్షల": 100_000,
  "కోటి": 10_000_000, "కోట్లు": 10_000_000, "కోట్ల": 10_000_000,
  vanda: 100, vandalu: 100, veyyi: 1_000, vey: 1_000, vela: 1_000, velu: 1_000, veyyilu: 1_000,
  laksha: 100_000, lakshalu: 100_000, lakshala: 100_000, koti: 10_000_000, kotlu: 10_000_000,
  hundred: 100, thousand: 1_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000,
  crore: 10_000_000, crores: 10_000_000, million: 1_000_000,
};

/** Joiners that may appear inside one spoken number and must not split it. */
const JOINERS = new Set(["and", "మరియు", "ki", "కు"]);

const DIGIT_GROUP = /^(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)(k|cr)?$/i;

/** Every number found in the text, left to right. */
export function parseAllNumbers(text: string): ParsedNumber[] {
  const normalized = normalizeForMatching(text);
  // \p{M} matters: Telugu vowel signs are combining marks, so a character
  // class of letters alone splits words mid-syllable (and silently no-ops).
  const tokens = normalized.split(/[^\p{L}\p{M}\p{N}.,]+/u).filter(Boolean);
  const results: ParsedNumber[] = [];

  let total = 0;
  let current = 0;
  let started = false;
  let usedDigits = false;
  let usedWords = false;
  let rawParts: string[] = [];

  const flush = () => {
    if (!started) return;
    const value = total + current;
    results.push({
      value,
      raw: rawParts.join(" "),
      source: usedDigits && usedWords ? "mixed" : usedDigits ? "digits" : "words",
      confidence: usedDigits && usedWords ? 0.8 : usedDigits ? 0.95 : 0.85,
    });
    total = 0;
    current = 0;
    started = false;
    usedDigits = false;
    usedWords = false;
    rawParts = [];
  };

  for (const token of tokens) {
    const word = token.replace(/[.,]+$/, "");
    if (started && JOINERS.has(word)) {
      rawParts.push(token);
      continue;
    }

    const digits = DIGIT_GROUP.exec(word);
    if (digits) {
      const base = Number.parseFloat(digits[1].replace(/,/g, ""));
      if (!Number.isFinite(base)) {
        flush();
        continue;
      }
      const suffix = digits[2]?.toLowerCase();
      const multiplier = suffix === "k" ? 1_000 : suffix === "cr" ? 10_000_000 : 1;
      // Two digit groups in a row are two different numbers ("3000 2 kw").
      if (started && usedDigits && current !== 0) flush();
      started = true;
      usedDigits = true;
      current += base * multiplier;
      rawParts.push(token);
      continue;
    }

    const unit = UNITS[word];
    if (unit !== undefined) {
      started = true;
      usedWords = true;
      current += unit;
      rawParts.push(token);
      continue;
    }

    const scale = SCALES[word];
    if (scale !== undefined) {
      started = true;
      usedWords = true;
      const base = current === 0 ? 1 : current;
      if (scale >= 1_000) {
        total += base * scale;
        current = 0;
      } else {
        current = base * scale;
      }
      rawParts.push(token);
      continue;
    }

    flush();
  }
  flush();
  return results;
}

/**
 * The single number in the text. When several are present the first is
 * returned with reduced confidence — the caller should confirm it rather
 * than assume.
 */
export function parseNumber(text: string): ParsedNumber | null {
  const all = parseAllNumbers(text);
  if (all.length === 0) return null;
  if (all.length === 1) return all[0];
  return { ...all[0], confidence: Math.min(all[0].confidence, 0.6) };
}

/** Digit sequences as spoken words ("nine eight seven", "tommidi enimidi"). */
export function spokenDigitSequence(text: string): string | null {
  const tokens = normalizeForMatching(text).split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  let digits = "";
  let doubleNext = false;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      digits += doubleNext ? token.repeat(2) : token;
      doubleNext = false;
      continue;
    }
    if (token === "double" || token === "డబుల్") {
      doubleNext = true;
      continue;
    }
    const unit = UNITS[token];
    if (unit !== undefined && unit <= 9) {
      digits += doubleNext ? String(unit).repeat(2) : String(unit);
      doubleNext = false;
      continue;
    }
    // Any other word breaks a digit sequence.
    if (digits.length > 0) break;
  }
  return digits.length > 0 ? digits : null;
}
