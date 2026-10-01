import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { WidgetRepository } from "@/core/services/widget-repository";
import { corsHeaders, isOriginAllowed, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetMessageLimiter } from "@halo/platform/rate-limit";
import { signWebAudio } from "@halo/voice/web-audio-auth";
const schema = z.object({ widgetKey: z.string().min(8).max(64), audio: z.string().min(4).max(426668).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
export const runtime = "nodejs";
export const OPTIONS = (request: NextRequest) => preflightResponse(request.headers.get("origin"));
export const POST = withErrorHandling("widget.speech", async (request: NextRequest) => {
  const origin = request.headers.get("origin"), headers = corsHeaders(origin);
  if (!(await widgetMessageLimiter.check(`speech:ip:${clientIp(request)}`)).allowed) return fail(AppError.rateLimited(), headers);
  // Bound the actual body, not just the untrusted Content-Length header.
  const reader = request.body?.getReader(); if (!reader) return fail(AppError.validation("Audio required"), headers);
  let size = 0; const parts: Uint8Array[] = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > 430000) return fail(AppError.validation("Audio exceeds ten seconds"), headers); parts.push(value);
  } } finally { await reader.cancel(); }
  const parsed = schema.safeParse((() => { try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return null; } })());
  if (!parsed.success) return fail(AppError.validation("Invalid audio request"), headers);
  const { receptionist, business, allowedDomains } = await new WidgetRepository().getReceptionistByWidgetKey(parsed.data.widgetKey);
  if (!isOriginAllowed(origin, allowedDomains) || !receptionist.voiceEnabled) return fail(AppError.forbidden("Voice is not enabled for this widget"), headers);
  if (!(await widgetMessageLimiter.check(`speech:tenant:${business.id}`)).allowed) return fail(AppError.rateLimited(), headers);
  const base = process.env.VOICE_GATEWAY_INTERNAL_URL, secret = process.env.VOICE_STREAM_TOKEN_SECRET;
  if (!base || !secret || secret.length < 32) return fail(AppError.serviceUnavailable("HALO voice gateway is not configured"), headers);
  const body = JSON.stringify({ businessId: business.id, language: receptionist.language, audio: parsed.data.audio, timestamp: Date.now() });
  try {
    const response = await fetch(new URL("/web/stt", base), { method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-halo-signature": signWebAudio(secret, body) }, body,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(28000)]) });
    const result = await response.json() as { text?: string; error?: string };
    if (!response.ok || !result.text) return fail(AppError.serviceUnavailable(result.error === "stt_not_configured" ? "HALO STT provider is not configured" : "HALO STT service failed to transcribe audio"), headers);
    return NextResponse.json({ data: { text: result.text } }, { headers });
  } catch { return fail(AppError.serviceUnavailable("HALO voice gateway is unreachable"), headers); }
});
