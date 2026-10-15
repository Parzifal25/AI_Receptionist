import "server-only";
import type { SecurityAuditRecord, SecurityAuditStore } from "@halo/platform/security-audit";
import { getAdminClient } from "./supabase/admin";

/** Lazy connection: unavailable credentials never cause a raw exception to enter logs. */
export const securityAuditStore: SecurityAuditStore = {
  async append(record: SecurityAuditRecord): Promise<void> {
    const { error } = await getAdminClient().from("audit_logs").insert({
      operation_id: record.operationId, business_id: record.businessId, actor_id: record.actorId,
      method: record.method, route_group: record.routeGroup,
      action: record.action, outcome: record.outcome, reason: record.reason, correlation_id: record.correlationId,
    }).abortSignal(AbortSignal.timeout(5000));
    if (error) throw new Error("Security audit persistence failed");
  },
};
