import { readyAgentConfig } from "../mocks/layer1-agent-config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Phase 2 — web-chat security through the real messages route:
 *   - an unknown visitor token never reaches the runtime;
 *   - agent/version identity comes from the conversation row, never the
 *     request body, and malformed, mismatched, unpublished, or foreign
 *     versions fail closed before the runtime or message writes;
 *   - the response envelope is unchanged: { data: { reply } }.
 */

vi.mock("@halo/workflows/event-bus", () => ({ emitBusinessEvent: vi.fn(async () => {}) }));
vi.mock("@halo/platform/rate-limit", () => ({
  widgetSessionLimiter: { check: vi.fn(async () => ({ allowed: true })) },
  widgetMessageLimiter: { check: vi.fn(async () => ({ allowed: true })) },
}));
vi.mock("@halo/scheduling/booking-orchestrator", () => ({
  BookingOrchestrator: class {
    async prepareTurn() {
      return null;
    }
  },
}));

const prompts: string[] = [];
const modelMessages: Array<Array<{ role: string; content: string }>> = [];
vi.mock("@halo/providers/llm/factory", () => ({
  getLLMProvider: () => ({
    name: "fake",
    capabilities: () => ({ streaming: false, tools: false, jsonMode: true, usage: true }),
    async complete(systemPrompt: string, messages: Array<{ role: string; content: string }>) {
      prompts.push(systemPrompt);
      modelMessages.push(messages);
      return { content: "Hello from the runtime.", model: "fake", usage: { promptTokens: 1, completionTokens: 1 } };
    },
    async isHealthy() {
      return true;
    },
  }),
}));
vi.mock("@halo/providers/knowledge/factory", () => ({
  getKnowledgeProvider: () => ({ name: "fake", async search() { return []; }, async indexDocument() {}, async removeDocument() {} }),
}));
vi.mock("@halo/providers/notification/factory", () => ({
  getNotificationProvider: () => ({ name: "fake", async notifyNewLead() {} }),
}));

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
const inserts: Array<{ table: string; payload: unknown }> = [];
const upserts: Array<{ table: string; payload: unknown }> = [];

vi.mock("@halo/tenancy/supabase/admin", () => ({ getAdminClient: () => fakeSupabase() }));

function fakeSupabase() {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const state: { filters: Array<[string, unknown]>; inFilters: Array<[string, unknown[]]>; inserted?: unknown; upserted?: unknown } = { filters: [], inFilters: [] };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => (state.filters.push([col, val]), b),
        in: (col: string, vals: unknown[]) => (state.inFilters.push([col, vals]), b),
        order: () => b,
        limit: () => b,
        insert: (payload: unknown) => ((state.inserted = payload), b),
        upsert: (payload: unknown) => ((state.upserted = payload), b),
        update: () => b,
      };
      const finish = (single: boolean) => {
        if (state.inserted !== undefined) {
          inserts.push({ table, payload: state.inserted });
          return Promise.resolve({ data: null, error: null });
        }
        if (state.upserted !== undefined) {
          upserts.push({ table, payload: state.upserted });
          return Promise.resolve({ data: null, error: null });
        }
        const data = rows.filter(
          (r) => state.filters.every(([c, v]) => r[c] === v) && state.inFilters.every(([c, vs]) => vs.includes(r[c])),
        );
        return Promise.resolve({ data: single ? (data[0] ?? null) : data, error: null });
      };
      b.maybeSingle = () => finish(true);
      b.single = () => finish(true);
      Object.defineProperty(b, "then", {
        value: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => finish(false).then(onFulfilled, onRejected),
        writable: true,
      });
      return b;
    },
  };
}

const receptionistRow: Row = {
  id: "r1",
  business_id: "b1",
  name: "Riley",
  greeting: "Hi",
  tone: "friendly",
  language: "en",
  custom_instructions: "",
  widget_key: "key-acme-123456",
  is_active: true,
  lead_capture_enabled: false,
  voice_enabled: false,
  branding: {},
  businesses: {
    id: "b1", name: "Acme", slug: "acme", description: "", industry: "", website: "", phone: "", email: "", address: "", business_hours: {}, logo_url: "",
    business_settings: [{ allowed_domains: [] }],
  },
};
const otherReceptionistRow: Row = {
  ...receptionistRow,
  id: "r2",
  name: "Rex",
  greeting: "Welcome to the second desk.",
  widget_key: "key-acme-other-123456",
};

