import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeOAuthState } from "@halo/platform/oauth-state";
import { resetEnvCacheForTests } from "@halo/platform/env";

const state = vi.hoisted(() => ({
  row: { id: "connection-a", access_token: "old-access", refresh_token: "old-refresh" } as Record<string, unknown> | null,
  lookupFail: false, fail: false, writes: [] as string[], filters: [] as Array<[string, unknown]>,
  role: "owner", tenant: "tenant-a",
}));
vi.mock("@halo/tenancy/auth", () => ({ requireBusiness: async () => ({ userId: "user-a", businessId: state.tenant, role: state.role }) }));
vi.mock("@halo/tenancy/supabase/admin", () => ({ getAdminClient: () => ({ from: () => {
  let op = "select"; let values: Record<string, unknown> = {};
  const builder = {
    select: () => builder,
    eq: (key: string, value: unknown) => { state.filters.push([key, value]); return builder; },
    is: (key: string, value: unknown) => { state.filters.push([key, value]); return builder; },
    delete: () => { op = "delete"; return builder; },
    update: (v: Record<string, unknown>) => { op = "update"; values = v; return builder; },
    insert: (v: Record<string, unknown>) => { op = "insert"; values = v; return builder; },
    maybeSingle: async () => ({ data: state.row ? { id: state.row.id } : null, error: state.lookupFail ? { message: "synthetic lookup error" } : null }),
    single: async () => execute(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(execute()).then(resolve),
  };
  function execute() {
    state.writes.push(op);
    if (op === "delete") state.row = null;
    else if (state.fail) return { error: { message: "synthetic storage failure" }, data: null };
    else state.row = { ...state.row, ...values };
    return { error: null, data: state.row };
  }
  return builder;
} }) }));
const fetchSpy = vi.fn<typeof fetch>();
beforeEach(() => {
  state.row = { id: "connection-a", access_token: "old-access", refresh_token: "old-refresh" };
  state.lookupFail = false; state.fail = false; state.writes = []; state.filters = []; state.role = "owner"; state.tenant = "tenant-a";
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-state-secret");
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("CALENDAR_CREDENTIALS_ENCRYPTION_KEY", "e".repeat(64));
  resetEnvCacheForTests();
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvCacheForTests(); });
async function callback() {
  const { GET } = await import("@/app/api/oauth/google-calendar/callback/route");
  const signed = encodeOAuthState({ businessId: "tenant-a", nonce: "synthetic-nonce" }, "synthetic-state-secret");
  return GET(new NextRequest(`http://localhost/api/oauth/google-calendar/callback?code=synthetic&state=${encodeURIComponent(signed)}`, { headers: { cookie: "ar_gcal_oauth_nonce=synthetic-nonce" } }));
}
it("preserves working credentials when replacement persistence fails", async () => {
  state.fail = true;
  const response = await callback();
  expect(response.headers.get("location")).toContain("calendar_error=exchange_failed");
  expect(state.row).toEqual({ id: "connection-a", access_token: "old-access", refresh_token: "old-refresh" });
  expect(state.writes).toEqual(["update"]);
});
it("reconnects in place and scopes the write to tenant, provider, business-level row and id", async () => {
  expect((await callback()).headers.get("location")).toContain("calendar=connected");
  expect(state.writes).toEqual(["update"]);
  expect(state.row?.id).toBe("connection-a");
  expect(state.row?.access_token).not.toBe("new-access");
  expect(state.row?.access_token).not.toBe("old-access");
  expect(state.filters).toEqual(expect.arrayContaining([["business_id", "tenant-a"], ["provider", "google"], ["staff_id", null], ["id", "connection-a"]]));
});
it("inserts on first connection", async () => {
  state.row = null;
  await callback();
  expect(state.writes).toEqual(["insert"]);
  expect(state.row).toMatchObject({ business_id: "tenant-a", provider: "google", staff_id: null });
});
it.each(["member", "foreign"])("refuses %s before provider exchange or persistence", async (kind) => {
  if (kind === "member") state.role = "member"; else state.tenant = "tenant-b";
  expect((await callback()).headers.get("location")).toContain("calendar_error=invalid_state");
  expect(fetchSpy).not.toHaveBeenCalled(); expect(state.writes).toEqual([]);
});
it("preserves existing credentials when Google omits refresh token", async () => {
  fetchSpy.mockResolvedValue(Response.json({ access_token: "new-access" }));
  await callback();
  expect(state.writes).toEqual([]); expect(state.row?.refresh_token).toBe("old-refresh");
});

it("fails closed on ambiguous or unavailable connection lookup without writing", async () => {
  state.lookupFail = true;
  expect((await callback()).headers.get("location")).toContain("calendar_error=exchange_failed");
  expect(state.writes).toEqual([]);
  expect(state.row?.access_token).toBe("old-access");
});
