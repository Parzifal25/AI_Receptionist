import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseToolExecutionAuditStore, toolExecutionRow } from "@halo/runtime/stores/supabase-tool-execution-audit-store";
import type { ToolAuditEntry } from "@halo/runtime/tools/audit";

/** Records every PostgREST builder call; answers with the configured result. */
function fakeClient(result: { error: { message: string } | null; data?: unknown[] | null }) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const op of ["insert", "update", "eq", "select"]) {
    builder[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return op === "insert" || op === "select" ? Promise.resolve({ data: result.data ?? null, error: result.error }) : builder;
    };
  }
  const client = { from: (table: string) => { calls.push({ op: "from", args: [table] }); return builder; } };
  return { client: client as unknown as SupabaseClient, calls };
}

const entry: ToolAuditEntry = {
  businessId: "11111111-1111-1111-1111-111111111111",
  conversationId: "22222222-2222-2222-2222-222222222222",
  agentId: "33333333-3333-3333-3333-333333333333",
  agentVersionId: "44444444-4444-4444-4444-444444444444",
  channelId: "phone-voice",
  turnId: "turn-1",
  correlationId: null,
  round: 0,
  intentId: "call_1",
  toolName: "save_contact_details",
  idempotencyKey: "a".repeat(32),
  sideEffecting: true,
  requestedAt: "2026-10-15T00:00:00.000Z",
};

const ROW_COLUMNS = ["agent_id", "agent_version_id", "business_id", "channel", "conversation_id", "correlation_id",
  "idempotency_key", "intent_id", "requested_at", "round", "side_effecting", "tool_name", "turn_id"];

describe("SupabaseToolExecutionAuditStore", () => {
  it("writes only allowlisted accountability columns", () => {
    expect(Object.keys(toolExecutionRow(entry)).sort()).toEqual(ROW_COLUMNS);
  });

  it("inserts a started row with the trusted tenant and returns a tenant-bound reference", async () => {
    const { client, calls } = fakeClient({ error: null });
    const ref = await new SupabaseToolExecutionAuditStore(client).recordStarted(entry, "2026-10-15T00:00:01.000Z");
    expect(calls[0]).toEqual({ op: "from", args: ["tool_executions"] });
    const row = calls[1]!.args[0] as Record<string, unknown>;
    expect(row).toMatchObject({ status: "started", business_id: entry.businessId, started_at: "2026-10-15T00:00:01.000Z" });
    expect(Object.keys(row).sort()).toEqual([...ROW_COLUMNS, "id", "started_at", "status"].sort());
    expect(ref).toEqual({ id: row.id, businessId: entry.businessId });
  });

  it("inserts rejections as final rows with their reason", async () => {
    const { client, calls } = fakeClient({ error: null });
    await new SupabaseToolExecutionAuditStore(client).recordRejected(entry, "not_granted", "2026-10-15T00:00:01.000Z");
    expect(calls[1]!.args[0]).toMatchObject({ status: "rejected", rejection_reason: "not_granted", finished_at: "2026-10-15T00:00:01.000Z" });
  });

  it("finalizes only the tenant's own still-started row and updates nothing else", async () => {
    const { client, calls } = fakeClient({ error: null, data: [{ id: "row-1" }] });
    await new SupabaseToolExecutionAuditStore(client).recordFinished(
      { id: "row-1", businessId: entry.businessId },
      { status: "failed", errorCode: "LEAD_WRITE_FAILED", finishedAt: "2026-10-15T00:00:02.000Z" },
    );
    expect(calls.find((c) => c.op === "update")!.args[0]).toEqual({ status: "failed", error_code: "LEAD_WRITE_FAILED", finished_at: "2026-10-15T00:00:02.000Z" });
    expect(calls.filter((c) => c.op === "eq").map((c) => c.args)).toEqual([
      ["id", "row-1"],
      ["business_id", entry.businessId],
      ["status", "started"],
    ]);
  });

  it("throws when a write fails so the runtime can apply its failure policy", async () => {
    await expect(new SupabaseToolExecutionAuditStore(fakeClient({ error: { message: "permission denied" } }).client).recordStarted(entry, entry.requestedAt))
      .rejects.toThrow(/insert failed/);
    await expect(new SupabaseToolExecutionAuditStore(fakeClient({ error: null, data: [] }).client)
      .recordFinished({ id: "row-1", businessId: entry.businessId }, { status: "succeeded", errorCode: null, finishedAt: entry.requestedAt }))
      .rejects.toThrow(/matched no started record/);
  });
});
