import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  MediaInboundEvent,
  MediaStreamAnswer,
  MediaStreamCodec,
  TelephonyCapabilities,
  TelephonyProvider,
  TelephonyWebhookEvent,
  TransferTarget,
  WebhookRequest,
  WebhookVerification,
} from "@halo/ports/telephony-provider";

/**
 * Deterministic telephony fake (HALO Phase 3).
 *
 * A self-consistent imaginary provider used by tests and the mock demo:
 *   - webhooks are JSON, signed with `x-fake-signature: hex(HMAC-SHA256(secret, url + "\n" + body))`;
 *   - the media stream is JSON lines: {event:"start"|"media"|"mark"|"dtmf"|"stop", ...}
 *     with base64 μ-law 8 kHz payloads — the same shape real media-stream
 *     vendors use, so the gateway code path is identical;
 *   - hang-up and transfer are recorded; transfer failure is injectable.
 * Fails closed exactly like a real adapter: no secret → every webhook rejected.
 */

export function signFakeWebhook(secret: string, url: string, body: string): string {
  return createHmac("sha256", secret).update(`${url}\n${body}`).digest("hex");
}

export class FakeTelephonyProvider implements TelephonyProvider {
  readonly name = "fake";
  readonly hangups: string[] = [];
  readonly transfers: Array<{ providerCallId: string; target: TransferTarget }> = [];
  transferShouldFail = false;

  constructor(private readonly secret: string | null) {}

  capabilities(): TelephonyCapabilities {
    return { transfer: true, outbound: false, marks: true };
  }

  verifyWebhook(request: WebhookRequest): WebhookVerification {
    if (!this.secret) return { ok: false, reason: "not_configured" };
    const signature = request.headers["x-fake-signature"];
    if (!signature) return { ok: false, reason: "missing_signature" };
    const expected = Buffer.from(signFakeWebhook(this.secret, request.url, request.rawBody), "hex");
    const given = Buffer.from(/^[0-9a-f]+$/i.test(signature) ? signature : "", "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: true };
  }

  parseWebhook(request: WebhookRequest): TelephonyWebhookEvent {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(request.rawBody) as Record<string, unknown>;
    } catch {
      return { kind: "ignored", detail: "malformed json" };
    }
    const callId = typeof body.callId === "string" ? body.callId : "";
    if (!callId) return { kind: "ignored", detail: "missing callId" };
    if (body.type === "inbound") {
      return { kind: "inbound_call", providerCallId: callId, from: String(body.from ?? ""), to: String(body.to ?? "") };
    }
    if (body.type === "status") {
      const statuses = ["ringing", "in_progress", "completed", "busy", "no_answer", "failed", "canceled"] as const;
      const status = statuses.find((s) => s === body.status);
      if (!status) return { kind: "ignored", detail: "unknown status" };
      return {
        kind: "call_status",
        providerCallId: callId,
        status,
        durationSeconds: typeof body.duration === "number" ? body.duration : null,
      };
    }
    return { kind: "ignored", detail: "unknown type" };
  }

  answerWithMediaStream(params: { streamUrl: string; parameters: Record<string, string> }): MediaStreamAnswer {
    return {
      contentType: "application/json",
      body: JSON.stringify({ action: "connect_stream", url: params.streamUrl, parameters: params.parameters }),
    };
  }

  rejectCall(params: { reason: "unknown_number" | "capacity" | "unavailable" }): MediaStreamAnswer {
    return { contentType: "application/json", body: JSON.stringify({ action: "reject", reason: params.reason }) };
  }

  createMediaCodec(): MediaStreamCodec {
    return new FakeMediaCodec();
  }

  async hangup(providerCallId: string): Promise<void> {
    this.hangups.push(providerCallId);
  }

  async transfer(providerCallId: string, target: TransferTarget): Promise<void> {
    if (this.transferShouldFail) throw new Error("fake transfer failed");
    this.transfers.push({ providerCallId, target });
  }
}

export class FakeMediaCodec implements MediaStreamCodec {
  readonly format = { encoding: "mulaw", sampleRate: 8000, channels: 1 } as const;
  readonly supportsMarks = true;

  decode(message: string): MediaInboundEvent[] {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return [{ type: "malformed", detail: "not json" }];
    }
    switch (msg.event) {
      case "start": {
        const params = (msg.parameters ?? {}) as Record<string, unknown>;
        return [
          {
            type: "start",
            providerCallId: String(msg.callId ?? ""),
            streamId: String(msg.streamId ?? ""),
            parameters: Object.fromEntries(
              Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"),
            ),
          },
        ];
      }
      case "media":
        return typeof msg.payload === "string"
          ? [{ type: "audio", audio: new Uint8Array(Buffer.from(msg.payload, "base64")) }]
          : [{ type: "malformed", detail: "media without payload" }];
      case "mark":
        return [{ type: "mark", name: String(msg.name ?? "") }];
      case "dtmf":
        return [{ type: "dtmf", digit: String(msg.digit ?? "") }];
      case "stop":
        return [{ type: "stop" }];
      case "connected":
        return [{ type: "connected" }];
      default:
        return [{ type: "malformed", detail: "unknown event" }];
    }
  }

  encodeAudio(audio: Uint8Array): string {
    return JSON.stringify({ event: "media", payload: Buffer.from(audio).toString("base64") });
  }

  encodeClear(): string {
    return JSON.stringify({ event: "clear" });
  }

  encodeMark(name: string): string {
    return JSON.stringify({ event: "mark", name });
  }
}
