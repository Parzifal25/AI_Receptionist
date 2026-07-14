import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  workflowDefinitionSchema,
  type BusinessEvent,
  type BusinessEventType,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStepLog,
} from "@/core/domain/workflow";
import type { WorkflowStore } from "./types";
import { getAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

const log = logger.child({ service: "workflow-store" });

/** Postgres unique-violation — the idempotency constraint firing. */
const UNIQUE_VIOLATION = "23505";

function rowToRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: row.id as string,
    workflowId: row.workflow_id as string,
    businessId: row.business_id as string,
    eventId: row.event_id as string,
    workflowVersion: row.workflow_version as number,
    status: row.status as WorkflowRun["status"],
    attempt: row.attempt as number,
    maxAttempts: row.max_attempts as number,
    nextAttemptAt: (row.next_attempt_at as string | null) ?? null,
    currentStep: row.current_step as number,
    correlationId: (row.correlation_id as string) ?? "",
    error: (row.error as string) ?? "",
  };
}

function rowToWorkflow(row: Record<string, unknown>): WorkflowDefinition | null {
  const parsed = workflowDefinitionSchema.safeParse({
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    enabled: row.enabled,
    version: row.version,
    conditions: row.conditions,
    steps: row.steps,
  });
  if (!parsed.success) {
    // A malformed definition must never take the engine down — skip it
    // loudly so the tenant's other workflows still run.
    log.error("invalid workflow definition, skipping", { workflowId: row.id });
    return null;
  }
  return parsed.data;
}

/** Production WorkflowStore over Supabase (service role, scoped in code). */
export class SupabaseWorkflowStore implements WorkflowStore {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  async insertEvent(event: BusinessEvent): Promise<void> {
    const { error } = await this.db.from("workflow_events").insert({
      id: event.id,
      business_id: event.businessId,
      type: event.type,
      correlation_id: event.correlationId,
      payload: event.payload,
      occurred_at: event.occurredAt,
    });
    if (error) throw new Error(`insert workflow event: ${error.message}`);
  }

  async getEvent(eventId: string): Promise<BusinessEvent | null> {
    const { data } = await this.db.from("workflow_events").select("*").eq("id", eventId).maybeSingle();
    if (!data) return null;
    return {
      id: data.id,
      businessId: data.business_id,
      type: data.type,
      correlationId: data.correlation_id ?? "",
      occurredAt: data.occurred_at,
      payload: data.payload ?? {},
    };
  }

  async listEnabledWorkflows(
    businessId: string,
    trigger: BusinessEventType,
  ): Promise<WorkflowDefinition[]> {
    const { data, error } = await this.db
      .from("workflows")
      .select("*")
      .eq("business_id", businessId)
      .eq("trigger", trigger)
      .eq("enabled", true);
    if (error) throw new Error(`list workflows: ${error.message}`);
    return (data ?? [])
      .map(rowToWorkflow)
      .filter((workflow): workflow is WorkflowDefinition => workflow !== null);
  }

  async getWorkflow(id: string): Promise<WorkflowDefinition | null> {
    const { data } = await this.db.from("workflows").select("*").eq("id", id).maybeSingle();
    return data ? rowToWorkflow(data) : null;
  }

  async createRun(run: {
    workflowId: string;
    businessId: string;
    eventId: string;
    workflowVersion: number;
    maxAttempts: number;
    correlationId: string;
  }): Promise<WorkflowRun | null> {
    const { data, error } = await this.db
      .from("workflow_runs")
      .insert({
        workflow_id: run.workflowId,
        business_id: run.businessId,
        event_id: run.eventId,
        workflow_version: run.workflowVersion,
        max_attempts: run.maxAttempts,
        correlation_id: run.correlationId,
      })
      .select()
      .single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return null; // duplicate delivery
      throw new Error(`create workflow run: ${error.message}`);
    }
    return rowToRun(data);
  }

  async updateRun(
    id: string,
    patch: Partial<
      Pick<WorkflowRun, "status" | "attempt" | "nextAttemptAt" | "currentStep" | "error">
    > & { startedAt?: string; finishedAt?: string },
  ): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.attempt !== undefined) row.attempt = patch.attempt;
    if (patch.nextAttemptAt !== undefined) row.next_attempt_at = patch.nextAttemptAt;
    if (patch.currentStep !== undefined) row.current_step = patch.currentStep;
    if (patch.error !== undefined) row.error = patch.error;
    if (patch.startedAt !== undefined) row.started_at = patch.startedAt;
    if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt;
    const { error } = await this.db.from("workflow_runs").update(row).eq("id", id);
    if (error) throw new Error(`update workflow run: ${error.message}`);
  }

  async appendLog(entry: WorkflowStepLog): Promise<void> {
    const { error } = await this.db.from("workflow_run_logs").insert({
      run_id: entry.runId,
      step_id: entry.stepId,
      attempt: entry.attempt,
      status: entry.status,
      detail: entry.detail,
    });
    if (error) throw new Error(`append workflow log: ${error.message}`);
  }

  async claimDueRuns(limit: number): Promise<WorkflowRun[]> {
    const { data, error } = await this.db.rpc("claim_due_workflow_runs", { batch_size: limit });
    if (error) throw new Error(`claim due runs: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map(rowToRun);
  }

  async scheduleTimer(timer: {
    businessId: string;
    eventType: BusinessEventType;
    payload: Record<string, unknown>;
    correlationId: string;
    fireAt: string;
  }): Promise<void> {
    const { error } = await this.db.from("workflow_timers").insert({
      business_id: timer.businessId,
      event_type: timer.eventType,
      payload: timer.payload,
      correlation_id: timer.correlationId,
      fire_at: timer.fireAt,
    });
    if (error) throw new Error(`schedule timer: ${error.message}`);
  }

  async claimDueTimers(limit: number): Promise<
    Array<{
      businessId: string;
      eventType: BusinessEventType;
      payload: Record<string, unknown>;
      correlationId: string;
    }>
  > {
    const { data, error } = await this.db.rpc("claim_due_workflow_timers", { batch_size: limit });
    if (error) throw new Error(`claim due timers: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      businessId: row.business_id as string,
      eventType: row.event_type as BusinessEventType,
      payload: (row.payload as Record<string, unknown>) ?? {},
      correlationId: (row.correlation_id as string) ?? "",
    }));
  }
}
