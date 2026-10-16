#!/usr/bin/env node
/**
 * Migration sanity check (plan P0.5 `check:migrations`).
 *
 * Applies every file in supabase/migrations/ in order to a Postgres database
 * and then verifies that columns referenced by application queries actually
 * exist — the class of bug behind the calendar_connections.status incident.
 *
 * Usage:
 *   node scripts/check-migrations.mjs <postgres-url>
 *
 * Requires HALO_DISPOSABLE_DATABASE=1 and an explicit loopback URL naming
 * halo_check_<suffix> (argument or HALO_DISPOSABLE_DB_URL). No developer fallback.
 * Exits non-zero on the first failure. Requires `psql` on PATH.
 */
import { requireDisposableDatabase } from "./disposable-database.mjs";
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");

const databaseUrl = requireDisposableDatabase(process.argv[2], process.env);

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error("check:migrations — no migration files found");
  process.exit(1);
}

const psql = (sql, capture = false) =>
  execFileSync("psql", [databaseUrl, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", ...(capture ? ["--tuples-only", "--no-align"] : []), "--quiet"], {
    input: sql,
    encoding: "utf8",
  });

console.log(`check:migrations — applying ${files.length} migrations to a throwaway database`);

const FIXTURE_BUSINESS = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // created after 0013 below

/**
 * P2-R1 / 0037 on a database that already holds duplicate business-level
 * calendar connections: the guard must abort the whole file, report a count
 * only (no tenant identifier), create no index and change no row. The
 * duplicates are then removed by this harness — never by the migration — so
 * the chain continues.
 */
function refuseCalendarDuplicates(sql) {
  psql(`insert into calendar_connections (business_id, staff_id, provider, calendar_ref) values
    ('${FIXTURE_BUSINESS}', null, 'google', 'p2r1-duplicate-1'), ('${FIXTURE_BUSINESS}', null, 'google', 'p2r1-duplicate-2');`);
  let refusal = "";
  try { psql(`BEGIN;\n${sql}\nCOMMIT;`); } catch (err) { refusal = String(err.stderr ?? err.message); }
  const rows = psql(`select count(*) from calendar_connections where business_id = '${FIXTURE_BUSINESS}' and staff_id is null;`, true).trim();
  const index = psql(`select count(*) from pg_indexes where indexname = 'calendar_connections_business_level_unique';`, true).trim();
  if (!/0037: 1 business-level calendar connection group\(s\) are duplicated/.test(refusal) || refusal.includes(FIXTURE_BUSINESS) || rows !== "2" || index !== "0") {
    console.error(`  ❌ 0037 did not refuse existing duplicates cleanly: rows=${rows} index=${index} refusal=${refusal.trim().slice(0, 200)}`);
    process.exit(1);
  }
  console.log("  ✅ 0037 refuses pre-existing duplicate business-level calendar connections: count only, no index, no row changed");
  psql(`delete from calendar_connections where business_id = '${FIXTURE_BUSINESS}' and calendar_ref like 'p2r1-duplicate-%';`);
}

/** One psql session; resolves with its exit code, stderr and wall time. */
function session(sql) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("psql", [databaseUrl, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--quiet"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr, ms: Date.now() - started }));
    child.stdin.end(sql);
  });
}

