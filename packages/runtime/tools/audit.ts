import { randomUUID } from "node:crypto";
import type { ToolRejectionReason, ToolResult } from "../contracts";

/**
 * D7 — tool-execution audit (migration 0032_tool_executions).
 *
 * One durable record per model-proposed tool call that reaches the tool
 * boundary. The runtime writes it; tools never do, so no tool can opt out.
 *
 *   rejected   — refused before execution (unknown tool, invalid arguments,
 *                budget, or an authorization denial). Written once.
 *   started    — written BEFORE the executor runs, then moved exactly once to
 *   succeeded  — the executor reported success, or
 *   failed     — the executor reported failure or threw.
 *
 * A record left in `started` means the outcome is unknown (the process died
 * or the finalize write failed). It must be reconciled by an operator; the
 * action is never replayed because of it.
 *
 * Accountability metadata only. Arguments, results, summaries, error
 * messages, transcripts and contact details are NEVER part of a record:
 * the types below have no field that could carry them.
 */

export type ToolExecutionAuditStatus = "started" | "succeeded" | "failed" | "rejected";

/** Trusted turn identity. Built by the runtime from TrustedRequestContext only. */
export interface ToolAuditContext {
  businessId: string;
  conversationId: string;
  agentId: string;
  agentVersionId: string;
  channelId: string;
  turnId: string;
  /** Telemetry correlation id when one is in scope; null otherwise. */
  correlationId: string | null;
}

export interface ToolAuditEntry extends ToolAuditContext {
  round: number;
  /** Provider tool-call id (bounded); identifies the call within the turn. */
  intentId: string;
  /** Registry name, or null when the model named a tool that does not exist. */
  toolName: string | null;
  /** Present once the call became a validated intent. */
  idempotencyKey: string | null;
  /** From the tool definition; null when the tool is unknown. */
  sideEffecting: boolean | null;
  requestedAt: string;
}

export interface ToolAuditRecord extends ToolAuditEntry {
  id: string;
  status: ToolExecutionAuditStatus;
  rejectionReason: ToolRejectionReason | null;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ToolAuditRef {
  id: string;
  businessId: string;
}

export interface ToolExecutionAuditStore {
  recordRejected(entry: ToolAuditEntry, reason: ToolRejectionReason, at: string): Promise<void>;
  /** Must resolve only once the record is durable; the id finalizes it. */
  recordStarted(entry: ToolAuditEntry, startedAt: string): Promise<ToolAuditRef>;
  recordFinished(
    ref: ToolAuditRef,
    outcome: { status: "succeeded" | "failed"; errorCode: string | null; finishedAt: string },
  ): Promise<void>;
}

export const TOOL_AUDIT_LIMITS = {
  maxIntentIdChars: 200,
  maxTurnIdChars: 100,
  maxCorrelationIdChars: 100,
} as const;

/** Error code written when the audit store refuses the pre-execution record. */
export const AUDIT_UNAVAILABLE_CODE = "AUDIT_UNAVAILABLE";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const CHANNEL = /^[a-z][a-z0-9-]{0,39}$/;

/** Only registry names are recorded; anything else is unknown, never stored verbatim. */
export function auditToolName(name: unknown, isRegistered: (name: string) => boolean): string | null {
  return typeof name === "string" && TOOL_NAME.test(name) && isRegistered(name) ? name : null;
}

/**
 * A safe, bounded error category. Codes come from executors; anything that
 * does not look like an identifier (a sentence, a payload, a stack) becomes
 * UNCLASSIFIED rather than being stored.
 */
export function auditErrorCode(result: Pick<ToolResult, "status" | "error">): string | null {
  if (result.status !== "failed") return null;
  const code = result.error?.code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "UNCLASSIFIED";
}

export function auditIntentId(id: unknown, fallback: string): string {
  const value = typeof id === "string" && id.trim() ? id.trim() : fallback;
  return value.slice(0, TOOL_AUDIT_LIMITS.maxIntentIdChars);
}

export function auditChannel(id: string): string {
  return CHANNEL.test(id) ? id : "unknown";
}

export function boundedId(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, max);
}

/**
 * In-process store with the same invariants the database enforces (one
 * transition from `started`, one execution per idempotency key per turn,
 * tenant-scoped reads). For tests and local harnesses; not durable.
 */
export class InMemoryToolExecutionAuditStore implements ToolExecutionAuditStore {
  private readonly rows = new Map<string, ToolAuditRecord>();

