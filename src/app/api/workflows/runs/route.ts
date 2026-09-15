import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { SupabaseWorkflowStore } from "@halo/workflows/supabase-workflow-store";
import { withErrorHandling } from "@/lib/api/respond";
import { requireBusiness } from "@halo/tenancy/auth";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  workflowId: z.string().uuid().optional(),
  status: z
    .enum(["pending", "running", "succeeded", "failed", "skipped", "dead_letter"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/workflows/runs — execution history for the caller's business.
 * Optional `workflowId` / `status` filters; newest first. Read-only, so
 * members see it too: knowing whether last night's reminders fired is not
 * an admin-only concern.
 */
export const GET = withErrorHandling("workflows.runs", async (request: NextRequest) => {
  const { businessId } = await requireBusiness();
  const params = querySchema.parse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );

  const runs = await new SupabaseWorkflowStore().listRuns(businessId, params);
  return NextResponse.json({ data: { runs } });
});
