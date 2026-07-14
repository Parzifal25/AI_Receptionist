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
});
