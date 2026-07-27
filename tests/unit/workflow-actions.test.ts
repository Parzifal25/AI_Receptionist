import { describe, expect, it, vi } from "vitest";
import type { BusinessEvent } from "@/core/domain/workflow";
import type { MessagingProvider, OutboundMessage } from "@/core/ports/messaging-provider";
import { createActionRegistry } from "@/core/services/workflows/action-registry";
import { CrmService, type CrmStore } from "@/core/services/crm/crm-service";
import type { ActionContext } from "@/core/services/workflows/types";
import { InMemoryWorkflowStore } from "../mocks/in-memory-workflow-store";

const event: BusinessEvent = {
  id: "evt-1",
  businessId: "biz-1",
  type: "appointment.created",
  correlationId: "conv-1",
  occurredAt: "2026-07-14T10:00:00.000Z",
  payload: { visitorName: "Ada", visitorEmail: "ada@example.com" },
};
const ctx: ActionContext = { event, businessId: "biz-1", correlationId: "conv-1" };

function fakeMessaging(): MessagingProvider & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    name: "fake",
    sent,
    supports: (channel) => channel !== "whatsapp",
    send: async (message) => {
      sent.push(message);
    },
  };
}

const stubCrm = new CrmService({
  findByEmail: async () => null,
  findByPhone: async () => null,
  insert: async (businessId, draft) => ({
    id: "cust-1",
    businessId,
    ...draft,
    totalAppointments: 0,
    revenueTotal: 0,
  }),
  update: async () => undefined,
  markMerged: async () => undefined,
  appendTimeline: async () => undefined,
} satisfies CrmStore);

/** DNS stub: every host resolves to a public IP unless listed here. */
const RESOLVED: Record<string, string> = {
  "internal.corp": "10.0.0.5",
  "metadata.cloud": "169.254.169.254",
  "rebind.example.com": "127.0.0.1",
};
const publicLookup = async (hostname: string, _options: { all: true }) => [
  { address: RESOLVED[hostname] ?? "93.184.216.34", family: 4 },
];

function registry(overrides: { fetchImpl?: typeof fetch; messaging?: MessagingProvider } = {}) {
  return createActionRegistry({
    messaging: overrides.messaging ?? fakeMessaging(),
    crm: stubCrm,
    store: new InMemoryWorkflowStore(),
    fetchImpl: overrides.fetchImpl,
    lookupImpl: publicLookup,
  });
}

describe("messaging actions", () => {
  it("delivers email through the messaging port", async () => {
    const messaging = fakeMessaging();
    const actions = registry({ messaging });
    await actions.send_email!({ to: "ada@example.com", body: "Hi!", subject: "Hello" }, ctx);
    expect(messaging.sent).toEqual([
      { channel: "email", to: "ada@example.com", body: "Hi!", subject: "Hello" },
    ]);
  });

  it("rejects when the resolved recipient is empty", async () => {
    const actions = registry();
    await expect(actions.send_sms!({ to: "", body: "x" }, ctx)).rejects.toThrow(/"to"/);
  });

  it("rejects channels the provider cannot deliver on", async () => {
    const actions = registry();
    await expect(
      actions.send_whatsapp!({ to: "+15550109999", body: "x" }, ctx),
    ).rejects.toThrow(/does not support whatsapp/);
  });
});

describe("call_webhook", () => {
  it("posts the event envelope with correlation headers (json format)", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const actions = registry({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await actions.call_webhook!({ url: "https://hooks.zapier.com/abc" }, ctx);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.zapier.com/abc");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-correlation-id"]).toBe("conv-1");
    expect(headers["x-event-id"]).toBe("evt-1");
    const body = JSON.parse(init.body as string);
    expect(body.event).toBe("appointment.created");
    expect(body.payload.visitorName).toBe("Ada");
  });

  it("formats Slack and Discord payloads", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const actions = registry({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await actions.call_webhook!(
      { url: "https://hooks.slack.com/x", format: "slack", text: "New booking from Ada" },
      ctx,
    );
    await actions.call_webhook!(
      { url: "https://discord.com/api/webhooks/x", format: "discord", text: "New booking" },
      ctx,
    );

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ text: "New booking from Ada" });
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ content: "New booking" });
  });

  it("treats non-2xx responses as failures (so the engine retries)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const actions = registry({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(actions.call_webhook!({ url: "https://x.example.com" }, ctx)).rejects.toThrow(
      /500/,
    );
  });

  it("refuses non-https targets", async () => {
    const actions = registry();
    await expect(
      actions.call_webhook!({ url: "http://internal.host/steal" }, ctx),
    ).rejects.toThrow(/https/);
  });

  it("refuses hosts that resolve to private/internal addresses (SSRF guard)", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const actions = registry({ fetchImpl: fetchImpl as unknown as typeof fetch });
    for (const url of [
      "https://internal.corp/hook",
      "https://metadata.cloud/latest",
      "https://rebind.example.com/x",
    ]) {
      await expect(actions.call_webhook!({ url }, ctx)).rejects.toThrow(/private or internal/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not follow redirects (a 3xx is a failed delivery)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://internal.corp/" } }),
    );
    const actions = registry({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(actions.call_webhook!({ url: "https://x.example.com" }, ctx)).rejects.toThrow(
      /302/,
    );
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("manual");
  });
});

