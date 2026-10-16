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
// D14 legacy fixture: knowledge written BEFORE 0033 exists, exactly as the
// pre-governance schema allowed it. It must never be served afterwards.
const bizL = "aaaaaaaa-aaaa-aaaa-aaaa-cccccccccccc"; // legacy tenant
const bizX = "aaaaaaaa-aaaa-aaaa-aaaa-dddddddddddd"; // another tenant
const legacyKnowledge = `
insert into businesses (id, name, slug) values ('${bizL}', 'Legacy L', 'legacy-l'), ('${bizX}', 'Other X', 'other-x');
insert into knowledge_collections (id, business_id, name) values
  ('c0000000-0000-4000-8000-00000000000a', '${bizX}', 'X collection');
insert into knowledge_documents (id, business_id, title, content, status) values
  ('d0000000-0000-4000-8000-00000000000a', '${bizL}', 'Legacy ready doc', 'legacyzebra warranty text', 'ready'),
  ('d0000000-0000-4000-8000-00000000000b', '${bizL}', 'Legacy empty doc', '', 'ready'),
  ('d0000000-0000-4000-8000-00000000000x', '${bizX}', 'X doc', 'xenon other tenant text', 'ready');
insert into knowledge_documents (id, business_id, title, content, status, collection_id) values
  ('d0000000-0000-4000-8000-00000000000c', '${bizL}', 'Legacy doc in foreign collection', 'legacyzebra foreign', 'ready', 'c0000000-0000-4000-8000-00000000000a');
insert into knowledge_chunks (document_id, business_id, content, chunk_index, embedding) values
  ('d0000000-0000-4000-8000-00000000000a', '${bizL}', 'legacyzebra warranty text', 0, array_fill(0.5::real, array[768])::vector),
  -- Tenant-mismatched legacy chunk: L's row pointing at X's document.
  ('d0000000-0000-4000-8000-00000000000x', '${bizL}', 'legacyzebra mismatched chunk', 0, null);
insert into faqs (id, business_id, question, answer, is_published) values
  ('f0000000-0000-4000-8000-00000000000a', '${bizL}', 'Legacyzebra question?', 'Legacyzebra published answer.', true);
`.replaceAll("00000000000x", "0000000000ff");
for (const file of [...((await import("node:fs")).readdirSync(migrationsDir))].filter((f) => f.endsWith(".sql")).sort()) {
  if (file === "0033_knowledge_governance.sql") psql(legacyKnowledge);
  psql(readFileSync(path.join(migrationsDir, file), "utf8"));
}
ok("stubs + all migrations applied (legacy knowledge seeded before 0033)");

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

// ---------------------------------------------------------------------------
// D14 — knowledge governance (0033): tenant-composite ownership, approval by
// owner/admin only, immutable revisions, atomic publication, governed
// keyword + vector retrieval with collection scope, legacy quarantine.
// Every statement runs as a real role: authenticated (with a JWT sub),
// service_role, anon, or — where stated — the table owner, to prove that
// the triggers hold even where grants and RLS are bypassed.
// ---------------------------------------------------------------------------
const val = (sql) => psql(sql, true).trim();
const vec = (x) => `array_fill(${x}::real, array[768])::vector`;
const colA1 = val(asUser(uA, `insert into knowledge_collections (business_id, name) values ('${bizA}', 'A sales') returning id;`));
const colA2 = val(asUser(uA, `insert into knowledge_collections (business_id, name) values ('${bizA}', 'A support') returning id;`));
const colB1 = val(asUser(uB, `insert into knowledge_collections (business_id, name) values ('${bizB}', 'B sales') returning id;`));
ok("collections created by tenant admins (A sales, A support, B sales)");
expectError(asUser(uC, `insert into knowledge_collections (business_id, name) values ('${bizA}', 'member collection');`), "a member cannot create collections");

const createDoc = (uid, biz, doc, title, content, col = null) =>
  asUser(uid, `select r.document_id || '|' || r.revision_id from knowledge_create_document_revision('${biz}', ${doc ? `'${doc}'` : "null"}, '${title}', '${content}', 'manual', '', ${col ? `'${col}'` : "null"}) r;`);
const index = (biz, doc, rev, chunks, embedding = 0.1) => {
  psql(asService(`select knowledge_begin_indexing('${biz}', '${doc}', '${rev}');
    insert into knowledge_chunks (document_id, business_id, revision_id, content, chunk_index, embedding)
    select '${doc}', '${biz}', '${rev}', c, i - 1, ${vec(embedding)} from unnest(array[${chunks.map((c) => `'${c}'`).join(",")}]::text[]) with ordinality t(c, i);`));
  return val(asService(`select knowledge_finish_indexing('${biz}', '${doc}', '${rev}', ${chunks.length});`));
};
const search = (biz, q, scope = "'{}'::uuid[]") => asService(`select count(*) from search_governed_knowledge('${biz}', '${q}', ${scope}, 20);`);
const vsearch = (biz, scope = "'{}'::uuid[]", embedding = 0.1) => asService(`select count(*) from match_governed_knowledge_chunks('${biz}', ${vec(embedding)}, ${scope}, 20);`);

// --- creation and trusted tenant ---------------------------------------------
const [docA, revA1] = val(createDoc(uA, bizA, null, "Panels", "alphaword panels warranty twenty years", colA1)).split("|");
ok("member A creates a document and its first draft revision");
expectError(createDoc(uA, bizB, null, "Forged", "alphaword forged"), "a caller-supplied foreign tenant id is refused (not a member)");
expectError(createDoc(uB, bizB, docA, "Hijack", "alphaword hijack"), "tenant B cannot revise tenant A's document through its own tenant id");
expectError(createDoc(uB, bizA, docA, "Hijack", "alphaword hijack"), "tenant B cannot revise tenant A's document by naming tenant A");
expectError(createDoc(uA, bizA, null, "Foreign collection", "alphaword", colB1), "a document cannot be bound to another tenant's collection");
expectError(asAnon(`select knowledge_create_document_revision('${bizA}', null, 'x', 'y');`), "a session without a JWT cannot create knowledge");
expectError(`begin; set local role anon; select knowledge_create_document_revision('${bizA}', null, 'x', 'y'); commit;`, "the anon role cannot execute governance functions");
expectError(createDoc(uA, bizA, null, "Empty", ""), "empty content is refused before it can be indexed");

// --- direct writes are closed --------------------------------------------------
expectError(asUser(uA, `insert into knowledge_documents (business_id, title, content) values ('${bizA}', 'direct', 'alphaword direct');`), "members cannot insert documents directly (RPC only)");
expectError(asUser(uA, `update knowledge_documents set content = 'tampered' where id = '${docA}';`), "members cannot update documents directly");
expectError(asUser(uA, `insert into knowledge_document_revisions (business_id, document_id, revision, title, content, content_sha256, source_type) values ('${bizA}', '${docA}', 99, 't', 'alphaword injected', repeat('0',64), 'manual');`), "members cannot insert revisions directly");
expectError(asUser(uA, `update knowledge_document_revisions set state = 'approved' where id = '${revA1}';`), "members cannot update revisions directly");
expectError(asUser(uA, `insert into knowledge_chunks (document_id, business_id, revision_id, content) values ('${docA}', '${bizA}', '${revA1}', 'alphaword injected');`), "members cannot write chunks");
expectError(asService(`update knowledge_document_revisions set state = 'approved' where id = '${revA1}';`), "service_role cannot write revisions directly (no grant)");
expectError(asService(`update knowledge_chunks set content = 'x' where revision_id = '${revA1}';`), "service_role cannot rewrite chunks");
expectCount(
  `select count(*) from (values ('anon','select'),('anon','insert'),('authenticated','insert'),('authenticated','update'),('authenticated','delete'),('service_role','insert'),('service_role','update'),('service_role','delete')) p(r, priv)
   cross join (values ('public.knowledge_document_revisions'),('public.faq_revisions')) t(name)
   where has_table_privilege(p.r, t.name, p.priv);`,
  0,
  "no role can write revision tables directly",
);
expectCount(
  `select count(*) from (values ('anon'),('authenticated')) r(name)
   cross join (values ('public.search_governed_knowledge(uuid,text,uuid[],integer)'),('public.match_governed_knowledge_chunks(uuid,vector,uuid[],integer)'),
                      ('public.search_knowledge(uuid,text,integer)'),('public.knowledge_begin_indexing(uuid,uuid,uuid)'),
                      ('public.knowledge_finish_indexing(uuid,uuid,uuid,integer)'),('public.knowledge_backfill_legacy(uuid,boolean)'),
                      ('public.knowledge_governance_census(uuid)'),('public.knowledge_require_approver(uuid)'),('public.is_knowledge_approver(uuid,uuid)')) f(sig)
   where has_function_privilege(r.name, f.sig, 'execute');`,
  0,
  "clients cannot execute retrieval, indexing, census, backfill or internal helpers",
);
expectCount(`select count(*) from pg_class where relname in ('knowledge_document_revisions','faq_revisions') and relrowsecurity;`, 2, "RLS enabled on both revision tables");

