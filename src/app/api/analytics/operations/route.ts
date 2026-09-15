import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { OperationsAnalyticsService } from "@halo/analytics/operations-analytics-service";
import { withErrorHandling } from "@/lib/api/respond";
import { requireBusiness } from "@halo/tenancy/auth";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/** GET /api/analytics/operations?days=30 — operations business metrics. */
export const GET = withErrorHandling("analytics.operations", async (request: NextRequest) => {
  const { businessId } = await requireBusiness();
  const { days } = querySchema.parse({
    days: request.nextUrl.searchParams.get("days") ?? undefined,
  });
  
  const metrics = await new OperationsAnalyticsService().getMetrics(businessId, days);
  return NextResponse.json({ data: { periodDays: days, metrics } });
});
