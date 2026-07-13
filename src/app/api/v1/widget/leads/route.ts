import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { WidgetRepository } from "@/core/services/widget-repository";
import { getNotificationProvider } from "@/providers/notification/log-notification-provider";
import { corsHeaders, isOriginAllowed, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetSessionLimiter } from "@/lib/rate-limit";

const bodySchema = z
  .object({
    visitorToken: z.string().min(16).max(128),
    name: z.string().trim().max(120).default(""),
    email: z.string().trim().email().max(254).or(z.literal("")).default(""),
    phone: z.string().trim().max(30).default(""),
    intent: z.string().trim().max(500).default(""),
  })
  .refine((data) => data.email !== "" || data.phone !== "", {
    message: "Provide an email or a phone number",
  });

export const OPTIONS = (request: NextRequest) =>
  preflightResponse(request.headers.get("origin"));

/**
 * POST /api/v1/widget/leads
 * Explicit lead submission from the widget's contact form — the guaranteed
 * capture path alongside conversational extraction.
 */
export const POST = withErrorHandling("widget.leads", async (request: NextRequest) => {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  const rate = await widgetSessionLimiter.check(`lead:${clientIp(request)}`);
  if (!rate.allowed) return fail(AppError.rateLimited(), headers);

  const body = bodySchema.parse(await request.json().catch(() => ({})));

  const repository = new WidgetRepository();
  const conversation = await repository.getConversationByToken(body.visitorToken);

  const { business, allowedDomains } = await repository.getReceptionistById(
    conversation.receptionistId,
  );
  if (!isOriginAllowed(origin, allowedDomains)) {
    return fail(AppError.forbidden("This domain is not allowed to use this widget"), headers);
  }

  const { isNew } = await repository.upsertConversationLead(
    conversation.businessId,
    conversation.id,
    { name: body.name, email: body.email, phone: body.phone, intent: body.intent },
  );

  if (isNew) {
    await repository.trackEvent(conversation.businessId, "lead_captured", { source: "form" });
    const settings = await repository.getBusinessNotificationSettings(conversation.businessId);
    if (settings.notifyOnLead) {
      await getNotificationProvider().notifyNewLead({
        businessId: conversation.businessId,
        businessName: business.name,
        recipientEmail: settings.notificationEmail,
        lead: { name: body.name, email: body.email, phone: body.phone, intent: body.intent },
      });
    }
  }

  return NextResponse.json({ data: { saved: true } }, { status: 201, headers });
});
