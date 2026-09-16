import { foldDigits, normalizeForMatching, normalizeText } from "../normalize";
import { spokenDigitSequence } from "./numerals";

/**
 * Indian mobile numbers, pincodes and caller names (plan §P3.6).
 *
 * Names are the one field that must NEVER be normalized destructively:
 * honorifics are stripped for matching only, transliteration is never
 * attempted, and the caller's exact words are what gets stored and read back.
 */

export interface ParsedPhone {
  /** +91XXXXXXXXXX */
  e164: string;
  national: string;
  raw: string;
  confidence: number;
  source: "digits" | "spoken";
}

const HONORIFICS = ["గారు", "garu", "gaaru", "శ్రీ", "sri", "shri", "smt", "శ్రీమతి", "mr", "mr.", "mrs", "mrs.", "ms", "ms."];

/** India mobile: 10 digits starting 6-9, optionally +91/91/0 prefixed. */
export function parseIndianMobile(text: string): ParsedPhone | null {
  const folded = foldDigits(normalizeText(text));
  const candidates = folded.match(/(?:\+?91[\s-]?)?[0-9][0-9\s-]{8,15}[0-9]/g) ?? [];
  for (const candidate of candidates) {
    const national = toNational(candidate.replace(/[\s-]/g, ""));
    if (national) {
      return { e164: `+91${national}`, national, raw: candidate.trim(), confidence: 0.95, source: "digits" };
    }
  }
  const spoken = spokenDigitSequence(text);
  if (spoken) {
    const national = toNational(spoken);
    if (national) return { e164: `+91${national}`, national, raw: text.trim(), confidence: 0.75, source: "spoken" };
  }
  return null;
}

function toNational(digits: string): string | null {
  let value = digits;
  if (value.startsWith("+91")) value = value.slice(3);
  else if (value.startsWith("91") && value.length === 12) value = value.slice(2);
  else if (value.startsWith("0") && value.length === 11) value = value.slice(1);
  return /^[6-9]\d{9}$/.test(value) ? value : null;
}

export interface ParsedPincode {
  pincode: string;
  raw: string;
  confidence: number;
}

/** Indian PIN: exactly 6 digits, first digit 1-9, not part of a longer run. */
export function parsePincode(text: string): ParsedPincode | null {
  const folded = foldDigits(normalizeText(text));
  const match = folded.match(/(?<!\d)([1-9]\d{5})(?!\d)/);
  return match ? { pincode: match[1], raw: match[1], confidence: 0.95 } : null;
}

export interface ParsedName {
  /** Exactly as the caller said it — stored and read back unchanged. */
  raw: string;
  /** Honorific-stripped, lower-cased: for matching only. */
  forMatching: string;
  honorific: string | null;
  confidence: number;
}

const NAME_LABELS = [
  /నా\s*పేరు\s*(.+)/u,
  /peru\s*(.+)/u,
  /my\s+name\s+is\s+(.+)/iu,
  /(?:i\s*am|i'm|this\s+is)\s+(.+)/iu,
  /name\s*[:\-]?\s*(.+)/iu,
];

/**
 * A name from a labelled phrase, or from a short bare utterance. Low
 * confidence by design: the agent echoes the name back rather than trusting it.
 */
export function extractName(text: string, options: { maxWords?: number } = {}): ParsedName | null {
  const original = normalizeText(text);
  if (!original) return null;
  const maxWords = options.maxWords ?? 5;

  for (const label of NAME_LABELS) {
    const match = label.exec(original);
    if (match?.[1]) {
      const candidate = trimName(match[1]);
      if (candidate) return buildName(candidate, 0.9);
    }
  }

  const words = original.split(/\s+/);
  if (words.length <= maxWords && !/\d/.test(original)) {
    const candidate = trimName(original);
    if (candidate) return buildName(candidate, 0.5);
  }
  return null;
}

function trimName(value: string): string {
  return value
    .replace(/["'.,!?]+$/g, "")
    .replace(/^[\s"'.,]+/g, "")
    .split(/\s+/)
    .slice(0, 5)
    .join(" ")
    .trim();
}

function buildName(candidate: string, confidence: number): ParsedName {
  const words = candidate.split(/\s+/);
  const honorific = words.find((w) => HONORIFICS.includes(normalizeForMatching(w))) ?? null;
  const forMatching = words
    .filter((w) => !HONORIFICS.includes(normalizeForMatching(w)))
    .map((w) => normalizeForMatching(w))
    .join(" ");
  return { raw: candidate, forMatching, honorific, confidence: forMatching ? confidence : Math.min(confidence, 0.3) };
}
