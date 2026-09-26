/**
 * HALO Phase 4.5 Sprint 3 — semantic response assembler.
 *
 * Turns a live LLM text stream into SPEECH CANDIDATES: complete sentences,
 * never fragments. It is a pure text component — it knows nothing about
 * tools, policy or tenants — and nothing it returns is speakable on its own:
 * every candidate still goes through `validateSegment` (see
 * `speech-stream.ts`) before a caller can hear it.
 *
 * Boundary policy. A boundary is where a sentence demonstrably ended:
 *   - `.`, `?`, `!`, and the danda (`।` `॥`), each only when FOLLOWED BY
 *     whitespace that has already arrived. The end of the current buffer is
 *     never a boundary: a stream that delivers "It is 3." and then "5 kW" is
 *     one sentence, and deciding early would split a number;
 *   - a `.` is additionally NOT a boundary when the word before it is a known
 *     abbreviation or a single letter ("Rs. 2,000", "రూ. 500", "K. Ravi"),
 *     or when the next visible character is a digit, a currency sign or a
 *     lowercase Latin letter ("No. 5", "approx. five"). Deciding needs that
 *     next character, so the assembler waits for it;
 *   - a newline run.
 *
 * There is NO mid-sentence cut. A long sentence is emitted whole when it
 * ends (or at `flush()`); the voice layer's existing `chunkForSpeech` splits
 * it for synthesis exactly as it does a complete reply. Holding text is
 * always safe; cutting it is what produces "₹20," and "Tomorrow at". This
 * also makes segmentation independent of how the provider chunked its
 * tokens, which a test asserts.
 *
 * Short sentences (under `minSegmentChars`, e.g. "సరే." or "Yes.") are held
 * and merged with the next one, so the caller never hears a lone "Yes"
 * that the rest of the reply might qualify.
 *
 * INVARIANT: the segments of a stream, joined with single spaces, equal the
 * whitespace-normalized full text. Nothing is dropped or reordered.
 */

export interface AssemblerOptions {
  minSegmentChars: number;
}

export const DEFAULT_ASSEMBLER_OPTIONS: AssemblerOptions = Object.freeze({ minSegmentChars: 12 });

const TERMINATOR = /[.?!।॥]+|\n+/g;

/**
 * Words that end in a period without ending the sentence. Latin entries are
 * matched case-insensitively. Telugu entries are the spoken abbreviations a
 * model actually writes on a sales call (రూ. = Rs., శ్రీ = Sri, డా. = Dr.).
 */
const ABBREVIATIONS = new Set([
  "rs", "inr", "mr", "mrs", "ms", "dr", "no", "nos", "vs", "approx", "st", "sr", "jr", "sq", "ft", "kg", "km",
  "hrs", "min", "max", "dept", "govt", "pvt", "ltd", "co", "ph", "tel", "mob",
  "రూ", "శ్రీ", "డా",
]);

const DIGIT_OR_CURRENCY = /[0-9₹$€£]/;
const LOWER_LATIN = /[a-z]/;

type Boundary = { end: number } | { wait: true } | null;

export class SentenceAssembler {
  private buffer = "";
  /** A completed sentence held back because it is too short to speak alone. */
  private held: string | null = null;
  private segments = 0;

  constructor(private readonly options: AssemblerOptions = DEFAULT_ASSEMBLER_OPTIONS) {}

  /** Characters waiting for a boundary (telemetry only). */
  get pendingChars(): number {
    return this.buffer.length + (this.held?.length ?? 0);
  }

  /** Segments emitted so far. */
  get count(): number {
    return this.segments;
  }

  /**
   * Feed one text delta; returns every segment that became complete.
   * Deltas may be arbitrarily small — single characters included.
   */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const boundary = this.nextBoundary();
      if (boundary === null || "wait" in boundary) break;
      const sentence = normalize(this.buffer.slice(0, boundary.end));
      this.buffer = this.buffer.slice(boundary.end);
      if (!sentence) continue;
      const merged = this.held === null ? sentence : `${this.held} ${sentence}`;
      this.held = null;
      if (merged.length < this.options.minSegmentChars) {
        this.held = merged;
        continue;
      }
      this.segments += 1;
      out.push(merged);
    }
    return out;
  }

  /**
   * Stream ended normally. Returns the remaining text as a final segment
   * (merged with any held short sentence). Call it ONLY on a completed
   * stream: text left in the buffer of a failed stream is an unfinished
   * sentence and must never be spoken. After `flush()` the assembler is spent.
   */
  flush(): string[] {
    const rest = normalize(this.buffer);
    this.buffer = "";
    const merged = [this.held, rest].filter((s): s is string => Boolean(s)).join(" ");
    this.held = null;
    if (!merged) return [];
    this.segments += 1;
    return [merged];
  }

  /**
   * The first decidable sentence end in the buffer: `{ end }` when found,
   * `{ wait }` when the earliest candidate needs characters that have not
   * arrived yet (boundaries are strictly ordered, so nothing after it may be
   * decided either), `null` when there is no candidate at all.
   */
  private nextBoundary(): Boundary {
    const text = this.buffer;
    TERMINATOR.lastIndex = 0;
    for (let match = TERMINATOR.exec(text); match; match = TERMINATOR.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      if (match[0][0] === "\n") return { end };
      if (end >= text.length) return { wait: true };
      if (!/\s/.test(text[end])) continue; // "3.5", "a.m.", "ok?!" mid-token
      if (match[0] !== ".") return { end };
      if (isAbbreviation(text, start)) continue;
      let next = end;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (next >= text.length) return { wait: true };
      const ch = text[next];
      if (DIGIT_OR_CURRENCY.test(ch) || LOWER_LATIN.test(ch)) continue;
      return { end };
    }
    return null;
  }
}

/** The word immediately before `dot` is a listed abbreviation or a lone letter. */
function isAbbreviation(text: string, dot: number): boolean {
  let start = dot;
  while (start > 0 && !/[\s(,;:"'“‘]/.test(text[start - 1])) start--;
  const word = text.slice(start, dot);
  if (!word) return false;
  if (/^[A-Za-z]$/.test(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
