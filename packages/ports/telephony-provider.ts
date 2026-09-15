import type { AudioFormat } from "./streaming-stt-provider";

/**
 * HALO Phase 3 — telephony port (plan §P5.2). Replaces the deleted Vapi
 * `voice-provider.ts`.
 *
 * Two surfaces, both provider-neutral:
 *
 *   CONTROL — webhooks and call-control REST: verify + parse the provider's
 *   HTTP callbacks, answer an inbound call by connecting it to our media
 *   stream, hang up, transfer. `verifyWebhook` is ON THE INTERFACE so no
 *   adapter can be added that forgets it, and it must FAIL CLOSED: an
 *   adapter constructed without its signing secret returns
 *   `{ ok: false, reason: "not_configured" }` for every request.
 *
 *   MEDIA — a codec for the provider's bidirectional media-stream wire
 *   protocol. It translates provider messages into `MediaInboundEvent`s and
 *   our audio/clear/mark commands into provider messages. Provider wire
 *   events never cross this boundary; the gateway only sees the neutral
 *   union below.
 */

export interface WebhookRequest {
  /** The full public URL the provider called (signature schemes sign it). */
  url: string;
  method: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  rawBody: string;
}

export type WebhookRejection = "not_configured" | "missing_signature" | "invalid_signature" | "malformed";

export type WebhookVerification = { ok: true } | { ok: false; reason: WebhookRejection };

export type ProviderCallStatus =
  | "ringing"
  | "in_progress"
  | "completed"
  | "busy"
  | "no_answer"
  | "failed"
  | "canceled";

export type TelephonyWebhookEvent =
  | {
      kind: "inbound_call";
      providerCallId: string;
      from: string;
      to: string;
    }
  | {
      kind: "call_status";
      providerCallId: string;
      status: ProviderCallStatus;
      durationSeconds: number | null;
    }
  | { kind: "ignored"; detail: string };

export interface MediaStreamAnswer {
  contentType: string;
  body: string;
}

export interface TransferTarget {
  /** E.164, tenant-configured. Never model-chosen. */
  phoneNumber: string;
}

export type MediaInboundEvent =
  | { type: "connected" }
  | {
      type: "start";
      providerCallId: string;
      streamId: string;
      /** Parameters WE put on the stream URL/instructions (e.g. the stream token). */
      parameters: Record<string, string>;
    }
  | { type: "audio"; audio: Uint8Array }
  | { type: "dtmf"; digit: string }
  /** Playback reached a mark we sent earlier (used to learn what the caller heard). */
  | { type: "mark"; name: string }
  | { type: "stop" }
  | { type: "malformed"; detail: string };

export interface MediaStreamCodec {
  /** The audio format carried in `audio` events and expected by `encodeAudio`. */
  readonly format: AudioFormat;
  /** Whether the provider acknowledges marks (otherwise delivery is estimated by time). */
  readonly supportsMarks: boolean;
  decode(message: string): MediaInboundEvent[];
  encodeAudio(audio: Uint8Array): string;
  /** Flush audio queued on the provider side (barge-in). */
  encodeClear(): string;
  encodeMark(name: string): string;
}

export interface TelephonyCapabilities {
  transfer: boolean;
  outbound: boolean;
  marks: boolean;
}

export interface TelephonyProvider {
  readonly name: string;
  capabilities(): TelephonyCapabilities;
  /** MANDATORY, constant-time, fail closed. */
  verifyWebhook(request: WebhookRequest): WebhookVerification;
  /** Parse an already-verified webhook. Never call on an unverified request. */
  parseWebhook(request: WebhookRequest): TelephonyWebhookEvent;
  /** Instructions that connect an inbound call to our media stream URL. */
  answerWithMediaStream(params: { streamUrl: string; parameters: Record<string, string> }): MediaStreamAnswer;
  /** Instructions that politely reject a call we will not serve (unknown number, capacity). */
  rejectCall(params: { reason: "unknown_number" | "capacity" | "unavailable" }): MediaStreamAnswer;
  createMediaCodec(): MediaStreamCodec;
  hangup(providerCallId: string): Promise<void>;
  transfer(providerCallId: string, target: TransferTarget): Promise<void>;
}