describe("schedule_followup", () => {
  it("schedules a timer that will re-enter the engine as followup.due", async () => {
    const store = new InMemoryWorkflowStore();
    const actions = createActionRegistry({
      messaging: fakeMessaging(),
      crm: stubCrm,
      store,
    });

    await actions.schedule_followup!({ delayMinutes: 60, reason: "review request" }, ctx);

    expect(store.timers).toHaveLength(1);
    expect(store.timers[0].eventType).toBe("followup.due");
    expect(store.timers[0].correlationId).toBe("conv-1");
    expect(Date.parse(store.timers[0].fireAt)).toBeGreaterThan(Date.now() + 59 * 60_000);
  });

  it("rejects nonsense delays", async () => {
    const actions = registry();
    await expect(actions.schedule_followup!({ delayMinutes: -5 }, ctx)).rejects.toThrow(
      /delayMinutes/,
    );
  });

  it("accepts a cadence in days, including the string a template variable produces", async () => {
    const store = new InMemoryWorkflowStore();
    const actions = createActionRegistry({
      messaging: fakeMessaging(),
      crm: stubCrm,
      store,
    });

    await actions.schedule_followup!({ delayDays: "90", reason: "periodic-rebook" }, ctx);

    const ninetyDaysMs = 90 * 24 * 60 * 60_000;
    const fireAt = Date.parse(store.timers[0].fireAt);
    expect(fireAt).toBeGreaterThan(Date.now() + ninetyDaysMs - 60_000);
    expect(fireAt).toBeLessThan(Date.now() + ninetyDaysMs + 60_000);
  });

  it("refuses to park a timer beyond a year", async () => {
    const actions = registry();
    await expect(actions.schedule_followup!({ delayDays: 400 }, ctx)).rejects.toThrow(/one-year/);
  });
});

describe("request_review", () => {
  it("messages the review link and records the ask for analytics", async () => {
    const messaging = fakeMessaging();
    const tracked: Array<{ type: string; metadata: Record<string, unknown> }> = [];
    const actions = createActionRegistry({
      messaging,
      crm: stubCrm,
      store: new InMemoryWorkflowStore(),
      trackUsage: async (_businessId, eventType, metadata) => {
        tracked.push({ type: eventType, metadata });
      },
    });

    const result = await actions.request_review!(
      { to: "ada@example.com", channel: "email", reviewUrl: "https://g.page/r/x/review" },
      ctx,
    );

    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0].channel).toBe("email");
    expect(messaging.sent[0].body).toContain("https://g.page/r/x/review");
    expect(tracked).toEqual([
      { type: "review_requested", metadata: { correlationId: "conv-1", channel: "email" } },
    ]);
    expect(result).toMatchObject({ to: "ada@example.com" });
  });

  it("requires a review URL", async () => {
    const actions = registry();
    await expect(actions.request_review!({ to: "ada@example.com" }, ctx)).rejects.toThrow(
      /reviewUrl/,
    );
  });
});

