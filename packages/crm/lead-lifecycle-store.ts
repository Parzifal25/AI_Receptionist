import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import type { LeadState } from "./lead-lifecycle";

export class LeadLifecycleStore {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}
  async transition(input: { businessId: string; customerId: string; eventKey: string; to: LeadState; reason: string }): Promise<LeadState> {
    const { data, error } = await this.db.rpc("transition_lead", { p_business_id: input.businessId,
      p_customer_id: input.customerId, p_event_key: input.eventKey, p_to_state: input.to, p_reason: input.reason });
    if (error) throw new Error(`lead transition: ${error.message}`);
    return data as LeadState;
  }
}
