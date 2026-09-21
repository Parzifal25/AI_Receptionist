import { z } from "zod";

/**
 * HALO Phase 4 — the Pipecat ⇄ HALO control protocol
 * (docs/PIPECAT_INTEGRATION.md §3, docs/PHASE4_REPORT.md).
 *
 * ONE socket per call, text frames only. No audio ever crosses it: Pipecat
 * owns the media pipeline (transport, VAD, STT, TTS, interruption) and HALO
 * owns everything that decides what the business does (tenant, agent, agent
 * version, conversation, tools, knowledge, policy, escalation, outcome).
 *
 * Trust model — the reason this file exists as a *validated* boundary:
 *
 *   - Pipecat NEVER names a tenant, an agent or an agent version. It presents
 *     the short-lived stream token HALO minted during the signature-verified
 *     telephony webhook; HALO resolves identity from the dialled number it
 *     provisioned itself and replies with `ready`. Identity travels HALO →
 *     Pipecat, never the other way (§16 of the Phase 4 brief).
 *   - Pipecat never holds tenant content. Every spoken line — greeting,
 *     reprompt, goodbye, transfer announcement, and every model reply —
 *     arrives as a `speak` command. Pipecat cannot invent or translate one.
 *   - Pipecat never performs a transfer or a hangup on its own authority; it
 *     reports and obeys.
 *   - Every inbound frame is schema-validated here before any session code
 *     sees it. An unparsable frame is a protocol error, not a default.
 *
 * `PROTOCOL_VERSION` is checked on `hello`: a Pipecat worker built against a
 * different major version is refused rather than silently misunderstood.
 */

export const PIPECAT_PROTOCOL_VERSION = "1.0" as const;

/** Bounds every text field so a misbehaving worker cannot exhaust memory. */
const MAX_TRANSCRIPT_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Pipecat → HALO
// ---------------------------------------------------------------------------

export const pipecatHelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.string().max(16),
  /** Provider call id as the telephony vendor reported it to Pipecat. */
  providerCallId: z.string().min(1).max(128),
  from: z.string().max(32),
  to: z.string().max(32),
  /** The HMAC stream token minted during the verified inbound webhook. */
  token: z.string().max(512),
  /** Free-form worker build id, for telemetry only. Never trusted. */
  worker: z.string().max(64).optional(),
});

export const pipecatEventSchema = z.discriminatedUnion("type", [
  /** Remote VAD detected the start of caller speech. */
  z.object({ type: z.literal("speech_started"), at: z.number().optional() }),
  /** Remote VAD endpointed the caller's utterance. */
  z.object({ type: z.literal("speech_stopped"), at: z.number().optional() }),
  z.object({
    type: z.literal("transcript"),
    final: z.boolean(),
    text: z.string().max(MAX_TRANSCRIPT_CHARS),
    /** Stable per utterance so a re-sent final is de-duplicated, not re-run. */
    utteranceId: z.string().max(128).optional(),
    language: z.string().max(16).nullable().default(null),
    /** Only when the vendor reports one. Never invented (`null`). */
    confidence: z.number().min(0).max(1).nullable().default(null),
  }),
  z.object({
    type: z.literal("playback"),
    playbackId: z.string().max(64),
    phase: z.enum(["first_audio", "chunk_played", "stopped"]),
    /** 0-based index of the chunk that finished playing out. */
    chunkIndex: z.int().min(0).max(512).optional(),
    reason: z.enum(["completed", "interrupted", "failed"]).optional(),
    audioMs: z.number().min(0).max(3_600_000).optional(),
  }),
  z.object({ type: z.literal("dtmf"), digit: z.string().max(4) }),
  /** Cumulative media accounting; HALO never estimates these itself. */
  z.object({
    type: z.literal("usage"),
    inboundAudioMs: z.number().min(0).max(3_600_000),
    outboundAudioMs: z.number().min(0).max(3_600_000),
    ttsCharacters: z.int().min(0).max(1_000_000),
  }),
  z.object({
    type: z.literal("error"),
    component: z.enum(["stt", "tts", "transport", "pipeline"]),
    code: z.string().max(64),
    retryable: z.boolean(),
  }),
  /** The media leg is gone (caller hung up, transport closed, worker stopping). */
  z.object({ type: z.literal("bye"), reason: z.enum(["caller_hangup", "transport_closed", "worker_shutdown", "pipeline_failure"]) }),
]);

export type PipecatHello = z.infer<typeof pipecatHelloSchema>;
export type PipecatEvent = z.infer<typeof pipecatEventSchema>;

export type PipecatFrameParse =
  | { ok: true; event: PipecatEvent }
  | { ok: false; error: string };

/** Parses one inbound text frame. Never throws; never returns partial data. */
export function parsePipecatEvent(raw: string): PipecatFrameParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "malformed_json" };
  }
  const parsed = pipecatEventSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "frame"}: ${i.message}`).join("; ") };
  }
  return { ok: true, event: parsed.data };
}

export function parsePipecatHello(raw: string): { ok: true; hello: PipecatHello } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "malformed_json" };
  }
  const parsed = pipecatHelloSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: "invalid_hello" };
  if (major(parsed.data.protocol) !== major(PIPECAT_PROTOCOL_VERSION)) {
    return { ok: false, error: `unsupported_protocol:${parsed.data.protocol}` };
  }
  return { ok: true, hello: parsed.data };
}

function major(version: string): string {
  return version.split(".")[0];
}

// ---------------------------------------------------------------------------
// HALO → Pipecat
// ---------------------------------------------------------------------------

/**
 * The identity every voice session carries end to end. Resolved server-side
 * from the dialled number, pinned for the whole call, and echoed by Pipecat
 * purely for correlation in ITS logs — HALO re-derives it per socket and
 * never reads it back from a frame.
 */
export interface VoiceSessionIdentity {
  /** The tenant. Named `tenantId` on the wire; `businessId` inside HALO. */
  tenantId: string;
  agentId: string;
  agentVersionId: string;
  agentVersion: number;
  callId: string;
  sessionId: string;
  conversationId: string;
  correlationId: string;
}

/**
 * Media parameters Pipecat needs to run the pipeline. Tenant-authored
 * SPOKEN CONTENT is deliberately absent: every line the caller hears comes
 * over the wire as a `speak` command at the moment it is due.
 */
export interface RemoteVoiceConfig {
  language: string;
  alternativeLanguages: string[];
  phraseHints: string[];
  voiceId?: string;
  speakingRate?: number;
  vad: { minSpeechMs: number; endHangoverMs: number };
  bargeIn: { enabled: boolean; minSpeechMs: number };
  maxCallDurationMs: number;
}

export type PipecatCommand =
  | { type: "ready"; protocol: string; session: VoiceSessionIdentity; voice: RemoteVoiceConfig }
  | {
      type: "speak";
      playbackId: string;
      /** `reply` = model output for a turn; `policy` = a deterministic HALO line. */
      kind: "reply" | "policy";
      /** Runtime turn id for replies; null for policy lines. */
      turnId: string | null;
      /** Pre-chunked at sentence boundaries so playback reports are granular. */
      chunks: string[];
      /** False while a handoff or hang-up sequence owns the call. */
      interruptible: boolean;
    }
  | { type: "stop_playback"; playbackId: string; reason: string }
  | { type: "hangup"; reason: string };

export function encodeCommand(command: PipecatCommand): string {
  return JSON.stringify(command);
}
