import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetEnvCacheForTests } from "@halo/platform/env";

vi.mock("@halo/workflows/event-bus", () => ({ emitBusinessEvent: vi.fn(async () => {}) }));
vi.mock("@halo/platform/rate-limit", () => ({
  widgetSessionLimiter: { check: vi.fn(async () => ({ allowed: true })) },
  widgetMessageLimiter: { check: vi.fn(async () => ({ allowed: true })) },
}));

/**
 * HALO Phase 1 — conversation ↔ agent linkage (plan §P1.3), hardened by
 * Phase 1.5 workstream 5 (fail-closed conversation creation).
 *
 * The route resolves the agent and its published version from the widget
 * key's tenant (never from the request) and persists both ids on the
 * conversation row. When resolution fails, creation fails CLOSED (503) —
 * except for the pre-backfill "agent_not_found" signature when the explicit
 * compatibility flag is set.
 */

type Row = Record<string, unknown>;

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
    id: "b1",
    name: "Acme",
    slug: "acme",
    description: "",
    industry: "",
    website: "",
    phone: "",
    email: "",
    address: "",
    business_hours: {},
    logo_url: "",
    business_settings: [{ allowed_domains: [] }],
  },
};

const agentRow: Row = {
  id: "agent-1",
  business_id: "b1",
  type: "receptionist",
  slug: "r1",
  display_name: "Riley",
  status: "active",
  live_version_id: "av-1",
  default_channel: "web",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const versionRow: Row = {
  id: "av-1",
  agent_id: "agent-1",
  business_id: "b1",
  version: 1,
  config: { identity: { name: "Riley", persona: "friendly" } },
  prompt_template: "You are Riley, the receptionist for Acme.",
  prompt_version: "2026-07-28.1",
  model: {},
  published_at: "2026-01-01T00:00:00Z",
  created_by: null,
  created_at: "2026-01-01T00:00:00Z",
};

let tables: Record<string, Row[]>;
const inserts: Array<{ table: string; payload: Row }> = [];

vi.mock("@halo/tenancy/supabase/admin", () => ({
  getAdminClient: () => fakeSupabase(),
}));

function fakeSupabase() {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const state: { filters: Array<[string, unknown]>; inserted?: Row } = { filters: [] };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          state.filters.push([col, val]);
          return b;
        },
        order: () => b,
        limit: () => b,
        insert: (payload: Row) => {
          state.inserted = payload;
          return b;
        },
        update: () => b,
      };
      const finish = (single: boolean) => {
        if (state.inserted !== undefined) {
          inserts.push({ table, payload: state.inserted });
          const row =
            table === "conversations"
              ? {
                  id: "conv-1",
                  business_id: state.inserted.business_id,
                  receptionist_id: state.inserted.receptionist_id,
                  visitor_token: "visitor-token-abcdef0123456789",
                  channel: state.inserted.channel,
                  status: "active",
                  message_count: 0,
                  started_at: "2026-01-01T00:00:00Z",
                  last_message_at: "2026-01-01T00:00:00Z",
                  ...(state.inserted.agent_id !== undefined ? { agent_id: state.inserted.agent_id } : {}),
                  ...(state.inserted.agent_version_id !== undefined
                    ? { agent_version_id: state.inserted.agent_version_id }
                    : {}),
                }
              : state.inserted;
          return Promise.resolve({ data: single ? row : [row], error: null });
        }
        const data = rows.filter((r) => state.filters.every(([c, v]) => r[c] === v));
        return Promise.resolve({ data: single ? (data[0] ?? null) : data, error: null });
      };
      b.maybeSingle = () => finish(true);
      b.single = () => finish(true);
      // listAgents awaits the builder directly (no terminator).
      Object.defineProperty(b, "then", {
        value: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          finish(false).then(onFulfilled, onRejected),
        writable: true,
      });
      return b;
    },
  };
}

const POST = async () => (await import("@/app/api/v1/widget/conversations/route")).POST;

function makeRequest() {
  return new NextRequest("http://localhost:3000/api/v1/widget/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ widgetKey: "key-acme-123456", channel: "chat", pageUrl: "" }),
  });
}

beforeEach(() => {
  inserts.length = 0;
  delete process.env.HALO_AGENT_RESOLUTION_COMPAT_FAIL_OPEN;
  resetEnvCacheForTests();
  tables = {
    receptionists: [receptionistRow],
    agents: [agentRow],
    agent_versions: [versionRow],
    usage_events: [],
  };
});

