import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@/core/errors/app-error";
import { workflowDefinitionSchema } from "@/core/domain/workflow";
import { SupabaseWorkflowStore } from "@/core/services/workflows/supabase-workflow-store";
import { fail, withErrorHandling } from "@/lib/api/respond";
import { requireBusiness } from "@/lib/auth";

export const dynamic = "force-dynamic";

const createSchema = workflowDefinitionSchema.omit({ id: true, businessId: true, version: true });

/** GET /api/workflows — every workflow for the caller's business. */
export const GET = withErrorHandling("workflows.list", async () => {
  const { businessId } = await requireBusiness();
  const workflows = await new SupabaseWorkflowStore().listWorkflows(businessId);
  return NextResponse.json({ data: { workflows } });
});

/** POST /api/workflows — create a workflow (admins only). */
export const POST = withErrorHandling("workflows.create", async (request: NextRequest) => {
  const { businessId, role } = await requireBusiness();
  if (role === "member") return fail(AppError.forbidden());

  const draft = createSchema.parse(await request.json());
  const workflow = await new SupabaseWorkflowStore().createWorkflow({ ...draft, businessId });
  return NextResponse.json({ data: { workflow } }, { status: 201 });
});
