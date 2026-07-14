import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrmStore, Customer, CustomerDraft, TimelineEntry } from "./crm-service";
import { getAdminClient } from "@/lib/supabase/admin";

function rowToCustomer(row: Record<string, unknown>): Customer {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    name: (row.name as string) ?? "",
    email: (row.email as string) ?? "",
    phone: (row.phone as string) ?? "",
    stage: row.stage as Customer["stage"],
    source: (row.source as string) ?? "",
    totalAppointments: (row.total_appointments as number) ?? 0,
    revenueTotal: Number(row.revenue_total ?? 0),
  };
}

/** Production CrmStore over Supabase (service role, scoped in code). */
export class SupabaseCrmStore implements CrmStore {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  async findByEmail(businessId: string, email: string): Promise<Customer | null> {
    const { data } = await this.db
      .from("customers")
      .select("*")
      .eq("business_id", businessId)
      .ilike("email", email)
      .is("merged_into", null)
      .limit(1)
      .maybeSingle();
    return data ? rowToCustomer(data) : null;
  }

  async findByPhone(businessId: string, phone: string): Promise<Customer | null> {
    const { data } = await this.db
      .from("customers")
      .select("*")
      .eq("business_id", businessId)
      .eq("phone", phone)
      .is("merged_into", null)
      .limit(1)
      .maybeSingle();
    return data ? rowToCustomer(data) : null;
  }

  async insert(businessId: string, draft: Required<CustomerDraft>): Promise<Customer> {
    const { data, error } = await this.db
      .from("customers")
      .insert({
        business_id: businessId,
        name: draft.name,
        email: draft.email,
        phone: draft.phone,
        stage: draft.stage,
        source: draft.source,
      })
      .select()
      .single();
    if (error) throw new Error(`insert customer: ${error.message}`);
    return rowToCustomer(data);
  }

  async update(id: string, patch: Partial<Omit<Customer, "id" | "businessId">>): Promise<void> {
    const row: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.email !== undefined) row.email = patch.email;
    if (patch.phone !== undefined) row.phone = patch.phone;
    if (patch.stage !== undefined) row.stage = patch.stage;
    if (patch.source !== undefined) row.source = patch.source;
    if (patch.totalAppointments !== undefined) row.total_appointments = patch.totalAppointments;
    if (patch.revenueTotal !== undefined) row.revenue_total = patch.revenueTotal;
    const { error } = await this.db.from("customers").update(row).eq("id", id);
    if (error) throw new Error(`update customer: ${error.message}`);
  }

  async markMerged(loserId: string, keeperId: string): Promise<void> {
    // Repoint the loser's history first so no timeline entry is orphaned if
    // the second write fails — a re-run of the merge is harmless.
    const { error: timelineError } = await this.db
      .from("customer_timeline")
      .update({ customer_id: keeperId })
      .eq("customer_id", loserId);
    if (timelineError) throw new Error(`repoint timeline: ${timelineError.message}`);

    const { error } = await this.db
      .from("customers")
      .update({ merged_into: keeperId })
      .eq("id", loserId);
    if (error) throw new Error(`mark merged: ${error.message}`);
  }

  async appendTimeline(
    businessId: string,
    customerId: string,
    entry: TimelineEntry,
  ): Promise<void> {
    const { error } = await this.db.from("customer_timeline").insert({
      business_id: businessId,
      customer_id: customerId,
      kind: entry.kind,
      title: entry.title,
      detail: entry.detail ?? {},
      occurred_at: entry.occurredAt ?? new Date().toISOString(),
    });
    if (error) throw new Error(`append timeline: ${error.message}`);
  }
}