const conversationRow = (overrides: Row = {}): Row => ({
  id: "conv-1",
  business_id: "b1",
  receptionist_id: "r1",
  visitor_token: "visitor-token-abcdef0123456789",
  channel: "chat",
  status: "active",
  message_count: 0,
  started_at: "2026-01-01T00:00:00Z",
  last_message_at: "2026-01-01T00:00:00Z",
  agent_id: "agent-1",
  agent_version_id: "av-1",
  ...overrides,
});

const ownVersion: Row = {
  id: "av-1", agent_id: "agent-1", business_id: "b1", version: 1, config: readyAgentConfig(), prompt_template: "You are Riley, the receptionist for Acme. TENANT A TEMPLATE", prompt_version: "x", model: {}, published_at: "2026-01-01T00:00:00Z", created_by: null, created_at: "2026-01-01T00:00:00Z",
};
const foreignVersion: Row = { ...ownVersion, id: "av-foreign", agent_id: "agent-foreign", business_id: "b2", prompt_template: "TENANT B SECRET TEMPLATE" };
const otherAgentVersion: Row = { ...ownVersion, id: "av-other-agent", agent_id: "agent-2", prompt_template: "OTHER AGENT TEMPLATE" };
const draftVersion: Row = { ...ownVersion, id: "av-draft", published_at: null, prompt_template: "DRAFT TEMPLATE" };

