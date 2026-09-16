import { createHmac, timingSafeEqual } from "node:crypto";
import { TELEPHONY_AUDIO_FORMAT } from "@halo/ports/streaming-stt-provider";
import type {
  MediaInboundEvent,
  MediaStreamAnswer,
  MediaStreamCodec,
  ProviderCallStatus,
  TelephonyCapabilities,
  TelephonyProvider,
  TelephonyWebhookEvent,
  TransferTarget,
  WebhookRequest,
  WebhookVerification,
} from "@halo/ports/telephony-provider";

/**
 * HALO Phase 3 — reference telephony adapter: the Twilio Programmable Voice
 * webhook + Media Streams wire protocol.
 *
 * It exists to prove the port against a REAL provider protocol rather than
 * only against the fake, and because the same message shape (JSON frames with
 * base64 G.711 μ-law payloads, `start`/`media`/`mark`/`clear`/`stop`) is what
 * most media-stream vendors expose. Choosing a production vendor is still the
 * open decision of plan §P4 (Indian PSTN reach, DLT/TRAI, Telugu latency):
 * nothing above this file depends on this adapter.
 *
 * VERIFICATION STATUS: contract-tested against the documented protocol with
 * recorded fixtures. NOT verified against live Twilio infrastructure — no
 * credentials exist in this environment (docs/KNOWN_LIMITATIONS.md).
 *
 * Security: `verifyWebhook` implements Twilio's documented scheme —
 * base64(HMAC-SHA1(authToken, url + concat(sorted form key+value))) compared
 * in constant time — and FAILS CLOSED when no auth token is configured.
 */

const API_BASE = "https://api.twilio.com";

export interface TwilioProviderOptions {
  accountSid: string;
  /** Also the webhook signing key. Absent/empty → every webhook is rejected. */
  authToken: string | null;
  fetchImpl?: typeof fetch;
}

export class TwilioMediaStreamProvider implements TelephonyProvider {
  readonly name = "twilio";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TwilioProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  capabilities(): TelephonyCapabilities {
    return { transfer: true, outbound: false, marks: true };
  }

  verifyWebhook(request: WebhookRequest): WebhookVerification {
    const token = this.options.authToken;
    if (!token) return { ok: false, reason: "not_configured" };
    const signature = request.headers["x-twilio-signature"];
    if (!signature) return { ok: false, reason: "missing_signature" };

    let params: URLSearchParams;
    try {
      params = new URLSearchParams(request.rawBody);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    let payload = request.url;
    for (const key of [...params.keys()].sort()) {
      for (const value of params.getAll(key)) payload += key + value;
    }
    const expected = createHmac("sha1", token).update(payload, "utf8").digest();
    let given: Buffer;
    try {
      given = Buffer.from(signature, "base64");
    } catch {
      return { ok: false, reason: "invalid_signature" };
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: true };
  }

  parseWebhook(request: WebhookRequest): TelephonyWebhookEvent {
    const params = new URLSearchParams(request.rawBody);
    const callSid = params.get("CallSid") ?? "";
    if (!callSid) return { kind: "ignored", detail: "missing CallSid" };
    const status = params.get("CallStatus") ?? "";
    // The voice webhook for a new inbound call arrives as `ringing`; later
    // callbacks carry progress statuses for the same CallSid.
    if (params.get("Direction") === "inbound" && (status === "ringing" || status === "")) {
      return { kind: "inbound_call", providerCallId: callSid, from: params.get("From") ?? "", to: params.get("To") ?? "" };
    }
    const mapped = STATUS_MAP[status];
    if (!mapped) return { kind: "ignored", detail: `unmapped CallStatus "${status}"` };
    const duration = Number.parseInt(params.get("CallDuration") ?? "", 10);
    return {
      kind: "call_status",
      providerCallId: callSid,
      status: mapped,
      durationSeconds: Number.isFinite(duration) ? duration : null,
    };
  }

  answerWithMediaStream(params: { streamUrl: string; parameters: Record<string, string> }): MediaStreamAnswer {
    const parameters = Object.entries(params.parameters)
      .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`)
      .join("");
    return {
      contentType: "text/xml",
      body:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Response><Connect><Stream url="${escapeXml(params.streamUrl)}">${parameters}</Stream></Connect></Response>`,
    };
  }

