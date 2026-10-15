import { RetrySafeWorkflowError } from "./types";
import { isTelemetryId, withTelemetryContext, telemetryId, jobTelemetryId } from "@halo/platform/telemetry";
import type {
  BusinessEvent,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
} from "@halo/core/domain/workflow";
import type { ActionRegistry, WorkflowStore } from "./types";
import { eventMatches, interpolateParams } from "./interpolate";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "workflow-engine" });

/** Run-level retry backoff: 5 min, 15 min, 45 min… capped at 6 h. */
function runBackoffMs(attempt: number): number {
  return Math.min(5 * 60_000 * 3 ** (attempt - 1), 6 * 3_600_000);
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000;

class StepTimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, stepId: string, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        const error = new StepTimeoutError(`step "${stepId}" timed out after ${ms}ms; outcome unknown, reconcile before manual replay`);
        // Reject first so an abort-aware executor cannot turn this into a
        // generic retryable rejection. Cancellation cannot undo remote work.
        reject(error);
        controller.abort(error);
      },
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The workflow engine. Fed business events by the event bus, it finds each
 * tenant's matching enabled workflows and executes them: conditions →
 * ordered steps with interpolated params, per-step timeouts and retries,
 * run-level retries with backoff via the cron worker, and a dead-letter
 * terminal state after max attempts. Every step attempt is logged; the
 * (workflow, event) uniqueness in the store makes duplicate event delivery
 * a no-op. Depends only on the store and action-registry contracts.
 */
export class WorkflowEngine {
  constructor(
    private readonly store: WorkflowStore,
    private readonly actions: ActionRegistry,
    private readonly options: { maxRunAttempts?: number } = {},
  ) {}

  /**
   * Ingest one event: record it, create idempotent runs for every matching
   * workflow, and execute them inline. Never throws — automation must not
   * break the flow that emitted the event.
   */
  async dispatch(event: BusinessEvent): Promise<void> {
    event = { ...event, telemetryCorrelationId: isTelemetryId(event.telemetryCorrelationId) ? event.telemetryCorrelationId : telemetryId() ?? jobTelemetryId("workflow_event", event.businessId, event.id) };
    try {
      await this.store.insertEvent(event);
      const workflows = await this.store.listEnabledWorkflows(event.businessId, event.type);
      for (const workflow of workflows) {
        await this.startRun(workflow, event);
      }
    } catch (error) {
      log.error("event dispatch failed", { eventId: event.id, type: event.type, error });
    }
  }

  /** Fire one specific workflow (the dashboard's manual trigger). */
  async runManually(workflow: WorkflowDefinition, event: BusinessEvent): Promise<void> {
    event = { ...event, telemetryCorrelationId: isTelemetryId(event.telemetryCorrelationId) ? event.telemetryCorrelationId : telemetryId() ?? jobTelemetryId("workflow_event", event.businessId, event.id) };
    await this.store.insertEvent(event);
    await this.startRun(workflow, event);
  }

  /**
   * Cron entry point: fire due timers as fresh events, then re-execute
   * failed runs whose backoff has elapsed.
   */
  async processDue(params: {
    emit: (event: Omit<BusinessEvent, "id" | "occurredAt">) => Promise<void>;
    batchSize?: number;
  }): Promise<{ timersFired: number; runsRetried: number }> {
    const batch = params.batchSize ?? 25;

    const timers = await this.store.claimDueTimers(batch);
    for (const timer of timers) {
      await withTelemetryContext(() => params.emit({
        businessId: timer.businessId,
        type: timer.eventType,
        correlationId: timer.correlationId,
        payload: timer.payload,
      }), timer.telemetryCorrelationId ?? jobTelemetryId("workflow_timer", timer.businessId, timer.correlationId));
    }

    const dueRuns = await this.store.claimDueRuns(batch);
    for (const run of dueRuns) {
      const [workflow, event] = await Promise.all([
        this.store.getWorkflow(run.workflowId),
        this.store.getEvent(run.eventId),
      ]);
      if (!workflow || !event) {
        await this.store.updateRun(run.id, {
          status: "dead_letter",
          error: "workflow or event no longer exists",
          finishedAt: new Date().toISOString(),
        });
        continue;
      }
      // The three rows are loaded by id: never run one tenant's steps on
      // another tenant's event. (0034 refuses such rows; older ones may exist.)
      if (workflow.businessId !== run.businessId || event.businessId !== run.businessId) {
        await this.store.updateRun(run.id, {
          status: "dead_letter",
          error: "workflow, event and run belong to different tenants",
          finishedAt: new Date().toISOString(),
        });
        continue;
      }
      await this.executeRun(run, workflow, event);
    }

    return { timersFired: timers.length, runsRetried: dueRuns.length };
  }

