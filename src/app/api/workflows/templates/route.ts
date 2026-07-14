import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import {
  getTemplate,
  instantiateTemplate,
  WORKFLOW_TEMPLATES,
} from "@/core/services/workflows/templates";
import { SupabaseWorkflowStore } from "@/core/services/workflows/supabase-workflow-store";
import { fail, withErrorHandling } from "@/lib/api/respond";
import { requireBusiness } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/workflows/templates — the built-in lifecycle journey gallery. */
export const GET = withErrorHandling("workflows.templates.list", async () => {
  await requireBusiness();
  return NextResponse.json({ data: { templates: WORKFLOW_TEMPLATES } });
});

const installSchema = z.object({
  templateId: z.string().min(1),
  variables: z.record(z.string(), z.string()).default({}),
});

/** POST /api/workflows/templates — install a template's workflows (admins). */
export const POST = withErrorHandling("workflows.templates.install", async (request: NextRequest) => {
  const { businessId, role } = await requireBusiness();
  if (role === "member") return fail(AppError.forbidden());

  const { templateId, variables } = installSchema.parse(await request.json());
  const template = getTemplate(templateId);
  if (!template) return fail(AppError.notFound("template"));

  let drafts;
  try {
    drafts = instantiateTemplate(template, variables);
  } catch (error) {
    return fail(AppError.validation(error instanceof Error ? error.message : "invalid variables"));
  }

  const store = new SupabaseWorkflowStore();
  const created = [];
  for (const draft of drafts) {
    created.push(await store.createWorkflow({ ...draft, businessId }));
  }
  return NextResponse.json({ data: { workflows: created } }, { status: 201 });
});