  async recordRejected(entry: ToolAuditEntry, reason: ToolRejectionReason, at: string): Promise<void> {
    const id = randomUUID();
    this.rows.set(id, {
      ...entry, id, status: "rejected", rejectionReason: reason, errorCode: null, startedAt: null, finishedAt: at,
    });
  }

  async recordStarted(entry: ToolAuditEntry, startedAt: string): Promise<ToolAuditRef> {
    if (!entry.toolName || !entry.idempotencyKey) throw new Error("a started record needs a tool name and idempotency key");
    const duplicate = [...this.rows.values()].some(
      (row) => row.businessId === entry.businessId && row.turnId === entry.turnId &&
        row.idempotencyKey === entry.idempotencyKey && row.status !== "rejected",
    );
    if (duplicate) throw new Error("duplicate execution for this idempotency key and turn");
    const id = randomUUID();
    this.rows.set(id, {
      ...entry, id, status: "started", rejectionReason: null, errorCode: null, startedAt, finishedAt: null,
    });
    return { id, businessId: entry.businessId };
  }

  async recordFinished(
    ref: ToolAuditRef,
    outcome: { status: "succeeded" | "failed"; errorCode: string | null; finishedAt: string },
  ): Promise<void> {
    const row = this.rows.get(ref.id);
    if (!row || row.businessId !== ref.businessId) throw new Error("audit record not found for this tenant");
    if (row.status !== "started") throw new Error("audit record is already final");
    this.rows.set(ref.id, {
      ...row,
      status: outcome.status,
      errorCode: outcome.status === "failed" ? outcome.errorCode : null,
      finishedAt: outcome.finishedAt,
    });
  }

  /** Tenant-scoped read, mirroring the members-read RLS policy. */
  forTenant(businessId: string): ToolAuditRecord[] {
    return [...this.rows.values()].filter((row) => row.businessId === businessId).map((row) => ({ ...row }));
  }

  get size(): number {
    return this.rows.size;
  }
}

export type ToolAuditFailureStage = "rejected" | "started" | "finished" | "not_configured";

/**
 * The runtime's view of the audit store for one turn. No method throws:
 * an audit failure never changes a tool's real outcome. Whether an
 * execution may proceed without its pre-execution record is decided by the
 * caller (side-effecting tools fail closed), not here.
 */
export class ToolAuditTrail {
  constructor(
    private readonly store: ToolExecutionAuditStore | undefined,
    private readonly context: ToolAuditContext,
    private readonly onFailure: (stage: ToolAuditFailureStage, toolName: string | null, error: unknown) => void,
    private readonly now: () => string,
  ) {}

  entry(params: { round: number; intentId: string; toolName: string | null; idempotencyKey: string | null; sideEffecting: boolean | null }): ToolAuditEntry {
    return { ...this.context, ...params, requestedAt: this.now() };
  }

  async rejected(entry: ToolAuditEntry, reason: ToolRejectionReason): Promise<void> {
    if (!this.store) return this.onFailure("not_configured", entry.toolName, null);
    try {
      await this.store.recordRejected(entry, reason, this.now());
    } catch (error) {
      this.onFailure("rejected", entry.toolName, error);
    }
  }

  /** The durable pre-execution reference, or null when it could not be written. */
  async started(entry: ToolAuditEntry): Promise<ToolAuditRef | null> {
    if (!this.store) {
      this.onFailure("not_configured", entry.toolName, null);
      return null;
    }
    try {
      return await this.store.recordStarted(entry, this.now());
    } catch (error) {
      this.onFailure("started", entry.toolName, error);
      return null;
    }
  }

  async finished(ref: ToolAuditRef, toolName: string, result: Pick<ToolResult, "status" | "error">): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.recordFinished(ref, {
        status: result.status === "succeeded" ? "succeeded" : "failed",
        errorCode: auditErrorCode(result),
        finishedAt: this.now(),
      });
    } catch (error) {
      this.onFailure("finished", toolName, error);
    }
  }
}

/** Result for a side-effecting tool whose pre-execution audit record could not be written. */
export function auditUnavailableResult(intentId: string, name: string): ToolResult {
  return {
    intentId,
    name,
    status: "failed",
    summary: "The action could not be completed. Tell the visitor honestly that it did not go through.",
    claimsPermitted: [],
    error: { code: AUDIT_UNAVAILABLE_CODE, message: "action not attempted: audit record unavailable" },
  };
}
