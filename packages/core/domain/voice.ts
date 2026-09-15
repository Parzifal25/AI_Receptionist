/**
 * HALO Phase 3 — voice / call domain model (plan §P5.3–§P5.5).
 *
 * Three things are kept deliberately apart:
 *
 *   1. TECHNICAL CALL STATE (`CallState`) — what the telephony leg is doing:
 *      ringing, connected, conversing, completed, failed… Driven by provider
 *      events and the media loop. Guarded by `packages/voice/call-state.ts`
 *      and, for terminal protection, by a Postgres trigger (0020).
 *   2. BUSINESS OUTCOME (`CallDisposition`) — what the conversation achieved.
 *      A `completed` call can be `not_interested`; a `no_answer` call has no
 *      outcome at all. Computed deterministically, never model-asserted.
 *   3. MEDIA-LOOP EVENTS (`CallEventType`) — the internal, provider-neutral
 *      debug/latency stream. Provider wire events never leave the adapter;
 *      only these reach storage and analytics.
 *
 * Values are lower_snake so they are stored verbatim in CHECK-constrained
 * text columns (the schema's CHECK-over-enum convention).
 */

export const CALL_DIRECTIONS = ["inbound", "outbound"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export const CALL_STATES = [
  "created",
  "queued",
  "dialing",
  "ringing",
  "connected",
  "in_conversation",
  "interrupted",
  "completing",
  "completed",
  "transferred",
  "no_answer",
  "busy",
  "failed",
  "cancelled",
] as const;
export type CallState = (typeof CALL_STATES)[number];

export const TERMINAL_CALL_STATES: readonly CallState[] = [
  "completed",
  "transferred",
  "no_answer",
  "busy",
  "failed",
  "cancelled",
];

export const CALL_DISPOSITIONS = [
  "qualified",
  "not_qualified",
  "callback_requested",
  "not_interested",
  "wrong_number",
  "language_barrier",
  "do_not_call",
  "appointment_booked",
  "escalated_to_human",
  "no_outcome",
] as const;
export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export const CALL_EVENT_TYPES = [
  "session_started",
  "state_changed",
  "speech_started",
  "endpoint",
  "stt_partial",
  "stt_final",
  "agent_turn",
  "tts_start",
  "tts_first_byte",
  "tts_complete",
  "tts_cancel",
  "barge_in",
  "turn_complete",
  "turn_cancelled",
  "silence",
  "dtmf",
  "transfer",
  "provider_error",
  "media_disconnected",
  "media_reconnected",
  "session_ended",
] as const;
export type CallEventType = (typeof CALL_EVENT_TYPES)[number];

/** Why a call leg ended, as recorded in `calls.hangup_cause`. Closed set. */
export const CALL_END_REASONS = [
  "caller_hangup",
  "agent_completed",
  "silence_timeout",
  "transferred",
  "media_disconnected",
  "stt_failure",
  "tts_failure",
  "agent_failure",
  "provider_status",
  "max_duration",
  "gateway_shutdown",
  "rejected",
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

export type TranscriptSpeaker = "caller" | "agent";

/**
 * How much of an agent utterance the caller actually heard. The model is
 * told the truth about interrupted replies on the next turn (§P5.6).
 */
export type TranscriptDelivery = "complete" | "interrupted" | "not_delivered";

export interface CallTranscriptTurn {
  turnIndex: number;
  speaker: TranscriptSpeaker;
  /** The original text: caller STT output verbatim, or the full agent reply. */
  text: string;
  /** For interrupted agent turns: the portion acknowledged as played. */
  deliveredText?: string;
  delivery: TranscriptDelivery;
  /** BCP-47-ish tag as reported/detected ("te-IN", "en-IN", "te-en"). */
  language: string | null;
  sttConfidence: number | null;
  startedAt: string;
  endedAt: string;
  /** Agent runtime turn id (correlates to runtime events and messages). */
  turnId: string | null;
  /** Agent turns produced by deterministic voice policy (silence reprompts, goodbyes). */
  source: "caller" | "runtime" | "voice_policy";
}

/** Server-controlled routing for one call: which tenant/agent/version answers. */
export interface VoiceRoute {
  businessId: string;
  agentId: string;
  agentVersionId: string;
  agentVersion: number;
  phoneNumberId: string;
  /** E.164 transfer target configured by the tenant; never model-chosen. */
  handoffNumber: string | null;
  language: string;
}

export interface CallUsage {
  /** Seconds of caller audio received from the provider. */
  inboundAudioSeconds: number;
  /** Seconds of synthesized audio sent to the provider. */
  outboundAudioSeconds: number;
  /** Characters sent to TTS (billing basis for most TTS vendors). */
  ttsCharacters: number;
  agentTurns: number;
  modelCalls: number;
  /** Omitted when no model call reported token usage (never estimated). */
  inputTokens?: number;
  outputTokens?: number;
  bargeIns: number;
  /** null: no pricing configuration exists, so no cost is fabricated. */
  costEstimate: number | null;
}

export function emptyCallUsage(): CallUsage {
  return {
    inboundAudioSeconds: 0,
    outboundAudioSeconds: 0,
    ttsCharacters: 0,
    agentTurns: 0,
    modelCalls: 0,
    bargeIns: 0,
    costEstimate: null,
  };
}

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Strict E.164 check for configured numbers (transfer targets, tenant DIDs). */
export function isE164(value: string): boolean {
  return E164_RE.test(value);
}