// --- indexing --------------------------------------------------------------------
expectError(asService(`select knowledge_finish_indexing('${bizB}', '${docA}', '${revA1}', 1);`), "indexing under the wrong tenant is refused (service role)");
expectError(asService(`select knowledge_begin_indexing('${bizA}', gen_random_uuid(), '${revA1}');`), "indexing names the exact document of the revision (service role)");
expectError(asService(`insert into knowledge_chunks (document_id, business_id, revision_id, content) values ('${docA}', '${bizB}', '${revA1}', 'alphaword cross');`), "a chunk cannot claim another tenant (service role)");
expectError(asService(`insert into knowledge_chunks (document_id, business_id, content) values ('${docA}', '${bizA}', 'alphaword unbound');`), "a new chunk must belong to a revision");
expectError(asUser(uC, `select knowledge_submit_revision('${revA1}');`), "an unindexed draft cannot be submitted");
const failedOutcome = (() => {
  psql(asService(`select knowledge_begin_indexing('${bizA}', '${docA}', '${revA1}');
    insert into knowledge_chunks (document_id, business_id, revision_id, content) values ('${docA}', '${bizA}', '${revA1}', 'alphaword partial');`));
  return val(asService(`select knowledge_finish_indexing('${bizA}', '${docA}', '${revA1}', 2);`));
})();
if (failedOutcome === "failed") ok("a partially indexed revision is marked failed (1 of 2 chunks)");
else fail("partial indexing", `expected failed, got ${failedOutcome}`);
expectCount(`select count(*) from knowledge_documents where id = '${docA}' and status = 'error';`, 1, "failed indexing shows as an error on the document");
expectError(asUser(uC, `select knowledge_submit_revision('${revA1}');`), "a failed index cannot be submitted for review");
const readyOutcome = index(bizA, docA, revA1, ["alphaword panels warranty twenty years", "alphaword second chunk"]);
if (readyOutcome === "ready") ok("re-indexing the draft completes (2 of 2 chunks)");
else fail("re-index", `expected ready, got ${readyOutcome}`);

// --- review ------------------------------------------------------------------------
psql(asUser(uC, `select knowledge_submit_revision('${revA1}');`));
ok("member C submits the indexed draft for review");
expectError(asService(`delete from knowledge_chunks where revision_id = '${revA1}';`), "chunks of a submitted revision are frozen");
expectCount(search(bizA, "alphaword"), 0, "pending content is not retrievable (keyword)");
expectCount(vsearch(bizA), 0, "pending content is not retrievable (vector)");
expectError(asUser(uC, `select knowledge_review_revision('${revA1}', true);`), "a member cannot approve");
expectError(asUser(uB, `select knowledge_review_revision('${revA1}', true);`), "another tenant's owner cannot approve");
expectError(asService(`select knowledge_review_revision('${revA1}', true);`), "the service role cannot approve (no human approver)");
expectCount(asUser(uA, `select count(*) from knowledge_review_revision('${revA1}', true) r where r = 'approved';`), 1, "owner A approves and publishes");
expectCount(`select count(*) from knowledge_document_revisions where id = '${revA1}' and state = 'approved' and reviewed_by = '${uA}' and submitted_by = '${uC}' and created_by = '${uA}' and reviewed_at is not null and submitted_at is not null;`, 1, "the revision records author, submitter, approver and timestamps");
expectCount(`select count(*) from knowledge_documents where id = '${docA}' and published_revision_id = '${revA1}';`, 1, "the document points at the approved revision");
expectCount(search(bizA, "alphaword"), 2, "approved content is retrievable (keyword)");
expectCount(vsearch(bizA), 2, "approved content is retrievable (vector)");
expectCount(asService(`select count(*) from search_knowledge('${bizA}', 'alphaword', 20);`), 2, "the pre-D14 search RPC returns governed content only");
expectError(asUser(uA, `select knowledge_review_revision('${revA1}', true);`), "an approved revision cannot be approved again");

// --- tenant isolation and collection scope -------------------------------------------
expectCount(search(bizB, "alphaword"), 0, "tenant B retrieval never returns tenant A content (keyword)");
expectCount(vsearch(bizB), 0, "tenant B retrieval never returns tenant A content (vector)");
expectCount(search(bizA, "alphaword", `array['${colA1}']::uuid[]`), 2, "scope with the bound collection returns the document");
expectCount(search(bizA, "alphaword", `array['${colA2}']::uuid[]`), 0, "scope with another own collection excludes the document");
expectCount(vsearch(bizA, `array['${colA2}']::uuid[]`), 0, "vector scope with another own collection excludes the document");
expectError(search(bizA, "alphaword", `array['${colB1}']::uuid[]`), "scope naming another tenant's collection is denied, not widened");
expectError(vsearch(bizA, `array['${colB1}']::uuid[]`), "vector scope naming another tenant's collection is denied");
expectError(search(bizA, "alphaword", `array[gen_random_uuid()]`), "scope naming an unknown collection is denied");
expectError(search(bizA, "alphaword", "null"), "a missing scope is denied");
expectCount(asUser(uB, `select count(*) from knowledge_document_revisions where business_id = '${bizA}';`), 0, "tenant B cannot read tenant A revisions (RLS)");
expectCount(asUser(uB, `select count(*) from knowledge_chunks where business_id = '${bizA}';`), 0, "tenant B cannot read tenant A chunks (RLS)");
expectCount(asUser(uC, `select count(*) from knowledge_document_revisions where business_id = '${bizA}';`), 1, "member C reads its own tenant's revisions");
expectError(`begin; set local role anon; select count(*) from knowledge_document_revisions; commit;`, "the anon role cannot read revisions");
expectError(asUser(uC, `update knowledge_documents set collection_id = '${colA2}' where id = '${docA}';`), "a member cannot update a document's collection directly (no grant)");
expectError(createDoc(uC, bizA, docA, "Panels", "alphaword moved", colA2), "a member cannot move published knowledge to another collection through an edit (trigger)");