for (const file of files) {
  const sql = readFileSync(path.join(migrationsDir, file), "utf8");
  try {
    if (file.startsWith("0037_")) refuseCalendarDuplicates(sql);
    psql(`BEGIN;\n${sql}\nCOMMIT;`);
    console.log(`  ✅ ${file}`);
    if (file === "0013_agents.sql") {
      // Seed legacy conversations for two receptionist identities in one
      // tenant. Migration 0015 must preserve this exact mapping rather than
      // assigning every conversation to an arbitrary tenant receptionist.
      psql(`
        insert into businesses (id, name, slug)
        values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Alpha migration fixture', 'alpha-migration-fixture');
        insert into receptionists (id, business_id, name, widget_key) values
          ('ffffffff-ffff-4fff-8fff-fffffffffff1', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Alpha receptionist one', 'alpha-migration-widget-one'),
          ('ffffffff-ffff-4fff-8fff-fffffffffff2', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Alpha receptionist two', 'alpha-migration-widget-two');
        insert into conversations (business_id, receptionist_id, visitor_token, channel) values
          ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-fffffffffff1', 'alpha-migration-conversation-one', 'chat'),
          ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-fffffffffff2', 'alpha-migration-conversation-two', 'chat');
      `);
    }
    if (file === "0014_agent_backfill.sql") {
      // Model a legacy conversation whose receptionist has no exact agent
      // mapping. Migration 0015 must leave it unlinked instead of guessing.
      psql(`
        insert into receptionists (id, business_id, name, widget_key)
        values ('ffffffff-ffff-4fff-8fff-fffffffffff3', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Unmapped legacy receptionist', 'alpha-migration-widget-three');
        insert into conversations (business_id, receptionist_id, visitor_token, channel)
        values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-fffffffffff3', 'alpha-migration-unmapped-conversation', 'chat');
      `);
    }
  } catch (err) {
    console.error(`  ❌ ${file} failed to apply:\n${err.stderr ?? err.message}`);
    process.exit(1);
  }
}

const linkedFixtureCount = psql(`
  select count(*)
  from conversations c
  join agents a on a.id = c.agent_id
    and a.business_id = c.business_id
    and a.slug = c.receptionist_id::text
  join agent_versions av on av.id = c.agent_version_id
    and av.agent_id = a.id
    and av.business_id = c.business_id
  where c.visitor_token in (
    'alpha-migration-conversation-one',
    'alpha-migration-conversation-two'
  );
`, true).trim();
if (linkedFixtureCount !== "2") {
  console.error(`  ❌ legacy conversation identity fixture expected 2 correctly linked rows, got ${linkedFixtureCount}`);
  process.exit(1);
}
console.log("  ✅ legacy conversation identity fixture preserves each receptionist mapping");
const unmappedFixtureCount = psql(`
  select count(*)
  from conversations
  where visitor_token = 'alpha-migration-unmapped-conversation'
    and agent_id is null and agent_version_id is null;
`, true).trim();
if (unmappedFixtureCount !== "1") {
  console.error(`  ❌ legacy conversation without an exact receptionist agent mapping was not left fail-closed: ${unmappedFixtureCount}`);
  process.exit(1);
}
console.log("  ✅ legacy conversation without an exact mapping remains unlinked; no identity is guessed");

psql(`
  do $$ begin
    begin
      insert into conversations (business_id, receptionist_id, visitor_token, channel, agent_id, agent_version_id)
      values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-fffffffffff1', 'alpha-migration-reject-null', 'chat', null, null);
      raise exception using errcode = 'ZX001', message = 'missing identity insert unexpectedly succeeded';
    exception when check_violation then
      null;
    end;
    begin
      insert into conversations (business_id, receptionist_id, visitor_token, channel, agent_id, agent_version_id)
      select a1.business_id, 'ffffffff-ffff-4fff-8fff-fffffffffff1', 'alpha-migration-reject-mismatch', 'chat', a2.id, a2.live_version_id
      from agents a1 cross join agents a2
      where a1.slug = 'ffffffff-ffff-4fff-8fff-fffffffffff1'
        and a2.slug = 'ffffffff-ffff-4fff-8fff-fffffffffff2';
      raise exception using errcode = 'ZX001', message = 'receptionist mismatch insert unexpectedly succeeded';
    exception when check_violation then
      null;
    end;
  end $$;
`);
console.log("  ✅ new conversations reject missing and receptionist-mismatched identity tuples");

