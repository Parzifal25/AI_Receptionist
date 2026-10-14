import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D7 — static checks of migration 0032_tool_executions. These read the SQL
 * text; they do NOT apply it. Database behaviour (RLS as real roles, the
 * triggers) is asserted by scripts/check-rls.mjs on a disposable database.
 */
const migrationsDir = path.resolve(__dirname, "../../supabase/migrations");
const sql = readFileSync(path.join(migrationsDir, "0032_tool_executions.sql"), "utf8");
const code = sql.replace(/--.*$/gm, "");
const tableBody = code.slice(code.indexOf("create table public.tool_executions"), code.indexOf("constraint tool_executions_lifecycle"));

describe("migration 0032_tool_executions (static)", () => {
  it("is the next contiguous, uniquely numbered migration", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(files.at(-1)).toBe("0032_tool_executions.sql");
    expect(files.every((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  it("has no column that could hold tool payloads, messages or contact data", () => {
    const columns = [...tableBody.matchAll(/^\s+([a-z_]+)\s+(?:uuid|text|smallint|boolean|timestamptz)/gm)].map((m) => m[1]);
    expect(columns.sort()).toEqual([
      "agent_id", "agent_version_id", "business_id", "channel", "conversation_id", "correlation_id", "created_at",
      "error_code", "finished_at", "id", "idempotency_key", "intent_id", "rejection_reason", "requested_at", "round",
      "side_effecting", "started_at", "status", "tool_name", "turn_id",
    ].sort());
    // No payload-capable column types; the exact column set above excludes payload names.
    expect(tableBody).not.toMatch(/\b(jsonb|json|bytea)\b/);
  });

  it("enables RLS, gives members tenant-scoped read only, and no client write path", () => {
    expect(code).toMatch(/alter table public\.tool_executions enable row level security;/);
    expect(code).toMatch(/create policy tool_executions_read on public\.tool_executions\s+for select to authenticated using \(public\.is_business_member\(business_id\)\);/);
    expect(code).not.toMatch(/create policy[^;]+for (insert|update|delete|all)/);
    expect(code).toMatch(/revoke all on public\.tool_executions from anon, authenticated;/);
    expect(code).toMatch(/grant select on public\.tool_executions to authenticated;/);
    expect(code).not.toMatch(/grant (insert|update|delete|all)[^;]* to (anon|authenticated)/);
  });

  it("enforces tenant ownership and the lifecycle with revoked security-definer triggers", () => {
    for (const fn of ["assert_tool_execution_ownership", "enforce_tool_execution_lifecycle"]) {
      expect(code).toMatch(new RegExp(`create or replace function public\\.${fn}\\(\\)[\\s\\S]+?security definer\\s+set search_path = public`));
      expect(code).toMatch(new RegExp(`revoke execute on function public\\.${fn}\\(\\) from public, anon, authenticated;`));
    }
    expect(code).toMatch(/create trigger tool_executions_ownership\s+before insert on public\.tool_executions/);
    expect(code).toMatch(/create trigger tool_executions_lifecycle\s+before insert or update on public\.tool_executions/);
    expect(code).toMatch(/new\.status not in \('started', 'rejected'\)/);
    expect(code).toMatch(/old\.status <> 'started'/);
  });

  it("allows one execution per action per turn and cascades with the conversation", () => {
    expect(code).toMatch(/create unique index tool_executions_one_execution_per_action\s+on public\.tool_executions \(business_id, turn_id, idempotency_key\)\s+where status <> 'rejected';/);
    expect(code).toMatch(/conversation_id\s+uuid not null references public\.conversations\(id\) on delete cascade/);
    expect(code).toMatch(/business_id\s+uuid not null references public\.businesses\(id\) on delete cascade/);
  });

  it("accepts exactly the runtime's rejection reasons", () => {
    const contracts = readFileSync(path.resolve(__dirname, "../../packages/runtime/contracts.ts"), "utf8");
    const union = contracts.slice(contracts.indexOf("export type ToolRejectionReason"), contracts.indexOf("export type ToolAuthorization"));
    const runtimeReasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    const block = code.slice(code.indexOf("rejection_reason in ("), code.indexOf("error_code"));
    const sqlReasons = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(sqlReasons).toEqual(runtimeReasons);
  });
});
