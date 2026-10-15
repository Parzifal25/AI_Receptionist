import type { ChatMessage } from "@halo/core/domain/types";
import { detectLanguage } from "@halo/language/detect";
import { ENGLISH_PACK, TELUGU_PACK } from "@halo/language/language-pack";
import { isSubstantiveQuestionIn } from "@halo/language/question-cues";

/**
 * Retrieval query rewriting.
 *
 * Visitors speak in follow-ups: "how much is that?", "and on weekends?",
 * "does it hurt?". Retrieving against the raw message finds nothing because
 * the topic lives in earlier turns. This rewrites the retrieval query by
 * prepending recent visitor context when the current message looks anaphoric
 * — zero LLM cost, pure function, and the raw message is always kept so
 * exact-match signals survive.
 */

/** Messages shorter than this (in words) rarely carry their own topic. */
const SHORT_MESSAGE_WORDS = 6;
/** How many previous visitor messages to fold into the query. */
const CONTEXT_MESSAGES = 2;

// Openers that point back at something already discussed.
const ANAPHORIC_RE =
  /^(and|also|what about|how about|is that|does that|is it|does it|do they|can i|how much|how long|why|ok(ay)?|yes|yeah|sure|no|that one|the same|it|that|those|them|he|she|they)\b/i;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Builds the query string the knowledge provider should search with.
 * Standalone messages pass through untouched; short or anaphoric follow-ups
 * are prefixed with the visitor's recent messages so the retriever sees the
 * conversation topic.
 */
export function buildRetrievalQuery(history: ChatMessage[], userMessage: string): string {
  const message = userMessage.trim();
  if (!message) return message;

  const isFollowUp =
    wordCount(message) < SHORT_MESSAGE_WORDS || ANAPHORIC_RE.test(message);
  if (!isFollowUp) return message;

  const recentVisitorContext = history
    .filter((m) => m.role === "user")
    .slice(-CONTEXT_MESSAGES)
    .map((m) => m.content.trim())
    .filter(Boolean);

  if (recentVisitorContext.length === 0) return message;
  return [...recentVisitorContext, message].join(" ");
}

/**
 * Whether a visitor message is a substantive question — the gate for
 * recording an unanswered_question event when retrieval comes back empty.
 * Greetings, very short messages and statements don't count; a business
 * shouldn't see "hi" in its knowledge-gap report.
 *
 * Language-configurable (AGENTS.md): the cues live in each language pack.
 * English text is judged by the English cues only, exactly as before. Text
 * detected as Telugu (script or romanized) is judged by the Telugu cues OR
 * the English ones, because Telugu callers code-mix ("EMI facility undaa?").
 */
export function isSubstantiveQuestion(userMessage: string): boolean {
  const packs = detectLanguage(userMessage).primary === "te" ? [TELUGU_PACK, ENGLISH_PACK] : [ENGLISH_PACK];
  return packs.some((pack) => isSubstantiveQuestionIn(userMessage, pack.questionCues));
}
