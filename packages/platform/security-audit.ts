import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { newTelemetryId, telemetryId } from "./telemetry";
import { logger } from "./logger";

export type SecurityAction = "updateSettings" | "disconnectGoogleCalendar" | "createDocument" | "updateDocument" | "reviewDocumentRevision" | "withdrawDocument" | "deleteDocument" | "createFaq" | "updateFaq" | "reviewFaqRevision" | "withdrawFaq" | "deleteFaq" | "updateLifecycleSettings" | "updateAppointmentLifecycle" | "updateLeadStatus" | "deleteLead" | "updateReceptionist" | "createBusiness" | "updateBusinessProfile" | "api_access" | "dashboard_mutation" | "authentication" | "calendar_authorization";
export interface SecurityIdentity { businessId: string | null; actorId: string | null }
export interface SecurityAuditRecord {
  operationId: string; businessId: string | null; actorId: string | null;
  method: string; routeGroup: string;
  action: SecurityAction; outcome: "attempted" | "denied" | "succeeded" | "failed" | "unknown";
  reason: "authorized" | "unauthenticated" | "forbidden" | "completed" | "request_failed" | "outcome_unknown";
  correlationId: string;
}
export interface SecurityAuditStore { append(record: SecurityAuditRecord): Promise<void> }
interface Scope {
  method: string; routeGroup: string; action: SecurityAction;
  store: SecurityAuditStore; operationId: string; correlationId: string;
  identity?: SecurityIdentity; mandatory: boolean; attempted?: Promise<void>; terminal?: boolean; eligible?: boolean;
}
const scopes = new AsyncLocalStorage<Scope>();
export function withSecurityAudit<T>(store: SecurityAuditStore, mandatory: boolean, fn: () => T, method = "OTHER", routeGroup = "other", action: SecurityAction = "api_access"): T {
  const safeMethod = ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"].includes(method) ? method : "OTHER";
  const safeGroup = ["health","widget","appointments","workflows","cron","campaigns","learning","analytics","admin","hooks","oauth"].includes(routeGroup) ? routeGroup : "other";
  return scopes.run({ store, mandatory, action, method: safeMethod, routeGroup: safeGroup, operationId: randomUUID(), correlationId: telemetryId() ?? newTelemetryId() }, fn);
}
function record(scope: Scope, outcome: SecurityAuditRecord["outcome"], reason: SecurityAuditRecord["reason"]): SecurityAuditRecord {
  // Explicit construction: caller metadata and request data never enter the record.
  return { operationId: scope.operationId, businessId: scope.identity?.businessId ?? null,
    actorId: scope.identity?.actorId ?? null, method: scope.method, routeGroup: scope.routeGroup, action: scope.action, outcome, reason, correlationId: scope.correlationId };
}
export class SecurityAuditUnavailable extends Error {
  constructor() { super("Security audit unavailable"); }
}
/** An admitted operation, not an authentication success. No actor/tenant inferred. */
export async function beginSecurityAudit(required?: boolean): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.eligible = true;
  scope.attempted ??= scope.store.append(record(scope, "attempted", "authorized"));
  try { await scope.attempted; } catch {
    logger.error("security audit unavailable", { stage: "attempted", reason: "audit_unavailable", operationId: scope.operationId, correlationId: scope.correlationId });
    if (required ?? scope.mandatory) throw new SecurityAuditUnavailable();
  }
}
/** Call only after verified authentication AND membership resolution, never from request metadata. */
export async function bindSecurityIdentity(identity: SecurityIdentity, afterExecution = false): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return; // server component outside the API wrapper
  if (scope.identity?.actorId === identity.actorId && identity.businessId === null) return;
  if (scope.identity && ((scope.identity.businessId !== null && scope.identity.businessId !== identity.businessId) || scope.identity.actorId !== identity.actorId)) {
    throw new SecurityAuditUnavailable();
  }
  if (!scope.identity || (scope.identity.businessId === null && identity.businessId !== null)) scope.attempted = undefined;
  scope.identity = { businessId: identity.businessId, actorId: identity.actorId };
  scope.eligible = true;
  scope.attempted ??= scope.store.append(record(scope, "attempted", "authorized"));
  try { await scope.attempted; } catch {
    logger.error("security audit unavailable", { stage: "attempted", reason: "audit_unavailable", operationId: scope.operationId, correlationId: scope.correlationId });
    if (scope.mandatory && !afterExecution) throw new SecurityAuditUnavailable();
  }
}
export async function rejectSecurityAudit(): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  await finishSecurityAudit(403);
  scope.terminal = true;
}
export async function failSecurityAudit(): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  await finishSecurityAudit(500);
  scope.terminal = true;
}
export async function recordAuthenticationDenial(): Promise<void> {
  const scope = scopes.getStore();
  if (!scope) return;
  await finishSecurityAudit(401);
  scope.terminal = true;
}
/** Best effort after execution: never turn a completed action into a replayable error. */
export async function finishSecurityAudit(status: number): Promise<void> {
  const scope = scopes.getStore();
  if (!scope || scope.terminal || (!scope.eligible && status !== 401 && status !== 403)) return;
  scope.terminal = true;
  const outcome = status === 401 || status === 403 ? "denied" : status >= 500 ? "unknown" : status >= 400 ? "failed" : "succeeded";
  const reason = status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : status >= 500 ? "outcome_unknown" : status >= 400 ? "request_failed" : "completed";
  try { await scope.store.append(record(scope, outcome, reason)); } catch {
    logger.error("security audit unavailable", { stage: "finished", reason: "audit_unavailable", operationId: scope.operationId, correlationId: scope.correlationId });
  }
}
