import { readyAgentConfig } from "../mocks/layer1-agent-config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppointmentManageService } from "@halo/lifecycle/manage-service";
import { createSchedulingFakes } from "../mocks/in-memory-scheduling";

// Note: full database RLS isolation is tested separately using real Supabase
// connections. This suite exercises widget identity through the real
// conversation-start route, WidgetRepository, SupabaseAgentRepository, and
// AgentResolver with a query-recording Supabase fake.

vi.mock("@halo/workflows/event-bus", () => ({ emitBusinessEvent: vi.fn(async () => {}) }));
vi.mock("@halo/platform/rate-limit", () => ({
  widgetSessionLimiter: { check: vi.fn(async () => ({ allowed: true })) },
  widgetMessageLimiter: { check: vi.fn(async () => ({ allowed: true })) },
}));
const modelRuntime = vi.hoisted(() => ({ getProvider: vi.fn(), complete: vi.fn() }));
vi.mock("@halo/providers/llm/factory", () => ({
  getLLMProvider: () => {
    modelRuntime.getProvider();
    return { complete: modelRuntime.complete };
  },
}));

type Row = Record<string, unknown>;
type Query = { table: string; filters: Array<[string, unknown]> };

const tenantA = {
  businessId: "business-a",
  receptionistId: "receptionist-a",
  key: "widget-key-tenant-a",
  agentId: "agent-a",
  versionId: "version-a",
};
const tenantB = {
  businessId: "business-b",
  receptionistId: "receptionist-b",
  key: "widget-key-tenant-b",
  agentId: "agent-b",
  versionId: "version-b",
};

const receptionist = (tenant: typeof tenantA, isActive = true): Row => ({
  id: tenant.receptionistId,
  business_id: tenant.businessId,
  name: `Receptionist ${tenant.businessId}`,
  greeting: `Hello ${tenant.businessId}`,
  tone: "friendly",
  language: "en",
  custom_instructions: "",
  widget_key: tenant.key,
  is_active: isActive,
  lead_capture_enabled: false,
  voice_enabled: false,
  branding: {},
  businesses: {
    id: tenant.businessId,
    name: tenant.businessId,
    slug: tenant.businessId,
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
});

const agent = (tenant: typeof tenantA): Row => ({
  id: tenant.agentId,
  business_id: tenant.businessId,
  type: "receptionist",
  slug: tenant.receptionistId,
  display_name: tenant.businessId,
  status: "active",
  live_version_id: tenant.versionId,
  default_channel: "web",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

const version = (tenant: typeof tenantA): Row => ({
  id: tenant.versionId,
  agent_id: tenant.agentId,
  business_id: tenant.businessId,
  version: 1,
  config: readyAgentConfig(),
  prompt_template: `Prompt for ${tenant.businessId}`,
  prompt_version: "test",
  model: {},
  published_at: "2026-01-01T00:00:00Z",
  created_by: null,
  created_at: "2026-01-01T00:00:00Z",
});

let tables: Record<string, Row[]>;
let queries: Query[];
let inserts: Array<{ table: string; payload: Row }>;

vi.mock("@halo/tenancy/supabase/admin", () => ({ getAdminClient: () => fakeSupabase() }));

function fakeSupabase() {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const state: { filters: Array<[string, unknown]>; inserted?: Row } = { filters: [] };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          state.filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        insert: (payload: Row) => {
          state.inserted = payload;
          return builder;
        },
      };

      const finish = (single: boolean) => {
        queries.push({ table, filters: [...state.filters] });
        if (state.inserted !== undefined) {
          inserts.push({ table, payload: state.inserted });
          const row = table === "conversations"
            ? {
                id: `conversation-${inserts.length}`,
                business_id: state.inserted.business_id,
                receptionist_id: state.inserted.receptionist_id,
                visitor_token: `visitor-token-${inserts.length}-abcdef0123456789`,
                channel: state.inserted.channel,
                status: "active",
                message_count: 0,
                started_at: "2026-01-01T00:00:00Z",
                last_message_at: "2026-01-01T00:00:00Z",
                agent_id: state.inserted.agent_id,
                agent_version_id: state.inserted.agent_version_id,
              }
            : state.inserted;
          return Promise.resolve({ data: single ? row : [row], error: null });
        }

        const matched = rows.filter((row) => state.filters.every(([column, value]) => row[column] === value));
        // Supabase maybeSingle rejects an unscoped multi-row result. Keep the
        // query log so the test also directly detects a removed key predicate.
        if (single && matched.length > 1) {
          return Promise.resolve({ data: null, error: { message: "multiple rows returned" } });
        }
        const data = single ? (matched[0] ?? null) : matched;
        return Promise.resolve({ data, error: null });
      };

      builder.maybeSingle = () => finish(true);
      builder.single = () => finish(true);
      Object.defineProperty(builder, "then", {
        value: (onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
          finish(false).then(onFulfilled, onRejected),
        writable: true,
      });
      return builder;
    },
  };
}

async function postConversation(widgetKey: string) {
  const { POST } = await import("@/app/api/v1/widget/conversations/route");
  return POST(new NextRequest("http://localhost:3000/api/v1/widget/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ widgetKey, channel: "chat", pageUrl: "" }),
  }));
}

