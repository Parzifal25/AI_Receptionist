import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { ChatService } from "@/core/services/chat-service";
import { WidgetRepository } from "@/core/services/widget-repository";
import { corsHeaders, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetMessageLimiter } from "@/lib/rate-limit";

const bodySchema = z.object({
  visitorToken: z.string().min(16).max(128),
  message: z.string().trim().min(1).max(2000),
});

export const OPTIONS = (request: NextRequest) =>
  preflightResponse(request.headers.get("origin"));

/**
 * POST /api/v1/widget/messages
 * One conversational turn. Rate limited per visitor token AND per IP so a
 * single visitor can't exhaust a tenant and a single IP can't mint tokens
 * to bypass the limit.
 */
export const POST = withErrorHandling("widget.messages", async (request: NextRequest) => {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  const body = bodySchema.parse(await request.json().catch(() => ({})));

  const [byToken, byIp] = await Promise.all([
    widgetMessageLimiter.check(`msg:token:${body.visitorToken}`),
    widgetMessageLimiter.check(`msg:ip:${clientIp(request)}`),
  ]);
  if (!byToken.allowed || !byIp.allowed) {
    return fail(AppError.rateLimited("You're sending messages too quickly — please wait a moment"), headers);
  }

  const repository = new WidgetRepository();
  const conversation = await repository.getConversationByToken(body.visitorToken);
  if (conversation.status === "ended") {
    return fail(AppError.conflict("This conversation has ended"), headers);
  }

  const { receptionist, business } = await repository.getReceptionistById(
    conversation.receptionistId,
  );

  const chat = new ChatService(undefined, undefined, undefined, repository);
  const { reply } = await chat.respond({
    business,
    receptionist,
    conversationId: conversation.id,
    userMessage: body.message,
  });

  await repository.trackEvent(business.id, "message_sent");

  return NextResponse.json({ data: { reply } }, { headers });
});
