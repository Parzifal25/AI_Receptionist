import { detectLanguage } from "./detect";
import { normalizeForMatching } from "./normalize";

/**
 * Per-language cues for "is this message a substantive question?" — the gate
 * that decides whether an empty retrieval is recorded as a knowledge gap.
 *
 * It was an English-only regex, so on a Telugu turn no gap was ever recorded
 * and the repeated-misunderstanding signal could not fire (gap G5.4). The
 * cues are data per language, like the intent lexicons, so a new language is
 * a new entry here rather than another hard-coded regex.
 */
export interface QuestionCues {
  /** A message with fewer words than this is never a substantive question. */
  minWords: number;
  /** A message that OPENS with one of these is a greeting or acknowledgement. */
  greetings: readonly string[];
  /** Interrogative words. */
  interrogatives: readonly string[];
  /**
   * Where an interrogative counts. English questions open with one
   * ("do you…"). Telugu is verb-final, so the question word sits anywhere
   * ("subsidy entha vastundi") and yes/no questions end in -ā ("EMI undaa").
   */
  interrogativePosition: "start" | "anywhere";
}

/** Exactly the previous English regexes, expressed as data. */
export const ENGLISH_QUESTION_CUES: QuestionCues = Object.freeze({
  minWords: 3,
  greetings: ["hi", "hey", "hello", "good morning", "good afternoon", "good evening", "thanks", "thank you", "ok", "okay", "bye", "goodbye"],
  interrogatives: ["do", "does", "did", "can", "could", "will", "would", "is", "are", "was", "were", "how", "what", "when", "where", "which", "who", "why", "should"],
  interrogativePosition: "start",
});

/**
 * Telugu script and romanized ("Tenglish") forms. Telugu agglutinates, so
 * fewer words carry a full question ("ధర ఎంత?"), hence two words minimum.
 * "emi" is left out on purpose: in Tenglish it is usually EMI, the loan.
 */
export const TELUGU_QUESTION_CUES: QuestionCues = Object.freeze({
  minWords: 2,
  greetings: [
    "నమస్కారం", "నమస్తే", "ధన్యవాదాలు", "థాంక్స్", "సరే", "ఓకే", "బై",
    "namaskaram", "namaskaramandi", "namaste", "namasthe", "dhanyavadalu", "thanks", "thank you", "sare", "ok", "okay", "bye",
  ],
  interrogatives: [
    "ఏమిటి", "ఏంటి", "ఎలా", "ఎప్పుడు", "ఎక్కడ", "ఎందుకు", "ఎవరు", "ఎంత", "ఎన్ని", "ఏది",
    "ఉందా", "ఉంటుందా", "వస్తుందా", "చేస్తారా", "ఇస్తారా", "చేయగలరా",
    "enti", "yenti", "emiti", "ela", "yela", "eppudu", "yeppudu", "ekkada", "yekkada", "enduku", "yenduku",
    "evaru", "entha", "yentha", "enta", "enni", "edi",
    "unda", "undaa", "untunda", "untundaa", "vastunda", "vastundaa", "chestara", "chestaraa", "istara", "istaraa",
    "cheyagalara", "cheyyagalara",
  ],
  interrogativePosition: "anywhere",
});

const TELUGU_SCRIPT = /[ఀ-౿]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Leading-phrase match with an ASCII word boundary, as the English regex did. */
function opensWithLatin(message: string, phrases: readonly string[]): boolean {
  const latin = phrases.filter((p) => !TELUGU_SCRIPT.test(p));
  if (latin.length === 0) return false;
  return new RegExp(`^(${latin.map(escapeRegExp).join("|")})\\b`, "i").test(message);
}

/**
 * Telugu-script phrases match as prefixes/substrings: an affix is normal
 * ("నమస్కారమండి", "ఎంతకి"). Latin phrases must be whole words, or "ela"
 * would claim "elaborate".
 */
function words(normalized: string): string[] {
  return normalized.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}

/**
 * A romanized cue word is also an English word or name often enough ("Ela
 * is my name"), and the detector may have called the text Telugu because of
 * that very word. So a Latin-script cue counts only when the REST of the
 * message is still Telugu on its own evidence.
 */
function containsCue(normalized: string, cues: readonly string[]): boolean {
  const tokens = words(normalized);
  return cues.some((cue) => {
    const c = normalizeForMatching(cue);
    if (TELUGU_SCRIPT.test(c)) return normalized.includes(c);
    const at = tokens.indexOf(c);
    if (at < 0) return false;
    const rest = [...tokens.slice(0, at), ...tokens.slice(at + 1)].join(" ");
    return detectLanguage(rest).primary === "te";
  });
}

function opensWith(normalized: string, cues: readonly string[]): boolean {
  const first = words(normalized).join(" ");
  return cues.some((cue) => {
    const c = normalizeForMatching(cue);
    return TELUGU_SCRIPT.test(c) ? first.startsWith(c) : first === c || first.startsWith(`${c} `);
  });
}

/**
 * Whether a message is a substantive question under one language's cues.
 * Greetings, very short messages and statements don't count; a business
 * shouldn't see "hi" in its knowledge-gap report.
 */
export function isSubstantiveQuestionIn(text: string, cues: QuestionCues): boolean {
  const message = text.trim();
  if (wordCount(message) < cues.minWords) return false;
  if (cues.interrogativePosition === "start") {
    if (opensWithLatin(message, cues.greetings)) return false;
    return message.includes("?") || opensWithLatin(message, cues.interrogatives);
  }
  const normalized = normalizeForMatching(message);
  if (opensWith(normalized, cues.greetings)) return false;
  return message.includes("?") || containsCue(normalized, cues.interrogatives);
}
