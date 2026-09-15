import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { SupabaseWorkflowStore } from "@halo/workflows/supabase-workflow-store";
import { withErrorHandling } from "@/lib/api/respond";
import { requireBusiness } from "@halo/tenancy/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/workflows/runs/:runId — the per-step log for one run: what each
 * step did, what it returned, and why a failure failed. A run belonging to
 * another business returns an empty log rather than a distinguishable 404.
 */
export const GET = withErrorHandling(
  "workflows.run-logs",
  async (_request: NextRequest, context: { params: Promise<{ runId: string }> }) => {
    const { businessId } = await requireBusiness();
    const { runId } = await context.params;
    const parsed = z.string().uuid().safeParse(runId);
    if (!parsed.success) return NextResponse.json({ data: { logs: [] } });

    const logs = await new SupabaseWorkflowStore().listRunLogs(businessId, parsed.data);
    return NextResponse.json({ data: { logs } });
  },
);
