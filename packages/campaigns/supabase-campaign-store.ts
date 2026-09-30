import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import type { CampaignStore, ClaimedContact, DialResult } from "./engine";

export class SupabaseCampaignStore implements CampaignStore {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}
  async claim(businessId: string, campaignId: string, limit: number): Promise<ClaimedContact[]> {
    const { data, error } = await this.db.rpc("claim_campaign_contacts", { p_business_id: businessId, p_campaign_id: campaignId, p_limit: limit });
    if (error) throw new Error(`claim campaign: ${error.message}`);
    const result: ClaimedContact[] = [];
    for (const row of data ?? []) {
      const { data: campaign, error: ce } = await this.db.from("campaigns").select("agent_id,agent_version_id,phone_number_id")
        .eq("business_id", businessId).eq("id", campaignId).single();
      if (ce || !campaign) throw new Error("Campaign unavailable");
      const [{ data: customer, error: ue }, { data: phone, error: pe }] = await Promise.all([
        this.db.from("customers").select("phone").eq("id", row.customer_id).eq("business_id", businessId).single(),
        this.db.from("phone_numbers").select("e164").eq("id", campaign.phone_number_id).eq("business_id", businessId).single(),
      ]);
      if (ue || pe || !customer || !phone) throw new Error("Campaign contact unavailable");
      result.push({ id: row.id, businessId, campaignId, customerId: row.customer_id, agentId: campaign.agent_id,
        agentVersionId: campaign.agent_version_id, from: phone.e164, to: row.target_number, attempt: row.attempt });
    }
    return result;
  }
  async authorize(contact: ClaimedContact): Promise<boolean> {
    const { data, error } = await this.db.rpc("campaign_contact_eligible", { p_business_id: contact.businessId, p_contact_id: contact.id });
    if (error) throw new Error(`campaign eligibility: ${error.message}`);
    return data === true;
  }
  async settle(contact: ClaimedContact, result: DialResult): Promise<void> {
    const { error } = await this.db.rpc("settle_campaign_contact", { p_business_id: contact.businessId, p_contact_id: contact.id,
      p_attempt: contact.attempt, p_status: result.status, p_retryable: result.status === "rejected" && result.retryable,
      p_provider_call_id: result.status === "accepted" ? result.providerCallId : null });
    if (error) throw new Error(`settle campaign: ${error.message}`);
  }
  async complete(contact: ClaimedContact, providerCallId: string, outcome: string, followupAt: Date | null): Promise<void> {
    const { error } = await this.db.rpc("complete_campaign_contact", { p_business_id: contact.businessId, p_contact_id: contact.id,
      p_attempt: contact.attempt, p_provider_call_id: providerCallId, p_outcome: outcome, p_followup_at: followupAt?.toISOString() ?? null });
    if (error) throw new Error(`campaign outcome: ${error.message}`);
  }
}
