import "server-only";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { TwilioOutboundDialer } from "@halo/providers/telephony/twilio-outbound-dialer";
import { CampaignEngine } from "./engine";
import { SupabaseCampaignStore } from "./supabase-campaign-store";

/** Explicit operational opt-in. No credentials, endpoints or destinations
 * come from a model, tenant prompt, or HTTP request. */
export async function dispatchCampaign(businessId: string, campaignId: string, limit: number) {
  if (process.env.HALO_OUTBOUND_ENABLED !== "true") throw new Error("Outbound dispatch is disabled");
  const db = getAdminClient();
  const { data: campaign, error } = await db.from("campaigns").select("phone_number_id")
    .eq("id", campaignId).eq("business_id", businessId).single();
  if (error || !campaign) throw new Error("Campaign unavailable");
  const phone = await db.from("phone_numbers").select("provider").eq("id", campaign.phone_number_id).eq("business_id", businessId).single();
  if (phone.error || phone.data?.provider !== "twilio") throw new Error("No outbound adapter configured for this carrier");
  const dialer = new TwilioOutboundDialer({ accountSid: process.env.TWILIO_ACCOUNT_SID ?? "", authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    gatewayUrl: process.env.HALO_OUTBOUND_GATEWAY_URL ?? "" });
  return new CampaignEngine(new SupabaseCampaignStore(db), dialer).dispatch(businessId, campaignId, limit);
}
