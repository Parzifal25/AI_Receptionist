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
 * local `docker run pgvector/pgvector:pg16`). It refuses to run against the
 * Supabase CLI stack (port 54322) unless CHECK_RLS_ALLOW_DESTRUCTIVE=1,
 * because that database holds the developer's local data — running it there
 * silently destroys the dev environment.
 *
 * Requires `psql` on PATH. Exits non-zero on the first failed assertion.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const stubsFile = path.join(root, "infrastructure", "ci", "supabase-stubs.sql");

const databaseUrl =
  process.argv[2] ?? process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Guard: 54322 is the Supabase CLI's local database — a developer's working
// environment, not a throwaway. This script drops its schemas, so refuse by
// default rather than destroy it.
if (/:54322\b/.test(databaseUrl) && process.env.CHECK_RLS_ALLOW_DESTRUCTIVE !== "1") {
  console.error(
    `check-rls refuses to run against the local Supabase stack (${databaseUrl}).\n` +
      "This script DROPS the public/auth/storage schemas and rebuilds them, which\n" +
      "destroys your local data. Point it at a throwaway Postgres instead:\n\n" +
      "  docker run -d --name halo-rls-check -e POSTGRES_PASSWORD=postgres \\\n" +
      "    -p 55433:5432 pgvector/pgvector:pg16\n" +
      "  psql postgresql://postgres:postgres@127.0.0.1:55433/postgres \\\n" +
      "    --set ON_ERROR_STOP=1 -f infrastructure/ci/supabase-stubs.sql\n" +
      "  npm run check:rls -- postgresql://postgres:postgres@127.0.0.1:55433/postgres\n\n" +
      "Set CHECK_RLS_ALLOW_DESTRUCTIVE=1 only if you really mean to wipe 54322.",
  );
  process.exit(1);
}

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
console.log(`check-rls — verifying RLS as real roles on ${databaseUrl}`);
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

if (failures > 0) {
  console.error(`\ncheck-rls FAILED with ${failures} assertion(s).`);
  process.exit(1);
}
console.log("\ncheck-rls OK — tenant isolation holds as the real authenticated/service_role roles.");
