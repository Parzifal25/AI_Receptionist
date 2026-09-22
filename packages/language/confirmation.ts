import { detectLanguage } from "./detect";
import { normalizeForMatching, scriptCounts } from "./normalize";

/**
 * HALO Phase 4.5 Sprint 2 — confirmation detection for a side-effecting tool.
 *
 * This is the narrowest and most safety-critical matcher in the product. It
 * answers exactly one question: did the caller, in the turn after being asked
 * to confirm a specific named action, say yes to it?
 *
 * It does NOT decide whether anything runs. The confirmation state machine in
 * `packages/runtime/tools/boundary.ts` still requires that a confirmation is
 * pending, that it names the very tool being authorized, that the tool is
 * offered, bound, within the channel's policy and not a duplicate. This
 * function can only ever turn a "no" into a "no" — it is one conjunct of
 * several, never a shortcut past them.
 *
 * WHY IT IS NOT THE INTENT LEXICON. `TELUGU_LEXICON.affirm` exists to read a
 * caller's general agreement, and it contains words like "ఉంది" (there is),
 * "కావాలి" (I want) and "చెప్పండి" (tell me). Those are affirmative in
 * conversation and are NOT authorization to book, cancel or transfer
 * anything. Treating any Telugu affirmative as consent for any side effect is
 * precisely the mistake this module exists to avoid, so it carries its own,
 * deliberately short list of words that actually mean "yes, do that".
 *
 * WHY THE POSITION RULE DIFFERS BY LANGUAGE. English put its "yes" first, and
 * the rule this replaces anchored on that. Telugu is verb-final: the
 * authorizing verb is the LAST word ("మీరు చెప్పినట్టు చేయండి" — "do as you
 * said"), and the same is true of romanized Telugu. Anchoring on the first
 * word would therefore have missed most real Telugu confirmations, which is
 * how a Telugu caller ends up unable to confirm anything. So English keeps
 * the start-anchored rule exactly as it was, and Telugu — in either script —
 * is matched anywhere in the utterance.
 *
 * ORDER IS THE SAFETY PROPERTY. Rejection, hedging and question forms are all
 * tested BEFORE agreement, and any of them ends the matter. "సరే చూద్దాం"
 * ("okay, let's see") contains a yes and is not one; "సరేనా?" ("okay?") is
 * the agent's question echoed back, not an answer. Telugu agglutination makes
 * this work in our favour: a negated verb carries its negation inside the
 * word, so "చెప్పలేదు" ("did not say") contains "లేదు" and reads as a
 * rejection without needing a parser.
 *
 * Deterministic by construction. No model, no scoring, no thresholds — an
 * authorization that is not reproducible is not reviewable.
 */

export type ConfirmationReading =
  /** An explicit yes to what was asked. The ONLY reading that authorizes. */
  | "affirmative"
  /** An explicit no. */
  | "rejection"
  /** Hedging, deferring, or not knowing. Not a yes. */
  | "uncertain"
  /** The caller asked something back instead of answering. */
  | "question"
  /** A backchannel that carries no decision at all ("hmm", "అలాగా"). */
  | "acknowledgement"
  /** Nothing recognisable either way. */
  | "none";

export interface ConfirmationClassification {
  reading: ConfirmationReading;
  /** The phrase that decided it, for logs and tests. Never the whole utterance. */
  matched: string | null;
  /** Which positional rule applied. */
  rule: "start_anchored" | "anywhere" | "none";
}

/**
 * Words that mean "yes, do that". Deliberately short. A word earns a place
 * here only if, said alone in answer to "shall I do X?", it means do X.
 */
const CONFIRM_PHRASES = [
  // Telugu script
  "సరే", "సరేనండి", "అవును", "అవునండి", "ఓకే", "కరెక్ట్", "చేయండి", "చెయ్యండి", "చేసేయండి", "కానివ్వండి",
  // Romanized Telugu, spelled the several ways transliteration and STT produce
  "sare", "sarandi", "sarenandi", "avunu", "avnu", "avunandi", "cheyandi", "cheyyandi",
  "cheseyandi", "cheseyyandi", "kanivvandi", "haan",
  // English
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "okey", "correct", "confirm", "confirmed",
  "please do", "go ahead", "do it", "that's right", "thats right", "sounds good", "absolutely", "of course",
] as const;

/** An explicit no, including the negated verb forms Telugu builds as one word. */
const REJECT_PHRASES = [
  "వద్దు", "వద్దండి", "కాదు", "లేదు", "అవసరం లేదు", "ఆసక్తి లేదు", "చేయకండి", "చేయవద్దు", "చెయ్యొద్దు",
  "vaddu", "vaddandi", "kadu", "ledu", "cheyakandi", "cheyyakandi", "cheyyavaddu", "cheyavaddu",
  "avasaram ledu", "asakti ledu",
  "no", "nope", "nah", "not interested", "don't want", "dont want", "not needed", "no thanks",
  "no thank you", "cancel", "stop", "don't", "dont do",
] as const;

