import type {
  BusinessEvent,
  BusinessEventType,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepLog,
} from "@halo/core/domain/workflow";
import type { WorkflowStore } from "@halo/workflows/types";

interface StoredTimer {
  businessId: string;
  eventType: BusinessEventType;
  payload: Record<string, unknown>;
  correlationId: string;
  fireAt: string;
  fired: boolean;
}

/**
 * In-memory WorkflowStore reproducing the database behaviours the engine
 * leans on: the (workflow, event) uniqueness constraint and due-run/timer
 * claiming. `now` is injectable so tests control the clock.
 */
export class InMemoryWorkflowStore implements WorkflowStore {
  events = new Map<string, BusinessEvent>();
  workflows = new Map<string, WorkflowDefinition>();
  runs = new Map<string, WorkflowRun>();
  logs: WorkflowStepLog[] = [];
  timers: StoredTimer[] = [];
  now: () => number = () => Date.now();
  private sequence = 0;

  addWorkflow(workflow: WorkflowDefinition): void {
    this.workflows.set(workflow.id, workflow);
  }

  async insertEvent(event: BusinessEvent): Promise<void> {
    this.events.set(event.id, event);
  }

  async getEvent(eventId: string): Promise<BusinessEvent | null> {
    return this.events.get(eventId) ?? null;
  }

  async listEnabledWorkflows(
    businessId: string,
    trigger: BusinessEventType,
  ): Promise<WorkflowDefinition[]> {
    return [...this.workflows.values()].filter(
      (w) => w.businessId === businessId && w.trigger === trigger && w.enabled,
    );
  }

  async getWorkflow(id: string): Promise<WorkflowDefinition | null> {
    return this.workflows.get(id) ?? null;
  }

  async createRun(input: {
    workflowId: string;
    businessId: string;
    eventId: string;
    workflowVersion: number;
    maxAttempts: number;
    correlationId: string;
  }): Promise<WorkflowRun | null> {
    const duplicate = [...this.runs.values()].some(
      (r) => r.workflowId === input.workflowId && r.eventId === input.eventId,
    );
    if (duplicate) return null;
    const run: WorkflowRun = {
      id: `run-${++this.sequence}`,
      workflowId: input.workflowId,
      businessId: input.businessId,
      eventId: input.eventId,
      workflowVersion: input.workflowVersion,
      status: "pending",
      attempt: 0,
      maxAttempts: input.maxAttempts,
      nextAttemptAt: null,
      currentStep: 0,
      correlationId: input.correlationId,
      error: "",
    };
    this.runs.set(run.id, run);
    return run;
  }

  async updateRun(
    id: string,
    patch: Partial<
      Pick<WorkflowRun, "status" | "attempt" | "nextAttemptAt" | "currentStep" | "error">
    > & { startedAt?: string; finishedAt?: string },
  ): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`no run ${id}`);
    if (patch.status !== undefined) run.status = patch.status;
    if (patch.attempt !== undefined) run.attempt = patch.attempt;
    if (patch.nextAttemptAt !== undefined) run.nextAttemptAt = patch.nextAttemptAt;
    if (patch.currentStep !== undefined) run.currentStep = patch.currentStep;
    if (patch.error !== undefined) run.error = patch.error;
  }

  async appendLog(log: WorkflowStepLog): Promise<void> {
    this.logs.push(log);
  }

  async claimDueRuns(limit: number): Promise<WorkflowRun[]> {
    const due = [...this.runs.values()]
      .filter(
        (r) =>
          r.status === "failed" &&
          r.nextAttemptAt !== null &&
          Date.parse(r.nextAttemptAt) <= this.now(),
      )
      .slice(0, limit);
    for (const run of due) run.status = "running";
    return due.map((run) => ({ ...run }));
  }

  async scheduleTimer(timer: {
    businessId: string;
    eventType: BusinessEventType;
    payload: Record<string, unknown>;
    correlationId: string;
    fireAt: string;
  }): Promise<void> {
    this.timers.push({ ...timer, fired: false });
  }

  async claimDueTimers(limit: number) {
    const due = this.timers
      .filter((t) => !t.fired && Date.parse(t.fireAt) <= this.now())
      .slice(0, limit);
    for (const timer of due) timer.fired = true;
    return due.map(({ businessId, eventType, payload, correlationId }) => ({
      businessId,
      eventType,
      payload,
      correlationId,
    }));
  }

  run(id: string): WorkflowRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`no run ${id}`);
    return run;
  }

  allRuns(): WorkflowRun[] {
    return [...this.runs.values()];
  }
}
