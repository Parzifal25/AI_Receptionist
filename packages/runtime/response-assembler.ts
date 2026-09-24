/**
 * HALO Phase 4.5 Sprint 3 — semantic response assembler.
 *
 * Turns a live LLM text stream into SAFE SPEECH CANDIDATES: complete
 * sentences first, natural clause boundaries second, never tiny fragments.
 * It is a pure text component — it knows nothing about tools, policy or
 * tenants — and it emits nothing on its own: every segment it returns is
 * still subject to the runtime's segment validation before it may be spoken.
 *
 * Boundary policy (mirrors `packages/voice/sentence-chunker.ts`, which has
 * split validated replies since Phase 3):
 *   1. sentence completion  — `.`, `?`, `!`, the Indic danda (`।` `॥`)
 *      and newlines, each only when followed by whitespace or the end, so
 *      "3.5 kW" and "Rs. 2,000" are not split mid-number;
 *   2. clause fallback      — a sentence that grows past `maxSegmentChars`
 *      without ending is cut at its last `,`/`،` (or space) so a run-on
 *      sentence cannot hold speech hostage;
 *   3. short-fragment merge — a completed sentence shorter than
 *      `minSegmentChars` is held and merged with the next one, so the
 *      caller never hears "Yes" … "we" … "can" as separate utterances.
 *
 * INVARIANT: the segments of a stream, joined with single spaces, equal the
 * whitespace-normalized full text. Nothing is dropped or reordered; the
 * final validated reply can always be reconstructed from what was emitted
 * plus what `flush()` returns.
 */

export interface AssemblerOptions {
  maxSegmentChars: number;
  minSegmentChars: number;
}

export const DEFAULT_ASSEMBLER_OPTIONS: AssemblerOptions = Object.freeze({ maxSegmentChars: 220, minSegmentChars: 12 });

/** Sentence end: terminal punctuation followed by whitespace/end, or a newline run. */
const SEGMENT_END = /([.?!।॥]+)(?=\s|$)|\n+/;

export class SentenceAssembler {
  private buffer = "";
  /** A completed sentence held back because it is too short to speak alone. */
  private held: string | null = null;
  private segments = 0;

  constructor(private readonly options: AssemblerOptions = DEFAULT_ASSEMBLER_OPTIONS) {}

  /** Characters waiting for a boundary (telemetry only). */
  get pendingChars(): number {
    return this.buffer.length;
  }

  /** Segments emitted so far. */
  get count(): number {
    return this.segments;
  }

  /**
   * Feed one text delta; returns every segment that became speakable.
   * Deltas may be arbitrarily small — the assembler is the thing that
   * turns them into natural speech units.
   */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const match = SEGMENT_END.exec(this.buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (!sentence) continue;
      const merged = this.held === null ? sentence : `${this.held} ${sentence}`;
      this.held = null;
      if (merged.length < this.options.minSegmentChars) {
        // Too short to speak alone ("సరే."). Wait for the next sentence.
        this.held = merged;
        continue;
      }
      out.push(...this.emit(merged, out));
    }
    // Clause fallback: a run-on with no sentence end must not buffer forever.
    if (this.held === null && this.buffer.length >= this.options.maxSegmentChars) {
      const cut = clauseCut(this.buffer, this.options.maxSegmentChars);
      if (cut > 0) {
        const piece = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut);
        if (piece) out.push(...this.emit(piece, out));
      }
    }
    return out;
  }

  /**
   * Stream ended. Returns the remaining text as a final segment (merged
   * with any held short sentence), or nothing when the reply ended exactly
   * on a boundary. After `flush()` the assembler is spent.
   */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (this.held !== null) {
      const merged = rest ? `${this.held} ${rest}` : this.held;
      this.held = null;
      return merged ? [merged] : [];
    }
    return rest ? [rest] : [];
  }

  private emit(segment: string, _prior: string[]): string[] {
    this.segments += 1;
    return [segment];
  }
}

/**
 * Split point for an over-long boundary-less stretch: the last clause
 * separator (`, ` / `، `) inside the window, else the last space, else the
 * window itself. Mirrors the voice chunker's `splitLong`.
 */
function clauseCut(text: string, max: number): number {
  const window = text.slice(0, max);
  let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("، "));
  if (cut > 0) return cut + 1;
  cut = window.lastIndexOf(" ");
  return cut > 0 ? cut : max;
}