// --- revision replacement: atomic, no mixing, history preserved ---------------------
const [, revA2] = val(createDoc(uC, bizA, docA, "Panels", "betaword battery backup ten hours")).split("|");
expectCount(search(bizA, "alphaword"), 2, "the published revision keeps serving while a new draft exists");
index(bizA, docA, revA2, ["betaword battery backup ten hours"], 0.2);
psql(asUser(uC, `select knowledge_submit_revision('${revA2}');`));
expectCount(search(bizA, "betaword"), 0, "the pending replacement is not served before approval");
psql(asUser(uA, `select knowledge_review_revision('${revA2}', true);`));
expectCount(search(bizA, "alphaword"), 0, "after replacement, no chunk of the old revision is served (keyword)");
expectCount(search(bizA, "betaword"), 1, "after replacement, the new revision is served");
expectCount(vsearch(bizA, "'{}'::uuid[]", 0.1), 1, "after replacement, the vector path serves only the new revision's chunks");
expectCount(`select count(*) from knowledge_document_revisions where id = '${revA1}' and state = 'superseded' and content = 'alphaword panels warranty twenty years' and retired_by = '${uA}';`, 1, "the superseded revision keeps its approved content and approver");
expectCount(`select count(*) from knowledge_chunks where revision_id = '${revA1}';`, 2, "the superseded revision's chunks are preserved (not served)");
expectCount(`select count(*) from knowledge_document_revisions where document_id = '${docA}' and state = 'approved';`, 1, "exactly one approved revision per document");

const [, revA3] = val(createDoc(uC, bizA, docA, "Panels", "gammaword draft")).split("|");
index(bizA, docA, revA3, ["gammaword draft"]);
psql(asUser(uC, `select knowledge_submit_revision('${revA3}');`));
const [, revA4] = val(createDoc(uC, bizA, docA, "Panels", "deltaword newer draft")).split("|");
expectCount(`select count(*) from knowledge_document_revisions where id = '${revA3}' and state = 'withdrawn' and retired_by = '${uC}';`, 1, "a newer edit withdraws the older pending revision");
expectError(asUser(uA, `select knowledge_review_revision('${revA3}', true);`), "a withdrawn (stale) revision cannot be approved");
index(bizA, docA, revA4, ["deltaword newer draft"]);
psql(asUser(uC, `select knowledge_submit_revision('${revA4}');`));
expectCount(asUser(uA, `select count(*) from knowledge_review_revision('${revA4}', false) r where r = 'rejected';`), 1, "owner A rejects a revision");
expectCount(search(bizA, "deltaword"), 0, "rejected content is never served");
expectCount(search(bizA, "betaword"), 1, "a rejection leaves the published revision serving");
expectError(asUser(uA, `select knowledge_review_revision('${revA4}', true);`), "a rejected revision cannot later be approved");

// --- invalid transitions hold even for the table owner (grants/RLS bypassed) ---------
expectError(`update knowledge_document_revisions set state = 'draft' where id = '${revA2}';`, "owner: approved -> draft is refused (trigger)");
expectError(`update knowledge_document_revisions set content = 'tampered' where id = '${revA2}';`, "owner: approved content is immutable (trigger)");
expectError(`update knowledge_document_revisions set reviewed_by = '${uC}' where id = '${revA2}';`, "owner: the approver record is immutable (trigger)");
expectError(`update knowledge_documents set published_revision_id = '${revA4}' where id = '${docA}';`, "owner: the pointer cannot name a rejected revision (trigger)");
expectError(`begin; update knowledge_document_revisions set state = 'withdrawn', retired_by = '${uA}', retired_at = now() where id = '${revA2}'; commit;`, "owner: withdrawing without clearing the pointer fails at commit (deferred check)");
expectError(`insert into knowledge_chunks (document_id, business_id, revision_id, content) values ('${docA}', '${bizA}', '${revA2}', 'alphaword injected after approval');`, "owner: chunks cannot be added to a published revision (trigger)");
expectCount(search(bizA, "betaword"), 1, "the refused tampering left the published revision intact");

// --- withdrawal and deletion ----------------------------------------------------------
expectError(asUser(uC, `select knowledge_withdraw_document('${docA}');`), "a member cannot withdraw");
expectError(asUser(uB, `select knowledge_withdraw_document('${docA}');`), "another tenant cannot withdraw");
expectCount(asUser(uA, `with d as (delete from knowledge_documents where id = '${docA}' returning 1) select count(*) from d;`), 0, "published knowledge cannot be deleted (withdraw first)");
expectCount(asUser(uA, `select count(*) from knowledge_withdraw_document('${docA}') w where w;`), 1, "owner A withdraws the document");
expectCount(search(bizA, "betaword"), 0, "withdrawn content is no longer retrievable (keyword)");
expectCount(vsearch(bizA), 0, "withdrawn content is no longer retrievable (vector)");
expectCount(`select count(*) from knowledge_document_revisions where id = '${revA2}' and state = 'withdrawn' and retired_by = '${uA}';`, 1, "the withdrawal is recorded on the revision");
expectCount(asUser(uC, `with d as (delete from knowledge_documents where id = '${docA}' returning 1) select count(*) from d;`), 0, "a member cannot delete knowledge");
expectCount(asUser(uB, `with d as (delete from knowledge_documents where id = '${docA}' returning 1) select count(*) from d;`), 0, "another tenant cannot delete knowledge");
expectCount(asUser(uA, `with d as (delete from knowledge_documents where id = '${docA}' returning 1) select count(*) from d;`), 1, "the owner deletes an unpublished document");
expectCount(`select count(*) from knowledge_document_revisions where document_id = '${docA}';`, 0, "deleting a document removes its revisions (cascade)");

// --- FAQs --------------------------------------------------------------------------------
const createFaq = (uid, biz, faq, q, a) =>
  asUser(uid, `select r.faq_id || '|' || r.revision_id from faq_create_revision('${biz}', ${faq ? `'${faq}'` : "null"}, '${q}', '${a}', 'General') r;`);
const [faqA, faqRev1] = val(createFaq(uC, bizA, null, "Epsilonword hours?", "Epsilonword nine to five.")).split("|");
expectCount(search(bizA, "epsilonword"), 0, "a new FAQ is not served before approval");
expectError(createFaq(uB, bizA, faqA, "Hijack?", "Hijack."), "tenant B cannot revise tenant A's FAQ");
expectError(asUser(uC, `select faq_review_revision('${faqRev1}', true);`), "a member cannot approve an FAQ");
expectError(asUser(uA, `update faqs set is_published = true where id = '${faqA}';`), "members cannot publish an FAQ by flag");
psql(asUser(uA, `select faq_review_revision('${faqRev1}', true);`));
expectCount(search(bizA, "epsilonword"), 1, "an approved FAQ is served");
expectCount(search(bizA, "epsilonword", `array['${colA1}']::uuid[]`), 0, "FAQs are unbound, so a nonempty collection scope excludes them");
const [, faqRev2] = val(createFaq(uC, bizA, faqA, "Epsilonword hours?", "Zetaword ten to six.")).split("|");
expectCount(asService(`select count(*) from search_governed_knowledge('${bizA}', 'epsilonword', '{}', 20) where content like '%nine to five%';`), 1, "the approved FAQ answer keeps serving while an edit is pending");
psql(asUser(uA, `select faq_review_revision('${faqRev2}', true);`));
expectCount(asService(`select count(*) from search_governed_knowledge('${bizA}', 'epsilonword', '{}', 20) where content like '%nine to five%';`), 0, "the superseded FAQ answer is no longer served");
expectCount(search(bizA, "zetaword"), 1, "the newly approved FAQ answer is served");
expectCount(`select count(*) from faq_revisions where id = '${faqRev1}' and state = 'superseded' and answer = 'Epsilonword nine to five.';`, 1, "the superseded FAQ revision keeps its approved text");
expectError(`update faq_revisions set answer = 'tampered' where id = '${faqRev2}';`, "owner: approved FAQ text is immutable (trigger)");
psql(asUser(uA, `select faq_withdraw('${faqA}');`));
expectCount(search(bizA, "zetaword"), 0, "a withdrawn FAQ is not served");
expectCount(`select count(*) from faqs where id = '${faqA}' and is_published = false and published_revision_id is null;`, 1, "withdrawal clears the FAQ pointer and its display flag");

