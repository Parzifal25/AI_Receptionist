import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@halo/core/errors/app-error";
import { getServerEnv } from "@halo/platform/env";
import { timingSafeEqualStr } from "@halo/platform/crypto";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { dispatchCampaign } from "@halo/campaigns/dispatch";
import { fail, withErrorHandling } from "@/lib/api/respond";
export const dynamic = "force-dynamic";
export const GET = withErrorHandling("cron.campaigns", async (request: NextRequest) => {
  const secret = getServerEnv().CRON_SECRET;
  if (!secret) return fail(AppError.internal("Campaign scheduler is not configured"));
  if (!timingSafeEqualStr(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "", secret)) return fail(AppError.unauthorized());
  const { data, error } = await getAdminClient().rpc("schedule_campaign_batch", { p_limit: 20 });
  if (error) throw AppError.internal("Campaign scheduler lookup failed");
  let dispatched = 0, failed = 0;
  for (const campaign of data ?? []) {
    try { await dispatchCampaign(campaign.business_id, campaign.id, 1); dispatched++; } catch { failed++; }
  }
  return NextResponse.json({ data: { dispatched, failed } }, { status: failed ? 503 : 200 });
});
