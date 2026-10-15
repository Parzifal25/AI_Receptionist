import { RetrySafeWorkflowError } from "@halo/workflows/types";
import { describe, expect, it, vi } from "vitest";
import type { BusinessEvent, WorkflowDefinition } from "@halo/core/domain/workflow";
import { WorkflowEngine } from "@halo/workflows/engine";
import type { ActionRegistry } from "@halo/workflows/types";
import { InMemoryWorkflowStore } from "../mocks/in-memory-workflow-store";

function makeEvent(overrides: Partial<BusinessEvent> = {}): BusinessEvent {
  return {
    id: overrides.id ?? "evt-1",
    businessId: "biz-1",
    type: "appointment.created",
    correlationId: "conv-1",
    occurredAt: "2026-07-14T10:00:00.000Z",
    payload: {
      visitorName: "Ada Lovelace",
      visitorEmail: "ada@example.com",
      serviceName: "AC repair",
      startsAt: "2026-07-15T09:00:00.000Z",
    },
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "wf-1",
    businessId: "biz-1",
    name: "Booking follow-through",
    description: "",
    trigger: "appointment.created",
    enabled: true,
    version: 1,
    conditions: [],
    steps: [
      {
        id: "email",
        action: "send_email",
        params: {
          to: "{{event.payload.visitorEmail}}",
          body: "Thanks {{event.payload.visitorName}} — see you at {{event.payload.startsAt}}!",
        },
      },
    ],
    ...overrides,
  };
}

function setup(actions: ActionRegistry, workflow = makeWorkflow()) {
  const store = new InMemoryWorkflowStore();
  store.addWorkflow(workflow);
  const engine = new WorkflowEngine(store, actions);
  return { store, engine };
}

