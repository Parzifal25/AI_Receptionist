import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { requireBusiness } from "@halo/tenancy/auth";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { campaignPolicySchema } from "@halo/campaigns/engine";
import { dispatchCampaign } from "@halo/campaigns/dispatch";
import { fail, withErrorHandling } from "@/lib/api/respond";
export const dynamic = "force-dynamic";
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: z.string().min(1).max(160), agentId: z.uuid(), agentVersionId: z.uuid(), phoneNumberId: z.uuid(), policy: campaignPolicySchema }),
  z.object({ action: z.literal("enroll"), campaignId: z.uuid(), contacts: z.array(z.object({ customerId: z.uuid(), consentAt: z.iso.datetime().refine(v => Date.parse(v) <= Date.now(), "Consent cannot be in the future") })).min(1).max(100) }),
  z.object({ action: z.literal("state"), campaignId: z.uuid(), state: z.enum(["active", "paused", "cancelled", "completed"]) }),
  z.object({ action: z.literal("dispatch"), campaignId: z.uuid(), limit: z.int().min(1).max(10).default(1) }),
]);
export const GET = withErrorHandling("campaigns.list", async () => {
  const { businessId } = await requireBusiness();
  const { data, error } = await getAdminClient().from("campaigns").select("*").eq("business_id", businessId).order("created_at", { ascending: false }).limit(100);
  if (error) throw AppError.internal("Campaign list failed");
  return NextResponse.json({ data });
});
export const POST = withErrorHandling("campaigns.command", async (request: NextRequest) => {
  const { businessId, role } = await requireBusiness();
  if (role === "member") return fail(AppError.forbidden());
  const input = command.parse(await request.json());
  const db = getAdminClient();
  if (input.action === "dispatch") return NextResponse.json({ data: await dispatchCampaign(businessId, input.campaignId, input.limit) });
  if (input.action === "create") {
    const p = input.policy;
    const result = await db.from("campaigns").insert({ business_id: businessId, name: input.name, agent_id: input.agentId,
      agent_version_id: input.agentVersionId, phone_number_id: input.phoneNumberId, timezone: p.timezone, weekdays: p.weekdays,
      start_minute: p.startMinute, end_minute: p.endMinute, max_attempts: p.maxAttempts, retry_delay_seconds: p.retryDelaySeconds }).select("id").single();
    if (result.error) throw AppError.internal("Campaign creation failed");
    return NextResponse.json({ data: result.data }, { status: 201 });
  }
  const campaign = await db.from("campaigns").select("id,state").eq("id", input.campaignId).eq("business_id", businessId).maybeSingle();
  if (campaign.error || !campaign.data) return fail(AppError.forbidden());
  if (input.action === "enroll") {
    if (!["draft", "paused"].includes(campaign.data.state)) return fail(AppError.validation("Pause the campaign before enrolling contacts"));
    const result = await db.from("campaign_contacts").upsert(input.contacts.map(c => ({ business_id: businessId, campaign_id: input.campaignId,
      customer_id: c.customerId, consent_at: c.consentAt })), { onConflict: "campaign_id,customer_id", ignoreDuplicates: true });
    if (result.error) throw AppError.internal("Campaign enrollment failed");
  } else {
    const result = await db.from("campaigns").update({ state: input.state }).eq("id", input.campaignId).eq("business_id", businessId);
    if (result.error) throw AppError.internal("Campaign state change failed");
  }
  return NextResponse.json({ data: { ok: true } });
});
