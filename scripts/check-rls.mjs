#!/usr/bin/env node
/**
 * Real-role RLS verification (HALO Phase 1.5, workstream 3).
 *
 * Applies the Supabase stubs + full migration set to a throwaway Postgres,
 * seeds two tenants, then verifies tenant isolation AS THE REAL DATABASE
 * ROLES — `authenticated` with a JWT-claim GUC (never as the table owner or
 * superuser, whose RLS bypass would prove nothing) plus `service_role`.
 *
 * Usage:
 *   node scripts/check-rls.mjs <postgres-url>
 *
 * DESTRUCTIVE: the target database's public/auth/storage schemas are dropped
 * and rebuilt, so it must be a throwaway (the CI Postgres service, or a
 * local `docker run pgvector/pgvector:pg16`). Both harnesses require
 * HALO_DISPOSABLE_DATABASE=1 and an explicit loopback URL naming
 * halo_check_<suffix> (argument or HALO_DISPOSABLE_DB_URL). Supabase CLI
 * ports are always rejected; there is no shared-database override.
 *
 * Requires `psql` on PATH. Exits non-zero on the first failed assertion.
 */
import { requireDisposableDatabase } from "./disposable-database.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const stubsFile = path.join(root, "infrastructure", "ci", "supabase-stubs.sql");

// These destructive harnesses must never infer a target from developer env.
const databaseUrl = requireDisposableDatabase(process.argv[2], process.env);