describe("ops_create", () => {
  const fakeOps = () => {
    const created: Array<Record<string, unknown>> = [];
    return {
      created,
      provider: {
        name: "fake-ops",
        supports: (kind: string) => kind !== "payment",
        createRecord: async (input: Record<string, unknown>) => {
          created.push(input);
          return { externalId: "ext-1" };
        },
      },
    };
  };

  it("creates a back-office record through the OpsProvider port", async () => {
    const ops = fakeOps();
    const actions = createActionRegistry({
      messaging: fakeMessaging(),
      crm: stubCrm,
      store: new InMemoryWorkflowStore(),
      ops: ops.provider as never,
    });

    const result = await actions.ops_create!(
      {
        kind: "fsm_ticket",
        email: "ada@example.com",
        data: { summary: "AC not cooling", priority: "high" },
      },
      ctx,
    );

    expect(ops.created).toHaveLength(1);
    expect(ops.created[0]).toMatchObject({
      kind: "fsm_ticket",
      businessId: "biz-1",
      correlationId: "conv-1",
      customer: { email: "ada@example.com" },
      data: { summary: "AC not cooling", priority: "high" },
    });
    expect(result).toMatchObject({ kind: "fsm_ticket", externalId: "ext-1", provider: "fake-ops" });
  });

  /** CRM that records what the action wrote, for timeline assertions. */
  const recordingCrm = () => {
    const timeline: Array<{ kind: string; title: string; detail?: Record<string, unknown> }> = [];
    const revenue: number[] = [];
    const crm = new CrmService({
      findByEmail: async () => null,
      findByPhone: async () => null,
      insert: async (businessId, draft) => ({
        id: "cust-1",
        businessId,
        ...draft,
        totalAppointments: 0,
        revenueTotal: 0,
      }),
      update: async (_id, patch) => {
        if (patch.revenueTotal !== undefined) revenue.push(patch.revenueTotal);
      },
      markMerged: async () => undefined,
      appendTimeline: async (_businessId, _customerId, entry) => {
        timeline.push(entry);
      },
    } satisfies CrmStore);
    return { crm, timeline, revenue };
  };

  it("puts the back-office record on the customer timeline", async () => {
    const ops = fakeOps();
    const { crm, timeline } = recordingCrm();
    const actions = createActionRegistry({
      messaging: fakeMessaging(),
      crm,
      store: new InMemoryWorkflowStore(),
      ops: ops.provider as never,
    });

    const result = await actions.ops_create!(
      { kind: "invoice", email: "ada@example.com", data: { amount: 240 } },
      ctx,
    );

    expect(result).toMatchObject({ timelined: true });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe("invoice");
    expect(timeline[0].title).toContain("Invoice");
    expect(timeline[0].title).toContain("ext-1");
    expect(timeline[0].detail).toMatchObject({ externalId: "ext-1", provider: "fake-ops" });
  });

  it("attributes a recorded payment as revenue, but never a quote", async () => {
    const paying = {
      name: "pay-ops",
      supports: () => true,
      createRecord: async () => ({ externalId: "pay-1" }),
    };
    const forPayment = recordingCrm();
    const forQuote = recordingCrm();

    await createActionRegistry({
      messaging: fakeMessaging(),
      crm: forPayment.crm,
      store: new InMemoryWorkflowStore(),
      ops: paying as never,
    }).ops_create!({ kind: "payment", email: "ada@example.com", data: { amount: 120 } }, ctx);

    await createActionRegistry({
      messaging: fakeMessaging(),
      crm: forQuote.crm,
      store: new InMemoryWorkflowStore(),
      ops: paying as never,
    }).ops_create!({ kind: "quote", email: "ada@example.com", data: { amount: 990 } }, ctx);

    expect(forPayment.revenue).toEqual([120]);
    expect(forQuote.revenue).toEqual([]);
  });

  it("skips the timeline when the journey knows no customer identity", async () => {
    const ops = fakeOps();
    const { crm, timeline } = recordingCrm();
    const actions = createActionRegistry({
      messaging: fakeMessaging(),
      crm,
      store: new InMemoryWorkflowStore(),
      ops: ops.provider as never,
    });

    const result = await actions.ops_create!({ kind: "fsm_ticket", data: {} }, ctx);

    expect(result).toMatchObject({ externalId: "ext-1", timelined: false });
    expect(timeline).toHaveLength(0);
  });

  it("still succeeds when the timeline write fails — a retry would double-create the record", async () => {
    const ops = fakeOps();
    const brokenCrm = new CrmService({
      findByEmail: async () => null,
      findByPhone: async () => null,
      insert: async () => {
        throw new Error("crm is down");
      },
      update: async () => undefined,
      markMerged: async () => undefined,
      appendTimeline: async () => undefined,
    } satisfies CrmStore);

    const result = await createActionRegistry({
      messaging: fakeMessaging(),
      crm: brokenCrm,
      store: new InMemoryWorkflowStore(),
      ops: ops.provider as never,
    }).ops_create!({ kind: "fsm_ticket", email: "ada@example.com", data: {} }, ctx);

    expect(ops.created).toHaveLength(1);
    expect(result).toMatchObject({ externalId: "ext-1", timelined: false });
  });

  it("rejects unknown kinds and unsupported kinds", async () => {
    const ops = fakeOps();
    const actions = createActionRegistry({
      messaging: fakeMessaging(),
      crm: stubCrm,
      store: new InMemoryWorkflowStore(),
      ops: ops.provider as never,
    });
    await expect(actions.ops_create!({ kind: "spaceship" }, ctx)).rejects.toThrow(/must be one of/);
    await expect(actions.ops_create!({ kind: "payment" }, ctx)).rejects.toThrow(
      /does not support payment/,
    );
    expect(ops.created).toHaveLength(0);
  });
});
