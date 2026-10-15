import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeOAuthState } from "@halo/platform/oauth-state";
import { resetEnvCacheForTests } from "@halo/platform/env";

/**
 * Phase 2, Workstream 1 — tenant identity at the route boundary.
 *
 * Every route here receives a tenant identifier from outside: an id in the
 * path, a workflow or run id, a signed OAuth state, a form field. Each test
 * signs in as tenant A and aims at tenant B's resource. The tenant must come
 * from the trusted context (the session membership, the per-tenant secret),
 * a foreign resource must be indistinguishable from a missing one, and no
 * side effect may happen. Stores, engine and providers are fakes; a
 * recording fetch proves no network request is made.
 */
const fake = vi.hoisted(() => ({
  session: { userId: "user-a", businessId: "tenant-a", role: "owner" as "owner" | "admin" | "member" },
  workflows: new Map<string, { id: string; businessId: string; version: number; name: string }>(),
  storeCalls: [] as Array<[string, ...unknown[]]>,
  manualRuns: [] as unknown[],
  emitted: [] as Array<{ businessId: string; type: string }>,
  hookSecrets: new Map<string, string>(),
  adminWrites: [] as Array<[string, string]>,
  appointments: new Map<string, { id: string; businessId: string; status: string }>(),
  transitions: [] as unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@halo/tenancy/auth", () => ({ requireBusiness: async () => ({ ...fake.session }) }));
vi.mock("@halo/workflows/supabase-workflow-store", () => ({
  SupabaseWorkflowStore: class {
    async getWorkflow(id: string) { fake.storeCalls.push(["getWorkflow", id]); return fake.workflows.get(id) ?? null; }
    async listWorkflows(businessId: string) { fake.storeCalls.push(["listWorkflows", businessId]); return [...fake.workflows.values()].filter((w) => w.businessId === businessId); }
    async updateWorkflow(...args: unknown[]) { fake.storeCalls.push(["updateWorkflow", ...args]); }
    async deleteWorkflow(...args: unknown[]) { fake.storeCalls.push(["deleteWorkflow", ...args]); }
    async listRuns(...args: unknown[]) { fake.storeCalls.push(["listRuns", ...args]); return []; }
    async listRunLogs(...args: unknown[]) { fake.storeCalls.push(["listRunLogs", ...args]); return []; }
  },
}));
vi.mock("@halo/workflows/event-bus", () => ({
  getWorkflowEngine: () => ({ runManually: async (...args: unknown[]) => { fake.manualRuns.push(args); } }),
  emitBusinessEvent: async (event: { businessId: string; type: string }) => { fake.emitted.push(event); },
}));
vi.mock("@halo/tenancy/supabase/admin", () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      const filters: Record<string, string> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: string) => { filters[column] = value; return builder; },
        is: () => builder,
        maybeSingle: async () => ({ data: fake.hookSecrets.has(filters.business_id) ? { workflow_webhook_secret: fake.hookSecrets.get(filters.business_id) } : null, error: null }),
        delete: () => { fake.adminWrites.push(["delete", table]); return builder; },
        insert: async () => { fake.adminWrites.push(["insert", table]); return { error: null }; },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
      return builder;
    },
  }),
}));
vi.mock("@halo/scheduling/scheduling-repository", () => ({
  SchedulingRepository: class { async getAppointment(id: string) { return fake.appointments.get(id) ?? null; } },
}));
vi.mock("@halo/lifecycle/manage-service", () => ({ loadBusinessById: async (id: string) => ({ id, name: "Synthetic" }) }));
vi.mock("@halo/lifecycle/lifecycle-service", () => ({
  AppointmentLifecycleService: class { async transition(...args: unknown[]) { fake.transitions.push(args); } },
}));

const WF_A = "00000000-0000-4000-8000-0000000000a1";
const WF_B = "00000000-0000-4000-8000-0000000000b1";
const RUN_B = "00000000-0000-4000-8000-0000000000b2";
const APPT_A = "00000000-0000-4000-8000-0000000000a3";
const APPT_B = "00000000-0000-4000-8000-0000000000b3";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const fetchSpy = vi.fn<typeof fetch>();