const psql = (sql, capture = false) =>
  execFileSync(
    "psql",
    [databaseUrl, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", ...(capture ? ["--tuples-only", "--no-align"] : []), "--quiet"],
    { input: sql, encoding: "utf8" },
  );

/** Wraps SQL to run as the `authenticated` role with a JWT sub claim (a real request context). */
const asUser = (uid, sql) =>
  `begin;\ndo $$ begin perform set_config('request.jwt.claim.sub', '${uid}', true); end $$;\nset local role authenticated;\n${sql}\ncommit;`;

/** Anonymous `authenticated` session — no JWT, exactly like an unauthenticated PostgREST request. */
const asAnon = (sql) => `begin; set local role authenticated;\n${sql}\ncommit;`;

/** Wraps SQL to run as the `service_role` role (bypassrls, the Regime B client). */
const asService = (sql) => `begin; set local role service_role;\n${sql}\ncommit;`;

let failures = 0;
const ok = (label, detail = "") => console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`);
const fail = (label, detail = "") => {
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  failures += 1;
};

function expectCount(sql, expected, label) {
  const actual = psql(sql, true).trim();
  if (actual === String(expected)) ok(`${label} = ${expected}`);
  else fail(label, `expected ${expected}, got ${actual}`);
}

function expectError(sql, label) {
  try {
    psql(sql);
    fail(label, "unexpectedly succeeded");
  } catch {
    ok(`${label} (rejected)`);
  }
}

// ---------------------------------------------------------------------------
// 1. Fresh schema: stubs + every migration, in order (same as check:migrations).
// ---------------------------------------------------------------------------
console.log("check-rls — verifying RLS as real roles on the explicitly selected disposable database");
// Idempotent on a reused database (CI runs check:migrations on the same
// service first): reset the application schemas, then rebuild from scratch.
// Extensions live in `public` and are re-created by 0001_init.sql.
psql(`
drop schema if exists public cascade;
drop schema if exists auth cascade;
drop schema if exists storage cascade;
create schema public;
grant all on schema public to public;
`);
psql(readFileSync(stubsFile, "utf8"));
for (const file of [...((await import("node:fs")).readdirSync(migrationsDir))].filter((f) => f.endsWith(".sql")).sort()) {
  psql(readFileSync(path.join(migrationsDir, file), "utf8"));
}
ok("stubs + all migrations applied");

// ---------------------------------------------------------------------------
// 2. Seed two tenants with no overlapping membership.
// ---------------------------------------------------------------------------
const uA = "11111111-1111-1111-1111-111111111111";
const uB = "11111111-1111-1111-1111-111111111112";
const uC = "11111111-1111-1111-1111-111111111113"; // member (not admin) of tenant A
const bizA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const bizB = "aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbbbbbb";
const rA = "bbbbbbbb-bbbb-bbbb-bbbb-aaaaaaaaaaaa";
const rB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

psql(`
insert into auth.users (id, email) values ('${uA}', 'a@test'), ('${uB}', 'b@test'), ('${uC}', 'c@test');
insert into businesses (id, name, slug) values ('${bizA}', 'Tenant A', 'tenant-a'), ('${bizB}', 'Tenant B', 'tenant-b');
insert into business_members (business_id, user_id, role) values
  ('${bizA}', '${uA}', 'owner'), ('${bizB}', '${uB}', 'owner'), ('${bizA}', '${uC}', 'member');
insert into receptionists (id, business_id, name, greeting, tone, language, custom_instructions, widget_key, is_active) values
  ('${rA}', '${bizA}', 'Riley', 'Hi', 'friendly', 'en', '', 'rls-widget-key-a-0001', true),
  ('${rB}', '${bizB}', 'Rex', 'Hi', 'friendly', 'en', '', 'rls-widget-key-b-0001', true);
`);

// Agent backfill (0014) — exactly what production runs for legacy tenants.
psql(readFileSync(path.join(migrationsDir, "0014_agent_backfill.sql"), "utf8"));
ok("0014 agent backfill applied");

psql(`
insert into conversations (business_id, receptionist_id, visitor_token, channel, agent_id, agent_version_id)
select '${bizA}', '${rA}', 'rls-token-a', 'chat', a.id, a.live_version_id from agents a where a.business_id = '${bizA}' limit 1;
insert into conversations (business_id, receptionist_id, visitor_token, channel, agent_id, agent_version_id)
select '${bizB}', '${rB}', 'rls-token-b', 'chat', a.id, a.live_version_id from agents a where a.business_id = '${bizB}' limit 1;
insert into leads (business_id, conversation_id, name, phone) values ('${bizA}', (select id from conversations where visitor_token = 'rls-token-a'), 'Lead A', '+15550000001');
insert into leads (business_id, conversation_id, name, phone) values ('${bizB}', (select id from conversations where visitor_token = 'rls-token-b'), 'Lead B', '+15550000002');
`);
ok("two tenants seeded (conversations, leads, agents, versions)");

// ---------------------------------------------------------------------------
// 3. Cross-tenant isolation as the real `authenticated` role.
// ---------------------------------------------------------------------------
expectCount(
  asAnon(`select count(*) from leads;`),
  0,
  "authenticated without JWT => auth.uid() null => zero rows (fail closed)",
);
expectCount(asUser(uA, `select count(*) from leads where business_id = '${bizA}';`), 1, "member A reads own leads");
expectCount(asUser(uA, `select count(*) from conversations where business_id = '${bizB}';`), 0, "member A cannot read tenant B conversations");
expectCount(asUser(uB, `select count(*) from leads where business_id = '${bizA}';`), 0, "member B cannot read tenant A leads");
expectCount(asUser(uA, `select count(*) from agents where business_id = '${bizB}';`), 0, "member A cannot read tenant B agents");
expectCount(asUser(uA, `select count(*) from agent_versions av join agents a on a.id = av.agent_id where a.business_id = '${bizB}';`), 0, "member A cannot read tenant B agent versions");
expectCount(asUser(uA, `select count(*) from leads where id = gen_random_uuid();`), 0, "forged lead id selects nothing (scoped read)");

// HALO Phase 2 — conversation_state (0019): members read only their tenant's state; service role writes.
psql(asService(`
insert into conversation_state (conversation_id, business_id, state)
select id, business_id, '{"version":1}'::jsonb from conversations where visitor_token in ('rls-token-a', 'rls-token-b');
`));
expectCount(asUser(uA, `select count(*) from conversation_state where business_id = '${bizA}';`), 1, "member A reads own conversation state");
expectCount(asUser(uA, `select count(*) from conversation_state where business_id = '${bizB}';`), 0, "member A cannot read tenant B conversation state");
expectCount(asAnon(`select count(*) from conversation_state;`), 0, "anonymous reads no conversation state");
expectError(asUser(uA, `insert into conversation_state (conversation_id, business_id, state) select id, business_id, '{}'::jsonb from conversations where visitor_token = 'rls-token-a';`), "member cannot write conversation state (service role only)");

// ---------------------------------------------------------------------------
// HALO Phase 3 — voice tables (0020): isolation, service-role-only writes,
// ownership triggers, call state graph, idempotency constraints.
// ---------------------------------------------------------------------------
const agentOf = (biz) => `(select id from agents where business_id = '${biz}' order by created_at limit 1)`;
const versionOf = (biz) => `(select live_version_id from agents where business_id = '${biz}' order by created_at limit 1)`;
psql(asService(`
insert into phone_numbers (business_id, agent_id, provider, e164, handoff_number) values
  ('${bizA}', ${agentOf(bizA)}, 'fake', '+914000000001', '+914000000099'),
  ('${bizB}', ${agentOf(bizB)}, 'fake', '+914000000002', null);
insert into conversations (business_id, channel, agent_id, agent_version_id, visitor_token)
  values ('${bizA}', 'phone', ${agentOf(bizA)}, ${versionOf(bizA)}, 'rls-phone-a'),
         ('${bizB}', 'phone', ${agentOf(bizB)}, ${versionOf(bizB)}, 'rls-phone-b');
insert into calls (business_id, agent_id, agent_version_id, conversation_id, phone_number_id, direction, provider, provider_call_id, from_number, to_number, state)
  values
  ('${bizA}', ${agentOf(bizA)}, ${versionOf(bizA)}, (select id from conversations where visitor_token = 'rls-phone-a'), (select id from phone_numbers where e164 = '+914000000001'), 'inbound', 'fake', 'CA-A', '+919800000001', '+914000000001', 'ringing'),
  ('${bizB}', ${agentOf(bizB)}, ${versionOf(bizB)}, (select id from conversations where visitor_token = 'rls-phone-b'), (select id from phone_numbers where e164 = '+914000000002'), 'inbound', 'fake', 'CA-B', '+919800000002', '+914000000002', 'ringing');
insert into call_events (call_id, business_id, seq, type, at, latency_ms)
  select id, business_id, 0, 'session_started', now(), null from calls;
insert into call_transcript_turns (call_id, business_id, seq, turn_index, speaker, source, text, delivery, started_at, ended_at)
  select id, business_id, 0, 0, 'caller', 'caller', 'hello', 'complete', now(), now() from calls;
insert into conversation_outcomes (business_id, call_id, conversation_id, agent_id, agent_version_id, disposition)
  select business_id, id, conversation_id, agent_id, agent_version_id, 'no_outcome' from calls;
insert into phone_suppressions (business_id, e164, reason, call_id)
  select business_id, from_number, 'do_not_call', id from calls;
`));
ok("voice rows seeded for both tenants (service role)");
for (const table of ["phone_numbers", "calls", "call_events", "call_transcript_turns", "conversation_outcomes", "phone_suppressions"]) {
  expectCount(asUser(uA, `select count(*) from ${table} where business_id = '${bizA}';`), 1, `member A reads own ${table}`);
  expectCount(asUser(uA, `select count(*) from ${table} where business_id = '${bizB}';`), 0, `member A cannot read tenant B ${table}`);
  expectCount(asAnon(`select count(*) from ${table};`), 0, `anonymous reads no ${table}`);
}
expectError(
  asUser(uA, `insert into phone_numbers (business_id, agent_id, provider, e164) values ('${bizA}', ${agentOf(bizA)}, 'fake', '+914000000010');`),
  "tenant admin cannot provision phone numbers (service role only)",
);
expectError(
  asUser(uA, `insert into calls (business_id, agent_id, agent_version_id, direction, provider, provider_call_id, state) values ('${bizA}', ${agentOf(bizA)}, ${versionOf(bizA)}, 'inbound', 'fake', 'CA-X', 'ringing');`),
  "member cannot write calls (service role only)",
);
expectCount(
  asUser(uA, `with u as (update calls set state = 'connected' where business_id = '${bizA}' returning 1) select count(*) from u;`),
  0,
  "member cannot update calls (no update policy)",
);
expectError(
  asService(`insert into calls (business_id, agent_id, agent_version_id, direction, provider, provider_call_id, state) values ('${bizA}', ${agentOf(bizB)}, ${versionOf(bizB)}, 'inbound', 'fake', 'CA-CROSS', 'ringing');`),
  "service_role cannot create a tenant A call served by tenant B's agent (ownership trigger)",
);
expectError(
  asService(`insert into call_events (call_id, business_id, seq, type, at) select id, '${bizB}', 5, 'dtmf', now() from calls where provider_call_id = 'CA-A';`),
  "service_role cannot attach a call event to another tenant's call",
);
expectError(
  asService(`insert into calls (business_id, agent_id, agent_version_id, direction, provider, provider_call_id, state) values ('${bizA}', ${agentOf(bizA)}, ${versionOf(bizA)}, 'inbound', 'fake', 'CA-A', 'ringing');`),
  "duplicate provider call id rejected (idempotent start)",
);
expectError(
  asService(`insert into call_events (call_id, business_id, seq, type, at) select id, business_id, 0, 'dtmf', now() from calls where provider_call_id = 'CA-A';`),
  "duplicate call event seq rejected (idempotent flush)",
);
expectError(
  asService(`insert into phone_numbers (business_id, agent_id, provider, e164) values ('${bizB}', ${agentOf(bizB)}, 'fake', '+914000000001');`),
  "a DID cannot route to two tenants",
);
expectError(
  asService(`update calls set state = 'completed' where provider_call_id = 'CA-A';`),
  "illegal call transition ringing -> completed rejected (trigger)",
);
psql(asService(`update calls set state = 'connected' where provider_call_id = 'CA-A'; update calls set state = 'in_conversation' where provider_call_id = 'CA-A'; update calls set state = 'completing' where provider_call_id = 'CA-A'; update calls set state = 'completed' where provider_call_id = 'CA-A';`));
ok("legal call path ringing -> connected -> in_conversation -> completing -> completed applied");
expectError(
  asService(`update calls set state = 'in_conversation' where provider_call_id = 'CA-A';`),
  "terminal call state cannot be resurrected, even by service_role",
);
expectError(
  asService(`insert into conversation_outcomes (business_id, call_id, agent_id, agent_version_id, disposition) select business_id, id, agent_id, agent_version_id, 'qualified' from calls where provider_call_id = 'CA-A';`),
  "one outcome per call",
);
expectError(
  asService(`insert into conversations (business_id, channel) values ('${bizA}', 'chat');`),
  "a widget conversation still requires a receptionist",
);
expectError(
  asService(`insert into conversations (business_id, receptionist_id, visitor_token, channel, agent_id, agent_version_id)
    values ('${bizA}', '${rA}', 'rls-null-agent-link', 'chat', null, null);`),
  "service role cannot create a conversation without its required agent/version tuple",
);
expectError(
  asService(`delete from agent_versions where id = ${versionOf(bizA)};`),
  "service role cannot delete an immutable agent version or null historical conversation links",
);
expectError(
  asService(`delete from agents where id = ${agentOf(bizA)};`),
  "service role cannot cascade-delete immutable agent versions or null conversation links",
);
expectCount(
  asService(`select count(*) from conversations where visitor_token = 'rls-token-a' and agent_id = ${agentOf(bizA)} and agent_version_id = ${versionOf(bizA)};`),
  1,
  "failed identity deletion leaves the persisted conversation tuple unchanged",
);

// Cross-tenant writes: inserts violate WITH CHECK (throw); UPDATE/DELETE
// against invisible rows are denied by filtering (0 rows mutated).
expectError(
  asUser(uA, `insert into leads (business_id, name) values ('${bizB}', 'injected');`),
  "member A cannot insert a lead into tenant B",
);
expectError(
  asUser(uA, `insert into conversations (business_id, receptionist_id) values ('${bizB}', '${rB}');`),
  "member A cannot insert a conversation into tenant B",
);
expectCount(
  asUser(uA, `with u as (update leads set name = 'hijacked' where business_id = '${bizB}' returning 1) select count(*) from u;`),
  0,
  "member A cannot update tenant B leads",
);
expectCount(
  asUser(uA, `with d as (delete from leads where business_id = '${bizB}' returning 1) select count(*) from d;`),
  0,
  "member A cannot delete tenant B leads",
);

// ---------------------------------------------------------------------------
// D7 — tool_executions (0032): members read only their tenant's audit rows;
// only the service role writes; ownership trigger; one-way lifecycle;
// one execution per action per turn.
// ---------------------------------------------------------------------------
const auditConv = (biz) => `(select id from conversations where business_id = '${biz}' and visitor_token like 'rls-token-%' limit 1)`;
const auditAgent = (biz) => `(select agent_id from conversations where business_id = '${biz}' and visitor_token like 'rls-token-%' limit 1)`;
const auditVersion = (biz) => `(select agent_version_id from conversations where business_id = '${biz}' and visitor_token like 'rls-token-%' limit 1)`;
const auditRow = (biz, intent, status) => status === "started"
  ? `insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, started_at)
  values ('${biz}', ${auditConv(biz)}, ${auditAgent(biz)}, ${auditVersion(biz)}, 'web-chat', 'rls-turn', 0, '${intent}', 'save_contact_details', '${"a".repeat(32)}', true, 'started', now(), now());`
  : `insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, rejection_reason, finished_at)
  values ('${biz}', ${auditConv(biz)}, ${auditAgent(biz)}, ${auditVersion(biz)}, 'web-chat', 'rls-turn', 0, '${intent}', 'save_contact_details', '${"a".repeat(32)}', true, 'rejected', now(), 'not_granted', now());`;
psql(asService(`${auditRow(bizA, "rls-a-1", "started")}\n${auditRow(bizB, "rls-b-1", "started")}`));
ok("tool_executions rows seeded for both tenants (service role)");
expectCount(asUser(uA, `select count(*) from tool_executions where business_id = '${bizA}';`), 1, "member A reads own tool_executions");
expectCount(asUser(uA, `select count(*) from tool_executions where business_id = '${bizB}';`), 0, "member A cannot read tenant B tool_executions");
expectCount(asAnon(`select count(*) from tool_executions;`), 0, "anonymous reads no tool_executions");
expectError(asUser(uA, auditRow(bizA, "rls-a-member", "rejected")), "member cannot write tool_executions (service role only)");
// Clients hold SELECT only, so a member UPDATE/DELETE is refused by the grant
// itself (permission denied), before RLS is even consulted.
expectError(
  asUser(uA, `update tool_executions set status = 'failed', finished_at = now() where business_id = '${bizA}';`),
  "member cannot update tool_executions (no client UPDATE grant)",
);
expectError(asUser(uA, `delete from tool_executions where business_id = '${bizA}';`), "member cannot delete tool_executions (no client DELETE grant)");
expectError(`begin; set local role anon; select count(*) from tool_executions; commit;`, "real anon role has no tool_executions access");
expectCount(
  `select count(*) from (values ('anon','select'),('anon','insert'),('authenticated','insert'),('authenticated','update'),('authenticated','delete'),('authenticated','truncate'),('authenticated','references'),('authenticated','trigger')) p(r, priv)
   where has_table_privilege(p.r, 'public.tool_executions', p.priv);`,
  0,
  "no client role holds any tool_executions privilege beyond SELECT",
);
expectCount(
  `select count(*) from (values ('anon'),('authenticated')) r(name), (values ('public.assert_tool_execution_ownership()'),('public.enforce_tool_execution_lifecycle()')) f(sig)
   where has_function_privilege(r.name, f.sig, 'execute');`,
  0,
  "clients cannot execute the tool_executions trigger functions",
);
expectCount(
  `select count(*) from pg_policies where schemaname = 'public' and tablename = 'tool_executions' and (cmd <> 'SELECT' or roles <> '{authenticated}');`,
  0,
  "tool_executions has only the authenticated SELECT policy",
);
expectCount(
  `select string_agg(column_name, ',' order by column_name) = 'agent_id,agent_version_id,business_id,channel,conversation_id,correlation_id,created_at,error_code,finished_at,id,idempotency_key,intent_id,rejection_reason,requested_at,round,side_effecting,started_at,status,tool_name,turn_id'
   from information_schema.columns where table_schema = 'public' and table_name = 'tool_executions';`,
  "t",
  "tool_executions has exactly the accountability columns (no payload, message or contact column)",
);
expectError(
  asService(`insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, rejection_reason, finished_at)
    values ('${bizA}', ${auditConv(bizB)}, ${auditAgent(bizA)}, ${auditVersion(bizA)}, 'web-chat', 'rls-turn-x', 0, 'rls-cross', null, null, null, 'rejected', now(), 'unknown_tool', now());`),
  "service_role cannot audit tenant A against tenant B's conversation (ownership trigger)",
);
expectError(
  asService(`insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, rejection_reason, finished_at)
    values ('${bizA}', ${auditConv(bizA)}, ${agentOf(bizB)}, ${auditVersion(bizA)}, 'web-chat', 'rls-turn-x', 0, 'rls-cross-agent', null, null, null, 'rejected', now(), 'unknown_tool', now());`),
  "service_role cannot audit tenant A against tenant B's agent (ownership trigger)",
);
expectError(
  asService(`insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, rejection_reason, finished_at)
    values ('${bizA}', ${auditConv(bizA)}, ${auditAgent(bizA)}, ${versionOf(bizB)}, 'web-chat', 'rls-turn-x', 0, 'rls-cross-version', null, null, null, 'rejected', now(), 'unknown_tool', now());`),
  "service_role cannot audit tenant A against tenant B's agent version (ownership trigger)",
);
expectError(
  asService(`insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, rejection_reason, finished_at)
    values ('${bizB}', ${auditConv(bizA)}, ${auditAgent(bizA)}, ${auditVersion(bizA)}, 'web-chat', 'rls-turn-x', 0, 'rls-relabel', null, null, null, 'rejected', now(), 'unknown_tool', now());`),
  "service_role cannot relabel tenant A's conversation as tenant B's audit row",
);
expectError(asService(auditRow(bizA, "rls-a-dup", "started")), "second execution for the same action and turn rejected (unique)");
expectCount(
  asService(`with i as (${auditRow(bizA, "rls-a-dup-rejected", "rejected").replace(/;\s*$/, "")} returning 1) select count(*) from i;`),
  1,
  "a duplicate intent is still recorded as a rejected row (unique index ignores rejections)",
);
for (const reason of ["unknown_tool", "not_granted", "channel_disallowed", "invalid_arguments", "duplicate", "confirmation_required", "precondition_failed", "budget_exhausted", "not_bound"]) {
  psql(asService(`insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, rejection_reason, finished_at)
    values ('${bizA}', ${auditConv(bizA)}, ${auditAgent(bizA)}, ${auditVersion(bizA)}, 'web-chat', 'rls-reasons', 0, 'rls-reason-${reason}', null, null, null, 'rejected', now(), '${reason}', now());`));
}
ok("every runtime ToolRejectionReason is accepted by the database");
expectError(
  asService(`insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, rejection_reason, finished_at)
    values ('${bizA}', ${auditConv(bizA)}, ${auditAgent(bizA)}, ${auditVersion(bizA)}, 'web-chat', 'rls-reasons', 0, 'rls-reason-bogus', null, null, null, 'rejected', now(), 'made_up', now());`),
  "an unknown rejection reason is refused",
);
expectError(
  asService(`insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, started_at)
    values ('${bizA}', ${auditConv(bizA)}, ${auditAgent(bizA)}, ${auditVersion(bizA)}, 'web-chat', 'rls-turn-3', 0, 'rls-no-key', 'save_contact_details', null, true, 'started', now(), now());`),
  "a started row needs an idempotency key (lifecycle check)",
);
expectError(
  asService(`insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, rejection_reason, finished_at)
    values ('${bizA}', ${auditConv(bizA)}, ${auditAgent(bizA)}, ${auditVersion(bizA)}, 'web-chat', 'rls-turn-3', 0, 'rls-bad-name', 'Save Contact; drop', null, null, 'rejected', now(), 'unknown_tool', now());`),
  "a tool name that is not an identifier is refused",
);
expectError(
  asService(`insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, started_at, finished_at)
    values ('${bizA}', ${auditConv(bizA)}, ${auditAgent(bizA)}, ${auditVersion(bizA)}, 'web-chat', 'rls-turn-2', 0, 'rls-direct', 'save_contact_details', '${"b".repeat(32)}', true, 'succeeded', now(), now(), now());`),
  "rows cannot be inserted already final (lifecycle trigger)",
);
expectCount(
  asService(`with u as (update tool_executions set status = 'succeeded', finished_at = now() where intent_id = 'rls-a-1' returning 1) select count(*) from u;`),
  1,
  "service_role finalizes a started row once",
);
expectError(
  asService(`update tool_executions set status = 'failed', error_code = 'X' where intent_id = 'rls-a-1';`),
  "final tool_executions rows are immutable (lifecycle trigger)",
);
expectError(
  asService(`update tool_executions set status = 'failed', finished_at = now(), business_id = '${bizA}' where intent_id = 'rls-b-1';`),
  "finalize cannot move a row to another tenant (lifecycle trigger)",
);
expectError(
  asService(`update tool_executions set status = 'failed', finished_at = now(), tool_name = 'offer_concession' where intent_id = 'rls-b-1';`),
  "finalize cannot rewrite which tool ran (lifecycle trigger)",
);
expectError(
  asService(`update tool_executions set status = 'started' where intent_id = 'rls-a-dup-rejected';`),
  "rejected rows are final (lifecycle trigger)",
);
psql(asService(auditRow(bizA, "rls-a-2", "started").replace("'rls-turn'", "'rls-turn-2'")));
expectCount(
  asService(`with u as (update tool_executions set status = 'failed', error_code = 'EXECUTOR_TIMEOUT', finished_at = now() where intent_id = 'rls-a-2' and status = 'started' returning 1) select count(*) from u;`),
  1,
  "service_role finalizes a started row as failed with a bounded error code",
);
expectError(
  asService(`update tool_executions set status = 'failed', error_code = 'a sentence with spaces', finished_at = now() where intent_id = 'rls-b-1';`),
  "an error code that is not an identifier is refused (no messages stored)",
);
// Retention: rows cascade with their conversation, so purge_expired_data()
// removes them for a tenant whose window has passed. A dedicated, backdated
// conversation keeps the fixture independent of the rest of the harness.
psql(asService(`
insert into business_settings (business_id) values ('${bizA}') on conflict (business_id) do nothing;
insert into conversations (business_id, receptionist_id, visitor_token, channel, agent_id, agent_version_id, started_at)
select business_id, receptionist_id, 'rls-audit-expired', channel, agent_id, agent_version_id, now() - interval '4000 days'
from conversations where visitor_token = 'rls-token-a';
insert into tool_executions (business_id, conversation_id, agent_id, agent_version_id, channel, turn_id, round, intent_id, tool_name, idempotency_key, side_effecting, status, requested_at, rejection_reason, finished_at)
select business_id, id, agent_id, agent_version_id, 'web-chat', 'rls-expired-turn', 0, 'rls-expired', null, null, null, 'rejected', now(), 'unknown_tool', now()
from conversations where visitor_token = 'rls-audit-expired';
`));
psql(asService(`select * from purge_expired_data();`));
expectCount(`select count(*) from tool_executions where intent_id = 'rls-expired';`, 0, "retention purge removes an expired conversation's tool_executions (cascade)");
expectCount(`select count(*) from tool_executions where intent_id = 'rls-a-1';`, 1, "retention purge keeps current tool_executions");

// ---------------------------------------------------------------------------
// 4. Member vs admin: plain members cannot manage agents.
// ---------------------------------------------------------------------------
expectError(
  asUser(uC, `insert into agents (business_id, type, slug, display_name) values ('${bizA}', 'custom', 'injected', 'Injected');`),
  "plain member cannot create agents (admin-only)",
);

// ---------------------------------------------------------------------------
// 5. agent_versions immutability as an authenticated ADMIN. agent_versions
//    has NO update/delete policies, so rows are invisible/unwritable — the
//    mutation touches zero rows (deny by filtering) — and the 0013 trigger
//    throws even if reached via service role.
// ---------------------------------------------------------------------------
expectCount(
  asUser(uA, `with u as (update agent_versions set prompt_template = 'tampered' where agent_id in (select id from agents where business_id = '${bizA}') returning 1) select count(*) from u;`),
  0,
  "admin cannot edit a published agent version (no update policy)",
);
expectCount(
  asUser(uA, `with d as (delete from agent_versions where agent_id in (select id from agents where business_id = '${bizA}') returning 1) select count(*) from d;`),
  0,
  "admin cannot delete agent versions (no delete policy)",
);
expectError(
  asService(`update agent_versions set prompt_template = 'tampered' where agent_id in (select id from agents where business_id = '${bizA}');`),
  "service_role cannot edit a published agent version (immutability trigger)",
);

// ---------------------------------------------------------------------------
// 6. live_version ownership (0018 trigger). RLS read isolation alone hides
//    foreign version ids from a tenant admin's subqueries, but version UUIDs
//    can leak (logs, backups) — the ownership trigger must reject them even
//    when known. The foreign id is resolved here via service_role (as an
//    attacker who learned it would).
// ---------------------------------------------------------------------------
const foreignVersionId = psql(
  asService(`select av.id from agent_versions av join agents a2 on a2.id = av.agent_id where a2.business_id = '${bizB}' limit 1;`),
  true,
).trim();
expectError(
  asUser(uA, `update agents set live_version_id = '${foreignVersionId}' where business_id = '${bizA}';`),
  "admin cannot repoint live_version_id to another tenant's version (known id)",
);

// Second agent + version in tenant A: the same-agent repoint must also fail.
psql(asUser(uA, `insert into agents (business_id, type, slug, display_name) values ('${bizA}', 'sales', 'sales-a', 'Sales A');`));
const secondAgentVersion = psql(
  asService(`
    with v as (
      insert into agent_versions (agent_id, business_id, version, prompt_template, prompt_version, published_at)
      select a.id, a.business_id, 1, 'Sales template A', '2026-07-28.1', now()
      from agents a where a.business_id = '${bizA}' and a.slug = 'sales-a'
      returning id
    ) select id from v;
  `),
  true,
).trim();
expectError(
  asUser(uA, `update agents set live_version_id = '${secondAgentVersion}' where business_id = '${bizA}' and slug = (select slug from agents where business_id = '${bizA}' and slug <> 'sales-a' limit 1);`),
  "admin cannot repoint live_version_id to a different agent's version (same tenant)",
);

// ---------------------------------------------------------------------------
// 7. service_role sees everything (Regime B depends on it) — and is the ONLY
//    place the ownership trigger must hold too (service role bypasses RLS).
// ---------------------------------------------------------------------------
expectCount(asService(`select count(*) from leads;`), 2, "service_role sees all tenants' leads (by design)");
expectError(
  asService(`update agents set live_version_id = (select av.id from agent_versions av join agents a2 on a2.id = av.agent_id where a2.business_id = '${bizB}' limit 1) where business_id = '${bizA}';`),
  "service_role also cannot cross tenant live_version ownership (trigger, not RLS)",
);

// ---------------------------------------------------------------------------
// 8. Sanity: admins CAN do the legitimate mutations.
// ---------------------------------------------------------------------------
expectCount(
  asUser(uA, `with i as (insert into agents (business_id, type, slug, display_name) values ('${bizA}', 'custom', 'admin-made', 'Admin Made') returning 1) select count(*) from i;`),
  1,
  "admin can create an agent in own tenant",
);

// Generic lead lifecycle: real roles, ownership, idempotency and terminal state.
const customerA = "cccccccc-cccc-cccc-cccc-aaaaaaaaaaaa";
psql(asService(`insert into customers(id,business_id,name) values ('${customerA}','${bizA}','Example');
select transition_lead('${bizA}','${customerA}','event-1','CONTACTING','campaign');
select transition_lead('${bizA}','${customerA}','event-1','CONTACTING','campaign');`));
expectCount(asUser(uA, `select count(*) from lead_state_events;`), 1, "lead event delivery is idempotent");
expectCount(asUser(uB, `select count(*) from lead_state_events;`), 0, "lead audit tenant isolation");
expectError(asUser(uA, `select transition_lead('${bizA}','${customerA}','forged','LOST','forged');`), "members cannot execute lead transitions");
expectError(asService(`select transition_lead('${bizB}','${customerA}','foreign','LOST','foreign');`), "lead transition checks ownership even for service role");
expectError(asService(`select transition_lead('${bizA}','${customerA}','event-1','LOST','conflict');`), "lead idempotency key cannot change meaning");
psql(asService(`select transition_lead('${bizA}','${customerA}','dnc','DO_NOT_CONTACT','requested');`));
expectError(asService(`update customers set lead_state='CONTACTING' where id='${customerA}';`), "DNC cannot be resurrected by direct SQL");

// Campaign isolation and queue safety use the same real-role fixture.
const campaignA = "dddddddd-dddd-dddd-dddd-aaaaaaaaaaaa";
const contactA = "eeeeeeee-eeee-eeee-eeee-aaaaaaaaaaaa";
const callableA = "cccccccc-cccc-cccc-cccc-aaaaaaaaaaab";
psql(asService(`
insert into customers(id,business_id,name,phone) values ('${callableA}','${bizA}','Callable','+15551230001');
insert into campaigns(id,business_id,agent_id,agent_version_id,phone_number_id,name,state,weekdays,start_minute,end_minute)
values ('${campaignA}','${bizA}',${agentOf(bizA)},${versionOf(bizA)},(select id from phone_numbers where business_id='${bizA}' limit 1),'Enrollment','active','{0,1,2,3,4,5,6}',0,1440);
insert into campaign_contacts(id,business_id,campaign_id,customer_id,consent_at)
values ('${contactA}','${bizA}','${campaignA}','${callableA}',now());
`));
for (const table of ['campaigns','campaign_contacts','campaign_events']) {
 expectCount(asUser(uB, `select count(*) from ${table} where business_id='${bizA}';`), 0, `${table} tenant isolation`);
 expectCount(asAnon(`select count(*) from ${table};`), 0, `${table} anonymous isolation`);
}
expectError(asService(`insert into campaign_contacts(business_id,campaign_id,customer_id,consent_at) values('${bizB}','${campaignA}','${callableA}',now());`), 'campaign cross-tenant foreign keys');
expectError(asUser(uA, `select * from claim_campaign_contacts('${bizA}','${campaignA}',1);`), 'members cannot dispatch campaigns');
expectCount(asService(`select count(*) from claim_campaign_contacts('${bizB}','${campaignA}',1);`), 0, 'foreign tenant cannot claim');
expectCount(asService(`select count(*) from claim_campaign_contacts('${bizA}','${campaignA}',1);`), 1, 'eligible contact claimed');
expectCount(asService(`select count(*) from claim_campaign_contacts('${bizA}','${campaignA}',1);`), 0, 'duplicate dispatch does not dial again');
psql(asService(`select settle_campaign_contact('${bizA}','${contactA}',1,'accepted',false,'call-one');
select complete_campaign_contact('${bizA}','${contactA}',1,'call-one','callback_requested',now()+interval '1 hour');
select complete_campaign_contact('${bizA}','${contactA}',1,'call-one','callback_requested',now()+interval '2 hours');`));
expectCount(asService(`select count(*) from campaign_events where contact_id='${contactA}' and type='followup_created';`), 1, 'duplicate outcomes create one follow-up');
expectError(asService(`select complete_campaign_contact('${bizA}','${contactA}',2,'call-one','qualified',null);`), 'stale campaign attempt rejected');
psql(asService(`select transition_lead('${bizA}','${callableA}','stop','DO_NOT_CONTACT','requested'); update campaign_contacts set due_at=now() where id='${contactA}';`));
expectCount(asService(`select count(*) from claim_campaign_contacts('${bizA}','${campaignA}',1);`), 0, 'DNC lead never recontacted');

// Controlled learning cannot rewrite or publish production versions.
// Callback race, destination binding, persisted voice version and carrier retry.
const callbackLead = "eeeeeeee-eeee-eeee-eeee-aaaaaaaaaaaa";
const callbackContact = "ffffffff-ffff-ffff-ffff-aaaaaaaaaaaa";
psql(asService(`insert into customers(id,business_id,phone) values('${callbackLead}','${bizA}','+919812345679');
insert into campaign_contacts(id,business_id,campaign_id,customer_id,consent_at)
values('${callbackContact}','${bizA}','${campaignA}','${callbackLead}',now());
select * from claim_campaign_contacts('${bizA}','${campaignA}',1);`));
const bindCallback = (destination = '+919812345679', attempt = 1) => `select bind_campaign_callback('${callbackContact}',${attempt},
(select provider from phone_numbers where business_id='${bizA}' limit 1),'callback-first',
(select e164 from phone_numbers where business_id='${bizA}' limit 1),'${destination}')`;
expectError(asUser(uA, bindCallback()), 'members cannot bind carrier callbacks');
expectCount(asService(`select count(*) from (${bindCallback('+919812340000')}) q where bind_campaign_callback;`), 0, 'callback destination substitution rejected');
expectCount(asService(`select count(*) from (${bindCallback()}) q where bind_campaign_callback;`), 1, 'signed callback can bind before dial response');
psql(asService(`select settle_campaign_contact('${bizA}','${callbackContact}',1,'accepted',false,'callback-first'); ${bindCallback()};`));
expectCount(asService(`select count(*) from calls where business_id='${bizA}' and provider_call_id='callback-first' and direction='outbound' and agent_version_id=${versionOf(bizA)};`), 1, 'outbound call pinned and created once');
psql(asService(`update calls set state='dialing' where provider_call_id='callback-first';
update calls set state='ringing' where provider_call_id='callback-first';
update calls set state='no_answer' where provider_call_id='callback-first';
update calls set state='no_answer' where provider_call_id='callback-first';`));
expectCount(asService(`select count(*) from campaign_contacts where id='${callbackContact}' and state='pending' and due_at>now() and outcome='no_answer';`), 1, 'carrier outcome schedules persisted retry');
expectCount(asService(`select count(*) from campaign_events where contact_id='${callbackContact}' and type='followup_created';`), 1, 'duplicate carrier status creates one follow-up');
expectCount(asService(`select count(*) from (${bindCallback('+919812345679', 2)}) q where bind_campaign_callback;`), 0, 'stale callback attempt rejected');

const proposalA = "ffffffff-ffff-ffff-ffff-aaaaaaaaaaaa";
psql(asService(`insert into learning_proposals(id,business_id,source_version_id,proposal_key,rationale,candidate_config,candidate_prompt)
values('${proposalA}','${bizA}',${versionOf(bizA)},'review-1','Improve clarity','{}','Candidate prompt');`));
expectCount(asUser(uB, `select count(*) from learning_proposals;`), 0, 'learning proposals are tenant isolated');
expectError(asUser(uA, `select review_learning_proposal('${bizA}','${proposalA}',true);`), 'unevaluated proposal cannot be approved');
expectError(asUser(uA, `select evaluate_learning_proposal('${bizA}','${proposalA}','corpus',1,1);`), 'reviewer cannot forge evaluation');
psql(asService(`select evaluate_learning_proposal('${bizA}','${proposalA}','generic-corpus-v1',2,2);`));
expectError(asUser(uC, `select review_learning_proposal('${bizA}','${proposalA}',true);`), 'ordinary member cannot approve learning');
expectError(asUser(uB, `select review_learning_proposal('${bizA}','${proposalA}',true);`), 'foreign admin cannot approve learning');
psql(asUser(uA, `select review_learning_proposal('${bizA}','${proposalA}',true); select review_learning_proposal('${bizA}','${proposalA}',true);`));
expectCount(asUser(uA, `select count(*) from learning_proposals p join agent_versions v on v.id=p.draft_version_id where p.id='${proposalA}' and v.published_at is null;`), 1, 'approval creates one unpublished draft');
expectCount(asUser(uA, `select count(*) from learning_proposals p join agents a on a.live_version_id=p.draft_version_id where p.id='${proposalA}';`), 0, 'learning never changes live version');
expectError(asService(`update learning_proposals set candidate_prompt='Changed after evaluation' where id='${proposalA}';`), 'evaluated proposal content is immutable');

// Production publication and pinning must hold below the application layer.
const draftVersion = psql(asService(`insert into agent_versions(agent_id,business_id,version,prompt_template,prompt_version)
values(${agentOf(bizA)},'${bizA}',100,'unpublished candidate','test') returning id;`), true).trim();
expectError(asService(`update agents set live_version_id='${draftVersion}' where id=${agentOf(bizA)};`), 'draft cannot become live even through service role');
expectError(asService(`insert into calls(business_id,agent_id,agent_version_id,direction,provider,provider_call_id,from_number,to_number,state)
values('${bizA}',${agentOf(bizA)},'${draftVersion}','inbound','fake','draft-call','+919812345679','+919812345678','ringing');`), 'production calls reject draft versions');
expectError(asService(`update calls set to_number='+919899999999' where provider_call_id='callback-first';`), 'persisted call destination is immutable');
expectError(asService(`update calls set agent_version_id='${draftVersion}' where provider_call_id='callback-first';`), 'persisted call version is immutable');
expectError(asService(`update conversations set agent_version_id='${draftVersion}' where business_id='${bizA}';`), 'production conversation rejects draft version');

const admittedCall = psql(asService(`insert into calls(business_id,agent_id,agent_version_id,direction,provider,provider_call_id,from_number,to_number,state)
values('${bizA}',${agentOf(bizA)},${versionOf(bizA)},'inbound','fake','atomic-admission','+919812345679','+919812345678','ringing') returning id;`), true).trim();
expectError(asUser(uA, `select begin_call_conversation('${bizA}','${admittedCall}');`), 'members cannot claim voice sessions');
expectCount(asService(`select count(*) from (select begin_call_conversation('${bizB}','${admittedCall}') as id) q where id is not null;`), 0, 'foreign tenant cannot claim voice session');
expectCount(asService(`select count(*) from (select begin_call_conversation('${bizA}','${admittedCall}') as id) q where id is not null;`), 1, 'first gateway atomically creates conversation');
expectCount(asService(`select count(*) from (select begin_call_conversation('${bizA}','${admittedCall}') as id) q where id is not null;`), 0, 'second gateway cannot duplicate the session');

psql(asService(`insert into conversation_outcomes(business_id,call_id,conversation_id,agent_id,agent_version_id,disposition,do_not_call)
select business_id,id,conversation_id,agent_id,agent_version_id,'do_not_call',true from calls where id='${admittedCall}';`));
expectCount(asService(`select count(*) from phone_suppressions where business_id='${bizA}' and e164='+919812345679';`), 1, 'DNC suppression commits atomically with outcome');
expectCount(asService(`select count(*) from customers where id='${callbackLead}' and lead_state='DO_NOT_CONTACT';`), 1, 'verified outcome updates CRM without an application callback');

if (failures > 0) {
  console.error(`\ncheck-rls FAILED with ${failures} assertion(s).`);
  process.exit(1);
}
console.log("\ncheck-rls OK — tenant isolation holds as the real authenticated/service_role roles.");
