import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { LifecycleAnalyticsService } from "@halo/analytics/lifecycle-analytics-service";
import { withErrorHandling } from "@/lib/api/respond";
import { requireBusiness } from "@halo/tenancy/auth";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/** GET /api/analytics/lifecycle?days=30 — customer-lifecycle business metrics. */
export const GET = withErrorHandling("analytics.lifecycle", async (request: NextRequest) => {
  const { businessId } = await requireBusiness();
  const { days } = querySchema.parse({
    days: request.nextUrl.searchParams.get("days") ?? undefined,
  });
  const metrics = await new LifecycleAnalyticsService().getMetrics(businessId, days);
  return NextResponse.json({ data: { periodDays: days, metrics } });
});
