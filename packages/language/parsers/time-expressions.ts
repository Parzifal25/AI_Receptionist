import { normalizeForMatching } from "../normalize";

/**
 * HALO Phase 4 — Telugu / Tenglish time expressions (plan §P3.6).
 *
 * The existing `when-parser` understands English time language and is well
 * tested; rather than duplicating its date arithmetic per language, this maps
 * Telugu and romanized-Telugu time words onto the English tokens it already
 * understands. The caller's original words are never replaced — the gloss is
 * an additional, deterministic input to the scheduling engine.
 */

const GLOSSARY: Array<[string, string]> = [
  // Days
  ["ఈ రోజు", "today"], ["ఈరోజు", "today"], ["ఇవాళ", "today"], ["ivala", "today"], ["ivaala", "today"],
  ["రేపు", "tomorrow"], ["repu", "tomorrow"], ["rEpu", "tomorrow"],
  ["ఎల్లుండి", "day after tomorrow"], ["ellundi", "day after tomorrow"],
  ["నిన్న", "yesterday"], ["ninna", "yesterday"],
  // Weekdays
  ["సోమవారం", "monday"], ["somavaram", "monday"], ["మంగళవారం", "tuesday"], ["mangalavaram", "tuesday"],
  ["బుధవారం", "wednesday"], ["budhavaram", "wednesday"], ["గురువారం", "thursday"], ["guruvaram", "thursday"],
  ["శుక్రవారం", "friday"], ["shukravaram", "friday"], ["sukravaram", "friday"],
  ["శనివారం", "saturday"], ["shanivaram", "saturday"], ["sanivaram", "saturday"],
  ["ఆదివారం", "sunday"], ["adivaram", "sunday"], ["aadivaram", "sunday"],
  // Parts of day
  ["ఉదయం", "morning"], ["udayam", "morning"], ["పొద్దున", "morning"], ["poddhuna", "morning"],
  ["మధ్యాహ్నం", "afternoon"], ["madhyahnam", "afternoon"], ["madhyanam", "afternoon"],
  ["సాయంత్రం", "evening"], ["sayantram", "evening"], ["saayantram", "evening"],
  ["రాత్రి", "night"], ["ratri", "night"],
  // Clock and ranges
  ["గంటలకు", "o'clock"], ["గంటకు", "o'clock"], ["gantalaku", "o'clock"], ["gantaku", "o'clock"],
  ["నిమిషాలు", "minutes"], ["nimishalu", "minutes"],
  ["వారం", "week"], ["varam", "week"], ["నెల", "month"], ["nela", "month"],
  ["వచ్చే", "next"], ["vachche", "next"], ["vache", "next"], ["తరువాత", "later"], ["tarvatha", "later"],
  ["ఇప్పుడు", "now"], ["ippudu", "now"], ["ఎప్పుడైనా", "anytime"], ["eppudaina", "anytime"],
];

const SORTED = [...GLOSSARY].sort((a, b) => b[0].length - a[0].length);

/**
 * An English gloss of the time language in `text`, suitable for the existing
 * when-parser. Non-time words are preserved, so digits and context survive.
 */
export function toEnglishTimeGloss(text: string): string {
  let out = normalizeForMatching(text);
  for (const [source, target] of SORTED) {
    const needle = normalizeForMatching(source);
    if (!needle) continue;
    out = out.split(needle).join(target);
  }
  return out.replace(/\s+/g, " ").trim();
}

export function hasTimeExpression(text: string): boolean {
  const normalized = normalizeForMatching(text);
  if (SORTED.some(([source]) => normalized.includes(normalizeForMatching(source)))) return true;
  return /\b(today|tomorrow|morning|afternoon|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|o'clock)\b/.test(
    normalized,
  );
}
