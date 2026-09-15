import type {
  BusinessEvent,
  BusinessEventType,
  WorkflowActionType,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepLog,
} from "@halo/core/domain/workflow";

/**
 * Persistence contract for the workflow engine. The production store is
 * Supabase (service role, tenant-scoped in code); tests use an in-memory
 * implementation that reproduces the idempotency constraint.
 */
export interface WorkflowStore {
  /** Audit trail / outbox — every emitted event is recorded first. */
  insertEvent(event: BusinessEvent): Promise<void>;
  getEvent(eventId: string): Promise<BusinessEvent | null>;

  listEnabledWorkflows(businessId: string, trigger: BusinessEventType): Promise<WorkflowDefinition[]>;
  getWorkflow(id: string): Promise<WorkflowDefinition | null>;

  /**
   * Creates a run for (workflow, event). Returns null when a run already
   * exists — the database uniqueness constraint makes duplicate event
   * delivery a no-op.
   */
  createRun(run: {
    workflowId: string;
    businessId: string;
    eventId: string;
    workflowVersion: number;
    maxAttempts: number;
    correlationId: string;
  }): Promise<WorkflowRun | null>;

  updateRun(
    id: string,
    patch: Partial<
      Pick<WorkflowRun, "status" | "attempt" | "nextAttemptAt" | "currentStep" | "error">
    > & { startedAt?: string; finishedAt?: string },
  ): Promise<void>;

  appendLog(log: WorkflowStepLog): Promise<void>;

  /** Failed runs whose next_attempt_at has passed, atomically claimed. */
  claimDueRuns(limit: number): Promise<WorkflowRun[]>;

  /** Scheduled triggers ("follow up in 3 days"). */
  scheduleTimer(timer: {
    businessId: string;
    eventType: BusinessEventType;
    payload: Record<string, unknown>;
    correlationId: string;
    fireAt: string;
  }): Promise<void>;
  claimDueTimers(limit: number): Promise<
    Array<{
      businessId: string;
      eventType: BusinessEventType;
      payload: Record<string, unknown>;
      correlationId: string;
    }>
  >;
}

/** What an action executor gets to work with. */
export interface ActionContext {
  event: BusinessEvent;
  businessId: string;
  correlationId: string;
}

/**
 * One action implementation. Receives already-interpolated params. Returns
 * detail for the execution log; throws on failure — the engine owns retries.
 */
export type ActionExecutor = (
  params: Record<string, unknown>,
  ctx: ActionContext,
) => Promise<Record<string, unknown> | void>;

export type ActionRegistry = Partial<Record<WorkflowActionType, ActionExecutor>>;