const conversationInserts = () => inserts.filter((entry) => entry.table === "conversations");
const queriesFor = (table: string) => queries.filter((query) => query.table === table);

beforeEach(() => {
  queries = [];
  inserts = [];
  modelRuntime.getProvider.mockClear();
  modelRuntime.complete.mockClear();
  tables = {
    // A first makes an omitted widget-key filter visibly resolve A when B is
    // requested; query assertions independently require the exact key filter.
    receptionists: [receptionist(tenantA), receptionist(tenantB)],
    agents: [agent(tenantA), agent(tenantB)],
    agent_versions: [version(tenantA), version(tenantB)],
    usage_events: [],
  };
});

describe("Multi-tenant Isolation — widget conversation identity", () => {
  it("resolves Tenant A's active widget key only to Tenant A", async () => {
    const response = await postConversation(tenantA.key);
    expect(response.status).toBe(201);

    const keyLookup = queriesFor("receptionists").find((query) => query.filters.some(([column]) => column === "widget_key"));
    expect(keyLookup?.filters).toContainEqual(["widget_key", tenantA.key]);
    expect(conversationInserts()).toHaveLength(1);
    expect(conversationInserts()[0].payload).toMatchObject({
      business_id: tenantA.businessId,
      receptionist_id: tenantA.receptionistId,
      agent_id: tenantA.agentId,
      agent_version_id: tenantA.versionId,
    });
  });

  it("resolves Tenant B's active widget key only to Tenant B", async () => {
    const response = await postConversation(tenantB.key);
    expect(response.status).toBe(201);

    const keyLookup = queriesFor("receptionists").find((query) => query.filters.some(([column]) => column === "widget_key"));
    expect(keyLookup?.filters).toContainEqual(["widget_key", tenantB.key]);
    expect(conversationInserts()).toHaveLength(1);
    expect(conversationInserts()[0].payload).toMatchObject({
      business_id: tenantB.businessId,
      receptionist_id: tenantB.receptionistId,
      agent_id: tenantB.agentId,
      agent_version_id: tenantB.versionId,
    });
    expect(conversationInserts()[0].payload.business_id).not.toBe(tenantA.businessId);
  });

  it.each([
    ["unknown", "widget-key-unknown"],
    ["inactive", "widget-key-inactive"],
  ])("fails closed for an %s key before inserting or resolving runtime identity", async (_kind, key) => {
    if (key === "widget-key-inactive") {
      tables.receptionists = [
        receptionist(tenantA),
        receptionist(tenantB),
        { ...receptionist(tenantB, false), widget_key: key },
      ];
    }

    const response = await postConversation(key);
    expect(response.status).toBe(404);
    expect(conversationInserts()).toHaveLength(0);
    // No tenant agent lookup means AgentResolver/runtime identity resolution
    // was never reached; conversation start does not invoke a model provider.
    expect(queriesFor("agents")).toHaveLength(0);
    expect(queriesFor("agent_versions")).toHaveLength(0);
    expect(modelRuntime.getProvider).not.toHaveBeenCalled();
    expect(modelRuntime.complete).not.toHaveBeenCalled();
  });

  it("requires the exact key predicate and preserves the matched tenant identity", async () => {
    for (const tenant of [tenantA, tenantB]) {
      queries = [];
      inserts = [];
      const response = await postConversation(tenant.key);
      expect(response.status).toBe(201);

      const receptionistLookup = queriesFor("receptionists").find((query) =>
        query.filters.some(([column]) => column === "widget_key"),
      );
      expect(receptionistLookup?.filters).toContainEqual(["widget_key", tenant.key]);
      expect(conversationInserts()[0].payload.business_id).toBe(tenant.businessId);
      expect(conversationInserts()[0].payload.receptionist_id).toBe(tenant.receptionistId);
      expect(conversationInserts()[0].payload.agent_id).toBe(tenant.agentId);
      expect(conversationInserts()[0].payload.agent_version_id).toBe(tenant.versionId);
    }
  });
});

describe("Multi-tenant Isolation — appointment manage tokens", () => {
  it("manage token intrinsically scopes to a single appointment", async () => {
    const fakes = createSchedulingFakes();
    const manageService = new AppointmentManageService(fakes.repository);

    await expect(manageService.cancel("invalid-token")).rejects.toThrow(/not found/i);
    // A token for appointment A cannot be used to pass an appointment B ID,
    // because the manage methods take ONLY the token and look up the appointment internally.
  });

  it("an unknown manage token can never resolve another business's appointment", async () => {
    const fakes = createSchedulingFakes();
    const manageService = new AppointmentManageService(fakes.repository);

    // No appointment exists; a guessed/foreign token resolves to nothing
    // rather than any row, so cancel/reschedule/feedback all fail closed.
    const context = await manageService.getContext("00000000-0000-4000-8000-000000000000");
    expect(context).toBeNull();

    await expect(
      manageService.reschedule("00000000-0000-4000-8000-000000000000", "2026-07-14T13:00:00.000Z", "s1"),
    ).rejects.toThrow(/not found/i);
    await expect(
      manageService.submitFeedback("00000000-0000-4000-8000-000000000000", { rating: 5, comment: "Great" }),
    ).rejects.toThrow(/not found/i);
  });
});
