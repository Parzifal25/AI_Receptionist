import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { ChatService } from "@/core/services/chat-service";
import { BookingOrchestrator } from "@/core/services/scheduling/booking-orchestrator";
import { WidgetRepository } from "@/core/services/widget-repository";
import { corsHeaders, isOriginAllowed, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetMessageLimiter } from "@/lib/rate-limit";

const bodySchema = z.object({
  visitorToken: z.string().min(16).max(128),
  message: z.string().trim().min(1).max(2000),
});

/**
 * Hard per-conversation ceiling (user + assistant rows combined). Bounds the
 * worst-case LLM spend a single visitor token can generate; real
 * receptionist chats stay far below it.
 */
const MAX_MESSAGES_PER_CONVERSATION = 200;

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

  const { receptionist, business, allowedDomains } = await repository.getReceptionistById(
    conversation.receptionistId,
  );

  // Same embed-domain policy as conversation start — a stolen visitor token
  // is useless from a site the business hasn't allowed.
  if (!isOriginAllowed(origin, allowedDomains)) {
    return fail(AppError.forbidden("This domain is not allowed to use this widget"), headers);
  }

  if (conversation.messageCount >= MAX_MESSAGES_PER_CONVERSATION) {
    await repository.endConversation(conversation.id);
    return fail(
      AppError.conflict("This conversation has reached its limit — please start a new one"),
      headers,
    );
  }

  const chat = new ChatService(undefined, undefined, undefined, repository, new BookingOrchestrator());
  const { reply } = await chat.respond({
    business,
    receptionist,
    conversationId: conversation.id,
    userMessage: body.message,
    channel: conversation.channel,
  });

  await repository.trackEvent(business.id, "message_sent");

  return NextResponse.json({ data: { reply } }, { headers });
});