for (const file of ["0014_agent_backfill.sql", "0022_backfill_agents_created_after_0014.sql"]) {
  const sql = readFileSync(path.join(migrationsDir, file), "utf8");
  psql(`BEGIN;\n${sql}\nCOMMIT;`);
}
const idempotentFixtureCount = psql(`
  select count(*)
  from conversations c
  join agents a on a.id = c.agent_id
    and a.business_id = c.business_id
    and a.slug = c.receptionist_id::text
  join agent_versions av on av.id = c.agent_version_id
    and av.agent_id = a.id
  where c.visitor_token in (
    'alpha-migration-conversation-one',
    'alpha-migration-conversation-two'
  );
`, true).trim();
if (idempotentFixtureCount !== "2") {
  console.error(`  ❌ replaying the documented idempotent backfills changed legacy links: ${idempotentFixtureCount} valid rows`);
  process.exit(1);
}
console.log("  ✅ agent backfill migrations 0014 and 0022 replay without duplicate or changed fixture links");
const stillUnmappedFixtureCount = psql(`
  select count(*)
  from conversations
  where visitor_token = 'alpha-migration-unmapped-conversation'
    and agent_id is null and agent_version_id is null;
`, true).trim();
if (stillUnmappedFixtureCount !== "1") {
  console.error(`  ❌ replaying an agent backfill guessed an identity for an existing unmapped conversation: ${stillUnmappedFixtureCount}`);
  process.exit(1);
}
console.log("  ✅ replayed backfills do not guess identities for existing unmapped conversations");