/** Hedging, deferring and not knowing. All of these are "not yet", never "yes". */
const UNCERTAIN_PHRASES = [
  "చూద్దాం", "ఆలోచిస్తాను", "ఆలోచించాలి", "ఆలోచిస్తా", "తెలియదు", "తెలీదు", "గుర్తు లేదు",
  "తర్వాత", "తరువాత", "ఇప్పుడు కుదరదు", "ఏమో",
  "chuddam", "choodham", "alochistanu", "alochinchali", "teliyadu", "telidu", "gurtu ledu",
  "tarvatha", "taruvatha", "ippudu kudaradu",
  "maybe", "not sure", "let me think", "i'll think", "ill think", "think about it", "later",
  "not now", "not right now", "no idea", "probably", "perhaps", "i guess",
] as const;

/**
 * The agent's own question echoed back. A question is never an answer, so
 * these are checked before agreement even though several contain a yes.
 */
const QUESTION_PHRASES = [
  "సరేనా", "సరేనాండి", "అవునా", "అవునాండి", "ఓకేనా", "కదా", "ఎందుకు", "ఏంటి",
  "sarena", "sarenaa", "avuna", "avunaa", "okena", "kada",
] as const;

/** Backchannels: the caller is listening, not deciding. */
const ACKNOWLEDGEMENT_PHRASES = [
  "హ్మ్", "ఊఁ", "ఊ", "అలాగా", "ఓహో", "ఓహ్", "అచ్ఛా",
  "hmm", "hmmm", "mm", "mhm", "uh huh", "uh-huh", "uhhuh", "oh", "i see", "alaga", "oho", "achha", "accha",
] as const;

const hasTelugu = (text: string): boolean => scriptCounts(text).telugu > 0;

/**
 * Substring matching for text that contains Telugu script, word-boundary
 * matching for Latin. Telugu has no usable word boundary and agglutinates —
 * "సరేనండి" contains "సరే" — while a Latin substring match would find "no"
 * inside "know" and "phone number", which on a confirmation gate is the
 * difference between running an action and not.
 */
function findPhrase(normalized: string, phrases: readonly string[], anchorToStart: boolean): string | null {
  // Longest first, so the most specific phrase decides.
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    const needle = normalizeForMatching(phrase);
    if (!needle) continue;
    if (hasTelugu(needle)) {
      if (anchorToStart ? normalized.startsWith(needle) : normalized.includes(needle)) return phrase;
      continue;
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = anchorToStart ? `^${escaped}(?![a-z0-9])` : `(?<![a-z0-9])${escaped}(?![a-z0-9])`;
    if (new RegExp(pattern, "u").test(normalized)) return phrase;
  }
  return null;
}

/**
 * Reads one utterance. Pure, deterministic and side-effect free: the same
 * text always produces the same reading, on every machine.
 */
export function classifyConfirmation(text: string): ConfirmationClassification {
  const normalized = normalizeForMatching(text);
  if (!normalized) return { reading: "none", matched: null, rule: "none" };

  // A question mark ends it: the caller asked, they did not answer.
  if (/[?？]/.test(normalized)) return { reading: "question", matched: "?", rule: "anywhere" };

  const questioned = findPhrase(normalized, QUESTION_PHRASES, false);
  if (questioned) return { reading: "question", matched: questioned, rule: "anywhere" };

  const rejected = findPhrase(normalized, REJECT_PHRASES, false);
  if (rejected) return { reading: "rejection", matched: rejected, rule: "anywhere" };

  const hedged = findPhrase(normalized, UNCERTAIN_PHRASES, false);
  if (hedged) return { reading: "uncertain", matched: hedged, rule: "anywhere" };

  /*
   * Position rule. English put its "yes" first and the rule this replaces
   * anchored there; that anchor is kept exactly, so no English utterance
   * changes meaning. Telugu — in its own script or romanized — is verb-final,
   * so the authorizing word is matched anywhere.
   */
  const detection = detectLanguage(normalized);
  const anchorToStart = !(hasTelugu(normalized) || detection.primary === "te");
  const confirmed = findPhrase(normalized, CONFIRM_PHRASES, anchorToStart);
  if (confirmed) {
    return { reading: "affirmative", matched: confirmed, rule: anchorToStart ? "start_anchored" : "anywhere" };
  }

  const acknowledged = findPhrase(normalized, ACKNOWLEDGEMENT_PHRASES, false);
  if (acknowledged) return { reading: "acknowledgement", matched: acknowledged, rule: "anywhere" };

  return { reading: "none", matched: null, rule: "none" };
}

/**
 * The single predicate a confirmation gate should call. True ONLY for an
 * explicit yes — every other reading, including silence, a backchannel and a
 * question, is a no.
 */
export function isExplicitConfirmation(text: string): boolean {
  return classifyConfirmation(text).reading === "affirmative";
}

/** What a confirmation gate calls. Injectable so a tenant can supply its own. */
export type ConfirmationDetector = (text: string) => boolean;
