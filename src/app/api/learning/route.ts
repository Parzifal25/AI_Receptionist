import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { summarizeOutcomes } from "@halo/learning/analysis";
import { LearningProposals, proposalSchema } from "@halo/learning/proposals";
import { requireBusiness } from "@halo/tenancy/auth";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { fail, withErrorHandling } from "@/lib/api/respond";
export const dynamic = "force-dynamic";
const command = z.discriminatedUnion("action", [
  proposalSchema.omit({ businessId: true }).extend({ action: z.literal("propose") }),
  z.object({ action: z.literal("review"), id: z.uuid(), approve: z.boolean() }),
]);
export const GET = withErrorHandling("learning.list", async (request: NextRequest) => {
  const { businessId } = await requireBusiness();
  const db = await createSupabaseServerClient();
  if (request.nextUrl.searchParams.get("view") === "outcomes") {
    const result = await db.from("conversation_outcomes").select("disposition,escalated,do_not_call")
      .eq("business_id", businessId).order("created_at", { ascending: false }).limit(1001);
    if (result.error) throw AppError.internal("Outcome analysis failed");
    const rows = result.data ?? [];
    return NextResponse.json({ data: { ...summarizeOutcomes(rows.slice(0, 1000)), truncated: rows.length > 1000 } });
  }
  const { data, error } = await db.from("learning_proposals").select("*").eq("business_id", businessId).order("created_at", { ascending: false }).limit(100);
  if (error) throw AppError.internal("Learning proposal lookup failed");
  return NextResponse.json({ data });
});
export const POST = withErrorHandling("learning.command", async (request: NextRequest) => {
  const { businessId, role } = await requireBusiness();
  if (role === "member") return fail(AppError.forbidden());
  const input = command.parse(await request.json());
  if (input.action === "propose") {
    const id = await new LearningProposals(getAdminClient()).propose({ ...input, businessId });
    return NextResponse.json({ data: { id } }, { status: 201 });
  }
  // Review MUST retain the real user JWT. The database independently requires
  // tenant admin membership and a passing evaluation of immutable content.
  const draftVersionId = await new LearningProposals(await createSupabaseServerClient()).review(businessId, input.id, input.approve);
  return NextResponse.json({ data: { draftVersionId } });
});