describe("WorkflowEngine", () => {
  it("executes steps in order with interpolated variables and records history", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const workflow = makeWorkflow({
      steps: [
        { id: "email", action: "send_email", params: { to: "{{event.payload.visitorEmail}}", body: "Thanks {{event.payload.visitorName}}!" } },
        { id: "ping", action: "call_webhook", params: { url: "https://hooks.example.com/x" } },
      ],
    });
    const { store, engine } = setup(
      {
        send_email: async (params) => {
          sent.push({ action: "email", ...params });
        },
        call_webhook: async (params) => {
          sent.push({ action: "webhook", ...params });
          return { status: 200 };
        },
      },
      workflow,
    );

    await engine.dispatch(makeEvent());

    expect(sent).toEqual([
      { action: "email", to: "ada@example.com", body: "Thanks Ada Lovelace!" },
      { action: "webhook", url: "https://hooks.example.com/x" },
    ]);
    const run = store.allRuns()[0];
    expect(run.status).toBe("succeeded");
    expect(store.logs.map((l) => [l.stepId, l.status])).toEqual([
      ["email", "succeeded"],
      ["ping", "succeeded"],
    ]);
    expect(run.correlationId).toBe("conv-1");
    expect(store.events.has("evt-1")).toBe(true); // audit trail
  });

  it("skips the run when conditions do not match, without executing actions", async () => {
    const executor = vi.fn();
    const workflow = makeWorkflow({
      conditions: [{ path: "payload.serviceName", op: "contains", value: "plumbing" }],
    });
    const { store, engine } = setup({ send_email: executor }, workflow);

    await engine.dispatch(makeEvent());

    expect(executor).not.toHaveBeenCalled();
    expect(store.allRuns()[0].status).toBe("skipped");
  });

  it("runs when conditions match", async () => {
    const executor = vi.fn(async () => undefined);
    const workflow = makeWorkflow({
      conditions: [
        { path: "payload.serviceName", op: "contains", value: "ac" },
        { path: "payload.visitorEmail", op: "exists" },
      ],
    });
    const { store, engine } = setup({ send_email: executor }, workflow);
    await engine.dispatch(makeEvent());
    expect(executor).toHaveBeenCalledOnce();
    expect(store.allRuns()[0].status).toBe("succeeded");
  });

  it("is idempotent: the same event delivered twice creates exactly one run", async () => {
    const executor = vi.fn(async () => undefined);
    const { store, engine } = setup({ send_email: executor });

    await engine.dispatch(makeEvent());
    await engine.dispatch(makeEvent()); // duplicate delivery

    expect(executor).toHaveBeenCalledTimes(1);
    expect(store.allRuns()).toHaveLength(1);
  });

  it("retries only explicitly retry-safe failures in-run and succeeds", async () => {
    let calls = 0;
    const workflow = makeWorkflow({
      steps: [
        {
          id: "flaky",
          action: "call_webhook",
          params: { url: "https://hooks.example.com" },
          retry: { maxAttempts: 3, backoffMs: 0 },
        },
      ],
    });
    const { store, engine } = setup(
      {
        call_webhook: async () => {
          calls += 1;
          if (calls < 3) throw new RetrySafeWorkflowError();
          return { status: 200 };
        },
      },
      workflow,
    );

    await engine.dispatch(makeEvent());

    expect(calls).toBe(3);
    expect(store.allRuns()[0].status).toBe("succeeded");
    // Two failed attempts and the final success are all in the log.
    expect(store.logs.filter((l) => l.status === "failed")).toHaveLength(2);
  });

  it("marks the run failed with a scheduled retry, then resumes from the failed step", async () => {
    const first = vi.fn(async () => undefined);
    let failOnce = true;
    const workflow = makeWorkflow({
      steps: [
        { id: "first", action: "send_email", params: {} },
        { id: "second", action: "call_webhook", params: { url: "https://x.example.com" } },
      ],
    });
    const { store, engine } = setup(
      {
        send_email: first,
        call_webhook: async () => {
          if (failOnce) {
            failOnce = false;
            throw new RetrySafeWorkflowError();
          }
          return { status: 200 };
        },
      },
      workflow,
    );

    await engine.dispatch(makeEvent());
    const run = store.allRuns()[0];
    expect(run.status).toBe("failed");
    expect(run.currentStep).toBe(1);
    expect(run.nextAttemptAt).not.toBeNull();
    expect(run.error).toBe("step_failed");

    // Cron comes around after the backoff.
    store.now = () => Date.parse(run.nextAttemptAt as string) + 1;
    const result = await engine.processDue({ emit: async () => undefined });

    expect(result.runsRetried).toBe(1);
    expect(store.run(run.id).status).toBe("succeeded");
    // The already-succeeded first step did not re-run.
    expect(first).toHaveBeenCalledTimes(1);
  });

  // Phase 2, Workstream 1: a retried run is rebuilt from three rows (run,
  // workflow, event) loaded by id. If they disagree on the tenant, executing
  // would run one tenant's steps on another tenant's event payload. 0034
  // stops such rows being written; rows from before it must still not run.
  for (const foreign of ["event", "workflow"] as const) {
    it(`dead-letters a retried run whose ${foreign} belongs to another tenant, without running a step`, async () => {
      let calls = 0;
      const workflow = makeWorkflow({ steps: [{ id: "hook", action: "call_webhook", params: { url: "https://x.example.com" } }] });
      const { store, engine } = setup({ call_webhook: async () => { calls += 1; if (calls === 1) throw new RetrySafeWorkflowError(); return { status: 200 }; } }, workflow);
      await engine.dispatch(makeEvent());
      const run = store.allRuns()[0];
      expect(run.status).toBe("failed");
      if (foreign === "event") store.events.get(run.eventId)!.businessId = "biz-2";
      else store.addWorkflow({ ...workflow, businessId: "biz-2" });

      store.now = () => Date.parse(run.nextAttemptAt as string) + 1;
      await engine.processDue({ emit: async () => undefined });

      expect(calls).toBe(1);
      expect(store.run(run.id)).toMatchObject({ status: "dead_letter", error: "workflow, event and run belong to different tenants" });
    });
  }

  it("parks a persistently failing run in the dead letter queue after max attempts", async () => {
    const { store, engine } = setup({
      send_email: async () => {
        throw new RetrySafeWorkflowError();
      },
    });

    await engine.dispatch(makeEvent());
    let run = store.allRuns()[0];
    for (let i = 0; i < 5 && run.status === "failed"; i++) {
      store.now = () => Date.parse(run.nextAttemptAt as string) + 1;
      await engine.processDue({ emit: async () => undefined });
      run = store.run(run.id);
    }

    expect(run.status).toBe("dead_letter");
    expect(run.attempt).toBe(run.maxAttempts);
    expect(run.nextAttemptAt).toBeNull();
  });

  it("quarantines a timed-out action without step or cron replay and aborts its work", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let finish: (() => void) | undefined;
      const action = vi.fn((_params, context) => {
        signal = context.signal;
        return new Promise<void>((resolve) => { finish = resolve; });
      });
      const workflow = makeWorkflow({
        steps: [
          { id: "hung", action: "call_webhook", params: { url: "https://x.example.com" }, timeoutMs: 100,
            retry: { maxAttempts: 3, backoffMs: 0 } },
        ],
      });
      const { store, engine } = setup(
        { call_webhook: action },
        workflow,
      );

      const dispatch = engine.dispatch(makeEvent());
      await vi.advanceTimersByTimeAsync(400);
      await dispatch;

      const run = store.allRuns()[0];
      expect(run.status).toBe("dead_letter");
      expect(run.error).toBe("step_timeout_outcome_unknown");
      expect(run.nextAttemptAt).toBeNull();
      expect(signal?.aborted).toBe(true);
      finish?.(); // Late completion cannot turn an uncertain outcome into success.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      await engine.processDue({ emit: async () => undefined });
      expect(action).toHaveBeenCalledTimes(1);
      expect(store.run(run.id).status).toBe("dead_letter");
    } finally { vi.useRealTimers(); }
  });

  it("fails cleanly on an unregistered action", async () => {
    const { store, engine } = setup({}); // registry has no send_email
    await engine.dispatch(makeEvent());
    expect(store.allRuns()[0].error).toContain("no executor registered");
  });

  it("fires due timers as fresh events through the emitter", async () => {
    const { store, engine } = setup({ send_email: async () => undefined });
    await store.scheduleTimer({
      businessId: "biz-1",
      eventType: "followup.due",
      payload: { reason: "review request" },
      correlationId: "conv-1",
      fireAt: new Date(Date.now() - 1000).toISOString(),
    });

    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await engine.processDue({
      emit: async (event) => {
        emitted.push({ type: event.type, payload: event.payload });
      },
    });

    expect(result.timersFired).toBe(1);
    expect(emitted).toEqual([{ type: "followup.due", payload: { reason: "review request" } }]);
    // A timer only fires once.
    const again = await engine.processDue({ emit: async () => undefined });
    expect(again.timersFired).toBe(0);
  });

  it("only triggers workflows for the matching business and event type", async () => {
    const executor = vi.fn();
    const store = new InMemoryWorkflowStore();
    store.addWorkflow(makeWorkflow({ id: "wf-other-biz", businessId: "biz-2" }));
    store.addWorkflow(makeWorkflow({ id: "wf-other-trigger", trigger: "lead.created" }));
    store.addWorkflow(makeWorkflow({ id: "wf-disabled", enabled: false }));
    const engine = new WorkflowEngine(store, { send_email: executor });

    await engine.dispatch(makeEvent());

    expect(executor).not.toHaveBeenCalled();
    expect(store.allRuns()).toHaveLength(0);
  });
});
