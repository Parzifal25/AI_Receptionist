/**
 * HALO Phase 3 — splits a validated reply into speakable chunks so TTS can
 * start on the first sentence while later ones synthesize, and so playback
 * marks tell us which sentences the caller actually heard.
 *
 * Script-neutral: sentence ends are `.`, `?`, `!`, the Devanagari danda
 * (`।`, `॥`, sometimes used in Indic text) and newlines — each only when
 * followed by whitespace or the end, so "3.5 kW" and "Rs. 2,000" style
 * abbreviations inside a sentence are not split mid-number. Very short
 * fragments are merged forward; over-long sentences are split at the last
 * comma or space before the limit. Never drops text.
 */

export interface ChunkerOptions {
  maxChunkChars: number;
  minChunkChars: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = Object.freeze({ maxChunkChars: 220, minChunkChars: 12 });

const SENTENCE_END = /([.?!।॥]+)(?=\s|$)|\n+/g;

export function chunkForSpeech(text: string, options: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const sentences: string[] = [];
  let last = 0;
  for (const match of normalized.matchAll(SENTENCE_END)) {
    const end = match.index! + match[0].length;
    const piece = normalized.slice(last, end).trim();
    if (piece) sentences.push(piece);
    last = end;
  }
  const tail = normalized.slice(last).trim();
  if (tail) sentences.push(tail);

  const merged: string[] = [];
  for (const sentence of sentences) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.length < options.minChunkChars) {
      merged[merged.length - 1] = `${prev} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }

  const out: string[] = [];
  for (const piece of merged) out.push(...splitLong(piece, options.maxChunkChars));
  return out;
}

function splitLong(piece: string, max: number): string[] {
  const out: string[] = [];
  let rest = piece;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("، "));
    if (cut > 0) cut += 1;
    else cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