function makeRequest(body: unknown, signal?: AbortSignal) {
  return new NextRequest("http://localhost/api/v1/widget/messages", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
}

async function POST() {
  const mod = await import("@/app/api/v1/widget/messages/route");
  return mod.POST;
}

beforeEach(() => {
  prompts.length = 0;
  modelMessages.length = 0;
  inserts.length = 0;
  upserts.length = 0;
  tables = {
    receptionists: [receptionistRow],
    conversations: [conversationRow()],
    agents: [{
      id: "agent-1", business_id: "b1", type: "receptionist", slug: "r1", display_name: "Riley",
      status: "active", live_version_id: "av-1", default_channel: "web",
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    }],
    agent_versions: [ownVersion, foreignVersion, otherAgentVersion, draftVersion],
    messages: [],
    conversation_state: [],
    business_settings: [],
  };
});

describe("POST /api/v1/widget/messages — Phase 2 security and compatibility", () => {
  it("answers on the runtime with the persisted agent version and the unchanged envelope", async () => {
    const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { reply: "Hello from the runtime." } });
    expect(prompts[0]).toContain("TENANT A TEMPLATE");
    expect(prompts[0]).toContain("You are Riley, the receptionist for Acme");
    expect(inserts.filter((i) => i.table === "messages")).toHaveLength(1);
    expect(upserts.filter((u) => u.table === "conversation_state")).toHaveLength(1);
    const usage = inserts.find((i) => i.table === "usage_events")?.payload as { event_type: string; metadata: Record<string, unknown> };
    expect(usage.event_type).toBe("message_sent");
    expect(usage.metadata).toMatchObject({ provider: "fake", modelCalls: 1, totalTokens: 2 });
    expect(JSON.stringify(usage.metadata)).not.toContain("hello");
  });

  it("rejects an unknown visitor token before any model call", async () => {
    const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-unknown-0000000000", message: "hello" }));
    expect(res.status).toBe(404);
    expect(prompts).toHaveLength(0);
  });

  it("ignores agent/version identity supplied in the request body", async () => {
    const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello", agentVersionId: "av-foreign", agentId: "agent-foreign" }));
    expect(res.status).toBe(200);
    expect(prompts[0]).toContain("TENANT A TEMPLATE");
    expect(prompts[0]).not.toContain("TENANT B SECRET TEMPLATE");
  });

  it("a conversation row pointing at another tenant's version cannot resolve it (tenant-scoped lookup)", async () => {
    tables.conversations = [conversationRow({ agent_version_id: "av-foreign", agent_id: "agent-foreign" })];
    const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }));
    expect(res.status).toBe(409);
    expect(prompts).toHaveLength(0);
    expect(inserts.filter((i) => i.table === "messages")).toHaveLength(0);
    expect(upserts.filter((u) => u.table === "conversation_state")).toHaveLength(0);
  });

  it("rejects a conversation with missing agent linkage before runtime or writes", async () => {
    tables.conversations = [conversationRow({ agent_id: null, agent_version_id: null })];
    const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "CONFLICT", message: "This conversation's agent configuration is unavailable" },
    });
    expect(prompts).toHaveLength(0);
    expect(inserts.filter((i) => ["messages", "usage_events"].includes(i.table))).toHaveLength(0);
    expect(upserts.filter((u) => u.table === "conversation_state")).toHaveLength(0);
  });

  it("rejects a conversation whose tenant does not own its receptionist context", async () => {
    tables.conversations = [conversationRow({ business_id: "b2" })];
    const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }));
    expect(res.status).toBe(409);
    expect(prompts).toHaveLength(0);
    expect(inserts.filter((i) => i.table === "messages")).toHaveLength(0);
    expect(upserts.filter((u) => u.table === "conversation_state")).toHaveLength(0);
  });

  it("rejects a valid same-tenant agent tuple pinned to a different receptionist", async () => {
    tables.receptionists = [receptionistRow, otherReceptionistRow];
    tables.conversations = [conversationRow({ receptionist_id: "r2" })];
    const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }));
    expect(res.status).toBe(409);
    expect(prompts).toHaveLength(0);
    expect(inserts.filter((i) => ["messages", "usage_events"].includes(i.table))).toHaveLength(0);
    expect(upserts.filter((u) => u.table === "conversation_state")).toHaveLength(0);
  });

  it("rejects partial or unresolved agent linkage", async () => {
    for (const linkage of [
      { agent_id: "agent-1", agent_version_id: null },
      { agent_id: "agent-1", agent_version_id: "missing-version" },
    ]) {
      tables.conversations = [conversationRow(linkage)];
      const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }));
      expect(res.status).toBe(409);
    }
    expect(prompts).toHaveLength(0);
    expect(inserts.filter((i) => i.table === "messages")).toHaveLength(0);
    expect(upserts.filter((u) => u.table === "conversation_state")).toHaveLength(0);
  });

  it("rejects a published version owned by a different agent", async () => {
    tables.conversations = [conversationRow({ agent_version_id: "av-other-agent" })];
    const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }));
    expect(res.status).toBe(409);
    expect(prompts).toHaveLength(0);
    expect(inserts.filter((i) => i.table === "messages")).toHaveLength(0);
    expect(upserts.filter((u) => u.table === "conversation_state")).toHaveLength(0);
  });

  it("rejects an unpublished pinned version", async () => {
    tables.conversations = [conversationRow({ agent_version_id: "av-draft" })];
    const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }));
    expect(res.status).toBe(409);
    expect(prompts).toHaveLength(0);
    expect(inserts.filter((i) => i.table === "messages")).toHaveLength(0);
    expect(upserts.filter((u) => u.table === "conversation_state")).toHaveLength(0);
  });

  it("only user/assistant rows are read back as history (tool rows are runtime records)", async () => {
    tables.messages = [
      { conversation_id: "conv-1", role: "tool", content: "", created_at: "2026-01-01T00:00:01Z" },
      { conversation_id: "conv-1", role: "user", content: "earlier question", created_at: "2026-01-01T00:00:00Z" },
    ];
    await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }));
    expect(modelMessages[0].map((m) => m.role)).toEqual(["user", "user"]);
    expect(modelMessages[0][0].content).toBe("earlier question");
  });
});

it("cancels an abandoned web request before model work or persistence", async () => {
  const controller = new AbortController();
  controller.abort();
  const res = await (await POST())(makeRequest({ visitorToken: "visitor-token-abcdef0123456789", message: "hello" }, controller.signal));
  expect(res.status).toBe(499);
  expect(prompts).toHaveLength(0);
  expect(inserts).toHaveLength(0);
  expect(upserts).toHaveLength(0);
});
