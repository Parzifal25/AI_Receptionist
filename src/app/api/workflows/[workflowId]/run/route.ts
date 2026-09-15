import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@halo/core/errors/app-error";
import { getWorkflowEngine } from "@halo/workflows/event-bus";
import { SupabaseWorkflowStore } from "@halo/workflows/supabase-workflow-store";
import { fail, withErrorHandling } from "@/lib/api/respond";
import { requireBusiness } from "@halo/tenancy/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/workflows/:workflowId/run
 * Manual trigger: a signed-in admin fires one specific workflow with an
 * optional JSON payload — for testing a new recipe or re-driving a one-off.
 * The synthetic event has type "manual" regardless of the workflow's
 * configured trigger, so conditions written against real events don't
 * accidentally gate a manual run; payload shape is the operator's business.
 */
export const POST = withErrorHandling(
  "workflows.run",
  async (request: NextRequest, context: { params: Promise<{ workflowId: string }> }) => {
    const { workflowId } = await context.params;
    const { businessId, role } = await requireBusiness();
    if (role === "member") return fail(AppError.forbidden());

    const workflow = await new SupabaseWorkflowStore().getWorkflow(workflowId);
    if (!workflow || workflow.businessId !== businessId) {
      return fail(AppError.notFound("workflow"));
    }

    let payload: Record<string, unknown> = {};
    const raw = await request.text();
    if (raw) {
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return fail(AppError.validation("Body must be JSON"));
      }
    }

    await getWorkflowEngine().runManually(workflow, {
      id: randomUUID(),
      businessId,
      type: "manual",
      correlationId: `manual-${workflowId}`,
      occurredAt: new Date().toISOString(),
      payload,
    });
    return NextResponse.json({ data: { started: true } });
  },
);
