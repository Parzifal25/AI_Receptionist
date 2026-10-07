import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { WidgetRepository } from "@/core/services/widget-repository";
import { corsHeaders, isOriginAllowed, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetSessionLimiter } from "@halo/platform/rate-limit";
import { signWebCall } from "@halo/voice/web-audio-auth";

const schema = z.object({ widgetKey: z.string().min(8).max(64) }).strict();
export const runtime = "nodejs";
export const OPTIONS = (request: NextRequest) => preflightResponse(request.headers.get("origin"));
/**
 * Offers the visitor a live voice session: a short-lived, call-bound stream
 * token and the Pipecat media socket to stream microphone audio to. Tenant
 * and agent are resolved server-side from the widget; speech credentials
 * never leave the server.
 */
export const POST = withErrorHandling("widget.voice-call", async (request: NextRequest) => {
  const origin = request.headers.get("origin"), headers = corsHeaders(origin);
  if (!(await widgetSessionLimiter.check(`call:ip:${clientIp(request)}`)).allowed) return fail(AppError.rateLimited(), headers);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(AppError.validation("Invalid voice call request"), headers);
  const { receptionist, business, allowedDomains } = await new WidgetRepository().getReceptionistByWidgetKey(parsed.data.widgetKey);
  if (!isOriginAllowed(origin, allowedDomains) || !receptionist.voiceEnabled) return fail(AppError.forbidden("Voice is not enabled for this widget"), headers);
  if (!(await widgetSessionLimiter.check(`call:tenant:${business.id}`)).allowed) return fail(AppError.rateLimited(), headers);
  const base = process.env.VOICE_GATEWAY_INTERNAL_URL, secret = process.env.VOICE_STREAM_TOKEN_SECRET;
  if (!base || !secret || secret.length < 32) return fail(AppError.serviceUnavailable("HALO voice gateway is not configured"), headers);
  const body = JSON.stringify({ businessId: business.id, timestamp: Date.now() });
  try {
    const response = await fetch(new URL("/web/call", base), { method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-halo-signature": signWebCall(secret, body) }, body,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
    const offer = await response.json() as { error?: string };
    if (!response.ok) return fail(AppError.serviceUnavailable(offer.error === "no_voice_agent" ? "No voice agent is published for this business" : "Live voice is not available"), headers);
    return NextResponse.json({ data: offer }, { headers: { ...headers, "cache-control": "no-store" } });
  } catch { return fail(AppError.serviceUnavailable("HALO voice gateway is unreachable"), headers); }
});
