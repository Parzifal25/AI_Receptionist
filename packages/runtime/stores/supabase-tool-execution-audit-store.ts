import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import type { ToolRejectionReason } from "../contracts";
import type { ToolAuditEntry, ToolAuditRef, ToolExecutionAuditStore } from "../tools/audit";

/**
 * Postgres-backed tool-execution audit (migration 0032_tool_executions).
 *
 * Service-role writes with the trusted tenant on every statement; members
 * read their own tenant's rows through RLS. The database enforces the
 * lifecycle (insert as `started`/`rejected`; one update from `started` to a
 * final status; nothing else), tenant ownership of the conversation, agent
 * and version, and one execution per idempotency key per turn.
 *
 * Only the columns built by `toolExecutionRow` are ever written: no tool
 * arguments, results, summaries, error messages or contact details.
 */
export function toolExecutionRow(entry: ToolAuditEntry) {
  return {
    business_id: entry.businessId,
    conversation_id: entry.conversationId,
    agent_id: entry.agentId,
    agent_version_id: entry.agentVersionId,
    channel: entry.channelId,
    turn_id: entry.turnId,
    correlation_id: entry.correlationId,
    round: entry.round,
    intent_id: entry.intentId,
    tool_name: entry.toolName,
    idempotency_key: entry.idempotencyKey,
    side_effecting: entry.sideEffecting,
    requested_at: entry.requestedAt,
  };
}

export class SupabaseToolExecutionAuditStore implements ToolExecutionAuditStore {
  private client: SupabaseClient | null;

  constructor(db?: SupabaseClient) {
    this.client = db ?? null;
  }

  private get db(): SupabaseClient {
    this.client ??= getAdminClient();
    return this.client;
  }

  async recordRejected(entry: ToolAuditEntry, reason: ToolRejectionReason, at: string): Promise<void> {
    const { error } = await this.db.from("tool_executions").insert({
      id: randomUUID(),
      ...toolExecutionRow(entry),
      status: "rejected",
      rejection_reason: reason,
      finished_at: at,
    });
    if (error) throw new Error(`tool execution audit insert failed: ${error.message}`);
  }

  async recordStarted(entry: ToolAuditEntry, startedAt: string): Promise<ToolAuditRef> {
    const id = randomUUID();
    const { error } = await this.db.from("tool_executions").insert({
      id,
      ...toolExecutionRow(entry),
      status: "started",
      started_at: startedAt,
    });
    if (error) throw new Error(`tool execution audit insert failed: ${error.message}`);
    return { id, businessId: entry.businessId };
  }

  async recordFinished(
    ref: ToolAuditRef,
    outcome: { status: "succeeded" | "failed"; errorCode: string | null; finishedAt: string },
  ): Promise<void> {
    const { data, error } = await this.db
      .from("tool_executions")
      .update({
        status: outcome.status,
        error_code: outcome.status === "failed" ? outcome.errorCode : null,
        finished_at: outcome.finishedAt,
      })
      .eq("id", ref.id)
      .eq("business_id", ref.businessId)
      .eq("status", "started")
      .select("id");
    if (error) throw new Error(`tool execution audit finalize failed: ${error.message}`);
    if (!data || data.length !== 1) throw new Error("tool execution audit finalize matched no started record");
  }
}
