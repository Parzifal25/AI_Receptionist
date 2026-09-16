/**
 * HALO Phase 4 — text normalization for multilingual matching (plan §P3.6).
 *
 * Rule that governs this whole package: **normalize for MATCHING, never for
 * STORAGE or DISPLAY.** The caller's original utterance is preserved verbatim
 * everywhere it is stored (transcripts, qualification `raw` fields); the
 * normalized form exists only so deterministic matchers can work.
 *
 * Telugu specifics:
 *   - Unicode NFC, because the same syllable can arrive decomposed;
 *   - ZWJ/ZWNJ (U+200C/U+200D) are stripped for matching only — they are
 *     meaningful for rendering and must survive in stored text;
 *   - Telugu, Devanagari and Arabic-Indic digits fold to ASCII, since
 *     numbers must be compared, validated and dialled.
 */

const ZERO_WIDTH = /[​-‏﻿]/g;

/** Digit ranges that fold to ASCII 0-9. */
const DIGIT_BASES = [0x0c66, 0x0966, 0x0660, 0x06f0] as const; // Telugu, Devanagari, Arabic-Indic, Extended Arabic-Indic

export function foldDigits(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const base = DIGIT_BASES.find((b) => code >= b && code <= b + 9);
    out += base === undefined ? char : String(code - base);
  }
  return out;
}

/** NFC + zero-width removal + digit folding + whitespace collapse. Case preserved. */
export function normalizeText(text: string): string {
  return foldDigits(text.normalize("NFC")).replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}

/** Normalized and lower-cased: the form every matcher in this package uses. */
export function normalizeForMatching(text: string): string {
  return normalizeText(text).toLowerCase();
}

export const TELUGU_BLOCK = /[ఀ-౿]/;

export function hasTeluguScript(text: string): boolean {
  return TELUGU_BLOCK.test(text);
}

/** Counts letters by script; punctuation, digits and spaces are ignored. */
export function scriptCounts(text: string): { telugu: number; latin: number; other: number } {
  let telugu = 0;
  let latin = 0;
  let other = 0;
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0)!;
    if (code >= 0x0c00 && code <= 0x0c7f) telugu += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
    else if (code > 0x7f && !/\s/.test(char)) other += 1;
  }
  return { telugu, latin, other };
}
