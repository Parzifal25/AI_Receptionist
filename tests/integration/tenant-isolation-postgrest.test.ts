import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { PostgrestClient } from "@supabase/postgrest-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SupabaseAgentRepository } from "@halo/agents/agent-repository";
import { SupabaseCrmStore } from "@halo/crm/supabase-crm-store";
import { encryptCalendarCredential } from "@halo/platform/calendar-credentials";
import { resetEnvCacheForTests } from "@halo/platform/env";
import { SupabaseToolExecutionAuditStore } from "@halo/runtime/stores/supabase-tool-execution-audit-store";
import { SchedulingRepository } from "@halo/scheduling/scheduling-repository";
import { SupabaseWorkflowStore } from "@halo/workflows/supabase-workflow-store";
import { requireDisposableDatabase, requireDisposablePostgrest } from "../../scripts/disposable-database.mjs";

/**
 * Phase 2, Workstream 1 — tenant isolation at the HTTP API boundary.
 *
 * A real PostgREST (the server Supabase runs in front of Postgres) serves a
 * disposable database with every migration applied. Requests are made with
 * @supabase/postgrest-js, the query builder inside supabase-js:
 *   - as a signed-in tenant member, with a JWT exactly like the dashboard's,
 *     which is also what anyone holding a member session can send directly;
 *   - unauthenticated, and with forged or expired tokens;
 *   - as service_role through the PRODUCTION stores, which bypass RLS and
 *     must scope every query themselves.
 *
 * Opt-in: needs HALO_DISPOSABLE_DATABASE=1, HALO_DISPOSABLE_DB_URL (loopback
 * halo_check_<suffix>, migrations applied, e.g. right after check:rls),
 * HALO_DISPOSABLE_POSTGREST_URL (loopback PostgREST serving that database)
 * and HALO_DISPOSABLE_JWT_SECRET (that PostgREST's locally generated secret).
 * Seeds uniquely named tenants; never touches a shared or hosted target, and
 * asserts that no request left the loopback interface.
 */
const enabled = process.env.HALO_DISPOSABLE_DATABASE === "1"
  && Boolean(process.env.HALO_DISPOSABLE_DB_URL)
  && Boolean(process.env.HALO_DISPOSABLE_POSTGREST_URL);
const dbUrl = enabled ? requireDisposableDatabase(undefined, process.env) : "";
const rest = enabled ? requireDisposablePostgrest(process.env) : { url: "", jwtSecret: "" };

