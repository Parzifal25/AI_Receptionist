/**
 * Built-in CRM: one `customers` row per real person, deduped by email and
 * phone, with an append-only activity timeline. Runs automatically off
 * business events (every lead and appointment lands here without any
 * configuration) and is also exposed as workflow actions.
 */

export type CustomerStage = "lead" | "engaged" | "booked" | "customer" | "lost";

export interface Customer {
  id: string;
  businessId: string;
  name: string;
  email: string;
  phone: string;
  stage: CustomerStage;
  source: string;
  totalAppointments: number;
  revenueTotal: number;
}

export interface CustomerDraft {
  name?: string;
  email?: string;
  phone?: string;
  stage?: CustomerStage;
  source?: string;
}

export interface TimelineEntry {
  kind: string;
  title: string;
  detail?: Record<string, unknown>;
  occurredAt?: string;
}

/** Persistence contract; Supabase in production, in-memory in tests. */
export interface CrmStore {
  findByEmail(businessId: string, email: string): Promise<Customer | null>;
  findByPhone(businessId: string, phone: string): Promise<Customer | null>;
  insert(businessId: string, draft: Required<CustomerDraft>): Promise<Customer>;
  update(id: string, patch: Partial<Omit<Customer, "id" | "businessId">>): Promise<void>;
  /** Stamp merged_into on the loser and repoint its timeline at the keeper. */
  markMerged(loserId: string, keeperId: string): Promise<void>;
  appendTimeline(businessId: string, customerId: string, entry: TimelineEntry): Promise<void>;
}

export function normalizeEmail(email: string | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** Digits only (with leading +), so "07700 900123" and "+44 7700 900123" can meet. */
export function normalizePhone(phone: string | undefined): string {
  const trimmed = (phone ?? "").trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? `+${digits.slice(1).replace(/\D/g, "")}` : digits.replace(/\D/g, "");
}

/** Funnel order — upserts only ever move a person forward, never back. */
const STAGE_ORDER: Record<CustomerStage, number> = {
  lead: 0,
  engaged: 1,
  booked: 2,
  customer: 3,
  lost: 0, // explicit resurrection: any new activity beats "lost"
};

export class CrmService {
  constructor(private readonly store: CrmStore) {}

  /**
   * Create-or-update by identity (email first, then phone). When the email
   * and the phone match two *different* existing customers, they are the
   * same person seen through two channels — merge them (keeper: the email
   * match), so history consolidates instead of splitting.
   */
  async upsertCustomer(
    businessId: string,
    draft: CustomerDraft,
  ): Promise<{ customer: Customer; created: boolean }> {
    const email = normalizeEmail(draft.email);
    const phone = normalizePhone(draft.phone);

    const byEmail = email ? await this.store.findByEmail(businessId, email) : null;
    const byPhone = phone ? await this.store.findByPhone(businessId, phone) : null;

    let existing = byEmail ?? byPhone;
    if (byEmail && byPhone && byEmail.id !== byPhone.id) {
      existing = await this.merge(byEmail, byPhone);
    }

    if (!existing) {
      const customer = await this.store.insert(businessId, {
        name: draft.name?.trim() ?? "",
        email,
        phone,
        stage: draft.stage ?? "lead",
        source: draft.source ?? "",
      });
      return { customer, created: true };
    }

    // Newest non-empty facts win; the stage only moves forward.
    const patch: Partial<Omit<Customer, "id" | "businessId">> = {};
    if (draft.name?.trim() && draft.name.trim() !== existing.name) patch.name = draft.name.trim();
    if (email && !existing.email) patch.email = email;
    if (phone && !existing.phone) patch.phone = phone;
    if (draft.stage && STAGE_ORDER[draft.stage] > STAGE_ORDER[existing.stage]) {
      patch.stage = draft.stage;
    }
    if (Object.keys(patch).length > 0) await this.store.update(existing.id, patch);

    return { customer: { ...existing, ...patch }, created: false };
  }

  async recordTimeline(
    businessId: string,
    customerId: string,
    entry: TimelineEntry,
  ): Promise<void> {
    await this.store.appendTimeline(businessId, customerId, entry);
  }

  /** Appointment counters + stage progression in one place. */
  async recordAppointment(customer: Customer, delta: 1 | 0 = 1): Promise<void> {
    await this.store.update(customer.id, {
      totalAppointments: customer.totalAppointments + delta,
      stage: STAGE_ORDER.booked > STAGE_ORDER[customer.stage] ? "booked" : customer.stage,
    });
  }

  /** Revenue attribution: accumulate onto the customer. */
  async recordRevenue(customer: Customer, amount: number): Promise<void> {
    if (!Number.isFinite(amount) || amount <= 0) return;
    await this.store.update(customer.id, { revenueTotal: customer.revenueTotal + amount });
  }

  private async merge(keeper: Customer, loser: Customer): Promise<Customer> {
    const patch: Partial<Omit<Customer, "id" | "businessId">> = {
      name: keeper.name || loser.name,
      email: keeper.email || loser.email,
      phone: keeper.phone || loser.phone,
      stage:
        STAGE_ORDER[loser.stage] > STAGE_ORDER[keeper.stage] ? loser.stage : keeper.stage,
      totalAppointments: keeper.totalAppointments + loser.totalAppointments,
      revenueTotal: keeper.revenueTotal + loser.revenueTotal,
    };
    await this.store.update(keeper.id, patch);
    await this.store.markMerged(loser.id, keeper.id);
    await this.store.appendTimeline(keeper.businessId, keeper.id, {
      kind: "merge",
      title: "Merged duplicate customer records",
      detail: { mergedCustomerId: loser.id },
    });
    return { ...keeper, ...patch };
  }
}
