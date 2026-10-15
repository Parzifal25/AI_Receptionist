import "server-only";
import { withTelemetryContext } from "@halo/platform/telemetry";
import { beginSecurityAudit, finishSecurityAudit, withSecurityAudit, type SecurityAction } from "@halo/platform/security-audit";
import { securityAuditStore } from "./security-audit-store";

/** Server-action boundary. Auth helpers persist the trusted attempt before writes. */
export function withAuditedAction<T>(fn: () => Promise<T>, options: { mandatory?: boolean; action?: SecurityAction; method?: string } = {}): Promise<T> {
  return withTelemetryContext(() => withSecurityAudit(securityAuditStore, options.mandatory ?? true, async () => {
    let status = 500;
    try {
      await beginSecurityAudit();
      const result = await fn();
      // A failed action may already have committed a partial write; never
      // call it rolled back. Void actions must mark explicit denials/failures.
      status = result && typeof result === "object" && "error" in result && result.error ? 500 : 200;
      return result;
    } finally {
      await finishSecurityAudit(status);
    }
  }, options.method ?? "POST", "admin", options.action ?? "dashboard_mutation"));
}