function psql(sql: string): string {
  return execFileSync("psql", [dbUrl, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--quiet"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const requested: URL[] = [];
const recordingFetch: typeof fetch = (input, init) => {
  requested.push(new URL(input instanceof Request ? input.url : String(input)));
  return fetch(input, init);
};

function sign(claims: Record<string, unknown>, secret = rest.jwtSecret): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

function client(token?: string, headers: Record<string, string> = {}): SupabaseClient {
  return new PostgrestClient(rest.url, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    fetch: recordingFetch,
  }) as unknown as SupabaseClient;
}

const tag = randomUUID().slice(0, 8);
const tenant = (t: "a" | "b") => ({
  t,
  biz: randomUUID(), owner: randomUUID(), receptionist: randomUUID(), agent: randomUUID(), version: randomUUID(),
  conversation: randomUUID(), lead: randomUUID(), staff1: randomUUID(), staff2: randomUUID(), appointment: randomUUID(),
  customer: randomUUID(), calendar: randomUUID(), workflow: randomUUID(), event: randomUUID(), run: randomUUID(),
  collection: randomUUID(),
  email: `p2-${t}-${tag}@example.test`, phone: `+1555${t === "a" ? "1" : "2"}${tag.replace(/\D/g, "0").slice(0, 6)}`,
  accessToken: `synthetic-access-${t}-${tag}`,
});
const A = tenant("a");
const B = tenant("b");
const memberA = randomUUID();
const KEY = "c".repeat(64);

// Each sweep makes several HTTP requests per tenant table (40+ tables).
describe.skipIf(!enabled)("tenant isolation over a real PostgREST (disposable)", { timeout: 120_000 }, () => {
  let tables: string[] = [];
  let asMemberA: SupabaseClient, asOwnerA: SupabaseClient, asService: SupabaseClient;

  beforeAll(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", rest.url);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
    vi.stubEnv("CALENDAR_CREDENTIALS_ENCRYPTION_KEY", KEY);
    resetEnvCacheForTests();
    const q = (v: string) => `'${v.replaceAll("'", "''")}'`;
    for (const x of [A, B]) {
      psql(`
        insert into auth.users (id, email) values (${q(x.owner)}, ${q(`owner-${x.t}-${tag}@example.test`)});
        insert into businesses (id, name, slug) values (${q(x.biz)}, ${q(`P2 HTTP ${x.t} ${tag}`)}, ${q(`p2-http-${x.t}-${tag}`)});
        insert into business_members (business_id, user_id, role) values (${q(x.biz)}, ${q(x.owner)}, 'owner');
        insert into receptionists (id, business_id, name, widget_key) values (${q(x.receptionist)}, ${q(x.biz)}, 'P2 receptionist', ${q(`p2-http-widget-${x.t}-${tag}`)});
        insert into agents (id, business_id, type, slug, display_name) values (${q(x.agent)}, ${q(x.biz)}, 'receptionist', ${q(x.receptionist)}, 'P2 agent');
        insert into agent_versions (id, agent_id, business_id, version, prompt_template, prompt_version, published_at)
          values (${q(x.version)}, ${q(x.agent)}, ${q(x.biz)}, 1, 'P2 template', 'p2', now());
        update agents set live_version_id = ${q(x.version)} where id = ${q(x.agent)};
        insert into conversations (id, business_id, receptionist_id, visitor_token, channel, agent_id, agent_version_id)
          values (${q(x.conversation)}, ${q(x.biz)}, ${q(x.receptionist)}, ${q(`p2-http-token-${x.t}-${tag}`)}, 'chat', ${q(x.agent)}, ${q(x.version)});
        insert into leads (id, business_id, conversation_id, name, phone) values (${q(x.lead)}, ${q(x.biz)}, ${q(x.conversation)}, 'P2 lead', ${q(x.phone)});
        insert into staff_members (id, business_id, name) values (${q(x.staff1)}, ${q(x.biz)}, 'P2 staff 1'), (${q(x.staff2)}, ${q(x.biz)}, 'P2 staff 2');
        insert into appointments (id, business_id, staff_id, conversation_id, service_name, visitor_name, starts_at, ends_at, status)
          values (${q(x.appointment)}, ${q(x.biz)}, ${q(x.staff1)}, ${q(x.conversation)}, 'P2 visit', 'P2 visitor', '2032-03-01T10:00Z', '2032-03-01T11:00Z', 'confirmed');
        insert into customers (id, business_id, name, email, phone) values (${q(x.customer)}, ${q(x.biz)}, 'P2 customer', ${q(x.email)}, ${q(x.phone)});
        insert into calendar_connections (id, business_id, staff_id, provider, calendar_ref, access_token, refresh_token)
          values (${q(x.calendar)}, ${q(x.biz)}, ${q(x.staff1)}, 'google', 'primary', ${q(encryptCalendarCredential(x.accessToken))}, ${q(encryptCalendarCredential(`synthetic-refresh-${x.t}`))});
        insert into workflows (id, business_id, name, trigger) values (${q(x.workflow)}, ${q(x.biz)}, ${q(`P2 workflow ${x.t}`)}, 'conversation.started');
        insert into workflow_events (id, business_id, type) values (${q(x.event)}, ${q(x.biz)}, 'conversation.started');
        insert into workflow_runs (id, workflow_id, business_id, event_id) values (${q(x.run)}, ${q(x.workflow)}, ${q(x.biz)}, ${q(x.event)});
        insert into workflow_run_logs (run_id, step_id, status) values (${q(x.run)}, 'p2-step', 'succeeded');
        insert into knowledge_collections (id, business_id, name) values (${q(x.collection)}, ${q(x.biz)}, 'P2 collection');`);
    }
    psql(`insert into auth.users (id, email) values ('${memberA}', 'member-a-${tag}@example.test');
          insert into business_members (business_id, user_id, role) values ('${A.biz}', '${memberA}', 'member');`);
    tables = psql(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped)
      order by 1;`).split("\n").filter(Boolean);
    asMemberA = client(sign({ sub: memberA, role: "authenticated" }));
    asOwnerA = client(sign({ sub: A.owner, role: "authenticated" }));
    asService = client(sign({ role: "service_role" }));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
  });

  const bRowCount = () => Number(psql(`select sum(c) from (${tables.map((t) => `select count(*) c from public.${t} where business_id = '${B.biz}'`).join(" union all ")}) s;`));

  it("a tenant member reads only its own tenant in every tenant table", async () => {
    expect(tables.length).toBeGreaterThan(40);
    const leaks: string[] = [];
    for (const table of tables) {
      const { data, error } = await asMemberA.from(table).select("business_id");
      if (error) {
        if (error.code !== "42501") leaks.push(`${table}: unexpected error ${error.code}`);
        continue;
      }
      const foreign = (data as Array<{ business_id: string }>).filter((row) => row.business_id !== A.biz);
      if (foreign.length > 0) leaks.push(`${table}: ${foreign.length} foreign row(s)`);
    }
    expect(leaks).toEqual([]);
    const { data: own } = await asMemberA.from("appointments").select("id");
    expect(own).toEqual([{ id: A.appointment }]);
  });

  it("filters, exact counts and OR-widening never reach the other tenant", async () => {
    const leaks: string[] = [];
    for (const table of tables) {
      const byB = await asMemberA.from(table).select("business_id").eq("business_id", B.biz);
      if (!byB.error && (byB.data as unknown[]).length > 0) leaks.push(`${table}: filter by B returned rows`);
      const counted = await asMemberA.from(table).select("*", { count: "exact", head: true }).eq("business_id", B.biz);
      if (!counted.error && counted.count !== 0) leaks.push(`${table}: exact count of B = ${counted.count}`);
      const widened = await asMemberA.from(table).select("business_id").or(`business_id.eq.${A.biz},business_id.eq.${B.biz}`);
      if (!widened.error && (widened.data as Array<{ business_id: string }>).some((row) => row.business_id !== A.biz)) leaks.push(`${table}: OR filter widened to B`);
    }
    expect(leaks).toEqual([]);
  });

  it("updates and deletes aimed at the other tenant change nothing", async () => {
    const before = bRowCount();
    const changed: string[] = [];
    for (const table of tables) {
      for (const as of [asMemberA, asOwnerA]) {
        const updated = await as.from(table).update({ business_id: A.biz }).eq("business_id", B.biz).select("business_id");
        if (!updated.error && (updated.data as unknown[]).length > 0) changed.push(`${table}: update moved B rows`);
        const deleted = await as.from(table).delete().eq("business_id", B.biz).select("business_id");
        if (!deleted.error && (deleted.data as unknown[]).length > 0) changed.push(`${table}: delete removed B rows`);
      }
    }
    expect(changed).toEqual([]);
    expect(bRowCount()).toBe(before);
  });

  it("a row claiming the other tenant is refused on insert, by RLS or by grant", async () => {
    const accepted: string[] = [];
    for (const table of tables) {
      const columns = psql(`select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
        where a.attrelid = 'public.${table}'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
          and not (a.attname = 'id' and a.atthasdef);`).split(",");
      const json = psql(`select row_to_json(t)::text from public.${table} t where business_id = '${B.biz}' limit 1;`)
        || psql(`select row_to_json(t)::text from public.${table} t limit 1;`);
      if (!json) continue;
      const source = JSON.parse(json) as Record<string, unknown>;
      const row = Object.fromEntries(columns.map((c) => [c, source[c]]));
      row.business_id = B.biz;
      const { error } = await asOwnerA.from(table).insert(row);
      // 42501: RLS or no grant. 23514: the 0034 reference check. P0001: an
      // older dedicated ownership guard (a copied row's parents are foreign).
      const refused = error && (["42501", "23514"].includes(error.code)
        || (error.code === "P0001" && /must reference (a|an) .*(same business|same agent)/.test(error.message)));
      if (!refused) accepted.push(`${table}: ${error ? `${error.code} ${error.message}` : "inserted"}`);
    }
    expect(accepted).toEqual([]);
  });

  it("the cross-tenant references closed by 0034 are refused over HTTP, with no existence oracle", async () => {
    const foreign = await asMemberA.from("appointments").update({ staff_id: B.staff1 }).eq("id", A.appointment).select("id");
    expect(foreign.error?.code).toBe("23514");
    expect(foreign.error?.message).toBe("appointments.staff_id must reference a row of staff_members in the same business");
    const unknown = await asMemberA.from("appointments").update({ staff_id: randomUUID() }).eq("id", A.appointment).select("id");
    // Another tenant's real staff member and a random id are indistinguishable.
    expect(unknown.error?.message).toBe(foreign.error?.message);

    const lead = await asMemberA.from("leads").update({ conversation_id: B.conversation }).eq("id", A.lead).select("id");
    expect(lead.error?.code).toBe("23514");
    const squat = await asOwnerA.from("agent_versions").insert({ agent_id: B.agent, business_id: A.biz, version: 77, prompt_template: "squat", prompt_version: "p2" });
    expect(squat.error?.code).toBe("23514");
    expect(psql(`select count(*) from agent_versions where agent_id = '${B.agent}';`)).toBe("1");

    const moved = await asMemberA.from("appointments").update({ staff_id: A.staff2 }).eq("id", A.appointment).select("staff_id");
    expect(moved.error).toBeNull();
    expect(moved.data).toEqual([{ staff_id: A.staff2 }]);
  });

  it("tenant identity is taken from the JWT, never from headers, schema switches or RPC arguments", async () => {
    const spoofed = client(sign({ sub: memberA, role: "authenticated" }), { "x-business-id": B.biz, "x-tenant-id": B.biz });
    const { data: leads } = await spoofed.from("leads").select("business_id");
    expect((leads as Array<{ business_id: string }>).every((row) => row.business_id === A.biz)).toBe(true);

    const authSchema = await (asMemberA as unknown as PostgrestClient).schema("auth").from("users").select("id");
    expect(authSchema.error).not.toBeNull();
    expect(authSchema.data).toBeNull();

    expect((await asMemberA.rpc("is_business_member", { target_business_id: A.biz })).data).toBe(true);
    expect((await asMemberA.rpc("is_business_member", { target_business_id: B.biz })).data).toBe(false);
    const forged = await asOwnerA.rpc("knowledge_create_document_revision", {
      p_business_id: B.biz, p_document_id: null, p_title: "Forged", p_content: "forged", p_source_type: "manual", p_source_ref: "", p_collection_id: null,
    });
    expect(forged.error).not.toBeNull();
    for (const [fn, args] of [
      ["search_governed_knowledge", { target_business_id: B.biz, query: "x", allowed_collection_ids: [], match_limit: 5 }],
      ["tenant_reference_census", {}],
      ["purge_expired_data", {}],
      ["claim_due_workflow_runs", { batch_size: 1 }],
    ] as const) {
      const { error } = await asOwnerA.rpc(fn, args);
      expect(error?.code, fn).toBe("42501");
    }
  });

  it("unauthenticated, forged, expired and member-less identities get nothing", async () => {
    const anonymous = client();
    const forged = client(sign({ role: "service_role" }, "synthetic-wrong-secret-synthetic-wrong-secret"));
    const expired = client(sign({ sub: A.owner, role: "authenticated", exp: Math.floor(Date.now() / 1000) - 60 }));
    const stranger = client(sign({ sub: randomUUID(), role: "authenticated" }));
    const leaks: string[] = [];
    for (const table of tables) {
      const open = await anonymous.from(table).select("business_id");
      if (!open.error && (open.data as unknown[]).length > 0) leaks.push(`${table}: anonymous read rows`);
      const nobody = await stranger.from(table).select("business_id");
      if (!nobody.error && (nobody.data as unknown[]).length > 0) leaks.push(`${table}: non-member read rows`);
    }
    expect(leaks).toEqual([]);
    for (const bad of [forged, expired]) {
      const { error, status } = await bad.from("leads").select("id") as unknown as { error: { code: string } | null; status: number };
      expect(status).toBe(401);
      expect(error).not.toBeNull();
    }
  });

  it("production service-role stores scope every query to the trusted tenant", async () => {
    const agents = new SupabaseAgentRepository(asService);
    expect(await agents.getAgent(A.agent, A.biz)).not.toBeNull();
    expect(await agents.getAgent(B.agent, A.biz)).toBeNull();
    expect(await agents.getVersion(B.version, A.biz)).toBeNull();

    const workflows = new SupabaseWorkflowStore(asService);
    expect((await workflows.listWorkflows(A.biz)).every((w) => w.businessId === A.biz)).toBe(true);
    expect((await workflows.listRuns(A.biz, { limit: 200 })).map((r) => r.id)).not.toContain(B.run);
    expect(await workflows.listRunLogs(A.biz, B.run)).toEqual([]);
    expect(await workflows.listRunLogs(B.biz, B.run)).toHaveLength(1);
    await workflows.updateWorkflow(B.workflow, A.biz, { name: "Hijacked" }, 1).catch(() => undefined);
    await workflows.deleteWorkflow(B.workflow, A.biz).catch(() => undefined);
    expect(psql(`select name from workflows where id = '${B.workflow}';`)).toBe("P2 workflow b");

    const crm = new SupabaseCrmStore(asService);
    expect(await crm.findByEmail(A.biz, B.email)).toBeNull();
    expect(await crm.findByPhone(A.biz, B.phone)).toBeNull();
    expect((await crm.findByEmail(B.biz, B.email))?.id).toBe(B.customer);

    const scheduling = new SchedulingRepository(asService);
    const window = await scheduling.listAppointments(A.biz, "2032-01-01T00:00Z", "2033-01-01T00:00Z");
    expect(window.map((a) => a.id)).toEqual([A.appointment]);
    expect((await scheduling.listActiveStaff(A.biz)).every((s) => s.businessId === A.biz)).toBe(true);
  });

  it("calendar credentials resolve only within the trusted tenant, even with a crafted staff id", async () => {
    const scheduling = new SchedulingRepository(asService);
    expect((await scheduling.getCalendarConnection(A.biz, A.staff1))?.oauth?.accessToken).toBe(A.accessToken);
    expect(await scheduling.getCalendarConnection(A.biz, B.staff1)).toBeNull();
    // getCalendarConnection interpolates the staff id into a PostgREST or()
    // filter; the tenant equality is a separate filter that cannot be removed.
    for (const crafted of [`${B.staff1},business_id.eq.${B.biz}`, `${B.staff1}),or(business_id.eq.${B.biz}`, `${B.staff1},staff_id.not.is.null`]) {
      const result = await scheduling.getCalendarConnection(A.biz, crafted);
      expect(result?.oauth?.accessToken).not.toBe(B.accessToken);
    }
    const { data } = await asOwnerA.from("calendar_connections").select("access_token");
    expect(data).toEqual([]);
  });

  it("the tool-execution audit store cannot record against another tenant's conversation", async () => {
    const store = new SupabaseToolExecutionAuditStore(asService);
    const entry = {
      businessId: A.biz, conversationId: A.conversation, agentId: A.agent, agentVersionId: A.version, channelId: "web-chat",
      turnId: `p2-turn-${tag}`, correlationId: null, round: 0, intentId: `p2-intent-${tag}`, toolName: "save_contact_details",
      idempotencyKey: "d".repeat(32), sideEffecting: true, requestedAt: new Date().toISOString(),
    };
    const ref = await store.recordStarted(entry, new Date().toISOString());
    await expect(store.recordStarted({ ...entry, conversationId: B.conversation, intentId: `p2-x-${tag}` }, new Date().toISOString()))
      .rejects.toThrow(/audit insert failed/);
    await expect(store.recordRejected({ ...entry, agentId: B.agent, intentId: `p2-y-${tag}`, toolName: null, idempotencyKey: null, sideEffecting: null }, "unknown_tool", new Date().toISOString()))
      .rejects.toThrow(/audit insert failed/);
    await expect(store.recordFinished({ id: ref.id, businessId: B.biz }, { status: "succeeded", errorCode: null, finishedAt: new Date().toISOString() }))
      .rejects.toThrow(/matched no started record/);
    await store.recordFinished(ref, { status: "succeeded", errorCode: null, finishedAt: new Date().toISOString() });
    expect(psql(`select status from tool_executions where id = '${ref.id}';`)).toBe("succeeded");
  });

  it("every request stayed on the loopback interface (no provider or hosted call)", () => {
    expect(requested.length).toBeGreaterThan(100);
    expect(new Set(requested.map((u) => u.host))).toEqual(new Set([new URL(rest.url).host]));
  });
});
