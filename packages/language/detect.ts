import { normalizeForMatching, scriptCounts } from "./normalize";

/**
 * HALO Phase 4 — script-based language detection with romanized-Telugu
 * ("Tenglish") recognition and code-switch flagging (plan §P3.3).
 *
 * Deliberately not a model: the decision only has to pick a language pack and
 * flag code switching, and a deterministic detector is reproducible, free and
 * fast enough for a voice turn.
 */

export type LanguageCode = "te" | "en" | "unknown";

export interface LanguageDetection {
  primary: LanguageCode;
  /** Telugu and Latin scripts (or Telugu words in Latin script) both present. */
  isCodeSwitched: boolean;
  /** Telugu written in Latin script. */
  romanized: boolean;
  confidence: number;
}

/** High-frequency Telugu function words as people actually type/say them in Latin script. */
const ROMANIZED_MARKERS = [
  "nenu", "naaku", "naku", "meeru", "miru", "mee", "maa", "kavali", "cheyandi", "cheyyandi",
  "cheppandi", "unnaru", "undi", "ledu", "kadu", "vaddu", "avunu", "sare", "entha", "enta",
  "ela", "emi", "enni", "eppudu", "ekkada", "vastundi", "chesaru", "chala", "bagundi", "garu",
  "repu", "ivala", "ellundi", "roju", "ippudu", "tarvatha", "gurinchi", "kosam", "daggara",
];

export function detectLanguage(text: string): LanguageDetection {
  const normalized = normalizeForMatching(text);
  if (!normalized) return { primary: "unknown", isCodeSwitched: false, romanized: false, confidence: 0 };

  const counts = scriptCounts(normalized);
  const romanizedHits = ROMANIZED_MARKERS.filter((marker) => ` ${normalized} `.includes(` ${marker}`)).length;

  if (counts.telugu > 0) {
    const teluguShare = counts.telugu / Math.max(1, counts.telugu + counts.latin);
    return {
      primary: "te",
      isCodeSwitched: counts.latin > 0,
      romanized: false,
      confidence: Math.min(0.99, 0.6 + teluguShare * 0.4),
    };
  }

  if (romanizedHits > 0) {
    return {
      primary: "te",
      // Romanized Telugu mixed with English technical terms is the normal case.
      isCodeSwitched: counts.latin > 0 && romanizedHits < normalized.split(/\s+/).length,
      romanized: true,
      confidence: Math.min(0.9, 0.5 + romanizedHits * 0.12),
    };
  }

  if (counts.latin > 0) return { primary: "en", isCodeSwitched: false, romanized: false, confidence: 0.7 };
  return { primary: "unknown", isCodeSwitched: false, romanized: false, confidence: 0 };
}
