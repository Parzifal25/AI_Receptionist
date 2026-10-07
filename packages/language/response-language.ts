import { detectLanguage } from "./detect";
import { scriptCounts } from "./normalize";

/**
 * HALO Phase A — the language a reply is written and spoken in.
 *
 * WHY THIS IS STATE AND NOT A PROMPT SENTENCE. "Reply in the caller's
 * language" left the decision to the model on every turn, with an English
 * system prompt and English business facts pulling the other way — so Telugu
 * was understood and answered in English. And nothing downstream could act on
 * a decision nobody had made: the synthesizer stayed on the agent's primary
 * language for the whole call. Here the runtime decides once per turn, from
 * the caller's own words and the previous decision, and the same value reaches
 * the prompt and the synthesizer.
 *
 * WHY NOT THE STT LANGUAGE FIELD. Recognition is pinned to the agent's primary
 * language (auto-detection misheard short Telugu greetings as Hindi), so the
 * vendor's field reports the pin, not what the caller spoke.
 *
 * Deliberately small: the existing script-and-marker detector, one sticky rule
 * for utterances too short to carry a language, and nothing else.
 */

export interface ResponseLanguage {
  /** A configured tag when the agent has one for this language ("te-IN"), else the bare code ("en"). */
  tag: string;
  /** The caller mixes this language with English; the reply mirrors the mix. */
  mixed: boolean;
}

export interface ResponseLanguageInput {
  utterance: string;
  /** The decision persisted by the previous turn, if any. */
  previous: ResponseLanguage | null;
  /** The agent's configured primary tag. */
  primary: string;
  fallbacks: string[];
  codeSwitchPolicy: "allow" | "prefer-primary" | "reject";
}

/** Languages the detector can tell apart. Anything else is not guessed at. */
const DETECTABLE = ["te", "en"];

/**
 * Latin script is not English. "ok", "washing machine", "independent house" are
 * what a Telugu speaker says mid-sentence, and romanized Telugu the detector
 * has no marker for ("survey free aa") is Latin too. So leaving Telugu for
 * English takes evidence of an English SENTENCE: two of its function words.
 * Short on purpose — it settles one question and is not a classifier.
 */
const ENGLISH_FUNCTION_WORDS = new Set([
  "i", "you", "we", "the", "an", "is", "are", "was", "do", "does", "can", "could", "will", "would",
  "what", "how", "when", "where", "which", "why", "who", "want", "need", "have", "has", "know", "tell",
  "of", "for", "and", "or", "about", "my", "your", "me", "it", "this", "that", "there", "please",
  "much", "many", "with", "in", "on", "at", "not",
]);
const MIN_ENGLISH_FUNCTION_WORDS = 2;

function looksLikeEnglishSentence(utterance: string): boolean {
  const words = utterance.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  return words.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)).length >= MIN_ENGLISH_FUNCTION_WORDS;
}

export function baseLanguage(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

/** The configured tag serving `base`, primary first. */
export function configuredTag(base: string, primary: string, fallbacks: string[]): string | null {
  return [primary, ...fallbacks].find((tag) => baseLanguage(tag) === base) ?? null;
}

const LANGUAGE_NAMES: Record<string, string> = { te: "Telugu", en: "English" };

/**
 * The one line the model is given. A value the system set, not advice to
 * weigh: short on purpose, and the only language instruction in the prompt
 * when a decision exists.
 */
export function describeResponseLanguage(language: ResponseLanguage): string {
  const base = baseLanguage(language.tag);
  const name = LANGUAGE_NAMES[base] ?? language.tag;
  if (base === "en") return name;
  return language.mixed
    ? `casual spoken ${name} mixed with English, the way the caller speaks: ${name} words in ${name} script, and the English words the caller uses kept as English words in Latin letters, never translated or transliterated`
    : `${name}, in ${name} script`;
}

/**
 * Null means "not decided": the agent is configured for a language the
 * detector cannot recognise, or for English only (where Latin script proves
 * nothing about which language was typed). The caller keeps its previous
 * behaviour rather than acting on a guess.
 */
export function resolveResponseLanguage(input: ResponseLanguageInput): ResponseLanguage | null {
  const bases = [input.primary, ...input.fallbacks].map(baseLanguage);
  if (bases.some((base) => !DETECTABLE.includes(base)) || bases.every((base) => base === "en")) return null;

  const standing: ResponseLanguage = input.previous ?? { tag: input.primary, mixed: false };
  if (input.codeSwitchPolicy === "reject") return { tag: input.primary, mixed: false };

  const tagFor = (base: string) => configuredTag(base, input.primary, input.fallbacks) ?? base;
  const detection = detectLanguage(input.utterance);

  if (detection.primary === "te") {
    // Romanized Telugu is always a mix in practice: the function words are
    // Telugu and the nouns are English ("naaku washing machine kavali").
    return { tag: tagFor("te"), mixed: detection.romanized || hasLatinWord(input.utterance) };
  }
  if (detection.primary === "en") {
    if (baseLanguage(standing.tag) !== "en" && !looksLikeEnglishSentence(input.utterance)) return standing;
    return { tag: tagFor("en"), mixed: false };
  }
  // Digits, punctuation, another script: nothing to decide from.
  return standing;
}

/**
 * Whether `reply` is visibly NOT in the decided language. Script only, and
 * only the two unambiguous cases: a Telugu reply with no Telugu script in it
 * at all, or an English reply that is mostly Telugu script. A mixed reply is
 * never a mismatch — which words to mix is the model's judgement, not a rule.
 */
export function isWrongLanguage(reply: string, expected: ResponseLanguage): boolean {
  const counts = scriptCounts(reply);
  if (counts.telugu + counts.latin === 0) return false;
  const base = baseLanguage(expected.tag);
  if (base === "te") return counts.telugu === 0;
  if (base === "en") return counts.telugu > counts.latin;
  return false;
}

/** A Latin-script word, not a stray letter or a unit ("5 kW" still counts; "A" does not). */
function hasLatinWord(text: string): boolean {
  return text.split(/\s+/).some((word) => scriptCounts(word).latin >= 2);
}

/**
 * The configured tag to SPEAK `text` in, decided from the text itself.
 *
 * The reply is not always in the language that was asked for: a tenant's
 * fallback line and every deterministic voice prompt are authored in the
 * agent's own language. Handing Telugu script to an English voice produces
 * noise, so the script of what is actually about to be spoken wins.
 */
export function speechLanguageFor(text: string, primary: string, fallbacks: string[]): string {
  const detection = detectLanguage(text);
  if (detection.primary === "unknown") return primary;
  return configuredTag(detection.primary, primary, fallbacks) ?? primary;
}
