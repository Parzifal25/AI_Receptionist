import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeOAuthState } from "@halo/platform/oauth-state";
import { resetEnvCacheForTests } from "@halo/platform/env";

/**
 * P2-R1 / migration 0037: two first connects for one business race. Both look
 * up "no business-level row"; the database's partial unique index lets one
 * insert win and rejects the other with 23505. The loser must then replace
 * the winner's row like a reconnect, never create a second row, and never
 * treat any other storage error as a conflict.
 */

type Row = { id: string; business_id: string; staff_id: null; provider: string; access_token: string };
const state = vi.hoisted(() => ({
  rows: [] as Row[], winnerInsertsBeforeUs: false, insertError: null as { code?: string; message: string } | null,
  retryLookupFails: false, lookups: 0, writes: [] as string[],
}));
vi.mock("@halo/tenancy/auth", () => ({ requireBusiness: async () => ({ userId: "user-a", businessId: "tenant-a", role: "owner" }) }));
vi.mock("@halo/tenancy/supabase/admin", () => ({ getAdminClient: () => ({ from: () => {
  let op = "select"; let values: Record<string, unknown> = {}; const filters: Record<string, unknown> = {};
  const matching = () => state.rows.filter(r => r.business_id === filters.business_id && r.provider === filters.provider
    && r.staff_id === null && (filters.id === undefined || r.id === filters.id));
  const builder = {
    select: () => builder,
    eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
    is: (key: string, value: unknown) => { filters[key] = value; return builder; },
    update: (v: Record<string, unknown>) => { op = "update"; values = v; return builder; },
    insert: (v: Record<string, unknown>) => { op = "insert"; values = v; return builder; },
    maybeSingle: async () => {
      state.lookups += 1;
      if (state.lookups > 1 && state.retryLookupFails) return { data: null, error: { message: "synthetic lookup error" } };
      const found = matching();
      // The concurrent winner commits between our lookup and our insert.
      if (state.lookups === 1 && state.winnerInsertsBeforeUs) {
        state.rows.push({ id: "winner", business_id: "tenant-a", staff_id: null, provider: "google", access_token: "winner-access" });
      }
      return { data: found[0] ? { id: found[0].id } : null, error: null };
    },
    single: async () => execute(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(execute()).then(resolve),
  };
  function execute() {
    state.writes.push(op);
    if (op === "insert") {
      if (state.insertError) return { data: null, error: state.insertError };
      const row = values as Row;
      // Partial unique index (business_id, provider) WHERE staff_id IS NULL.
      if (state.rows.some(r => r.business_id === row.business_id && r.provider === row.provider && r.staff_id === null)) {
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      state.rows.push({ ...row, id: "ours" });
      return { data: { id: "ours" }, error: null };
    }
    const [target] = matching();
    if (!target) return { data: null, error: { message: "no row" } };
    Object.assign(target, values);
    return { data: { id: target.id }, error: null };
  }
  return builder;
} }) }));

const fetchSpy = vi.fn<typeof fetch>();
beforeEach(() => {
  state.rows = []; state.winnerInsertsBeforeUs = false; state.insertError = null; state.retryLookupFails = false;
  state.lookups = 0; state.writes = [];
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
  const response = await GET(new NextRequest(`http://localhost/api/oauth/google-calendar/callback?code=synthetic&state=${encodeURIComponent(signed)}`,
    { headers: { cookie: "ar_gcal_oauth_nonce=synthetic-nonce" } }));
  return response.headers.get("location") ?? "";
}

it("a first connect that loses the insert race replaces the winner's row instead of failing or duplicating", async () => {
  state.winnerInsertsBeforeUs = true;
  expect(await callback()).toContain("calendar=connected");
  expect(state.writes).toEqual(["insert", "update"]);
  expect(state.rows).toHaveLength(1);
  expect(state.rows[0].id).toBe("winner");
  // This consent's (encrypted) tokens replaced the winner's.
  expect(state.rows[0].access_token).not.toBe("winner-access");
  expect(state.rows[0].access_token).not.toBe("new-access");
});

it("an uncontested first connect still inserts exactly once", async () => {
  expect(await callback()).toContain("calendar=connected");
  expect(state.writes).toEqual(["insert"]);
  expect(state.rows.map(r => r.id)).toEqual(["ours"]);
});

it("treats only a unique violation as a lost race; any other insert error fails without a retry", async () => {
  state.insertError = { code: "23503", message: "synthetic foreign key failure" };
  expect(await callback()).toContain("calendar_error=exchange_failed");
  expect(state.writes).toEqual(["insert"]);
  expect(state.lookups).toBe(1);
});

it("fails closed when the winner's row cannot be read back after the conflict", async () => {
  state.winnerInsertsBeforeUs = true; state.retryLookupFails = true;
  expect(await callback()).toContain("calendar_error=exchange_failed");
  expect(state.writes).toEqual(["insert"]);
  expect(state.rows.map(r => r.access_token)).toEqual(["winner-access"]);
});
