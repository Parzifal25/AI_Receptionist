import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { workflowDefinitionSchema } from "@/core/domain/workflow";
import { SupabaseWorkflowStore } from "@/core/services/workflows/supabase-workflow-store";
import { fail, withErrorHandling } from "@/lib/api/respond";
import { requireBusiness } from "@/lib/auth";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  trigger: workflowDefinitionSchema.shape.trigger.optional(),
  enabled: z.boolean().optional(),
  conditions: workflowDefinitionSchema.shape.conditions.optional(),
  steps: workflowDefinitionSchema.shape.steps.optional(),
});

type Context = { params: Promise<{ workflowId: string }> };

async function loadOwned(workflowId: string) {
  const { businessId, role } = await requireBusiness();
  const store = new SupabaseWorkflowStore();
  const workflow = await store.getWorkflow(workflowId);
  if (!workflow || workflow.businessId !== businessId) throw AppError.notFound("workflow");
  return { businessId, role, store, workflow };
}

export const GET = withErrorHandling(
  "workflows.get",
  async (_request: NextRequest, context: Context) => {
    const { workflowId } = await context.params;
    const { workflow } = await loadOwned(workflowId);
    return NextResponse.json({ data: { workflow } });
  },
);

export const PATCH = withErrorHandling(
  "workflows.update",
  async (request: NextRequest, context: Context) => {
    const { workflowId } = await context.params;
    const { role, businessId, store, workflow } = await loadOwned(workflowId);
    if (role === "member") return fail(AppError.forbidden());

    const patch = patchSchema.parse(await request.json());
    await store.updateWorkflow(workflowId, businessId, patch, workflow.version);
    const updated = await store.getWorkflow(workflowId);
    return NextResponse.json({ data: { workflow: updated } });
  },
);

export const DELETE = withErrorHandling(
  "workflows.delete",
  async (_request: NextRequest, context: Context) => {
    const { workflowId } = await context.params;
    const { role, businessId, store } = await loadOwned(workflowId);
    if (role === "member") return fail(AppError.forbidden());

    await store.deleteWorkflow(workflowId, businessId);
    return NextResponse.json({ data: { deleted: true } });
  },
);
