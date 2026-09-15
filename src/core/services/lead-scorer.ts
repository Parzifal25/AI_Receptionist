import type { ChatMessage, LeadDraft } from "@halo/core/domain/types";

/**
 * Lead qualification.
 *
 * Capturing a contact is commodity. The value is telling the business *who to
 * call first*. This scores a captured lead 0–100 from deterministic signals —
 * contactability, stated intent, buying language, urgency, timeline, and
 * engagement — buckets it into a temperature, classifies the lead kind
 * (emergency / returning customer / spam), and recommends the next action.
 * It runs with zero added LLM latency or cost, composing on top of the
 * extraction that already produced the draft.
 */

export type LeadTemperature = "hot" | "warm" | "cold";

/** What kind of lead this is, beyond how warm it is. */
export type LeadClassification =
  | "emergency"
  | "returning_customer"
  | "spam"
  | "standard";

export interface LeadQualification {
  score: number; // 0–100
  temperature: LeadTemperature;
  classification: LeadClassification;
  /** Human-readable reasons, surfaced in the dashboard ("Asked about pricing"). */
  signals: string[];
  /** What the business should do with this lead right now. */
  nextAction: string;
}

// Buying-intent phrases a prospect uses when they're close to a decision.
const BUYING_PHRASES = [
  "price",
  "prices",
  "pricing",
  "cost",
  "costs",
  "how much",
  "quote",
  "estimate",
  "buy",
  "purchase",
  "sign up",
  "book",
  "booking",
  "appointment",
  "schedule",
  "available",
  "availability",
  "openings",
  "get started",
  "come in",
  "consultation",
  "demo",
];

// Phrases that signal the visitor is past shopping and ready to commit.
const HIGH_INTENT_PHRASES = [
  "ready to",
  "want to book",
  "i'd like to book",
  "let's do it",
  "send me the quote",
  "how do i sign up",
  "how do i pay",
  "can you fit me in",
];

// Urgency phrases that mean "reach out now, not next week".
const URGENCY_PHRASES = [
  "today",
  "asap",
  "urgent",
  "urgently",
  "right now",
  "right away",
  "this week",
  "tonight",
  "tomorrow",
  "immediately",
  "as soon as possible",
];

// Situations where minutes matter — the owner should be interrupted.
const EMERGENCY_PHRASES = [
  "emergency",
  "flooding",
  "flooded",
  "burst pipe",
  "sewage",
  "no heat",
  "no hot water",
  "no power",
  "gas leak",
  "gas smell",
  "smell gas",
  "sparks",
  "burning smell",
  "severe pain",
  "unbearable pain",
  "bleeding",
  "knocked out tooth",
  "roof is leaking",
  "water everywhere",
  "hit by a car",
  "not breathing",
  "seizure",
  "poison",
];

// A near-term stated timeline is a commitment signal distinct from urgency.
const NEAR_TIMELINE_PHRASES = ["next week", "this month", "this weekend", "in a few days"];

// Self-identification as an existing customer — route to service, call fast.
const RETURNING_PHRASES = [
  "existing customer",
  "existing client",
  "existing patient",
  "i'm a customer",
  "i am a customer",
  "my last appointment",
  "my previous appointment",
  "you guys came out",
  "you came out last",
  "i've used you before",
  "i have used you before",
  "came here before",
  "been here before",
  "my account",
];

// Decision-maker signals — the person who can say yes.
const DECISION_MAKER_PHRASES = [
  "i'm the owner",
  "i am the owner",
  "i own",
  "my house",
  "my home",
  "my property",
  "my business",
  "our office",
  "my company",
];

// Unsolicited-vendor / SEO-spam vocabulary. One hit is suspicion; the
// pattern is unmistakable in practice.
const SPAM_PHRASES = [
  "seo services",
  "guest post",
  "backlink",
  "backlinks",
  "link building",
  "increase your traffic",
  "rank on google",
  "first page of google",
  "web design services",
  "business proposal",
  "collaboration proposal",
  "crypto",
  "loan offer",
  "we are a marketing agency",
  "boost your sales",
];

