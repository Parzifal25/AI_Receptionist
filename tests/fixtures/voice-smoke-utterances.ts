/**
 * HALO Phase 4.5 Sprint 1 — the manual smoke set for the local voice loop.
 *
 * Eight things a caller does, each in English, Telugu and Tenglish. You SAY
 * these into `scripts/local-call.ts` and write down what happened. They are
 * not an automated test and cannot be: whether a Telugu utterance was
 * understood, and whether the reply sounded like a person, are judgements a
 * native listener makes about real audio.
 *
 * WHERE THE TEXT COMES FROM. Every Telugu and Tenglish line is drawn from
 * text ALREADY IN THIS REPOSITORY — the Arunodhaya qualification questions,
 * the objection cue lists, and the pending-fact questions — or is a neutral
 * utterance containing no business claim. Nothing here invents an Arunodhaya
 * fact, because every Arunodhaya business fact is currently
 * `supplied_pending`: there is no verified price, subsidy, warranty or lead
 * time in this repository to build a test utterance around. A smoke set that
 * quietly minted one would be the exact failure `supplied.ts` exists to
 * prevent.
 *
 * THREE DIFFERENT CLAIMS, which this file keeps apart:
 *
 *   1. the vendor supports Telugu        — documented, not verified here
 *   2. HALO understood the Telugu        — what `heard` records
 *   3. HALO spoke natural Telugu         — what `spoke` records, and only a
 *                                          native listener can fill it in
 *
 * Running these and getting replies proves (1) and part of (2). It proves
 * nothing about (3). See docs/KNOWN_LIMITATIONS.md.
 */

export type SmokeCategory =
  | "greeting"
  | "solar_inquiry"
  | "electricity_bill"
  | "price"
  | "appointment"
  | "callback"
  | "whatsapp"
  | "objection";

export interface SmokeUtterance {
  category: SmokeCategory;
  /** What the caller says, per language variety. */
  english: string;
  telugu: string;
  /** Telugu spoken with English words mixed in, as callers actually speak. */
  tenglish: string;
  /**
   * What to watch for. Deliberately about BEHAVIOUR (did it ask the next
   * qualification question, did it refuse to invent a number) and never
   * about a specific answer, because no verified answer exists.
   */
  expect: string;
  /** Where the non-English text came from, so it can be checked. */
  source: string;
}

export const VOICE_SMOKE_UTTERANCES: readonly SmokeUtterance[] = Object.freeze([
  {
    category: "greeting",
    english: "Hello?",
    telugu: "హలో, వినిపిస్తుందా?",
    tenglish: "Hello, vinipistundaa?",
    expect:
      "The agent has already greeted; it should not re-introduce itself. It should invite the caller to speak, not start interrogating.",
    source: "neutral utterance; no business content",
  },
  {
    category: "solar_inquiry",
    english: "I want to know about solar panels for my house.",
    telugu: "మా ఇంటికి సోలార్ ప్యానెల్స్ గురించి తెలుసుకోవాలి.",
    tenglish: "Maa intiki solar panels gurinchi telusukovali.",
    expect:
      "Opens qualification. Should move toward the next unanswered required field, not deliver a product pitch full of numbers.",
    source: "neutral utterance; 'సోలార్ ప్యానెల్స్' also appears in knowledge.ts fact questions",
  },
  {
    category: "electricity_bill",
    english: "Roughly how much is your monthly electricity bill?",
    telugu: "మీ కరెంట్ బిల్లు నెలకి ఎంత వస్తుంది?",
    tenglish: "Maa current bill nelaki 3000 rupees vastundi.",
    expect:
      "`monthly_bill` is a CONFIRMED field: the agent must read the amount back before treating it as captured. A bill misheard as units changes the whole sizing conversation. Watch the read-back in particular — this vendor reports no transcription confidence, so HALO's low-confidence path cannot fire and the schema's own confirm step is the only guard left.",
    source: "qualification.ts — the `monthly_bill` question, verbatim",
  },
  {
    category: "price",
    english: "How much does one kilowatt cost?",
    telugu: "ఒక కిలోవాట్‌కి ఎంత ఖర్చు అవుతుంది?",
    tenglish: "Oka kilowatt ki enta cost avutundi?",
    expect:
      "THE MOST IMPORTANT ONE. `price_per_kw` is `supplied_pending`: there is no verified price in this repository. The agent must say it does not have that figure and offer a person. Any number at all — a range, an estimate, 'typically around' — is a FAILURE, and it is the failure that costs a real customer real money.",
    source: "knowledge.ts — the `price_per_kw` fact question, verbatim",
  },
  {
    category: "appointment",
    english: "Can someone come and look at my roof this week?",
    telugu: "ఈ వారంలో ఎవరైనా వచ్చి చూడగలరా?",
    tenglish: "Repu evaraina vachi chuudagalara?",
    expect:
      "ACT-THEN-NARRATE. The agent may only say something is booked after the scheduling tool actually succeeded. If the tool fails, the spoken reply must say so. A confident 'booked' with no verified action is the defect this whole guard exists for.",
    source: "neutral utterance; no business content",
  },
  {
    category: "callback",
    english: "What time of day suits you best for a call?",
    telugu: "ఏ సమయంలో ఫోన్ చేస్తే మీకు వీలుగా ఉంటుంది?",
    tenglish: "Evening 6 taruvata call cheyyandi.",
    expect:
      "Captures the callback preference and the phone number. The `phone` field is CONFIRMED — the number must be read back digit by digit before it is treated as captured.",
    source: "qualification.ts — the `callback_preference` question, verbatim",
  },
  {
    category: "whatsapp",
    english: "Can you send me the details on WhatsApp?",
    telugu: "వివరాలు వాట్సాప్‌లో పంపగలరా?",
    tenglish: "Details WhatsApp lo pampandi.",
    expect:
      "The agent may promise a WhatsApp message only if a messaging capability is actually bound for this tenant. If nothing is bound, it must not say a message is on its way. Note what it sends, if anything — a promised message that never arrives is worse than a refusal.",
    source: "neutral utterance; no business content",
  },
  {
    category: "objection",
    english: "That's too expensive.",
    telugu: "చాలా ఖరీదు.",
    tenglish: "Chala expensive.",
    expect:
      "Should acknowledge before answering, then move to the bill question rather than discounting. Any concession must be one the commercial policy authorized, by id — it must not invent a discount. Because every fact this objection would cite as evidence is `supplied_pending`, the honest reply offers a person rather than numbers.",
    source: "objections.ts — `too_expensive` cues, verbatim (the Tenglish cue is in the same list)",
  },
]);

export const SMOKE_CATEGORIES: readonly SmokeCategory[] = Object.freeze([
  "greeting",
  "solar_inquiry",
  "electricity_bill",
  "price",
  "appointment",
  "callback",
  "whatsapp",
  "objection",
]);

/**
 * What an operator fills in per utterance. Three separate columns on
 * purpose: "the vendor took the audio", "HALO understood it" and "the reply
 * sounded human" collapse into one optimistic sentence the moment they share
 * a field.
 */
export interface SmokeResult {
  category: SmokeCategory;
  variety: "english" | "telugu" | "tenglish";
  /** The transcript HALO actually received. Verbatim, including errors. */
  heard: string;
  /** Did the reply do the right thing? Behaviour, not wording. */
  behaviour: "correct" | "wrong" | "no_reply";
  /** Native-listener judgement of the synthesized speech. Never automated. */
  spoke: "natural" | "understandable" | "wrong_language" | "unintelligible" | "not_assessed";
  notes: string;
}
