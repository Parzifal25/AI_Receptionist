import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { WidgetRepository } from "@/core/services/widget-repository";
import { corsHeaders, isOriginAllowed, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetConfigLimiter } from "@/lib/rate-limit";

const querySchema = z.object({
  key: z.string().min(8).max(64),
});

export const OPTIONS = (request: NextRequest) =>
  preflightResponse(request.headers.get("origin"));

/**
 * GET /api/v1/widget/config?key=<widgetKey>
 * Public, non-secret widget bootstrap: branding, greeting, capabilities.
 */
export const GET = withErrorHandling("widget.config", async (request: NextRequest) => {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  const rate = await widgetConfigLimiter.check(`config:${clientIp(request)}`);
  if (!rate.allowed) return fail(AppError.rateLimited(), headers);

  const { key } = querySchema.parse({
    key: request.nextUrl.searchParams.get("key"),
  });

  const repository = new WidgetRepository();
  const { receptionist, business, allowedDomains } =
    await repository.getReceptionistByWidgetKey(key);

  if (!isOriginAllowed(origin, allowedDomains)) {
    return fail(AppError.forbidden("This domain is not allowed to embed this widget"), headers);
  }

  await repository.trackEvent(business.id, "widget_loaded");

  return NextResponse.json(
    {
      data: {
        receptionistName: receptionist.name,
        businessName: business.name,
        greeting: receptionist.greeting,
        language: receptionist.language,
        voiceEnabled: receptionist.voiceEnabled,
        branding: receptionist.branding,
      },
    },
    { headers },
  );
});
