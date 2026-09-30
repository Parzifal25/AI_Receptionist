/** Default language hints affect compute only, never intent or authorization.
 * Agent versions can replace these lists for any supported language. */
export const DEFAULT_ROUTING_CUES = {
  complexPhrases: ["discount", "negotia", "concession", "legal", "complaint", "డిస్కౌంట్", "తగ్గించ", "బేరం", "thaggin", "taggin"],
  simplePhrases: ["hi", "hello", "hey", "thanks", "thank you", "yes", "no", "ok", "okay", "sure", "సరే", "అవును", "కాదు", "నమస్కారం", "sare", "avunu"],
} as const;