  private async startRun(workflow: WorkflowDefinition, event: BusinessEvent): Promise<void> {
    const run = await this.store.createRun({
      workflowId: workflow.id,
      businessId: workflow.businessId,
      eventId: event.id,
      workflowVersion: workflow.version,
      maxAttempts: this.options.maxRunAttempts ?? 3,
      correlationId: event.correlationId,
    });
    // null = a run for this (workflow, event) already exists — duplicate
    // delivery of the same event is intentionally a no-op.
    if (!run) return;

    if (!eventMatches(event, workflow.conditions)) {
      await this.store.updateRun(run.id, {
        status: "skipped",
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    await this.executeRun(run, workflow, event);
  }

  private async executeRun(
    run: WorkflowRun,
    workflow: WorkflowDefinition,
    event: BusinessEvent,
  ): Promise<void> {
    // Legacy events get a stable tenant-scoped ID, independent of the cron request.
    const fallback = jobTelemetryId("workflow_event", event.businessId, event.id);
    return withTelemetryContext(() => this.executeRunInContext(run, workflow, event),
      isTelemetryId(event.telemetryCorrelationId) ? event.telemetryCorrelationId : fallback);
  }

  private async executeRunInContext(run: WorkflowRun, workflow: WorkflowDefinition, event: BusinessEvent): Promise<void> {
    const attempt = run.attempt + 1;
    await this.store.updateRun(run.id, {
      status: "running",
      attempt,
      startedAt: new Date().toISOString(),
    });

    // Resume where the previous attempt failed — completed steps never
    // re-run (and are also written to be idempotent as a second line of
    // defence against at-least-once delivery).
    for (let index = run.currentStep; index < workflow.steps.length; index++) {
      const step = workflow.steps[index];
      const outcome = await this.executeStep(run, step, event, attempt);
      if (!outcome.ok) {
        const exhausted = outcome.uncertain || attempt >= run.maxAttempts;
        await this.store.updateRun(run.id, {
          status: exhausted ? "dead_letter" : "failed",
          currentStep: index,
          error: outcome.error,
          nextAttemptAt: exhausted ? null : new Date(Date.now() + runBackoffMs(attempt)).toISOString(),
          finishedAt: exhausted ? new Date().toISOString() : undefined,
        });
        log[exhausted ? "error" : "warn"]("workflow run attempt failed", {
          runId: run.id,
          workflowId: workflow.id,
          stepId: step.id,
          attempt,
          deadLetter: exhausted,
          error: outcome.error,
        });
        return;
      }
      await this.store.updateRun(run.id, { currentStep: index + 1 });
    }

    await this.store.updateRun(run.id, {
      status: "succeeded",
      error: "",
      nextAttemptAt: null,
      finishedAt: new Date().toISOString(),
    });
    log.info("workflow run succeeded", {
      runId: run.id,
      workflowId: workflow.id,
      steps: workflow.steps.length,
      attempt,
    });
  }

  private async executeStep(
    run: WorkflowRun,
    step: WorkflowStep,
    event: BusinessEvent,
    runAttempt: number,
  ): Promise<{ ok: true } | { ok: false; error: string; uncertain?: boolean }> {
    const executor = this.actions[step.action];
    if (!executor) {
      const error = `no executor registered for action "${step.action}"`;
      await this.store.appendLog({
        runId: run.id,
        stepId: step.id,
        attempt: runAttempt,
        status: "failed",
        detail: { error },
      });
      return { ok: false, error };
    }

    const maxAttempts = step.retry?.maxAttempts ?? 1;
    const backoffMs = step.retry?.backoffMs ?? 1_000;
    const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    let lastError = "";

    for (let stepAttempt = 1; stepAttempt <= maxAttempts; stepAttempt++) {
      let completed = false;
      let executorStarted = false;
      try {
        const params = interpolateParams(step.params, event);
        const controller = new AbortController();
        executorStarted = true;
        const detail = await withTimeout(
          executor(params, {
            event,
            businessId: run.businessId,
            correlationId: run.correlationId,
            signal: controller.signal,
          }),
          timeoutMs,
          step.id,
          controller,
        );
        completed = true;
        await this.store.appendLog({
          runId: run.id,
          stepId: step.id,
          attempt: runAttempt,
          status: "succeeded",
          detail: { ...(detail ?? {}), stepAttempt },
        });
        return { ok: true };
      } catch (error) {
        if (completed) return { ok: false, error: "action_completed_history_unavailable", uncertain: true };
        lastError = error instanceof StepTimeoutError ? "step_timeout_outcome_unknown" : "step_failed";
        await this.store.appendLog({
          runId: run.id,
          stepId: step.id,
          attempt: runAttempt,
          status: "failed",
          detail: { error: lastError, stepAttempt },
        });
        if (executorStarted && !(error instanceof RetrySafeWorkflowError) && !(error instanceof StepTimeoutError)) return { ok: false, error: "action_outcome_unknown", uncertain: true };
        if (error instanceof StepTimeoutError) return { ok: false, error: lastError, uncertain: true };
        if (stepAttempt < maxAttempts && backoffMs > 0) await sleep(backoffMs);
      }
    }
    return { ok: false, error: lastError };
  }
}
