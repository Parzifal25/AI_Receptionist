import type { EscalationReason } from "@halo/runtime/contracts";

/**
 * Arunodhaya Phase 4 — escalation configuration (brief §10).
 *
 * Two separate questions, deliberately kept apart:
 *
 *   WHEN should a person take over?  — this file.
 *   DID the transfer actually work?  — the telephony provider, and only the
 *                                      provider. The agent speaks the
 *                                      tenant's `transferAnnounce` line
 *                                      before the bridge and, if the bridge
 *                                      fails, the `transferFailed` line. It
 *                                      can never say "you're connected"
 *                                      unless the provider confirmed it
 *                                      (packages/voice/voice-session.ts and
 *                                      pipecat/remote-session.ts).
 *
 * When no live handoff number is configured, `request_human_handoff` returns
 * no permitted claim at all and instructs the agent to promise a CALLBACK
 * instead of a connection.
 */
export const ARUNODHAYA_ESCALATION = {
  /**
   * Escalation reasons that trigger a LIVE transfer (as opposed to being
   * recorded for a callback). Everything else is recorded and called back,
   * because a failed live transfer is a worse customer experience than an
   * honest "we will call you".
   */
  liveTransferReasons: ["explicit_human_request"] as EscalationReason[],

  /**
   * Phrases meaning "I want a person", in the caller's own language. The
   * runtime's built-in detector is English and would never fire on a Telugu
   * call — these are what actually make escalation work here.
   */
  humanRequestPhrases: [
    "మనిషితో మాట్లాడాలి",
    "మనిషిని ఇవ్వండి",
    "ఎవరైనా మనిషి",
    "మీ టీమ్‌తో మాట్లాడాలి",
    "మేనేజర్‌తో మాట్లాడాలి",
    "manishi tho matladali",
    "manishini ivvandi",
    "human tho matladali",
    "manager tho matladali",
    "real person",
    "talk to a person",
    "speak to someone",
  ],

  /**
   * Situations that must reach a person. These are configuration, not code:
   * the runtime's escalation manager consumes them as triggers.
   */
  escalationTriggers: [
    // A complaint about existing work is not a sales conversation.
    "complaint about an existing installation or a previous visit",
    "a commercial question the policy does not authorize an answer to",
    "a technical question with no verified answer configured",
    "the caller has repeated the same objection past its budget",
    "the caller is distressed, angry or says they were misled",
    "anything involving a refund, a legal threat or a government complaint",
  ],

  /**
   * Repeated misunderstanding is a first-class escalation reason on a phone
   * call: a caller who has been misheard twice will not be helped by a third
   * attempt. Bounded by the qualification engine's own per-field attempts.
   */
  maxUnresolvedFieldsBeforeHuman: 2,
} as const;
