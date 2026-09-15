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
 * Defaults to the local Supabase CLI database URL when no argument is given.
 * Exits non-zero on the first failure. Requires `psql` on PATH.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");

const databaseUrl =
  process.argv[2] ??
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

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

for (const file of files) {
  const sql = readFileSync(path.join(migrationsDir, file), "utf8");
  try {
    psql(`BEGIN;\n${sql}\nCOMMIT;`);
    console.log(`  ✅ ${file}`);
  } catch (err) {
    console.error(`  ❌ ${file} failed to apply:\n${err.stderr ?? err.message}`);
    process.exit(1);
  }
}

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
  { table: "knowledge_documents", columns: ["id", "business_id", "title", "content", "source_type", "source_ref", "status", "created_at", "updated_at", "collection_id"] },
  // HALO Phase 2 — agent runtime conversation state (0019).
  { table: "conversation_state", columns: ["conversation_id", "business_id", "state", "state_version", "updated_at"] },
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

if (failed) {
  console.error("check:migrations — schema drift detected");
  process.exit(1);
}

console.log("check:migrations — all migrations apply and all asserted columns exist ✅");
