/** Deterministic operational alert evaluation and a local-only test sink. */
export type AlertType = "provider_outage" | "database_unready" | "failed_job_backlog" | "dead_letter_backlog" | "overdue_work" | "monitoring_stale";
export type AlertState = "firing" | "resolved" | "unavailable";
export interface OperationalSnapshot {
  at: string;
  databaseReady: boolean | null;
  providerHealthy: boolean | null;
  failedJobs: number | null;
  deadLetterJobs: number | null;
  overdueWork: number | null;
  monitoringFresh: boolean | null;
}
export interface AlertEvent {
  id: string;
  type: AlertType;
  severity: "warning" | "critical";
  state: AlertState;
  component: string;
  firstSeenAt: string;
  lastSeenAt: string;
  reason: string;
  correlationId?: string;
}
export interface AlertSink { deliver(event: AlertEvent): Promise<void> }

const definitions: Array<{ type: AlertType; severity: AlertEvent["severity"]; component: string; reason: string; active: (s: OperationalSnapshot, failures: number) => boolean | null | "pending" }> = [
  { type: "provider_outage", severity: "critical", component: "ai_provider", reason: "Provider failed in three consecutive observations", active: (s, failures) => s.providerHealthy === null ? null : s.providerHealthy ? false : failures >= 3 ? true : "pending" },
  { type: "database_unready", severity: "critical", component: "database", reason: "Database readiness check failed", active: s => s.databaseReady === null ? null : !s.databaseReady },
  { type: "failed_job_backlog", severity: "warning", component: "workflow_queue", reason: "At least five workflow jobs are failed", active: s => s.failedJobs === null ? null : s.failedJobs >= 5 },
  { type: "dead_letter_backlog", severity: "critical", component: "workflow_queue", reason: "Dead-letter queue is non-empty", active: s => s.deadLetterJobs === null ? null : s.deadLetterJobs > 0 },
  { type: "overdue_work", severity: "warning", component: "background_work", reason: "Background work is overdue", active: s => s.overdueWork === null ? null : s.overdueWork > 0 },
  { type: "monitoring_stale", severity: "warning", component: "monitoring", reason: "Critical monitoring data is stale or unavailable", active: s => s.monitoringFresh === null ? null : !s.monitoringFresh },
];

/** Keeps only current incident state. Repeated observations update timestamps without emitting duplicates. */
export class AlertEvaluator {
  private readonly active = new Map<AlertType, AlertEvent>();
  private providerFailures = 0;
  evaluate(snapshot: OperationalSnapshot, correlationId?: string): AlertEvent[] {
    // An unavailable probe is not evidence of recovery: only a healthy observation resets the streak.
    this.providerFailures = snapshot.providerHealthy === false ? this.providerFailures + 1 : snapshot.providerHealthy === true ? 0 : this.providerFailures;
    const emitted: AlertEvent[] = [];
    for (const definition of definitions) {
      const observed = definition.active(snapshot, this.providerFailures);
      const previous = this.active.get(definition.type);
      if (observed === "pending") {
        // Failing but below the threshold: neither fire nor claim the condition cleared.
        if (previous) this.active.set(definition.type, { ...previous, lastSeenAt: snapshot.at });
      } else if (observed === null) {
        if (!previous || previous.state !== "unavailable") {
          const event: AlertEvent = { id: `halo.${definition.type}`, type: definition.type, severity: definition.severity, state: "unavailable", component: definition.component, firstSeenAt: previous?.firstSeenAt ?? snapshot.at, lastSeenAt: snapshot.at, reason: "Required monitoring observation unavailable", ...(correlationId ? { correlationId } : {}) };
          this.active.set(definition.type, event); emitted.push(event);
        } else this.active.set(definition.type, { ...previous, lastSeenAt: snapshot.at });
      } else if (observed) {
        if (!previous || previous.state !== "firing") {
          const event: AlertEvent = { id: `halo.${definition.type}`, type: definition.type, severity: definition.severity, state: "firing", component: definition.component, firstSeenAt: snapshot.at, lastSeenAt: snapshot.at, reason: definition.reason, ...(correlationId ? { correlationId } : {}) };
          this.active.set(definition.type, event); emitted.push(event);
        } else this.active.set(definition.type, { ...previous, lastSeenAt: snapshot.at, ...(correlationId ? { correlationId } : {}) });
      } else if (previous && previous.state !== "resolved") {
        const event = { ...previous, state: "resolved" as const, lastSeenAt: snapshot.at, reason: "Condition cleared" };
        this.active.set(definition.type, event); emitted.push(event);
      }
    }
    return emitted;
  }
  list(): AlertEvent[] { return [...this.active.values()].map(event => ({ ...event })); }
}

/** In-memory sink intended only for tests and local exercises; delivery is idempotent per incident transition. */
export class LocalAlertSink implements AlertSink {
  private readonly events = new Map<string, AlertEvent>();
  private failuresRemaining = 0;
  failNext(count = 1): void { this.failuresRemaining = Math.max(0, Math.floor(count)); }
  async deliver(event: AlertEvent): Promise<void> {
    if (this.failuresRemaining > 0) { this.failuresRemaining--; throw new Error("Local alert sink delivery failed"); }
    const key = `${event.id}:${event.state}:${event.lastSeenAt}`;
    this.events.set(key, { ...event });
  }
  list(): AlertEvent[] { return [...this.events.values()].map(event => ({ ...event })); }
}

/** Bounded retry; the caller receives an observable error after the final attempt. */
export async function deliverAlert(sink: AlertSink, event: AlertEvent, maxAttempts = 2): Promise<void> {
  const attempts = Math.max(1, Math.min(3, Math.floor(maxAttempts)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await sink.deliver(event); return; } catch (error) { lastError = error; }
  }
  throw new Error(`Alert delivery failed after ${attempts} attempts`, { cause: lastError });
}
