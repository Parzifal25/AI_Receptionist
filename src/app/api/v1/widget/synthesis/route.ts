import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { WidgetRepository } from "@/core/services/widget-repository";
import { corsHeaders, isOriginAllowed, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetMessageLimiter } from "@halo/platform/rate-limit";
import { signWebTts } from "@halo/voice/web-audio-auth";

const schema = z.object({ visitorToken: z.string().min(16).max(128) }).strict();
export const runtime = "nodejs";
export const OPTIONS = (request: NextRequest) => preflightResponse(request.headers.get("origin"));
/** Synthesize only the persisted HALO reply belonging to this visitor. */
export const POST = withErrorHandling("widget.synthesis", async (request: NextRequest) => {
  const origin = request.headers.get("origin"), headers = corsHeaders(origin);
  if (!(await widgetMessageLimiter.check(`tts:ip:${clientIp(request)}`)).allowed) return fail(AppError.rateLimited(), headers);
  const reader = request.body?.getReader(); if (!reader) return fail(AppError.validation("Request required"), headers);
  let size = 0; const parts: Uint8Array[] = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > 1024) return fail(AppError.validation("Request too large"), headers); parts.push(value);
  } } finally { await reader.cancel(); }
  const body = schema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
  const repository = new WidgetRepository();
  const conversation = await repository.getConversationByToken(body.visitorToken);
  if (conversation.status === "ended") return fail(AppError.conflict("Conversation ended"), headers);
  const { receptionist, business, allowedDomains } = await repository.getReceptionistById(conversation.receptionistId);
  if (business.id !== conversation.businessId || !receptionist.voiceEnabled || !isOriginAllowed(origin, allowedDomains)) return fail(AppError.forbidden(), headers);
  if (!(await widgetMessageLimiter.check(`tts:tenant:${business.id}`)).allowed) return fail(AppError.rateLimited(), headers);
  const messages = await repository.getRecentMessages(conversation.id, 1);
  const reply = messages[0];
  if (reply?.role !== "assistant" || !reply.content.trim()) return fail(AppError.conflict("No HALO reply ready for playback"), headers);
  const base = process.env.VOICE_GATEWAY_INTERNAL_URL, secret = process.env.VOICE_STREAM_TOKEN_SECRET;
  if (!base || !secret || secret.length < 32) return fail(AppError.serviceUnavailable("HALO voice gateway is not configured"), headers);
  const payload = JSON.stringify({ businessId: business.id, language: receptionist.language, text: reply.content, timestamp: Date.now() });
  try {
    const response = await fetch(new URL("/web/tts", base), { method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-halo-signature": signWebTts(secret, payload) }, body: payload,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(28000)]) });
    if (!response.ok) return fail(AppError.serviceUnavailable("HALO speech synthesis failed"), headers);
    const audio = await response.json();
    return NextResponse.json({ data: audio }, { headers: { ...headers, "cache-control": "no-store" } });
  } catch { return fail(AppError.serviceUnavailable("HALO voice gateway is unreachable"), headers); }
});
