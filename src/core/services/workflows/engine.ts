import type {
  BusinessEvent,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
} from "@/core/domain/workflow";
import type { ActionRegistry, WorkflowStore } from "./types";
import { eventMatches, interpolateParams } from "./interpolate";
import { logger } from "@/lib/logger";

const log = logger.child({ service: "workflow-engine" });

/** Run-level retry backoff: 5 min, 15 min, 45 min… capped at 6 h. */
function runBackoffMs(attempt: number): number {
  return Math.min(5 * 60_000 * 3 ** (attempt - 1), 6 * 3_600_000);
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number, stepId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`step "${stepId}" timed out after ${ms}ms`)),
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
      await params.emit({
        businessId: timer.businessId,
        type: timer.eventType,
        correlationId: timer.correlationId,
        payload: timer.payload,
      });
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
        const exhausted = attempt >= run.maxAttempts;
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
          correlationId: run.correlationId,
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
      correlationId: run.correlationId,
      steps: workflow.steps.length,
      attempt,
    });
  }

  private async executeStep(
    run: WorkflowRun,
    step: WorkflowStep,
    event: BusinessEvent,
    runAttempt: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
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
      try {
        const params = interpolateParams(step.params, event);
        const detail = await withTimeout(
          executor(params, {
            event,
            businessId: run.businessId,
            correlationId: run.correlationId,
          }),
          timeoutMs,
          step.id,
        );
        await this.store.appendLog({
          runId: run.id,
          stepId: step.id,
          attempt: runAttempt,
          status: "succeeded",
          detail: { ...(detail ?? {}), stepAttempt },
        });
        return { ok: true };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await this.store.appendLog({
          runId: run.id,
          stepId: step.id,
          attempt: runAttempt,
          status: "failed",
          detail: { error: lastError, stepAttempt },
        });
        if (stepAttempt < maxAttempts && backoffMs > 0) await sleep(backoffMs);
      }
    }
    return { ok: false, error: lastError };
  }
}