// Explicit disengagement — a real visitor, but not a lead today.
const DISENGAGED_PHRASES = [
  "just browsing",
  "just looking",
  "not interested",
  "no thanks",
  "maybe later",
  "just curious",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-phrase match with word boundaries, so "book" matches "book a visit"
 * but not "facebook". Compiled once per phrase list at module load.
 */
function compile(phrases: string[]): RegExp {
  return new RegExp(`\\b(?:${phrases.map(escapeRegExp).join("|")})\\b`, "i");
}

function countMatches(text: string, phrases: string[]): number {
  return phrases.filter((p) => new RegExp(`\\b${escapeRegExp(p)}\\b`, "i").test(text)).length;
}

const HIGH_INTENT_RE = compile(HIGH_INTENT_PHRASES);
const URGENCY_RE = compile(URGENCY_PHRASES);
const EMERGENCY_RE = compile(EMERGENCY_PHRASES);
const NEAR_TIMELINE_RE = compile(NEAR_TIMELINE_PHRASES);
const RETURNING_RE = compile(RETURNING_PHRASES);
const DECISION_MAKER_RE = compile(DECISION_MAKER_PHRASES);
const SPAM_RE = compile(SPAM_PHRASES);
const DISENGAGED_RE = compile(DISENGAGED_PHRASES);

function visitorText(transcript: ChatMessage[]): string {
  return transcript
    .filter((m) => m.role === "user")
    .map((m) => m.content.toLowerCase())
    .join(" \n ");
}

function temperatureFor(score: number): LeadTemperature {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

function nextActionFor(
  classification: LeadClassification,
  temperature: LeadTemperature,
): string {
  if (classification === "emergency") return "Call immediately — emergency";
  if (classification === "spam") return "Review before contacting — looks like spam";
  if (classification === "returning_customer") return "Call back soon — existing customer";
  if (temperature === "hot") return "Call within the hour";
  if (temperature === "warm") return "Follow up today";
  return "Add to follow-up list";
}

/**
 * Scores a lead from its captured contact details plus the conversation that
 * produced it. Pure and deterministic — the same inputs always score the same,
 * which keeps the "call these first" ordering explainable to the business.
 */
export function scoreLead(draft: LeadDraft, transcript: ChatMessage[] = []): LeadQualification {
  const signals: string[] = [];
  let score = 0;

  // Contactability — a lead you can't reach is worth little.
  if (draft.phone) {
    score += 30;
    signals.push("Shared phone number");
  }
  if (draft.email) {
    score += 20;
    signals.push("Shared email");
  }
  if (draft.name) {
    score += 10;
    signals.push("Gave their name");
  }

  // Stated intent.
  if (draft.intent && draft.intent.trim().length > 0) {
    score += 10;
    signals.push(`Intent: ${draft.intent.trim()}`);
  }

  const text = `${visitorText(transcript)} ${(draft.intent ?? "").toLowerCase()}`;

  // Buying language — the strongest single predictor of revenue.
  const buyingHits = countMatches(text, BUYING_PHRASES);
  if (buyingHits > 0) {
    score += Math.min(20, buyingHits * 10);
    signals.push("Showed buying intent");
  }
  if (HIGH_INTENT_RE.test(text)) {
    score += 10;
    signals.push("Ready to commit");
  }

  // Urgency — worth calling before the lead cools.
  if (URGENCY_RE.test(text)) {
    score += 10;
    signals.push("Expressed urgency");
  } else if (NEAR_TIMELINE_RE.test(text)) {
    score += 5;
    signals.push("Near-term timeline");
  }

  // Decision maker — the person who can say yes.
  if (DECISION_MAKER_RE.test(text)) {
    score += 5;
    signals.push("Likely decision maker");
  }

  // Engagement — sustained back-and-forth signals real interest.
  const visitorTurns = transcript.filter((m) => m.role === "user").length;
  if (visitorTurns >= 3) {
    score += 5;
    signals.push("Engaged conversation");
  }

  // Explicit disengagement dampens everything above.
  if (DISENGAGED_RE.test(text)) {
    score -= 15;
    signals.push("Said they're just looking");
  }

  // Classification — evaluated in priority order; emergency beats everything.
  let classification: LeadClassification = "standard";
  if (EMERGENCY_RE.test(text)) {
    classification = "emergency";
    score += 25;
    signals.push("Emergency situation");
  } else if (SPAM_RE.test(text)) {
    classification = "spam";
    score = Math.min(score, 10);
    signals.push("Looks like unsolicited outreach");
  } else if (RETURNING_RE.test(text)) {
    classification = "returning_customer";
    score += 5;
    signals.push("Existing customer");
  }

  score = Math.max(0, Math.min(100, score));
  const temperature = temperatureFor(score);
  return {
    score,
    temperature,
    classification,
    signals,
    nextAction: nextActionFor(classification, temperature),
  };
}
