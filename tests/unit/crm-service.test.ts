import { describe, expect, it } from "vitest";
import {
  CrmService,
  normalizeEmail,
  normalizePhone,
  type CrmStore,
  type Customer,
  type CustomerDraft,
  type TimelineEntry,
} from "@/core/services/crm/crm-service";

class InMemoryCrmStore implements CrmStore {
  customers: Customer[] = [];
  timeline: Array<{ customerId: string; entry: TimelineEntry }> = [];
  merged: Array<{ loserId: string; keeperId: string }> = [];
  private sequence = 0;

  async findByEmail(businessId: string, email: string): Promise<Customer | null> {
    return (
      this.customers.find(
        (c) => c.businessId === businessId && c.email === email && !this.isMerged(c.id),
      ) ?? null
    );
  }
  async findByPhone(businessId: string, phone: string): Promise<Customer | null> {
    return (
      this.customers.find(
        (c) => c.businessId === businessId && c.phone === phone && !this.isMerged(c.id),
      ) ?? null
    );
  }
  async insert(businessId: string, draft: Required<CustomerDraft>): Promise<Customer> {
    const customer: Customer = {
      id: `cust-${++this.sequence}`,
      businessId,
      ...draft,
      totalAppointments: 0,
      revenueTotal: 0,
    };
    this.customers.push(customer);
    return customer;
  }
  async update(id: string, patch: Partial<Omit<Customer, "id" | "businessId">>): Promise<void> {
    const customer = this.customers.find((c) => c.id === id);
    if (!customer) throw new Error(`no customer ${id}`);
    Object.assign(customer, patch);
  }
  async markMerged(loserId: string, keeperId: string): Promise<void> {
    this.merged.push({ loserId, keeperId });
    for (const row of this.timeline) {
      if (row.customerId === loserId) row.customerId = keeperId;
    }
  }
  async appendTimeline(_businessId: string, customerId: string, entry: TimelineEntry): Promise<void> {
    this.timeline.push({ customerId, entry });
  }
  private isMerged(id: string): boolean {
    return this.merged.some((m) => m.loserId === id);
  }
  byId(id: string): Customer {
    const customer = this.customers.find((c) => c.id === id);
    if (!customer) throw new Error(`no customer ${id}`);
    return customer;
  }
}

const BIZ = "biz-1";

function setup() {
  const store = new InMemoryCrmStore();
  return { store, crm: new CrmService(store) };
}

describe("normalization", () => {
  it("lower-cases and trims emails", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });
  it("reduces phones to digits, keeping a leading +", () => {
    expect(normalizePhone("+44 7700 900-123")).toBe("+447700900123");
    expect(normalizePhone("(555) 010 9999")).toBe("5550109999");
    expect(normalizePhone("")).toBe("");
  });
});

describe("CrmService.upsertCustomer", () => {
  it("creates a new customer on first contact", async () => {
    const { crm } = setup();
    const { customer, created } = await crm.upsertCustomer(BIZ, {
      name: "Ada",
      email: "Ada@Example.com",
      stage: "engaged",
    });
    expect(created).toBe(true);
    expect(customer.email).toBe("ada@example.com");
    expect(customer.stage).toBe("engaged");
  });

  it("updates the same person instead of duplicating (matched by email)", async () => {
    const { store, crm } = setup();
    const first = await crm.upsertCustomer(BIZ, { name: "Ada", email: "ada@example.com" });
    const second = await crm.upsertCustomer(BIZ, {
      name: "Ada Lovelace",
      email: "ADA@example.com",
      phone: "+44 7700 900123",
    });
    expect(second.created).toBe(false);
    expect(second.customer.id).toBe(first.customer.id);
    expect(store.customers).toHaveLength(1);
    // Newest name wins; the phone fills the gap.
    expect(store.byId(first.customer.id).name).toBe("Ada Lovelace");
    expect(store.byId(first.customer.id).phone).toBe("+447700900123");
  });

  it("matches by phone when there is no email", async () => {
    const { store, crm } = setup();
    await crm.upsertCustomer(BIZ, { phone: "07700 900123" });
    const { created } = await crm.upsertCustomer(BIZ, { phone: "07700900123", name: "Ada" });
    expect(created).toBe(false);
    expect(store.customers).toHaveLength(1);
  });

  it("merges duplicates when email and phone point at different records", async () => {
    const { store, crm } = setup();
    const emailOnly = await crm.upsertCustomer(BIZ, { email: "ada@example.com", name: "Ada" });
    const phoneOnly = await crm.upsertCustomer(BIZ, { phone: "5550109999" });
    expect(store.customers).toHaveLength(2);

    // A later message reveals both identities belong to one person.
    const { customer } = await crm.upsertCustomer(BIZ, {
      email: "ada@example.com",
      phone: "5550109999",
    });

    expect(customer.id).toBe(emailOnly.customer.id);
    expect(store.merged).toEqual([
      { loserId: phoneOnly.customer.id, keeperId: emailOnly.customer.id },
    ]);
    const keeper = store.byId(emailOnly.customer.id);
    expect(keeper.phone).toBe("5550109999");
    expect(keeper.name).toBe("Ada");
    // The merge itself lands on the timeline.
    expect(store.timeline.some((t) => t.entry.kind === "merge")).toBe(true);
  });

  it("moves the pipeline stage forward but never backward", async () => {
    const { store, crm } = setup();
    const { customer } = await crm.upsertCustomer(BIZ, { email: "a@b.co", stage: "booked" });
    await crm.upsertCustomer(BIZ, { email: "a@b.co", stage: "lead" });
    expect(store.byId(customer.id).stage).toBe("booked");
    await crm.upsertCustomer(BIZ, { email: "a@b.co", stage: "customer" });
    expect(store.byId(customer.id).stage).toBe("customer");
  });
});

describe("appointments, revenue, timeline", () => {
  it("counts appointments and advances the stage", async () => {
    const { store, crm } = setup();
    const { customer } = await crm.upsertCustomer(BIZ, { email: "a@b.co" });
    await crm.recordAppointment(customer);
    const updated = store.byId(customer.id);
    expect(updated.totalAppointments).toBe(1);
    expect(updated.stage).toBe("booked");
  });

  it("accumulates revenue and ignores invalid amounts", async () => {
    const { store, crm } = setup();
    const { customer } = await crm.upsertCustomer(BIZ, { email: "a@b.co" });
    await crm.recordRevenue(customer, 120.5);
    await crm.recordRevenue({ ...customer, revenueTotal: 120.5 }, -50);
    await crm.recordRevenue({ ...customer, revenueTotal: 120.5 }, Number.NaN);
    expect(store.byId(customer.id).revenueTotal).toBe(120.5);
  });

  it("records timeline entries", async () => {
    const { store, crm } = setup();
    const { customer } = await crm.upsertCustomer(BIZ, { email: "a@b.co" });
    await crm.recordTimeline(BIZ, customer.id, { kind: "note", title: "Called back" });
    expect(store.timeline.at(-1)?.entry.title).toBe("Called back");
  });
});
