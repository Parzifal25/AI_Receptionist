import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { signWebCall } from "@halo/voice/web-audio-auth";
import type { AudioFormat } from "@halo/ports/streaming-stt-provider";
import { logger } from "@halo/platform/logger";
import { mintStreamToken } from "./stream-token";

const schema = z.object({ businessId: z.string().uuid(), timestamp: z.number() }).strict();

export interface WebCallDeps {
  secret: string;
  tokenTtlMs: number;
  /** Where the browser streams audio: the Pipecat worker's media socket. */
  mediaUrl: string;
  controlUrl: string;
  /** The wire format of the media socket; the browser must match it. */
  format: AudioFormat;
  /** The tenant's own active voice route, resolved server-side. Null declines. */
  resolveNumber(businessId: string): Promise<string | null>;
  now(): number;
}

/**
 * Offers a browser the same media session a carrier gets: a short-lived stream
 * token bound to a call id and the tenant's provisioned voice route, plus the
 * Pipecat media socket to stream to. The caller is the HALO web server, which
 * has already authorized the widget and its origin; the browser never names a
 * tenant, an agent or a number.
 */
export async function handleWebCall(req: IncomingMessage, res: ServerResponse, deps: WebCallDeps | null): Promise<void> {
  const send = (status: number, data: object) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1024) { send(413, { error: "bad_request" }); return; } chunks.push(Buffer.from(chunk)); }
  if (!deps) { send(503, { error: "voice_call_not_configured" }); return; }
  const body = Buffer.concat(chunks).toString("utf8");
  const signature = req.headers["x-halo-signature"], expected = signWebCall(deps.secret, body);
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) { send(403, { error: "unauthorized" }); return; }
  const parsed = schema.safeParse((() => { try { return JSON.parse(body); } catch { return null; } })());
  if (!parsed.success || Math.abs(deps.now() - parsed.data.timestamp) > 30000) { send(400, { error: "bad_request" }); return; }
  const to = await deps.resolveNumber(parsed.data.businessId);
  if (!to) { send(404, { error: "no_voice_agent" }); return; }
  const callId = `web-${randomUUID()}`;
  // Not a phone number, and unique per session: it can never match a CRM
  // contact or a do-not-call entry belonging to a real caller.
  const from = `web:${callId.slice(4, 22)}`;
  const token = mintStreamToken(deps.secret, { providerCallId: callId, from, to }, deps.tokenTtlMs, deps.now());
  logger.info("web voice call offered", { callId });
  send(200, {
    mediaUrl: deps.mediaUrl,
    format: deps.format,
    start: { event: "start", callId, streamId: callId, parameters: { token, callId, from, to, haloControlUrl: deps.controlUrl } },
  });
}