// --- Schema assertions the application relies on ---------------------------
// Every column list below mirrors a production .select() in src/.
const assertions = [
  // scheduling-repository.ts getCalendarConnection() — must NOT reference
  // calendar_connections.status (verified absent from the schema).
  {
    table: "calendar_connections",
    columns: ["id", "provider", "calendar_ref", "access_token", "refresh_token", "expires_at", "basic_username", "basic_password", "staff_id", "business_id"],
  },
  { table: "appointments", columns: ["id", "business_id", "staff_id", "conversation_id", "service_name", "visitor_name", "visitor_phone", "visitor_email", "starts_at", "ends_at", "timezone", "status", "manage_token", "notes"] },
  { table: "booking_drafts", columns: ["conversation_id", "business_id", "service", "draft_date", "draft_time", "visitor_name", "visitor_email", "visitor_phone", "notes", "time_committed"] },
  { table: "workflow_runs", columns: ["id", "workflow_id", "business_id", "event_id", "status", "current_step", "attempt", "next_attempt_at"] },
  { table: "appointment_reminders", columns: ["id", "appointment_id", "business_id", "channel", "send_at", "status", "attempts", "last_error"] },
  { table: "usage_events", columns: ["id", "business_id", "event_type", "metadata"] },
  { table: "scheduling_settings", columns: ["business_id", "booking_enabled", "timezone", "slot_duration_minutes", "buffer_minutes", "min_notice_minutes", "max_advance_days", "holidays", "reminders_enabled", "reminder_lead_minutes", "location_address", "prep_instructions", "intake_form", "review_url", "auto_no_show_enabled", "no_show_grace_minutes"] },
  // HALO Phase 1 — agent model (0013_agents.sql).
  { table: "agents", columns: ["id", "business_id", "type", "slug", "display_name", "status", "live_version_id", "default_channel", "created_at", "updated_at"] },
  { table: "agent_versions", columns: ["id", "agent_id", "business_id", "version", "config", "prompt_template", "prompt_version", "model", "published_at", "created_by", "created_at"] },
  // HALO Phase 1 — conversation agent linkage (0015).
  { table: "conversations", columns: ["id", "business_id", "receptionist_id", "visitor_token", "channel", "status", "page_url", "user_agent", "message_count", "started_at", "last_message_at", "ended_at", "agent_id", "agent_version_id"] },
  // HALO Phase 1 — message tool foundation (0016).
  { table: "messages", columns: ["id", "conversation_id", "business_id", "role", "content", "created_at", "tool_call_id", "tool_name", "tool_args", "tool_result"] },
  // HALO Phase 1 — knowledge collections (0017).
  { table: "knowledge_collections", columns: ["id", "business_id", "name", "language", "embedding_model", "embedding_dim", "created_at", "updated_at"] },
  { table: "knowledge_documents", columns: ["id", "business_id", "title", "content", "source_type", "source_ref", "status", "created_at", "updated_at", "collection_id", "published_revision_id"] },
  // D14 — knowledge governance (0033). Mirrors packages/providers/knowledge/supabase-knowledge-provider.ts and src/features/{knowledge,faqs}.
  { table: "knowledge_document_revisions", columns: ["id", "business_id", "document_id", "revision", "title", "content", "content_sha256", "source_type", "source_ref", "origin", "state", "index_status", "chunk_count", "created_by", "created_at", "submitted_by", "submitted_at", "reviewed_by", "reviewed_at", "retired_by", "retired_at"] },
  { table: "faq_revisions", columns: ["id", "business_id", "faq_id", "revision", "question", "answer", "category", "content_sha256", "origin", "state", "created_by", "created_at", "reviewed_by", "reviewed_at", "retired_by", "retired_at"] },
  { table: "faqs", columns: ["id", "business_id", "question", "answer", "category", "sort_order", "is_published", "published_revision_id"] },
  { table: "knowledge_chunks", columns: ["id", "document_id", "business_id", "revision_id", "content", "chunk_index", "embedding"] },
  // HALO Phase 2 — agent runtime conversation state (0019).
  { table: "conversation_state", columns: ["conversation_id", "business_id", "state", "state_version", "updated_at"] },
  // D7 — tool-execution audit (0032). Mirrors packages/runtime/stores/supabase-tool-execution-audit-store.ts.
  { table: "tool_executions", columns: ["id", "business_id", "conversation_id", "agent_id", "agent_version_id", "channel", "turn_id", "correlation_id", "round", "intent_id", "tool_name", "idempotency_key", "side_effecting", "status", "rejection_reason", "error_code", "requested_at", "started_at", "finished_at", "created_at"] },
  // HALO Phase 3 — voice / telephony (0020). Mirrors packages/voice/stores/supabase-call-store.ts.
  { table: "phone_numbers", columns: ["id", "business_id", "agent_id", "provider", "e164", "handoff_number", "status", "label"] },
  { table: "calls", columns: ["id", "business_id", "agent_id", "agent_version_id", "conversation_id", "phone_number_id", "direction", "provider", "provider_call_id", "from_number", "to_number", "state", "state_changed_at", "answered_at", "ended_at", "duration_seconds", "hangup_cause", "language", "usage", "cost_estimate", "recording_ref", "recording_consent_at", "correlation_id"] },
  { table: "call_events", columns: ["id", "call_id", "business_id", "seq", "type", "at", "latency_ms", "detail"] },
  { table: "call_transcript_turns", columns: ["id", "call_id", "business_id", "seq", "turn_index", "speaker", "source", "text", "delivered_text", "delivery", "language", "stt_confidence", "turn_id", "started_at", "ended_at"] },
  { table: "conversation_outcomes", columns: ["id", "business_id", "conversation_id", "call_id", "agent_id", "agent_version_id", "disposition", "disposition_reason", "qualification", "appointment_id", "escalated", "do_not_call", "computed_by"] },
  { table: "phone_suppressions", columns: ["id", "business_id", "e164", "reason", "call_id", "created_at"] },
];

let failed = false;
for (const { table, columns } of assertions) {
  const sql = `
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '${table}';
  `;
  let existing;
  try {
    existing = psql(sql, true)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    console.error(`  ❌ could not introspect ${table}: ${err.stderr ?? err.message}`);
    process.exit(1);
  }

  if (existing.length === 0) {
    console.error(`  ❌ table ${table} does not exist after migrations`);
    failed = true;
    continue;
  }

  for (const column of columns) {
    if (!existing.includes(column)) {
      console.error(`  ❌ ${table}.${column} is referenced by application queries but does not exist`);
      failed = true;
    }
  }
}