beforeEach(() => {
  fake.session = { userId: "user-a", businessId: "tenant-a", role: "owner" };
  fake.workflows = new Map([
    [WF_A, { id: WF_A, businessId: "tenant-a", version: 1, name: "A" }],
    [WF_B, { id: WF_B, businessId: "tenant-b", version: 1, name: "B" }],
  ]);
  fake.storeCalls = []; fake.manualRuns = []; fake.emitted = []; fake.adminWrites = []; fake.transitions = [];
  fake.hookSecrets = new Map([["tenant-a", "synthetic-hook-secret-a"], ["tenant-b", "synthetic-hook-secret-b"]]);
  fake.appointments = new Map([
    [APPT_A, { id: APPT_A, businessId: "tenant-a", status: "confirmed" }],
    [APPT_B, { id: APPT_B, businessId: "tenant-b", status: "confirmed" }],
  ]);
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});

const json = (body: unknown) => new NextRequest("http://localhost/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

describe("workflow routes take the tenant from the session, never from the id", () => {
  it("another tenant's workflow is indistinguishable from a missing one, for every verb", async () => {
    const detail = await import("@/app/api/workflows/[workflowId]/route");
    const run = await import("@/app/api/workflows/[workflowId]/run/route");
    const responses = [
      await detail.GET(new NextRequest("http://localhost/api"), params({ workflowId: WF_B })),
      await detail.PATCH(json({ name: "Hijacked" }), params({ workflowId: WF_B })),
      await detail.DELETE(new NextRequest("http://localhost/api", { method: "DELETE" }), params({ workflowId: WF_B })),
      await run.POST(json({}), params({ workflowId: WF_B })),
    ];
    const unknown = await detail.GET(new NextRequest("http://localhost/api"), params({ workflowId: UNKNOWN }));
    for (const response of responses) {
      expect(response.status).toBe(unknown.status);
      expect(await response.json()).toEqual(await unknown.clone().json());
    }
    expect(unknown.status).toBe(404);
    expect(fake.storeCalls.filter(([name]) => name === "updateWorkflow" || name === "deleteWorkflow")).toEqual([]);
    expect(fake.manualRuns).toEqual([]);
  });

  it("writes pass the session tenant down to the store as a second filter", async () => {
    const detail = await import("@/app/api/workflows/[workflowId]/route");
    expect((await detail.PATCH(json({ name: "Renamed" }), params({ workflowId: WF_A }))).status).toBe(200);
    expect((await detail.DELETE(new NextRequest("http://localhost/api", { method: "DELETE" }), params({ workflowId: WF_A }))).status).toBe(200);
    expect(fake.storeCalls).toContainEqual(["updateWorkflow", WF_A, "tenant-a", expect.objectContaining({ name: "Renamed" }), 1]);
    expect(fake.storeCalls).toContainEqual(["deleteWorkflow", WF_A, "tenant-a"]);
  });

  it("a member cannot write even its own tenant's workflow", async () => {
    fake.session.role = "member";
    const detail = await import("@/app/api/workflows/[workflowId]/route");
    expect((await detail.PATCH(json({ name: "Renamed" }), params({ workflowId: WF_A }))).status).toBe(403);
    expect(fake.storeCalls.some(([name]) => name === "updateWorkflow")).toBe(false);
  });

  it("run history and run logs are always queried with the session tenant; a tenant id in the query is ignored", async () => {
    const runs = await import("@/app/api/workflows/runs/route");
    const logs = await import("@/app/api/workflows/runs/[runId]/route");
    await runs.GET(new NextRequest(`http://localhost/api/workflows/runs?businessId=tenant-b&business_id=tenant-b`));
    const response = await logs.GET(new NextRequest("http://localhost/api"), params({ runId: RUN_B }));
    expect(await response.json()).toEqual({ data: { logs: [] } });
    expect(fake.storeCalls).toContainEqual(["listRuns", "tenant-a", expect.objectContaining({ limit: 50 })]);
    expect(fake.storeCalls).toContainEqual(["listRunLogs", "tenant-a", RUN_B]);
    expect(fake.storeCalls.flat()).not.toContain("tenant-b");
  });

  it("creating a workflow ignores a tenant id in the body", async () => {
    const list = await import("@/app/api/workflows/route");
    const created: unknown[] = [];
    const { SupabaseWorkflowStore } = await import("@halo/workflows/supabase-workflow-store");
    (SupabaseWorkflowStore.prototype as unknown as { createWorkflow: (d: unknown) => Promise<unknown> }).createWorkflow = async (draft) => { created.push(draft); return draft; };
    const response = await list.POST(json({ businessId: "tenant-b", id: WF_B, name: "Injected", trigger: "conversation.started", steps: [{ id: "s1", action: "send_email", params: {} }] }));
    expect(response.status).toBe(201);
    expect(created).toEqual([expect.objectContaining({ businessId: "tenant-a" })]);
  });
});

describe("the inbound workflow hook trusts the path tenant only with that tenant's own secret", () => {
  const hook = async (businessId: string, token: string | null) => {
    const { POST } = await import("@/app/api/hooks/[businessId]/route");
    return POST(
      new NextRequest(`http://localhost/api/hooks/${businessId}`, { method: "POST", body: "{}", headers: token ? { "x-webhook-token": token } : {} }),
      params({ businessId }),
    );
  };

  it("tenant A's secret cannot fire tenant B's workflows, and an unknown tenant looks the same", async () => {
    const crossed = await hook("tenant-b", "synthetic-hook-secret-a");
    const unknown = await hook("tenant-unknown", "synthetic-hook-secret-a");
    const missing = await hook("tenant-b", null);
    for (const response of [crossed, unknown, missing]) expect(response.status).toBe(401);
    expect(await crossed.json()).toEqual(await unknown.json());
    expect(fake.emitted).toEqual([]);
  });

  it("the tenant's own secret fires only that tenant's event", async () => {
    expect((await hook("tenant-b", "synthetic-hook-secret-b")).status).toBe(200);
    expect(fake.emitted).toEqual([expect.objectContaining({ businessId: "tenant-b", type: "webhook.received" })]);
  });

  it("a tenant whose hook secret is empty cannot be fired at all", async () => {
    fake.hookSecrets.set("tenant-b", "");
    expect((await hook("tenant-b", "")).status).toBe(401);
    expect(fake.emitted).toEqual([]);
  });
});

describe("the calendar OAuth callback binds the connection to the tenant that started it", () => {
  const SECRET = "synthetic-state-secret-for-tests";
  const callback = async (state: string, nonceCookie: string) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SECRET);
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-client-secret");
    vi.stubEnv("CALENDAR_CREDENTIALS_ENCRYPTION_KEY", "e".repeat(64));
    resetEnvCacheForTests();
    const { GET } = await import("@/app/api/oauth/google-calendar/callback/route");
    const url = `http://localhost/api/oauth/google-calendar/callback?code=synthetic-code&state=${encodeURIComponent(state)}`;
    return GET(new NextRequest(url, { headers: { cookie: `ar_gcal_oauth_nonce=${nonceCookie}` } }));
  };

  it("a state minted for tenant B is refused for a session in tenant A, before any token exchange or write", async () => {
    const response = await callback(encodeOAuthState({ businessId: "tenant-b", nonce: "synthetic-nonce" }, SECRET), "synthetic-nonce");
    expect(response.headers.get("location")).toContain("calendar_error=invalid_state");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.adminWrites).toEqual([]);
  });

  it("a state signed with another secret, or a nonce from another browser, is refused", async () => {
    for (const response of [
      await callback(encodeOAuthState({ businessId: "tenant-a", nonce: "synthetic-nonce" }, "synthetic-other-secret"), "synthetic-nonce"),
      await callback(encodeOAuthState({ businessId: "tenant-a", nonce: "synthetic-nonce" }, SECRET), "synthetic-other-nonce"),
    ]) {
      expect(response.headers.get("location")).toContain("calendar_error=invalid_state");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.adminWrites).toEqual([]);
  });

  it("a member of the right tenant still cannot attach a calendar", async () => {
    fake.session.role = "member";
    const response = await callback(encodeOAuthState({ businessId: "tenant-a", nonce: "synthetic-nonce" }, SECRET), "synthetic-nonce");
    expect(response.headers.get("location")).toContain("calendar_error=invalid_state");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the dashboard appointment action re-checks ownership of the submitted id", () => {
  const submit = async (id: string) => {
    const { updateAppointmentLifecycle } = await import("@/features/appointments/actions");
    const data = new FormData();
    data.set("id", id); data.set("status", "cancelled"); data.set("business_id", "tenant-b");
    await updateAppointmentLifecycle(data);
  };

  it("another tenant's appointment id changes nothing", async () => {
    await submit(APPT_B);
    await submit(UNKNOWN);
    expect(fake.transitions).toEqual([]);
  });

  it("the tenant's own appointment transitions, with the session tenant's business", async () => {
    await submit(APPT_A);
    expect(fake.transitions).toEqual([[expect.objectContaining({ id: "tenant-a" }), expect.objectContaining({ id: APPT_A }), "cancelled"]]);
  });
});
