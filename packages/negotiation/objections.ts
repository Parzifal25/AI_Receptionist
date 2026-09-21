import { z } from "zod";
import { normalizeForMatching } from "@halo/language/normalize";

/**
 * HALO Phase 4 — objection handling (brief §7).
 *
 * An objection is not a failure state and not a trigger for pressure. The
 * agent's job is to acknowledge it, understand what is actually behind it,
 * answer with VERIFIED information, ask one useful question, and continue
 * only if that is appropriate. Every one of those moves is tenant content
 * here: the cue words that recognize the objection, the acknowledgement, the
 * follow-up question and which verified facts may be used to answer it.
 *
 * Detection is deterministic substring matching over normalized text, not a
 * classifier. Cues are matched as substrings because Indic scripts have no
 * usable `\b` and callers switch scripts and spellings freely inside one
 * sentence ("chala expensive andi"). A classifier would be less predictable
 * and would cost a model call inside a voice turn.
 *
 * `evidence` names verified facts (knowledge document ids or fact keys). The
 * agent answers FROM those. It never manufactures a counter-argument, and an
 * objection with no evidence configured is an explicit instruction to be
 * honest about not knowing and to offer a person.
 */

const localized = z.record(z.string().min(2).max(16), z.string().min(1).max(600));

export const objectionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  /** Per-language cue phrases, matched as normalized substrings. */
  cues: z.record(z.string().min(2).max(16), z.array(z.string().min(2).max(80)).max(60)),
  /** How to acknowledge it, in the customer's language. Never dismissive. */
  acknowledge: localized,
  /** Verified fact / knowledge ids the answer may draw on. May be empty. */
  evidence: z.array(z.string().min(1).max(80)).max(12).default([]),
  /** One question that moves the conversation forward, not a pitch. */
  followUp: localized.optional(),
  /**
   * After this many raises of the SAME objection, stop re-answering and
   * offer a person. Repetition means the answer is not landing.
   */
  escalateAfter: z.int().min(1).max(5).default(2),
  /**
   * True when this objection means "not now" rather than "convince me":
   * the agent closes politely instead of continuing qualification.
   */
  endsQualification: z.boolean().default(false),
});

export const objectionCatalogSchema = z.object({
  version: z.string().min(1).max(40),
  language: z.string().min(2).max(16),
  objections: z.array(objectionSchema).max(40).default([]),
});

export type Objection = z.infer<typeof objectionSchema>;
export type ObjectionCatalog = z.infer<typeof objectionCatalogSchema>;

export type CatalogParseResult =
  | { ok: true; catalog: ObjectionCatalog }
  | { ok: false; errors: string[] };

export function parseObjectionCatalog(raw: unknown): CatalogParseResult {
  const parsed = objectionCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "catalog"}: ${i.message}`) };
  }
  const catalog = parsed.data;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const objection of catalog.objections) {
    if (ids.has(objection.id)) errors.push(`duplicate objection id "${objection.id}"`);
    ids.add(objection.id);
    if (!objection.cues[catalog.language]?.length) {
      errors.push(`objection "${objection.id}" has no cues in "${catalog.language}"`);
    }
    if (!objection.acknowledge[catalog.language]) {
      errors.push(`objection "${objection.id}" has no acknowledgement in "${catalog.language}"`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, catalog };
}

export interface ObjectionMatch {
  objection: Objection;
  /** The cue that fired, for telemetry and review. Never shown to a caller. */
  cue: string;
  language: string;
}

/**
 * Matches an utterance against the catalog. Cues from EVERY configured
 * language are tried, because a Telugu caller routinely raises an objection
 * in English ("it's too expensive") mid-sentence.
 */
export function matchObjections(utterance: string, catalog: ObjectionCatalog): ObjectionMatch[] {
  const normalized = normalizeForMatching(utterance);
  if (!normalized) return [];
  const matches: ObjectionMatch[] = [];
  for (const objection of catalog.objections) {
    for (const [language, cues] of Object.entries(objection.cues)) {
      const hit = cues.find((cue) => normalized.includes(normalizeForMatching(cue)));
      if (hit) {
        matches.push({ objection, cue: hit, language });
        break;
      }
    }
  }
  return matches;
}

/** Times each objection has been raised on this conversation. */
export type ObjectionHistory = Record<string, number>;

export function recordObjections(history: ObjectionHistory, matches: ObjectionMatch[]): ObjectionHistory {
  const next = { ...history };
  for (const match of matches) next[match.objection.id] = (next[match.objection.id] ?? 0) + 1;
  return next;
}

/** An objection raised more times than its own budget allows. */
export function exhaustedObjections(history: ObjectionHistory, catalog: ObjectionCatalog): Objection[] {
  return catalog.objections.filter((o) => (history[o.id] ?? 0) > o.escalateAfter);
}
