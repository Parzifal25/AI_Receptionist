import { normalizeForMatching } from "./normalize";

/**
 * HALO Phase 4 — per-language intent lexicons (plan §P3.6).
 *
 * The audit's most dangerous finding was that every English regex in the
 * product SILENTLY NO-OPS on Telugu: nothing errors, the deterministic layer
 * just switches off. These lexicons replace guesswork with explicit,
 * per-language phrase lists, and an unsupported language degrades LOUDLY
 * (see language-pack.ts) instead of pretending to understand.
 *
 * Matching is substring-based on normalized text, because Telugu has no
 * regex word boundary and agglutination makes affixes normal ("సరేనండి"
 * contains "సరే").
 */

export type IntentName =
  | "affirm"
  | "deny"
  | "dont_know"
  | "repeat"
  | "human"
  | "do_not_call"
  | "wrong_number"
  | "call_back_later";

export type IntentLexicon = Record<IntentName, string[]>;

export const TELUGU_LEXICON: IntentLexicon = {
  affirm: [
    "అవును", "అవునండి", "సరే", "సరేనండి", "ఓకే", "కరెక్ట్", "ఉంది", "కావాలి", "చెప్పండి",
    "avunu", "avnu", "avunandi", "sare", "sarenandi", "ok", "okay", "okey", "correct", "kavali", "undi", "haan", "ha",
    "yes", "yeah", "yep", "sure", "right",
  ],
  deny: [
    "కాదు", "లేదు", "వద్దు", "వద్దండి", "అవసరం లేదు", "ఆసక్తి లేదు",
    "kadu", "ledu", "vaddu", "vaddandi", "avasaram ledu", "asakti ledu", "interest ledu",
    "no", "nope", "not interested", "don't want", "dont want", "not needed",
  ],
  dont_know: [
    "తెలియదు", "తెలీదు", "గుర్తు లేదు", "ఖచ్చితంగా తెలియదు",
    "teliyadu", "telidu", "gurtu ledu", "idea ledu",
    "don't know", "dont know", "no idea", "not sure", "can't remember", "cant remember",
  ],
  repeat: [
    "మళ్ళీ చెప్పండి", "మళ్లీ చెప్పండి", "వినిపించలేదు", "అర్థం కాలేదు", "ఏమన్నారు",
    "malli cheppandi", "marokasari", "vinipinchaledu", "artham kaledu", "emannaru",
    "repeat", "say that again", "pardon", "come again", "couldn't hear", "couldnt hear", "didn't catch",
  ],
  human: [
    "మనిషి", "మనిషితో", "మనిషితో మాట్లాడాలి", "సిబ్బంది", "మేనేజర్", "మీ ఆఫీస్",
    "manishi", "manishi tho", "manishitho matladali", "manager", "staff",
    "human", "real person", "speak to someone", "talk to a person", "agent", "executive", "representative",
  ],
  do_not_call: [
    "కాల్ చేయకండి", "మళ్ళీ కాల్ చేయకండి", "ఫోన్ చేయకండి", "నా నంబర్ తీసేయండి", "డిస్టర్బ్ చేయకండి",
    "call cheyakandi", "malli call cheyakandi", "phone cheyakandi", "number tiseyandi", "disturb cheyakandi",
    "do not call", "don't call", "dont call again", "remove my number", "stop calling", "unsubscribe",
  ],
  wrong_number: [
    "రాంగ్ నంబర్", "తప్పు నంబర్", "ఎవరు కావాలి", "ఇది వేరే నంబర్",
    "wrong number", "tappu number", "rong number", "evaru kavali",
  ],
  call_back_later: [
    "తర్వాత చేయండి", "తరువాత మాట్లాడదాం", "ఇప్పుడు కుదరదు", "బిజీగా ఉన్నాను",
    "tarvatha cheyandi", "taruvatha matladudam", "ippudu kudaradu", "busy ga unnanu",
    "call me later", "call back later", "not a good time", "i'm busy", "im busy", "later please",
  ],
};

export const ENGLISH_LEXICON: IntentLexicon = {
  affirm: ["yes", "yeah", "yep", "sure", "correct", "right", "ok", "okay", "please do", "go ahead", "that's right"],
  deny: ["no", "nope", "not interested", "don't want", "dont want", "not needed", "no thanks", "no thank you"],
  dont_know: ["don't know", "dont know", "no idea", "not sure", "can't remember", "cant remember", "unsure"],
  repeat: ["repeat", "say that again", "pardon", "come again", "couldn't hear", "couldnt hear", "didn't catch"],
  human: ["human", "real person", "speak to someone", "talk to a person", "agent", "executive", "representative", "manager"],
  do_not_call: ["do not call", "don't call", "dont call again", "remove my number", "stop calling", "unsubscribe", "take me off"],
  wrong_number: ["wrong number", "you have the wrong", "who do you want"],
  call_back_later: ["call me later", "call back later", "not a good time", "i'm busy", "im busy", "later please"],
};

export interface IntentMatch {
  intent: IntentName;
  phrase: string;
  confidence: number;
}

/** All intents present in the text, longest phrase first (most specific wins). */
export function matchIntents(text: string, lexicon: IntentLexicon): IntentMatch[] {
  const normalized = normalizeForMatching(text);
  if (!normalized) return [];
  const matches: IntentMatch[] = [];
  for (const [intent, phrases] of Object.entries(lexicon) as Array<[IntentName, string[]]>) {
    const hit = [...phrases].sort((a, b) => b.length - a.length).find((phrase) => normalized.includes(normalizeForMatching(phrase)));
    if (hit) {
      matches.push({ intent, phrase: hit, confidence: hit.length >= 10 ? 0.9 : 0.75 });
    }
  }
  return matches.sort((a, b) => b.phrase.length - a.phrase.length);
}

export function hasIntent(text: string, lexicon: IntentLexicon, intent: IntentName): boolean {
  return matchIntents(text, lexicon).some((m) => m.intent === intent);
}
