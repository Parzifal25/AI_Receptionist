import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { WidgetRepository } from "@/core/services/widget-repository";
import { corsHeaders, isOriginAllowed, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetSessionLimiter } from "@/lib/rate-limit";

const bodySchema = z.object({
  widgetKey: z.string().min(8).max(64),
  channel: z.enum(["chat", "voice"]).default("chat"),
  pageUrl: z.string().max(2000).default(""),
});

export const OPTIONS = (request: NextRequest) =>
  preflightResponse(request.headers.get("origin"));

/**
 * POST /api/v1/widget/conversations
 * Starts a conversation. Returns a visitor token the browser holds as its
 * proof of conversation ownership — no Supabase credentials ever reach the
 * visitor.
 */
export const POST = withErrorHandling("widget.conversations", async (request: NextRequest) => {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  const rate = await widgetSessionLimiter.check(`session:${clientIp(request)}`);
  if (!rate.allowed) return fail(AppError.rateLimited(), headers);

  const body = bodySchema.parse(await request.json().catch(() => ({})));

  const repository = new WidgetRepository();
  const { receptionist, business, allowedDomains } =
    await repository.getReceptionistByWidgetKey(body.widgetKey);

  if (!isOriginAllowed(origin, allowedDomains)) {
    return fail(AppError.forbidden("This domain is not allowed to embed this widget"), headers);
  }

  const conversation = await repository.createConversation({
    businessId: business.id,
    receptionistId: receptionist.id,
    channel: body.channel,
    pageUrl: body.pageUrl,
    userAgent: request.headers.get("user-agent") ?? "",
  });

  await repository.trackEvent(business.id, "conversation_started", {
    channel: body.channel,
  });
  if (body.channel === "voice") {
    await repository.trackEvent(business.id, "voice_used");
  }

  return NextResponse.json(
    {
      data: {
        visitorToken: conversation.visitorToken,
        greeting: receptionist.greeting,
      },
    },
    { status: 201, headers },
  );
});