// --- concurrency: real parallel sessions -----------------------------------------------
const { spawn } = await import("node:child_process");
const psqlAsync = (sql) => new Promise((resolve) => {
  const child = spawn("psql", [databaseUrl, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--quiet"]);
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", () => {});
  child.on("close", (code) => resolve({ code, out: out.trim() }));
  child.stdin.end(sql);
});
const [docC, revC1] = val(createDoc(uA, bizA, null, "Concurrent", "thetaword one")).split("|");
index(bizA, docC, revC1, ["thetaword one"]);
psql(asUser(uA, `select knowledge_submit_revision('${revC1}');`));
const slowApprove = asUser(uA, `select knowledge_review_revision('${revC1}', true); select pg_sleep(1.5);`);
const fastApprove = asUser(uA, `select pg_sleep(0.3); select knowledge_review_revision('${revC1}', true);`);
const racers = await Promise.all([psqlAsync(slowApprove), psqlAsync(fastApprove)]);
if (racers.filter((r) => r.code === 0).length === 1) ok("two concurrent approvals of one revision: exactly one succeeds");
else fail("concurrent approvals", `exit codes ${racers.map((r) => r.code).join(",")}`);
const editDuringApproval = await Promise.all([
  psqlAsync(asUser(uA, `select knowledge_withdraw_document('${docC}'); select pg_sleep(1.0);`)),
  psqlAsync(asUser(uC, `select pg_sleep(0.3); select r.revision from knowledge_create_document_revision('${bizA}', '${docC}', 'Concurrent', 'thetaword two') r;`)),
  psqlAsync(asUser(uC, `select pg_sleep(0.3); select r.revision from knowledge_create_document_revision('${bizA}', '${docC}', 'Concurrent', 'thetaword three') r;`)),
]);
if (editDuringApproval.every((r) => r.code === 0)) ok("a withdrawal and two concurrent edits serialize on the document lock");
else fail("concurrent edits", `exit codes ${editDuringApproval.map((r) => r.code).join(",")}`);
expectCount(`select count(distinct revision) from knowledge_document_revisions where document_id = '${docC}';`, 3, "concurrent edits receive distinct revision numbers");
expectCount(`select count(*) from knowledge_document_revisions where document_id = '${docC}' and state in ('draft', 'pending_review');`, 1, "after concurrent edits only the newest revision is open");
expectCount(
  `select count(*) from knowledge_documents d where d.business_id in ('${bizA}', '${bizB}') and (
     (d.published_revision_id is not null) <> exists (select 1 from knowledge_document_revisions r where r.document_id = d.id and r.state = 'approved')
     or exists (select 1 from knowledge_document_revisions r where r.document_id = d.id and r.state = 'approved' and r.id is distinct from d.published_revision_id));`,
  0,
  "publication pointer and approved revision agree for every document",
);

// --- legacy data: quarantined, never served, never approved ---------------------------------
expectCount(search(bizL, "legacyzebra"), 0, "legacy chunks and an is_published legacy FAQ are not served after 0033");
expectCount(vsearch(bizL, "'{}'::uuid[]", 0.5), 0, "legacy vector chunks are not served after 0033");
expectCount(asService(`select row_count from knowledge_governance_census('${bizL}') where check_name = 'documents_without_revision';`), 3, "census: legacy documents without a revision");
expectCount(asService(`select row_count from knowledge_governance_census('${bizL}') where check_name = 'legacy_faqs_marked_published_but_unapproved';`), 1, "census: legacy FAQ flagged published but unapproved");
expectCount(asService(`select row_count from knowledge_governance_census('${bizL}') where check_name = 'chunks_with_foreign_document';`), 1, "census: tenant-mismatched legacy chunk");
expectCount(asService(`select row_count from knowledge_governance_census('${bizL}') where check_name = 'documents_with_foreign_collection';`), 1, "census: legacy document bound to a foreign collection");
expectCount(`select count(*) from pg_constraint where conname = 'knowledge_chunks_document_tenant_fk' and not convalidated;`, 1, "a legacy mismatch leaves the composite FK NOT VALID instead of aborting the rollout");
expectError(asService(`insert into knowledge_chunks (document_id, business_id, content) values ('d0000000-0000-4000-8000-0000000000ff', '${bizL}', 'new mismatch');`), "new tenant-mismatched chunks are refused (chunk trigger)");
expectCount(`select count(*) from pg_constraint where conname = 'knowledge_documents_collection_tenant_fk' and not convalidated;`, 1, "the legacy foreign-collection binding also leaves its composite FK NOT VALID");
expectError(`update knowledge_documents set collection_id = 'c0000000-0000-4000-8000-00000000000a' where id = 'd0000000-0000-4000-8000-00000000000a';`, "owner: the NOT VALID composite FK still refuses a new cross-tenant collection binding");
expectCount(asService(`select count(*) from knowledge_backfill_legacy('${bizL}');`), 4, "backfill dry run lists every legacy item");
expectCount(`select count(*) from knowledge_document_revisions where business_id = '${bizL}';`, 0, "backfill dry run writes nothing");
expectError(asUser(uA, `select * from knowledge_backfill_legacy('${bizL}', true);`), "clients cannot run the backfill");
expectCount(asService(`select count(*) from knowledge_backfill_legacy('${bizL}', true) where action like 'quarantined%';`), 2, "backfill quarantines empty and foreign-collection documents");
expectCount(`select count(*) from knowledge_document_revisions where business_id = '${bizL}' and state = 'draft' and index_status = 'pending' and origin = 'legacy_backfill' and created_by is null;`, 1, "backfill creates an unindexed, unapproved draft for the usable legacy document");
expectCount(`select count(*) from faq_revisions where business_id = '${bizL}' and state = 'pending_review' and origin = 'legacy_backfill';`, 1, "backfill puts the legacy FAQ into review, not into publication");
expectCount(search(bizL, "legacyzebra"), 0, "backfilled legacy content is still not served");
expectCount(asService(`select count(*) from knowledge_backfill_legacy('${bizL}', true) where action not like 'quarantined%';`), 0, "backfill is idempotent");

// --- tenant deletion cascades through published knowledge ---------------------------------
const bizT = "aaaaaaaa-aaaa-aaaa-aaaa-eeeeeeeeeeee";
const uT = "11111111-1111-1111-1111-111111111114";
psql(`insert into auth.users (id, email) values ('${uT}', 't@test'); insert into businesses (id, name, slug) values ('${bizT}', 'Tenant T', 'tenant-t');
insert into business_members (business_id, user_id, role) values ('${bizT}', '${uT}', 'owner');`);
const [docT, revT] = val(createDoc(uT, bizT, null, "T doc", "iotaword text")).split("|");
index(bizT, docT, revT, ["iotaword text"]);
psql(asUser(uT, `select knowledge_submit_revision('${revT}'); select knowledge_review_revision('${revT}', true);`));
expectCount(search(bizT, "iotaword"), 1, "tenant T publishes a document");
psql(`delete from businesses where id = '${bizT}';`);
expectCount(`select count(*) from knowledge_document_revisions where business_id = '${bizT}';`, 0, "deleting a tenant cascades through published documents and revisions");

// ---------------------------------------------------------------------------
// Phase 2, Workstream 1 — tenant isolation across EVERY tenant-owned table.
//
// The sections above prove specific behaviour. This one is catalog-driven, so
// a table, policy, foreign key or function added later is either covered or
// fails the gate, without anyone remembering to extend the harness:
//   a. structural invariants: RLS, policy predicates, foreign-key ownership
//      coverage, the SECURITY DEFINER surface and client privileges;
//   b. a symmetric two-tenant fixture for every table that had no rows yet;
//   c. a generic sweep: tenant A reads, inserts, updates, deletes and
//      relabels against tenant B in every tenant-owned table;
//   d. targeted cross-tenant reference, calendar, session-reuse and
//      missing-context cases.
// Each refusal is matched against its expected reason: expectError above
// accepts any failure, including a typo.
// ---------------------------------------------------------------------------
const rollback = (wrapped) => wrapped.replace(/commit;\s*$/, "rollback;");
const errorLine = (error) => {
  const text = String(error.stderr ?? error.message);
  return (text.split("\n").find((line) => line.includes("ERROR:")) ?? text.trim()).replace(/^.*ERROR:\s*/, "");
};
// The wording of every tenant refusal in the schema: RLS, grants, the generic
// 0034 trigger and the older dedicated guards (0018, 0020, 0021, 0025, 0027).
const TENANT_REFUSAL = /row-level security|permission denied|same business|same agent and business|must reference a version of the same agent|of this tenant|does not match tenant|Invalid campaign (version|number)/;
function expectRefused(sql, pattern, label) {
  try {
    psql(sql);
    fail(label, "unexpectedly succeeded");
  } catch (error) {
    const reason = errorLine(error);
    if (pattern.test(reason)) ok(`${label} (refused: ${reason.slice(0, 100)})`);
    else fail(label, `refused for an unexpected reason: ${reason}`);
  }
}
/** A count that must be 0, or a statement refused outright for a privilege/RLS reason. */
function expectNothing(sql, label) {
  try {
    const out = psql(sql, true).trim();
    if (out === "0") ok(`${label} = 0`);
    else fail(label, `expected 0, got ${out}`);
  } catch (error) {
    const reason = errorLine(error);
    if (/permission denied|row-level security/.test(reason)) ok(`${label} (refused: ${reason.slice(0, 100)})`);
    else fail(label, `unexpected error: ${reason}`);
  }
}

// --- a. structural invariants --------------------------------------------------
expectCount(
  `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;`,
  0,
  "every public table has RLS enabled",
);
expectCount(
  `select coalesce(string_agg(c.relname, ',' order by c.relname), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped);`,
  "businesses,workflow_run_logs",
  "only the tenant root and one parent-scoped child lack a business_id column",
);
// Every policy is a membership/admin predicate on the row's own tenant,
// optionally narrowed by AND; none targets anon; none is unconditional.
expectCount(
  String.raw`select coalesce(string_agg(tablename || '.' || policyname, ', '), '') from pg_policies
   where schemaname = 'public' and (
     roles && array['anon']::name[]
     or (qual is null and with_check is null)
     or coalesce(qual, '') ~* ' OR ' or coalesce(with_check, '') ~* ' OR '
     or (qual is not null and qual !~ '^\(?is_business_(member|admin)\((business_id|id)\)( AND .+)?\)?$'
         and qual !~ '^\(EXISTS \( SELECT 1\s+FROM workflow_runs r\s+WHERE \(\(r\.id = workflow_run_logs\.run_id\) AND is_business_member\(r\.business_id\)\)\)\)$')
     or (with_check is not null and with_check !~ '^\(?is_business_(member|admin)\((business_id|id)\)( AND .+)?\)?$'));`,
  "",
  "every RLS policy is a tenant-membership predicate (no anon, no OR-widening, no unconditional policy)",
);
// Every single-column foreign key between two tenant-owned tables must be
// ownership-checked: a composite (column, business_id) key, the generic
// assert_tenant_reference() trigger (0034), or one of the older dedicated
// guards listed here, each of which the generic test below exercises.
const dedicatedGuards = [
  "agents.live_version_id", "calls.agent_id", "calls.agent_version_id", "calls.conversation_id", "calls.phone_number_id",
  "call_events.call_id", "call_transcript_turns.call_id", "phone_suppressions.call_id", "phone_numbers.agent_id",
  "campaigns.agent_id", "campaigns.agent_version_id", "campaigns.phone_number_id",
  "conversation_outcomes.agent_id", "conversation_outcomes.agent_version_id", "conversation_outcomes.call_id", "conversation_outcomes.conversation_id",
  "conversations.agent_id", "conversations.agent_version_id", "learning_proposals.source_version_id",
  "tool_executions.agent_id", "tool_executions.agent_version_id", "tool_executions.conversation_id",
];
const tenantFkSql = String.raw`
  with tenant_tables as (
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped)),
  fk as (
    select k.conrelid, s.relname src, d.relname dst, a.attname col
    from pg_constraint k
    join tenant_tables s on s.oid = k.conrelid join tenant_tables d on d.oid = k.confrelid
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where k.contype = 'f' and array_length(k.conkey, 1) = 1),
  composite as (
    select k.conrelid, a.attname col from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
    where k.contype = 'f' and a.attname <> 'business_id'
      and exists (select 1 from pg_attribute b where b.attrelid = k.conrelid and b.attnum = any(k.conkey) and b.attname = 'business_id')),
  generic as (
    select t.tgrelid conrelid, unnest(string_to_array(encode(t.tgargs, 'escape'), '\000')) arg
    from pg_trigger t where t.tgfoid = to_regprocedure('public.assert_tenant_reference()'))
  select fk.src, fk.col, fk.dst,
    exists (select 1 from composite c where c.conrelid = fk.conrelid and c.col = fk.col) as composite,
    exists (select 1 from generic g where g.conrelid = fk.conrelid and g.arg = fk.col) as generic
  from fk order by 1, 2`;
const tenantFks = psql(tenantFkSql, true).trim().split("\n").filter(Boolean).map((line) => {
  const [src, col, dst, composite, generic] = line.split("|");
  return { src, col, dst, composite: composite === "t", generic: generic === "t" };
});
const uncovered = tenantFks.filter((fk) => !fk.composite && !fk.generic && !dedicatedGuards.includes(`${fk.src}.${fk.col}`));
if (uncovered.length === 0) ok(`every tenant-to-tenant foreign key (${tenantFks.length}) is ownership-checked`);
else fail("tenant foreign keys without an ownership check", uncovered.map((fk) => `${fk.src}.${fk.col}->${fk.dst}`).join(", "));

// The SECURITY DEFINER surface clients can reach is exactly this reviewed
// list; each one checks auth.uid() membership itself (sections above).
const clientDefinerAllowlist = [
  "create_business_with_owner", "faq_create_revision", "faq_review_revision", "faq_withdraw", "is_business_admin",
  "is_business_member", "knowledge_create_document_revision", "knowledge_review_revision", "knowledge_submit_revision",
  "knowledge_withdraw_document", "review_learning_proposal",
];
const definerSql = (role, extra = "") => `select coalesce(string_agg(distinct p.proname, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and has_function_privilege('${role}', p.oid, 'execute') ${extra}
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');`;
expectCount(definerSql("authenticated"), clientDefinerAllowlist.join(","), "authenticated can execute only the reviewed SECURITY DEFINER functions");
expectCount(definerSql("anon"), "", "anon can execute no SECURITY DEFINER function (trigger functions included)");
expectCount(
  `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');`,
  0,
  "every SECURITY DEFINER function pins its search_path",
);
// TRUNCATE ignores RLS; REFERENCES and TRIGGER are schema-level powers.
// Supabase grants all three to clients by default (see the CI stubs).
expectCount(
  `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace, (values ('anon'), ('authenticated')) r(name)
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and (has_table_privilege(r.name, c.oid, 'truncate') or has_table_privilege(r.name, c.oid, 'references') or has_table_privilege(r.name, c.oid, 'trigger'));`,
  0,
  "no client role holds TRUNCATE, REFERENCES or TRIGGER on any public table",
);
expectCount(
  `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'S'
     and (has_sequence_privilege('anon', c.oid, 'usage') or has_sequence_privilege('anon', c.oid, 'select')
          or has_sequence_privilege('anon', c.oid, 'update') or has_sequence_privilege('authenticated', c.oid, 'update'));`,
  0,
  "anon holds no sequence privilege and authenticated cannot setval",
);

// --- b. symmetric two-tenant fixture (table owner; triggers still fire, so
//        every insert here is also a same-tenant positive control) -----------
const pid = (kind, t, n = 1) => `${kind}0000000-0000-4000-8000-0000000000${t}${n}`;
const tenantsP2 = [
  { t: "a", biz: bizA, uid: uA },
  { t: "b", biz: bizB, uid: uB },
];
for (const { t, biz } of tenantsP2) {
  const conv = `(select id from conversations where visitor_token = 'rls-token-${t}')`;
  const lead = `(select id from leads where business_id = '${biz}' order by created_at limit 1)`;
  psql(`
insert into staff_members (id, business_id, name) values ('${pid("5", t, 1)}', '${biz}', 'P2 staff ${t}1'), ('${pid("5", t, 2)}', '${biz}', 'P2 staff ${t}2');
insert into appointments (id, business_id, staff_id, conversation_id, lead_id, service_name, visitor_name, starts_at, ends_at, status)
  values ('${pid("6", t)}', '${biz}', '${pid("5", t, 1)}', ${conv}, ${lead}, 'P2 visit', 'P2 visitor', '2031-01-01T10:00Z', '2031-01-01T11:00Z', 'confirmed');
insert into appointment_feedback (appointment_id, business_id, rating) values ('${pid("6", t)}', '${biz}', 5);
insert into appointment_reminders (appointment_id, business_id, channel, send_at) values ('${pid("6", t)}', '${biz}', 'sms', '2031-01-01T09:00Z');
insert into intake_responses (appointment_id, business_id, answers) values ('${pid("6", t)}', '${biz}', '{}');
insert into booking_drafts (conversation_id, business_id) values (${conv}, '${biz}');
insert into business_settings (business_id) values ('${biz}') on conflict (business_id) do nothing;
insert into scheduling_settings (business_id) values ('${biz}') on conflict (business_id) do nothing;
insert into calendar_connections (id, business_id, staff_id, provider, calendar_ref, access_token, refresh_token)
  values ('${pid("c", t)}', '${biz}', '${pid("5", t, 1)}', 'google', 'p2-calendar-${t}', 'synthetic-ciphertext-${t}', 'synthetic-ciphertext-${t}');
insert into customers (id, business_id, name) values ('${pid("7", t, 1)}', '${biz}', 'P2 customer ${t}'), ('${pid("7", t, 2)}', '${biz}', 'P2 duplicate ${t}');
update customers set merged_into = '${pid("7", t, 1)}' where id = '${pid("7", t, 2)}';
insert into customer_timeline (business_id, customer_id, kind) values ('${biz}', '${pid("7", t, 1)}', 'note');
insert into usage_events (business_id, event_type) values ('${biz}', 'conversation_started');
insert into messages (conversation_id, business_id, role, content) values (${conv}, '${biz}', 'user', 'p2 hello ${t}');
insert into workflows (id, business_id, name, trigger) values ('${pid("8", t)}', '${biz}', 'P2 workflow ${t}', 'conversation.started');
insert into workflow_events (id, business_id, type) values ('${pid("9", t)}', '${biz}', 'conversation.started');
insert into workflow_runs (id, workflow_id, business_id, event_id) values ('${pid("a", t)}', '${pid("8", t)}', '${biz}', '${pid("9", t)}');
insert into workflow_run_logs (run_id, step_id, status) values ('${pid("a", t)}', 'p2-step', 'succeeded');
insert into workflow_timers (business_id, event_type, fire_at) values ('${biz}', 'p2.timer', '2031-01-01T00:00Z');
`);
}
// Tenant B gets what only tenant A had: a campaign with a claimed contact,
// lead events, a learning proposal and approved knowledge plus an FAQ.
psql(asService(`
insert into customers (id, business_id, name, phone) values ('${pid("7", "b", 3)}', '${bizB}', 'P2 callable b', '+15551230002');
insert into campaigns (id, business_id, agent_id, agent_version_id, phone_number_id, name, state, weekdays, start_minute, end_minute)
values ('${pid("d", "b")}', '${bizB}', ${agentOf(bizB)}, ${versionOf(bizB)}, (select id from phone_numbers where business_id = '${bizB}' limit 1), 'P2 B campaign', 'active', '{0,1,2,3,4,5,6}', 0, 1440);
insert into campaign_contacts (id, business_id, campaign_id, customer_id, consent_at) values ('${pid("e", "b")}', '${bizB}', '${pid("d", "b")}', '${pid("7", "b", 3)}', now());
select * from claim_campaign_contacts('${bizB}', '${pid("d", "b")}', 1);
select transition_lead('${bizB}', '${pid("7", "b", 1)}', 'p2-b-event', 'CONTACTING', 'campaign');
insert into learning_proposals (business_id, source_version_id, proposal_key, rationale, candidate_config, candidate_prompt)
values ('${bizB}', ${versionOf(bizB)}, 'p2-b', 'P2 rationale', '{}', 'P2 candidate');
`));
const [docB, revB] = val(createDoc(uB, bizB, null, "P2 B doc", "kappaword tenant b text", colB1)).split("|");
index(bizB, docB, revB, ["kappaword tenant b text"], 0.3);
psql(asUser(uB, `select knowledge_submit_revision('${revB}'); select knowledge_review_revision('${revB}', true);`));
const [, faqRevB] = val(createFaq(uB, bizB, null, "Kappaword hours?", "Kappaword tenant b answer.")).split("|");
psql(asUser(uB, `select faq_review_revision('${faqRevB}', true);`));
// WS4 audit fixtures are required before the generic non-vacuous table sweep.
psql(asService(`insert into audit_logs (operation_id,business_id,actor_id,action,outcome,reason,correlation_id) values
 (gen_random_uuid(),'${bizA}','${uA}','api_access','attempted','authorized',gen_random_uuid()),
 (gen_random_uuid(),'${bizB}','${uB}','api_access','denied','forbidden',gen_random_uuid()),
 (gen_random_uuid(),null,null,'api_access','denied','unauthenticated',gen_random_uuid());`));
expectNothing(asUser(uA, `select count(*) from audit_logs where business_id is null or business_id = '${bizB}';`), "audit: member cannot read unscoped or foreign security records");
for (const role of ["anon", "authenticated", "service_role"]) {
 for (const statement of ["update audit_logs set reason = 'completed'", "delete from audit_logs", "truncate audit_logs"]) {
  expectRefused(`begin; set local role ${role}; ${statement}; rollback;`, /permission denied/, `audit: ${role} cannot ${statement.split(" ")[0]}`);
 }
}
expectRefused(asUser(uA, `insert into audit_logs (operation_id,business_id,actor_id,action,outcome,reason,correlation_id) values
 (gen_random_uuid(),'${bizA}','${uA}','api_access','succeeded','completed',gen_random_uuid());`), /permission denied/, "audit: clients cannot fabricate success records");
expectRefused(asService(`insert into audit_logs (operation_id,action,outcome,reason,correlation_id) values
 (gen_random_uuid(),'api_access','denied','synthetic-private-token',gen_random_uuid());`), /check constraint/, "audit: arbitrary reason strings refused");
ok("audit: service-only append, immutable to application roles; server timestamps and bounded fields");

ok("phase 2 fixture: both tenants own rows in every tenant table (same-tenant references accepted by the triggers)");

const tenantTables = psql(
  `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped)
   order by 1;`,
  true,
).trim().split("\n").filter(Boolean);
const gaps = tenantTables.filter((table) => val(`select count(*) filter (where business_id = '${bizA}') > 0 and count(*) filter (where business_id = '${bizB}') > 0 from public.${table};`) !== "t");
if (gaps.length === 0) ok(`fixture is non-vacuous: tenants A and B both own rows in all ${tenantTables.length} tenant tables`);
else fail("fixture gap (sweep would be vacuous)", gaps.join(", "));

// Insertable copy of a row: every column except generated ones and a
// defaulted id, so the copy gets a fresh primary key.
const insertableColumns = (table) => val(`select string_agg(quote_ident(a.attname), ',' order by a.attnum) from pg_attribute a
  where a.attrelid = 'public.${table}'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
    and not (a.attname = 'id' and a.atthasdef);`);
const rowJson = (table, biz, where = "") => val(`select row_to_json(t)::text from public.${table} t where business_id = '${biz}' ${where} limit 1;`);
const insertCopy = (table, json, overrides = {}) => {
  const cols = insertableColumns(table);
  return `insert into public.${table} (${cols}) select ${cols} from jsonb_populate_record(null::public.${table}, $p2json$${JSON.stringify({ ...JSON.parse(json), ...overrides })}$p2json$::jsonb);`;
};

// --- c. generic sweep: tenant A against tenant B, every tenant table -----------
// The copy drops B's live-version pointer so RLS, not the 0018 trigger, is what
// refuses it: this loop proves the policies; the loop after it, the triggers.
const sweepOverrides = { agents: { live_version_id: null } };
for (const table of tenantTables) {
  expectNothing(asUser(uA, `select count(*) from public.${table} where business_id <> '${bizA}';`), `sweep ${table}: tenant A reads no other tenant's rows`);
  expectNothing(asAnon(`select count(*) from public.${table};`), `sweep ${table}: authenticated without a JWT reads nothing`);
  expectNothing(`begin; set local role anon; select count(*) from public.${table}; commit;`, `sweep ${table}: the anon role reads nothing`);
  expectRefused(rollback(asUser(uA, insertCopy(table, rowJson(table, bizB), sweepOverrides[table]))), /row-level security|permission denied/, `sweep ${table}: tenant A cannot insert a tenant B row`);
  expectNothing(rollback(asUser(uA, `with u as (update public.${table} set business_id = business_id where business_id = '${bizB}' returning 1) select count(*) from u;`)), `sweep ${table}: tenant A updates no tenant B row`);
  expectNothing(rollback(asUser(uA, `with d as (delete from public.${table} where business_id = '${bizB}' returning 1) select count(*) from d;`)), `sweep ${table}: tenant A deletes no tenant B row`);
  try {
    const moved = psql(rollback(asUser(uA, `with u as (update public.${table} set business_id = '${bizB}' where business_id = '${bizA}' returning 1) select count(*) from u;`)), true).trim();
    if (moved === "0") ok(`sweep ${table}: tenant A cannot relabel its rows as tenant B's = 0`);
    else fail(`sweep ${table}: relabel`, `${moved} row(s) moved to tenant B`);
  } catch (error) {
    const reason = errorLine(error);
    if (/row-level security|permission denied|same business|immutable|identity/.test(reason)) ok(`sweep ${table}: tenant A cannot relabel its rows as tenant B's (refused: ${reason.slice(0, 100)})`);
    else fail(`sweep ${table}: relabel`, `unexpected error: ${reason}`);
  }
}
expectNothing(asUser(uA, `select count(*) from businesses where id <> '${bizA}';`), "sweep businesses: tenant A reads no other tenant");
expectNothing(rollback(asUser(uA, `with u as (update businesses set name = name where id = '${bizB}' returning 1) select count(*) from u;`)), "sweep businesses: tenant A updates no other tenant");
expectNothing(rollback(asUser(uA, `with d as (delete from businesses where id = '${bizB}' returning 1) select count(*) from d;`)), "sweep businesses: tenant A deletes no other tenant");
expectRefused(rollback(asUser(uA, `insert into businesses (name, slug) values ('Injected', 'injected-tenant');`)), /row-level security|permission denied/, "sweep businesses: a direct tenant insert is refused (create_business_with_owner only)");
expectNothing(asUser(uA, `select count(*) from workflow_run_logs where run_id = '${pid("a", "b")}';`), "sweep workflow_run_logs: tenant A reads no log of tenant B's run");
expectNothing(rollback(asUser(uA, `with d as (delete from workflow_run_logs where run_id = '${pid("a", "b")}' returning 1) select count(*) from d;`)), "sweep workflow_run_logs: tenant A deletes no log of tenant B's run");

// Every tenant-to-tenant reference refuses a row that points at another
// tenant's parent — even for service_role, which bypasses RLS entirely.
const rowHints = { tool_executions: "and status in ('started', 'rejected')", customers: "and lead_state = 'NEW' and merged_into is null" };
for (const fk of tenantFks.filter((f) => !f.composite)) {
  const json = rowJson(fk.src, bizA, rowHints[fk.src] ?? "");
  const foreignParent = val(`select id from public.${fk.dst} where business_id = '${bizB}' order by id limit 1;`);
  if (!json || !foreignParent) {
    fail(`cross-tenant ${fk.src}.${fk.col}`, "fixture lacks a tenant A row or a tenant B parent");
    continue;
  }
  expectRefused(rollback(asService(insertCopy(fk.src, json, { [fk.col]: foreignParent }))), TENANT_REFUSAL, `service_role cannot point tenant A's ${fk.src}.${fk.col} at tenant B's ${fk.dst}`);
}

// --- d. targeted cases ------------------------------------------------------------
// The confirmed client-reachable gaps, as the real roles that could exploit them.
const agentB = val(asService(`select ${agentOf(bizB)};`));
expectRefused(
  rollback(asUser(uA, `insert into agent_versions (agent_id, business_id, version, prompt_template, prompt_version) values ('${agentB}', '${bizA}', 9001, 'squat', 'p2');`)),
  /same business/,
  "a tenant A admin cannot attach a version to tenant B's agent (would squat B's version numbers)",
);
// Foreign ids are resolved by service_role and passed as literals, exactly as
// an attacker who learned them would; a subquery as the member would see
// nothing through RLS and only set the column to NULL.
const conversationB = val(asService(`select id from conversations where visitor_token = 'rls-token-b';`));
expectRefused(
  rollback(asUser(uC, `update leads set conversation_id = '${conversationB}' where business_id = '${bizA}';`)),
  /same business/,
  "a tenant A member cannot link a lead to tenant B's conversation",
);
const leadB = val(asService(`select id from leads where business_id = '${bizB}' limit 1;`));
for (const [col, value, what] of [["staff_id", pid("5", "b", 2), "staff member"], ["conversation_id", conversationB, "conversation"], ["lead_id", leadB, "lead"]]) {
  expectRefused(
    rollback(asUser(uC, `update appointments set ${col} = '${value}' where id = '${pid("6", "a")}';`)),
    /same business/,
    `a tenant A member cannot point an appointment at tenant B's ${what}`,
  );
}
expectCount(
  rollback(asUser(uC, `with u as (update appointments set staff_id = '${pid("5", "a", 2)}' where id = '${pid("6", "a")}' returning 1) select count(*) from u;`)),
  1,
  "positive control: a member can still reassign an appointment to another staff member of the same tenant",
);
// The exclusion constraint is keyed on staff and time across tenants, so a
// foreign appointment on B's staff member would block B's own booking. The
// attempt commits if it is not refused, then B books that exact slot.
try { psql(asUser(uC, `update appointments set staff_id = '${pid("5", "b", 2)}' where id = '${pid("6", "a")}';`)); } catch { /* refused: asserted above */ }
try {
  const booked = val(rollback(asService(`with i as (insert into appointments (business_id, staff_id, starts_at, ends_at, status) values ('${bizB}', '${pid("5", "b", 2)}', '2031-01-01T10:00Z', '2031-01-01T11:00Z', 'confirmed') returning 1) select count(*) from i;`)));
  if (booked === "1") ok("tenant B can still book the slot tenant A tried to occupy on B's staff member");
  else fail("tenant B booking after A's attempt", `inserted ${booked}`);
} catch (error) {
  fail("tenant B booking after A's attempt", `blocked: ${errorLine(error)}`);
}
// The conversation identity guard (0021) validates the receptionist only
// through the agent's slug, and tenant admins choose agent slugs. An agent in
// tenant A named after tenant B's receptionist passes that guard; the 0034
// reference check is what refuses the conversation.
const slugAgent = val(asUser(uA, `insert into agents (business_id, type, slug, display_name) values ('${bizA}', 'receptionist', '${rB}', 'Named after B') returning id;`));
const slugVersion = val(asService(`insert into agent_versions (agent_id, business_id, version, prompt_template, prompt_version, published_at)
  values ('${slugAgent}', '${bizA}', 1, 'slug squat', 'p2', now()) returning id;`));
expectRefused(
  rollback(asService(`insert into conversations (business_id, receptionist_id, visitor_token, channel, agent_id, agent_version_id)
    values ('${bizA}', '${rB}', 'p2-slug-squat', 'chat', '${slugAgent}', '${slugVersion}');`)),
  /conversations\.receptionist_id must reference a row of receptionists in the same business/,
  "an agent named after tenant B's receptionist cannot open a tenant A conversation on B's receptionist",
);
expectCount(asService(`select count(*) from tenant_reference_census();`), 0, "census: no existing row references another tenant's parent");
expectRefused(asUser(uA, `select * from tenant_reference_census();`), /permission denied for function tenant_reference_census/, "clients cannot run the tenant-reference census");

// TRUNCATE ignores RLS: a client must not be able to empty a shared table.
for (const role of ["anon", "authenticated"]) {
  expectRefused(`begin; set local role ${role}; truncate public.usage_events; rollback;`, /permission denied/, `${role} cannot TRUNCATE a table holding every tenant's rows`);
}
expectCount(`select count(distinct business_id) from usage_events;`, 2, "both tenants' usage events survived the TRUNCATE attempts");

// Calendar credentials never reach a client, even the owning tenant's admin.
expectCount(asService(`select count(*) from calendar_connections where business_id in ('${bizA}', '${bizB}');`), 2, "service role sees both tenants' calendar connections");
expectNothing(asUser(uA, `select count(*) from calendar_connections;`), "a tenant owner reads no calendar connection, not even its own");
expectNothing(asUser(uA, `select count(*) from calendar_connections where access_token is not null or refresh_token is not null;`), "a tenant owner reads no calendar credential column");
expectRefused(
  rollback(asUser(uA, `insert into calendar_connections (business_id, provider, calendar_ref) values ('${bizA}', 'google', 'p2-injected');`)),
  /row-level security|permission denied/,
  "a tenant owner cannot create a calendar connection directly (server-side OAuth only)",
);
expectNothing(rollback(asUser(uA, `with u as (update calendar_connections set calendar_ref = 'hijacked' returning 1) select count(*) from u;`)), "a tenant owner updates no calendar connection");
expectNothing(`begin; set local role anon; select count(*) from calendar_connections; commit;`, "the anon role reads no calendar connection");

// 0037: one business-level (staff_id IS NULL) connection per business and
// provider. Every case runs as the service role, the only writer, and rolls back.
const businessLevel = (biz, provider, ref) =>
  `insert into calendar_connections (business_id, staff_id, provider, calendar_ref) values ('${biz}', null, '${provider}', '${ref}');`;
expectCount(
  `select count(*) from pg_indexes where schemaname = 'public' and tablename = 'calendar_connections'
     and indexname = 'calendar_connections_business_level_unique'
     and indexdef like 'CREATE UNIQUE INDEX%(business_id, provider) WHERE (staff_id IS NULL)';`,
  1,
  "0037: business-level calendar uniqueness is a partial unique index on (business_id, provider)",
);
expectRefused(
  rollback(asService(`${businessLevel(bizA, "google", "first")}\n${businessLevel(bizA, "google", "second")}`)),
  /duplicate key value violates unique constraint "calendar_connections_business_level_unique"/,
  "0037: a second business-level google connection for one business is rejected",
);
expectCount(
  rollback(asService(`${businessLevel(bizA, "google", "a-google")}\n${businessLevel(bizA, "outlook", "a-outlook")}\n${businessLevel(bizB, "google", "b-google")}
select count(*) from calendar_connections where staff_id is null and business_id in ('${bizA}', '${bizB}');`)),
  3,
  "0037: other providers and other tenants keep their own business-level connection",
);
expectCount(
  rollback(asService(`${businessLevel(bizA, "google", "business")}
insert into calendar_connections (business_id, staff_id, provider, calendar_ref) values ('${bizA}', '${pid("5", "a", 2)}', 'google', 'second-staff');
with u as (update calendar_connections set calendar_ref = 'reconnected' where business_id = '${bizA}' and provider = 'google' and staff_id is null returning 1)
select (select count(*) from u) || ',' || (select count(*) from calendar_connections where business_id = '${bizA}' and provider = 'google');`)),
  "1,3",
  "0037: staff-level rows beside the business-level row stay allowed, and an in-place reconnect updates it",
);
expectRefused(
  rollback(asService(`insert into calendar_connections (business_id, staff_id, provider, calendar_ref) values ('${bizA}', '${pid("5", "a", 1)}', 'google', 'duplicate-staff');`)),
  /duplicate key value violates unique constraint "calendar_connections_business_id_staff_id_provider_key"/,
  "0008: a duplicate staff-level connection is still rejected by the original constraint",
);

// A pooled connection carries no tenant context from one transaction into the
// next: PostgREST sets the JWT claim and role per transaction (set local).
const session = psql(`
begin; do $$ begin perform set_config('request.jwt.claim.sub', '${uA}', true); end $$; set local role authenticated; select count(*) > 0 from leads; commit;
select current_user = session_user;
begin; set local role authenticated; select count(*) from leads; commit;
begin; do $$ begin perform set_config('request.jwt.claim.sub', '${uB}', true); end $$; set local role authenticated; select count(*) from leads where business_id = '${bizA}'; commit;
select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), 'unset');
`, true).trim().split("\n").map((line) => line.trim());
if (JSON.stringify(session) === JSON.stringify(["t", "t", "0", "0", "unset"])) ok("one reused session: tenant context and role end with each transaction (A, then none, then B)");
else fail("session reuse", `got ${JSON.stringify(session)}`);

// Missing or invalid tenant context fails closed.
expectRefused(asUser("not-a-uuid", `select count(*) from leads;`), /invalid input syntax for type uuid/, "a malformed JWT subject is refused, not read as anyone");
expectCount(asUser("", `select count(*) from leads;`), 0, "an empty JWT subject reads nothing");
expectCount(
  asUser("22222222-2222-2222-2222-222222222222", `select (select count(*) from leads) + (select count(*) from conversations) + (select count(*) from knowledge_document_revisions) + (select count(*) from tool_executions) + (select count(*) from appointments);`),
  0,
  "an authenticated user with no membership reads nothing",
);
psql(`delete from business_members where business_id = '${bizA}' and user_id = '${uC}';`);
expectCount(asUser(uC, `select count(*) from knowledge_document_revisions where business_id = '${bizA}';`), 0, "removing a membership revokes access on the next statement (no cached tenant)");
psql(`insert into business_members (business_id, user_id, role) values ('${bizA}', '${uC}', 'member');`);

// Knowledge: tenant B's approved content is served to B only, on both paths.
expectCount(search(bizB, "kappaword"), 2, "tenant B's approved document and FAQ are served to tenant B (keyword)");
expectCount(search(bizA, "kappaword"), 0, "tenant A never retrieves tenant B's approved content (keyword)");
expectCount(vsearch(bizA, "'{}'::uuid[]", 0.3), 0, "tenant A never retrieves tenant B's approved chunks (vector)");
expectRefused(search(bizA, "kappaword", `array['${colB1}']::uuid[]`), /scope names an unknown collection/, "tenant A naming tenant B's collection is denied as unknown (no existence oracle), not widened");

if (failures > 0) {
  console.error(`\ncheck-rls FAILED with ${failures} assertion(s).`);
  process.exit(1);
}
console.log("\ncheck-rls OK — tenant isolation holds as the real authenticated/service_role roles.");
