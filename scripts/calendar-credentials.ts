import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { getServerEnv } from "@halo/platform/env";
import {
  createCalendarCredentialFetch,
  assertLocalSupabaseIdentity,
  assertNoProxyConfiguration,
  planCalendarCredentialRun,
} from "@halo/platform/calendar-credential-target";
import {
  CALENDAR_CREDENTIAL_FIELDS,
  migrateCalendarCredentialBatch,
  verifyCalendarCredentialRow,
  type CalendarCredentialRow,
} from "@halo/platform/calendar-credential-migration";

/**
 * Resumable credential format migration. Default encrypts legacy plaintext;
 * --reencrypt rotates to the active key; --decrypt is the explicit rollback;
 * --verify-current checks format and authentication under the active key.
 * Never prints credentials. Run with secrets supplied by the secret manager.
 *
 * Local-only: every mode requires --target=http://127.0.0.1:55321 and an
 * effective NEXT_PUBLIC_SUPABASE_URL that is that same origin. Hosted and
 * unprovable targets are refused before any request is made.
 */
async function main(): Promise<void> {
// Fail closed before any client exists: every mode, read-only included, must
// name the local target and the effective URL must independently match it.
const plan = planCalendarCredentialRun(process.argv.slice(2), process.env.NEXT_PUBLIC_SUPABASE_URL);
const { mode, verifyOnly } = plan;
const batchSize = 250;
assertNoProxyConfiguration(process.env);
const env = getServerEnv();
const currentKey = env.CALENDAR_CREDENTIALS_ENCRYPTION_KEY;
if (!currentKey) throw new Error("CALENDAR_CREDENTIALS_ENCRYPTION_KEY is required");
// Supabase CLI status exposes local ANON_KEY and SERVICE_ROLE_KEY through
// `supabase status -o json` (also `-o env`). Capture JSON only in memory and
// compare its instance keys and API/DB URLs; never print or persist the output.
let status: Record<string, unknown>;
try {
  status = JSON.parse(execFileSync("supabase", ["status", "--workdir", process.cwd(), "--output", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
    timeout: 120_000,
  })) as Record<string, unknown>;
} catch {
  throw new Error("Could not verify the running local Supabase instance with the Supabase CLI");
}
assertLocalSupabaseIdentity(status, env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, env.SUPABASE_SERVICE_ROLE_KEY);
// Built from the proven origin rather than the shared admin client, with a
// fetch that refuses any other origin, table, or (when verifying) any write.
const db = createClient(plan.origin, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: createCalendarCredentialFetch(plan) },
});

let cursor: string | null = null;
let changed = 0;
let scanned = 0;
while (true) {
  let query = db
    .from("calendar_connections")
    .select("id, access_token, refresh_token, basic_username, basic_password")
    .order("id", { ascending: true })
    .limit(batchSize);
  if (cursor) query = query.gt("id", cursor);
  const { data: rows, error } = await query;
  if (error) throw new Error(`Calendar credential scan failed: ${error.message}`);
  if (!rows?.length) break;

  const batch = rows as unknown as CalendarCredentialRow[];
  if (verifyOnly) {
    for (const row of batch) verifyCalendarCredentialRow(row, currentKey);
  } else {
    changed += await migrateCalendarCredentialBatch(batch, mode, async (id, before, after) => {
      let update = db.from("calendar_connections").update(after).eq("id", id);
      for (const field of CALENDAR_CREDENTIAL_FIELDS) update = update.eq(field, before[field]);
      const result = await update.select("id").maybeSingle();
      if (result.error) throw new Error(`Calendar credential update failed for row ${id}: ${result.error.message}`);
      return Boolean(result.data);
    });
  }

  scanned += batch.length;
  cursor = batch[batch.length - 1].id;
  if (batch.length < batchSize) break;
}

console.log(
  verifyOnly
    ? `Calendar credential verification complete: ${scanned} row(s) authenticated with the active key.`
    : `Calendar credential migration complete: ${changed} changed, ${scanned} scanned (${mode}).`,
);
}

void main().catch((error: unknown) => {
  console.error("Calendar credential operation failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
