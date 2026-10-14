import { describe, expect, it } from "vitest";
import { AlertEvaluator, LocalAlertSink, deliverAlert, type OperationalSnapshot } from "@halo/platform/alerts";

const healthy = (at: string): OperationalSnapshot => ({ at, databaseReady: true, providerHealthy: true, failedJobs: 0, deadLetterJobs: 0, overdueWork: 0, monitoringFresh: true });

describe("operational alert generation and local discovery", () => {
  it("fires once after sustained provider failure, deduplicates, and resolves on recovery", () => {
    const evaluator = new AlertEvaluator();
    for (let n = 1; n <= 2; n++) expect(evaluator.evaluate({ ...healthy(`2026-10-13T00:0${n}:00Z`), providerHealthy: false })).toEqual([]);
    const fired = evaluator.evaluate({ ...healthy("2026-10-13T00:03:00Z"), providerHealthy: false }, "incident-a");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ id: "halo.provider_outage", state: "firing", correlationId: "incident-a" });
    expect(evaluator.evaluate({ ...healthy("2026-10-13T00:04:00Z"), providerHealthy: false })).toEqual([]);
    expect(evaluator.evaluate(healthy("2026-10-13T00:05:00Z"))).toMatchObject([{ state: "resolved", reason: "Condition cleared" }]);
  });

  it("never reports a continuing provider outage as resolved after an unavailable probe", () => {
    const evaluator = new AlertEvaluator();
    for (let n = 1; n <= 3; n++) evaluator.evaluate({ ...healthy(`2026-10-13T00:0${n}:00Z`), providerHealthy: false });
    expect(evaluator.evaluate({ ...healthy("2026-10-13T00:04:00Z"), providerHealthy: null })).toMatchObject([{ type: "provider_outage", state: "unavailable" }]);
    expect(evaluator.evaluate({ ...healthy("2026-10-13T00:05:00Z"), providerHealthy: false })).toMatchObject([{ type: "provider_outage", state: "firing" }]);
    expect(evaluator.evaluate(healthy("2026-10-13T00:06:00Z"))).toMatchObject([{ type: "provider_outage", state: "resolved" }]);

    const fresh = new AlertEvaluator();
    fresh.evaluate({ ...healthy("2026-10-13T00:00:00Z"), providerHealthy: null });
    expect(fresh.evaluate({ ...healthy("2026-10-13T00:01:00Z"), providerHealthy: false })).toEqual([]);
    expect(fresh.list().find(event => event.type === "provider_outage")?.state).toBe("unavailable");
  });

  it("detects db failure, backlog, overdue work and stale observations without customer data", () => {
    const evaluator = new AlertEvaluator();
    const events = evaluator.evaluate({ at: "2026-10-13T00:00:00Z", databaseReady: false, providerHealthy: true, failedJobs: 5, deadLetterJobs: 1, overdueWork: 2, monitoringFresh: false });
    expect(events.map(event => event.type)).toEqual(["database_unready", "failed_job_backlog", "dead_letter_backlog", "overdue_work", "monitoring_stale"]);
    expect(JSON.stringify(events)).not.toMatch(/prompt|customer|secret|tenant/);
  });

  it("makes missing evaluation inputs explicitly unavailable", () => {
    const evaluator = new AlertEvaluator();
    expect(evaluator.evaluate({ ...healthy("2026-10-13T00:00:00Z"), databaseReady: null })).toMatchObject([{ type: "database_unready", state: "unavailable" }]);
  });

  it("delivers to an inspectable local sink and exposes bounded delivery failures", async () => {
    const evaluator = new AlertEvaluator();
    const event = evaluator.evaluate({ ...healthy("2026-10-13T00:00:00Z"), deadLetterJobs: 1 })[0];
    const sink = new LocalAlertSink();
    sink.failNext();
    await deliverAlert(sink, event, 2);
    expect(sink.list()).toEqual([event]);
    sink.failNext(4);
    await expect(deliverAlert(sink, { ...event, state: "resolved" }, 9)).rejects.toThrow("failed after 3 attempts");
    expect(sink.list()).toEqual([event]);
  });
});