// D14: on a database without legacy tenant mismatches, 0033 validates its
// composite tenant foreign keys instead of leaving them NOT VALID.
const unvalidated = psql(`
  select count(*) from pg_constraint
  where conname in ('knowledge_documents_collection_tenant_fk', 'knowledge_chunks_document_tenant_fk')
    and not convalidated;
`, true).trim();
if (unvalidated !== "0") {
  console.error(`  ❌ 0033 left ${unvalidated} composite tenant foreign key(s) NOT VALID on a clean database`);
  failed = true;
} else {
  console.log("  ✅ 0033 composite tenant foreign keys are validated on a clean database");
}

// P2-R1 / 0037: hold the winner's transaction open until PostgreSQL
// confirms that the losing insert is blocked on it. Process startup time
// cannot substitute for observed lock contention.
{
  const winner = spawn("psql", [databaseUrl, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--quiet"], { stdio: ["pipe", "pipe", "pipe"] });
  let winnerError = "";
  winner.stderr.on("data", chunk => { winnerError += chunk; });
  const winnerDone = new Promise(resolve => winner.on("close", code => resolve({ code, stderr: winnerError })));
  let readyTimer;
  const ready = new Promise((resolve, reject) => {
    let output = "";
    winner.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("halo_calendar_winner_ready")) { clearTimeout(readyTimer); resolve(); }
    });
    winner.on("error", reject);
    winner.on("close", () => { clearTimeout(readyTimer); reject(new Error("calendar race winner exited before release")); });
    readyTimer = setTimeout(() => reject(new Error("calendar race winner readiness timed out")), 10000);
  });
  winner.stdin.write(`begin;
    insert into calendar_connections (business_id, staff_id, provider, calendar_ref) values ('${FIXTURE_BUSINESS}', null, 'google', 'p2r1-race-1');
    \\echo halo_calendar_winner_ready
`);
  let loserDone;
  let observedBlocking = false;
  try {
    await ready;
    const application = `halo_calendar_loser_${process.pid}`;
    loserDone = session(`set application_name = '${application}';
      set statement_timeout = '15s';
      insert into calendar_connections (business_id, staff_id, provider, calendar_ref) values ('${FIXTURE_BUSINESS}', null, 'google', 'p2r1-race-2');`);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      observedBlocking = psql(`select exists (select 1 from pg_stat_activity where application_name = '${application}' and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0);`, true).trim() === "t";
      if (observedBlocking) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally {
    clearTimeout(readyTimer);
    winner.stdin.end("commit;\n");
  }
  const results = [await winnerDone, ...(loserDone ? [await loserDone] : [])];
  const won = results.filter(r => r.code === 0).length;
  const lost = results.filter(r => r.code !== 0 && /calendar_connections_business_level_unique/.test(r.stderr)).length;
  const rows = psql(`select count(*) from calendar_connections where business_id = '${FIXTURE_BUSINESS}' and staff_id is null and provider = 'google';`, true).trim();
  if (!observedBlocking || won !== 1 || lost !== 1 || rows !== "1") {
    console.error(`  ❌ 0037 concurrent first connects: won=${won} lost=${lost} observed-lock-wait=${observedBlocking} rows=${rows}`);
    failed = true;
  } else {
    console.log(`  ✅ 0037 concurrent first connects: observed PostgreSQL lock wait before winner commit; loser refused by unique index; one row remains`);
  }
  psql(`delete from calendar_connections where business_id = '${FIXTURE_BUSINESS}' and calendar_ref like 'p2r1-race-%';`);
}

if (failed) {
  console.error("check:migrations — schema drift detected");
  process.exit(1);
}

console.log("check:migrations — all migrations apply and all asserted columns exist ✅");