describe("conversation creation — agent linkage (Phase 1)", () => {
  it("resolves the tenant's agent + published version server-side and persists both ids", async () => {
    const res = await (await POST())(makeRequest());
    expect(res.status).toBe(201);

    const conversationInsert = inserts.find((i) => i.table === "conversations");
    expect(conversationInsert).toBeDefined();
    // Persisted from the resolver — not from any client-controlled field.
    expect(conversationInsert?.payload.agent_id).toBe("agent-1");
    expect(conversationInsert?.payload.agent_version_id).toBe("av-1");
    // The resolved version is the published one, via the receptionist mapping.
    expect(conversationInsert?.payload.receptionist_id).toBe("r1");

    const body = await res.json();
    expect(body.data.visitorToken).toBeDefined();
    expect(body.data.greeting).toBe("Hi");
  });

  it("never persists agent identity supplied by the request", async () => {
    // A forged extra field in the body cannot select a different agent: the
    // schema ignores it and resolution is server-side.
    const request = new NextRequest("http://localhost:3000/api/v1/widget/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        widgetKey: "key-acme-123456",
        channel: "chat",
        pageUrl: "",
        agentId: "agent-of-another-tenant",
        agentVersionId: "forged-version",
      }),
    });
    const res = await (await POST())(request);
    expect(res.status).toBe(201);
    const conversationInsert = inserts.find((i) => i.table === "conversations");
    expect(conversationInsert?.payload.agent_id).toBe("agent-1");
    expect(conversationInsert?.payload.agent_version_id).toBe("av-1");
  });

  it("rejects an unknown widget key (no tenant can be proven)", async () => {
    tables.receptionists = [];
    const res = await (await POST())(makeRequest());
    expect(res.status).toBe(404);
  });
});

describe("conversation creation — fail-closed resolution (Phase 1.5, WS5)", () => {
  it("fails CLOSED (503) with no conversation row when the agent is not backfilled", async () => {
    tables.agents = [];
    tables.agent_versions = [];

    const res = await (await POST())(makeRequest());
    expect(res.status).toBe(503);
    expect(inserts.find((i) => i.table === "conversations")).toBeUndefined();

    const body = await res.json();
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("fails CLOSED (503) when the agent is inactive — never eligible for the compat path", async () => {
    tables.agents = [{ ...agentRow, status: "paused" }];

    const res = await (await POST())(makeRequest());
    expect(res.status).toBe(503);
    expect(inserts.find((i) => i.table === "conversations")).toBeUndefined();
  });

  it("fails CLOSED (503) when the agent is archived", async () => {
    tables.agents = [{ ...agentRow, status: "archived" }];

    const res = await (await POST())(makeRequest());
    expect(res.status).toBe(503);
    expect(inserts.find((i) => i.table === "conversations")).toBeUndefined();
  });

  it("fails CLOSED (503) when there is no published live version", async () => {
    tables.agents = [{ ...agentRow, live_version_id: null }];
    tables.agent_versions = [];

    const res = await (await POST())(makeRequest());
    expect(res.status).toBe(503);
    expect(inserts.find((i) => i.table === "conversations")).toBeUndefined();
  });

  it("compat flag admits ONLY the pre-backfill signature (agent_not_found)", async () => {
    process.env.HALO_AGENT_RESOLUTION_COMPAT_FAIL_OPEN = "true";
    resetEnvCacheForTests();
    tables.agents = [];
    tables.agent_versions = [];

    const res = await (await POST())(makeRequest());
    expect(res.status).toBe(201);
    const conversationInsert = inserts.find((i) => i.table === "conversations");
    expect(conversationInsert?.payload.agent_id ?? null).toBeNull();
    expect(conversationInsert?.payload.agent_version_id ?? null).toBeNull();
  });

  it("compat flag does NOT admit an inactive agent (fails closed even with flag set)", async () => {
    process.env.HALO_AGENT_RESOLUTION_COMPAT_FAIL_OPEN = "true";
    resetEnvCacheForTests();
    tables.agents = [{ ...agentRow, status: "paused" }];

    const res = await (await POST())(makeRequest());
    expect(res.status).toBe(503);
    expect(inserts.find((i) => i.table === "conversations")).toBeUndefined();
  });

  it("compat flag does NOT admit a missing live version (fails closed even with flag set)", async () => {
    process.env.HALO_AGENT_RESOLUTION_COMPAT_FAIL_OPEN = "true";
    resetEnvCacheForTests();
    tables.agents = [{ ...agentRow, live_version_id: null }];
    tables.agent_versions = [];

    const res = await (await POST())(makeRequest());
    expect(res.status).toBe(503);
    expect(inserts.find((i) => i.table === "conversations")).toBeUndefined();
  });
});