  rejectCall(params: { reason: "unknown_number" | "capacity" | "unavailable" }): MediaStreamAnswer {
    const verb = params.reason === "unknown_number" ? `<Reject reason="rejected"/>` : `<Reject reason="busy"/>`;
    return { contentType: "text/xml", body: `<?xml version="1.0" encoding="UTF-8"?><Response>${verb}</Response>` };
  }

  createMediaCodec(): MediaStreamCodec {
    return new TwilioMediaCodec();
  }

  async hangup(providerCallId: string): Promise<void> {
    await this.updateCall(providerCallId, { Status: "completed" });
  }

  async transfer(providerCallId: string, target: TransferTarget): Promise<void> {
    // The dial target comes from tenant configuration, never from the model.
    await this.updateCall(providerCallId, {
      Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${escapeXml(target.phoneNumber)}</Dial></Response>`,
    });
  }

  private async updateCall(providerCallId: string, body: Record<string, string>): Promise<void> {
    if (!this.options.authToken) throw new Error("twilio: no auth token configured");
    const url = `${API_BASE}/2010-04-01/Accounts/${encodeURIComponent(this.options.accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`twilio: call update failed with ${response.status}`);
    }
  }
}

const STATUS_MAP: Record<string, ProviderCallStatus> = {
  queued: "ringing",
  initiated: "ringing",
  ringing: "ringing",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "canceled",
};

/**
 * Twilio Media Streams frames. Stateful by design: outbound frames must carry
 * the `streamSid` learned from the `start` frame, so one codec belongs to one
 * media socket.
 */
export class TwilioMediaCodec implements MediaStreamCodec {
  readonly format = TELEPHONY_AUDIO_FORMAT;
  readonly supportsMarks = true;
  private streamSid = "";

  decode(message: string): MediaInboundEvent[] {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return [{ type: "malformed", detail: "not json" }];
    }
    const event = frame.event;
    switch (event) {
      case "connected":
        return [{ type: "connected" }];
      case "start": {
        const start = (frame.start ?? {}) as Record<string, unknown>;
        this.streamSid = str(start.streamSid) || str(frame.streamSid);
        const custom = (start.customParameters ?? {}) as Record<string, unknown>;
        return [
          {
            type: "start",
            providerCallId: str(start.callSid),
            streamId: this.streamSid,
            parameters: Object.fromEntries(
              Object.entries(custom).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            ),
          },
        ];
      }
      case "media": {
        const media = (frame.media ?? {}) as Record<string, unknown>;
        const payload = str(media.payload);
        if (!payload) return [{ type: "malformed", detail: "media without payload" }];
        return [{ type: "audio", audio: new Uint8Array(Buffer.from(payload, "base64")) }];
      }
      case "dtmf": {
        const dtmf = (frame.dtmf ?? {}) as Record<string, unknown>;
        return [{ type: "dtmf", digit: str(dtmf.digit) }];
      }
      case "mark": {
        const mark = (frame.mark ?? {}) as Record<string, unknown>;
        return [{ type: "mark", name: str(mark.name) }];
      }
      case "stop":
        return [{ type: "stop" }];
      default:
        return [{ type: "malformed", detail: `unknown event "${String(event ?? "")}"` }];
    }
  }

  encodeAudio(audio: Uint8Array): string {
    return JSON.stringify({
      event: "media",
      streamSid: this.streamSid,
      media: { payload: Buffer.from(audio).toString("base64") },
    });
  }

  encodeClear(): string {
    return JSON.stringify({ event: "clear", streamSid: this.streamSid });
  }

  encodeMark(name: string): string {
    return JSON.stringify({ event: "mark", streamSid: this.streamSid, mark: { name } });
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Signs a form-encoded body exactly as Twilio does (tests and local fixtures). */
export function signTwilioWebhook(authToken: string, url: string, form: Record<string, string>): string {
  let payload = url;
  for (const key of Object.keys(form).sort()) payload += key + form[key];
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}
