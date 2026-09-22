import { normalizeText } from "./normalize";

/**
 * HALO Phase 4.5 Sprint 2 — script-aware token ESTIMATION.
 *
 * Everything this module returns is an estimate and is named as one. No
 * tokenizer ships in this repository, no provider tokenizer is vendored, and
 * no provider has ever reported `input_tokens` for this product's traffic.
 * A number here is a budgeting input, never a billing figure and never a
 * claim about what a provider counted.
 *
 * WHY THIS EXISTS
 * ---------------
 * The context budget counted CHARACTERS and treated the result as if it
 * bounded tokens. That holds only for Latin text. Byte-pair tokenizers are
 * trained overwhelmingly on Latin script, so a Telugu character — three UTF-8
 * bytes, usually outside the learned vocabulary — costs far more tokens than
 * a Latin one. A prompt can therefore sit comfortably inside a character
 * budget and be multiples over the real token budget, and nothing errors:
 * the budget just stops meaning anything. That is the same silent-no-op
 * failure mode as an English-only regex, one layer down.
 *
 * THE MODEL
 * ---------
 * Estimated tokens are a weighted sum over CODEPOINTS, classified by script:
 *
 *   latin      0.25 tokens/char   ≈ 4 chars per token, the widely used English
 *                                  rule of thumb, and the ratio this repo's
 *                                  own English prompts sit at.
 *   indic      1.00 tokens/char   one token per character. Telugu, Devanagari
 *   cjk        1.00 tokens/char   and CJK codepoints are typically 1–3 tokens
 *   other      1.00 tokens/char   each under byte-fallback; 1.0 is a floor on
 *                                  the pessimistic side of every tokenizer we
 *                                  can reason about, and the direction of the
 *                                  error is deliberate — see below.
 *   astral     2.00 tokens/char   emoji and other supplementary-plane
 *                                  codepoints usually cost several tokens.
 *
 * DIRECTION OF ERROR IS A SAFETY PROPERTY. The estimator must never say a
 * multilingual prompt is smaller than it is: an under-estimate silently
 * overruns a real context window mid-call, an over-estimate trims a knowledge
 * snippet. So the non-Latin weights round UP, and a test pins that Telugu can
 * never be budgeted at the Latin ratio.
 *
 * WHAT WOULD REPLACE IT. A provider-reported `input_tokens` for the same
 * string, recorded per language, turns each weight from a constant into a
 * measurement. `estimateTokens` is deliberately a pure function of text so
 * that comparison is a subtraction, not a rewrite. Until then: ESTIMATE.
 */

export type ScriptClass = "latin" | "indic" | "cjk" | "other" | "astral";

/** Estimated tokens per codepoint, by script class. */
export type TokenWeights = Readonly<Record<ScriptClass, number>>;

export const DEFAULT_TOKEN_WEIGHTS: TokenWeights = Object.freeze({
  latin: 0.25,
  indic: 1,
  cjk: 1,
  other: 1,
  astral: 2,
});

/**
 * Identifier for the estimation method, carried on every estimate and in
 * telemetry. Bump the date when a weight changes, so a stored number can be
 * read against the rules that produced it.
 */
export const TOKEN_ESTIMATOR_ID = "halo-script-weighted-estimate/2026-09-22";

export interface TokenEstimate {
  /** ESTIMATED tokens. Not a provider count. Never rendered as exact. */
  estimatedTokens: number;
  /** Unicode codepoints (not UTF-16 code units). */
  chars: number;
  /** UTF-8 bytes — the single cheapest signal that a budget is Latin-blind. */
  bytes: number;
  /** chars / estimatedTokens. Around 4 for English, around 1 for Telugu. */
  charsPerToken: number;
  /** Codepoint counts by script class. */
  scripts: Readonly<Record<ScriptClass, number>>;
  /** Which rules produced this number. */
  estimator: string;
}

/** Indic script blocks this product can actually receive. */
const INDIC_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0900, 0x097f], // Devanagari
  [0x0980, 0x09ff], // Bengali
  [0x0a00, 0x0a7f], // Gurmukhi
  [0x0a80, 0x0aff], // Gujarati
  [0x0b00, 0x0b7f], // Oriya
  [0x0b80, 0x0bff], // Tamil
  [0x0c00, 0x0c7f], // Telugu
  [0x0c80, 0x0cff], // Kannada
  [0x0d00, 0x0d7f], // Malayalam
  [0x0d80, 0x0dff], // Sinhala
];

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
];

const inAny = (code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean =>
  ranges.some(([lo, hi]) => code >= lo && code <= hi);

export function classifyCodePoint(code: number): ScriptClass {
  if (code > 0xffff) return "astral";
  // ASCII, Latin-1 supplement and the Latin extended blocks, plus every
  // ASCII digit, space and punctuation mark — all cheap for a BPE tokenizer.
  if (code <= 0x024f) return "latin";
  if (inAny(code, INDIC_RANGES)) return "indic";
  if (inAny(code, CJK_RANGES)) return "cjk";
  // General punctuation (– — “ ” …) is Latin-cheap in practice.
  if (code >= 0x2010 && code <= 0x205f) return "latin";
  return "other";
}

const EMPTY_SCRIPTS: Record<ScriptClass, number> = { latin: 0, indic: 0, cjk: 0, other: 0, astral: 0 };

/**
 * Estimates the tokens a string will cost. Deterministic, allocation-light,
 * and a pure function of the text: same string in, same number out, on every
 * platform and in every locale.
 */
export function estimateTokens(text: string, weights: TokenWeights = DEFAULT_TOKEN_WEIGHTS): TokenEstimate {
  const scripts: Record<ScriptClass, number> = { ...EMPTY_SCRIPTS };
  let chars = 0;
  let weighted = 0;
  for (const char of text) {
    const cls = classifyCodePoint(char.codePointAt(0)!);
    scripts[cls] += 1;
    weighted += weights[cls];
    chars += 1;
  }
  // A non-empty string always costs at least one token.
  const estimatedTokens = chars === 0 ? 0 : Math.max(1, Math.ceil(weighted));
  return {
    estimatedTokens,
    chars,
    bytes: utf8Bytes(text),
    charsPerToken: estimatedTokens === 0 ? 0 : chars / estimatedTokens,
    scripts,
    estimator: TOKEN_ESTIMATOR_ID,
  };
}

/** Estimated tokens only, for callers that do not need the breakdown. */
export function estimatedTokenCount(text: string, weights: TokenWeights = DEFAULT_TOKEN_WEIGHTS): number {
  return estimateTokens(text, weights).estimatedTokens;
}

/** UTF-8 byte length without allocating a Buffer per call. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Bytes per character, the cheapest available alarm for a Latin-blind budget.
 * Around 1.0 for English, around 3.0 for Telugu. Used in telemetry so a drift
 * upward is visible without waiting for a provider to report tokens.
 */
export function bytesPerChar(text: string): number {
  const chars = [...normalizeText(text)].length;
  return chars === 0 ? 0 : utf8Bytes(normalizeText(text)) / chars;
}
