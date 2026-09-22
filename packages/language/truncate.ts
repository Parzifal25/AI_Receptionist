import { estimatedTokenCount, type TokenWeights } from "./tokens";

/**
 * HALO Phase 4.5 Sprint 2 — truncation that does not damage text.
 *
 * `String.prototype.slice` counts UTF-16 code units, so cutting at a fixed
 * offset can:
 *   - split a surrogate pair, producing a lone surrogate that is no longer
 *     valid text and that some JSON encoders and log sinks will mangle;
 *   - cut a Telugu syllable away from its vowel sign or virama, so the
 *     remaining text renders as a different — and often nonsensical — word.
 *     Telugu writes ఇల్లు as four codepoints; cutting after three leaves
 *     something no reader recognises.
 *
 * Neither is hypothetical for this product: every trimmed field here can hold
 * Telugu, and the caller's own words are what gets trimmed.
 *
 * The rules, in order, all deterministic and ICU-free (`Intl.Segmenter`
 * depends on the host's ICU build, so the same input could truncate
 * differently on two machines — unacceptable for a budget that has to be
 * reproducible):
 *   1. never cut inside a surrogate pair;
 *   2. never cut immediately before a combining mark, a virama, or a
 *      ZWJ/ZWNJ — walk back to the start of that cluster;
 *   3. where a word boundary is close by, prefer it, so a trimmed message
 *      ends on a whole word rather than mid-word.
 *
 * Truncation is never silent: every caller records WHAT it trimmed, and the
 * context builder reports it in `budget.trimmed`.
 */

/** How far back the truncator may walk to end on a whole word. */
const WORD_BOUNDARY_WINDOW = 24;

/** Combining marks, viramas and joiners that must stay with their base. */
function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritics
    (code >= 0x0900 && code <= 0x0dff && isIndicMark(code)) ||
    code === 0x200c || // ZWNJ
    code === 0x200d || // ZWJ
    (code >= 0xfe00 && code <= 0xfe0f) // variation selectors
  );
}

/**
 * Dependent vowel signs, viramas, anusvara/visarga and nuktas across the
 * Indic blocks. Every Indic block lays these out at the same offsets within
 * its 128-codepoint range, which is why one predicate covers all of them.
 */
function isIndicMark(code: number): boolean {
  const offset = code & 0x7f;
  return (
    (offset >= 0x00 && offset <= 0x03) || // anusvara / visarga / candrabindu
    (offset >= 0x3e && offset <= 0x4d) || // dependent vowel signs + virama
    (offset >= 0x51 && offset <= 0x57) || // accents and length marks
    (offset >= 0x62 && offset <= 0x63) || // vocalic vowel signs
    offset === 0x3c // nukta
  );
}

/**
 * Codepoints that cannot be the LAST thing in a string: a virama says "the
 * next consonant joins this one", and a joiner says "more of this cluster
 * follows". Ending on either leaves a word that is incomplete rather than
 * merely shortened.
 */
function isTrailingIncomplete(code: number): boolean {
  if (code === 0x200c || code === 0x200d) return true;
  return code >= 0x0900 && code <= 0x0dff && (code & 0x7f) === 0x4d;
}

/** Whitespace the truncator is willing to end on. */
const isBreak = (char: string): boolean => /[\s।॥.,;:!?—–-]/.test(char);

/**
 * Truncates to at most `maxChars` UTF-16 code units WITHOUT splitting a
 * codepoint or a combining sequence, preferring a nearby word boundary.
 * Returns the original string when it already fits.
 */
export function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  let end = maxChars;
  // 1. Never end on the high half of a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;

  // 2. Never leave a combining mark orphaned: walk back off the whole cluster.
  while (end > 0) {
    const next = text.codePointAt(end);
    if (next === undefined || !isCombining(next)) break;
    end -= 1;
    const prev = text.charCodeAt(end - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) end -= 1;
  }

  // 2b. Never END on a virama or a joiner: both promise more characters.
  while (end > 0 && isTrailingIncomplete(text.codePointAt(end - 1)!)) end -= 1;

  // 3. Prefer a whole word when one ends close by.
  const window = text.slice(Math.max(0, end - WORD_BOUNDARY_WINDOW), end);
  for (let i = window.length - 1; i >= 0; i--) {
    if (isBreak(window[i])) {
      const candidate = end - (window.length - 1 - i);
      if (candidate > 0) return text.slice(0, candidate).trimEnd();
      break;
    }
  }
  return text.slice(0, end);
}

/**
 * Truncates to an ESTIMATED token count. Binary search over `truncateChars`,
 * so every guarantee above still holds and the result is deterministic.
 * The token figure is an estimate (see `tokens.ts`); the character result is
 * exact.
 */
export function truncateToEstimatedTokens(text: string, maxTokens: number, weights?: TokenWeights): string {
  if (maxTokens <= 0) return "";
  const count = (s: string) => (weights ? estimatedTokenCount(s, weights) : estimatedTokenCount(s));
  if (count(text) <= maxTokens) return text;

  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = truncateChars(text, mid);
    if (count(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
