import { RetrySafeWorkflowError } from "@halo/workflows/types";
import { describe, it, expect, vi } from "vitest";
import { bindSecurityIdentity, finishSecurityAudit, recordAuthenticationDenial, withSecurityAudit, type SecurityAuditRecord, type SecurityAuditStore } from "@halo/platform/security-audit";
import { telemetryId, withTelemetryContext, isTelemetryId } from "@halo/platform/telemetry";
import { WorkflowEngine } from "@halo/workflows/engine";
import { InMemoryWorkflowStore } from "../mocks/in-memory-workflow-store";
import type { BusinessEvent, WorkflowDefinition } from "@halo/core/domain/workflow";
import { mintStreamToken, verifyStreamToken } from "../../services/voice-gateway/stream-token";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const identity = { actorId: a, businessId: b };
function memory() { const rows: SecurityAuditRecord[] = []; return { rows, append: async (r: SecurityAuditRecord) => { rows.push(structuredClone(r)); } }; }
const event = (id = a, tenant = a): BusinessEvent => ({ id, businessId: tenant, correlationId: "business-journey", telemetryCorrelationId: id, type: "lead.created", occurredAt: "2026-01-01T00:00:00Z", payload: { token: "synthetic-private-token" } });
const workflow = (tenant = a): WorkflowDefinition => ({ id: `wf-${tenant}`, businessId: tenant, name: "Synthetic", description: "", version: 1, enabled: true, trigger: "lead.created", conditions: [], steps: [{ id: "s", action: "send_email", params: {}, retry: { maxAttempts: 2, backoffMs: 0 } }] });

describe("WS4 audit boundary", () => {
 it("records trusted identity, ordered attempts and outcomes without metadata", async () => {
  const store = memory();
  await withTelemetryContext(() => withSecurityAudit(store, true, async () => {
   await bindSecurityIdentity({ ...identity, token: "synthetic-private-token" } as typeof identity);
   await finishSecurityAudit(200);
  }), a);
  expect(store.rows.map(r => r.outcome)).toEqual(["attempted", "succeeded"]);
  expect(store.rows[0]).toMatchObject({ ...identity, correlationId: a });
  expect(store.rows[1].operationId).toBe(store.rows[0].operationId);
  expect(JSON.stringify(store.rows)).not.toContain("synthetic-private");
 });
 it("records authorization denial and unauthenticated navigation exactly once", async () => {
  const store = memory();
  await withSecurityAudit(store, false, async () => { await bindSecurityIdentity(identity); await finishSecurityAudit(403); });
  await withSecurityAudit(store, false, async () => { await recordAuthenticationDenial(); await finishSecurityAudit(500); });
  expect(store.rows.map(r => r.outcome)).toEqual(["attempted", "denied", "denied"]);
  expect(store.rows[2]).toMatchObject({ businessId: null, actorId: null, reason: "unauthenticated" });
 });
 it("fails closed before side effects on mandatory persistence failure", async () => {
  const sideEffect = vi.fn(); const store: SecurityAuditStore = { append: async () => { throw new Error("synthetic-private-token"); } };
  await expect(withSecurityAudit(store, true, async () => { await bindSecurityIdentity(identity); sideEffect(); })).rejects.toThrow("Security audit unavailable");
  expect(sideEffect).not.toHaveBeenCalled();
 });
 it("does not roll back or replay completed work when terminal audit fails", async () => {
  const rows = memory(); let calls = 0;
  const result = await withSecurityAudit({ append: async r => { if (r.outcome !== "attempted") throw new Error("private"); await rows.append(r); } }, true, async () => {
   await bindSecurityIdentity(identity); calls++; await finishSecurityAudit(200); return "completed";
  });
  expect(result).toBe("completed"); expect(calls).toBe(1); expect(rows.rows[0].outcome).toBe("attempted");
 });
 it("isolates concurrent scopes and refuses identity replacement", async () => {
  const store = memory();
  await Promise.all([a,b].map(id => withTelemetryContext(() => withSecurityAudit(store, true, async () => {
   await bindSecurityIdentity({ businessId: id, actorId: id }); await Promise.resolve();
   await expect(bindSecurityIdentity({ businessId: id === a ? b : a, actorId: id })).rejects.toThrow();
   await finishSecurityAudit(200);
  }), id)));
  expect(store.rows).toHaveLength(4);
  for (const row of store.rows) expect(row.correlationId).toBe(row.businessId);
  expect(telemetryId()).toBeUndefined();
 });
});

describe("WS4 durable job context and commit point", () => {
 it("restores serialized context on execution, retry and dead letter under another cron context", async () => {
  const store = new InMemoryWorkflowStore(); store.addWorkflow(workflow());
  const ids: Array<string | undefined> = [];
  const engine = new WorkflowEngine(store, { send_email: async () => { ids.push(telemetryId()); throw new RetrySafeWorkflowError(); } }, { maxRunAttempts: 2 });
  const serialized = JSON.parse(JSON.stringify(event()));
  await withTelemetryContext(() => engine.dispatch(serialized), b);
  store.now = () => Date.now() + 3600000;
  await withTelemetryContext(() => engine.processDue({ emit: async () => {} }), b);
  expect(ids).toEqual([a,a,a,a]); expect(store.allRuns()[0].status).toBe("dead_letter");
  expect(JSON.stringify(store.allRuns()) + JSON.stringify(store.logs)).not.toContain("synthetic-private-token");
  expect(telemetryId()).toBeUndefined();
 });
 it("isolates concurrent tenants and creates stable legacy fallback IDs", async () => {
  const store = new InMemoryWorkflowStore(); [a,b].forEach(t => store.addWorkflow(workflow(t)));
  const seen: Record<string,string | undefined> = {};
  const engine = new WorkflowEngine(store, { send_email: async (_,ctx) => { await Promise.resolve(); seen[ctx.businessId] = telemetryId(); } });
  await Promise.all([a,b].map(t => engine.dispatch({ ...event(t,t), telemetryCorrelationId: "malformed" })));
  expect(isTelemetryId(seen[a])).toBe(true); expect(isTelemetryId(seen[b])).toBe(true); expect(seen[a]).not.toBe(seen[b]);
 });
 it("quarantines a completed action when writing success evidence fails, without retry", async () => {
  const store = new InMemoryWorkflowStore(); store.addWorkflow(workflow());
  store.appendLog = async () => { throw new Error("synthetic-private-token"); };
  const action = vi.fn(async () => ({ ok: true }));
  const engine = new WorkflowEngine(store, { send_email: action });
  await engine.dispatch(event());
  expect(action).toHaveBeenCalledTimes(1);
  expect(store.allRuns()[0]).toMatchObject({ status: "dead_letter", error: "action_completed_history_unavailable", nextAttemptAt: null });
  store.now = () => Date.now() + 3600000;
  await engine.processDue({ emit: async () => {} }); expect(action).toHaveBeenCalledTimes(1);
 });
 it("authenticates correlation in stream tokens and rejects conflicting or tampered values", () => {
  const claims = { providerCallId: "synthetic-call", from: "synthetic-from", to: "synthetic-to" };
  const token = mintStreamToken("synthetic-secret", { ...claims, correlationId: a }, 1000, 0);
  expect(verifyStreamToken("synthetic-secret", token, claims, 1)).toEqual({ ok: true, correlationId: a });
  expect(verifyStreamToken("synthetic-secret", token.replace(a,b), claims, 1).ok).toBe(false);
  expect(verifyStreamToken("synthetic-secret", token + ".extra", claims, 1).ok).toBe(false);
  expect(verifyStreamToken("synthetic-secret", mintStreamToken("synthetic-secret", claims,1000,0),claims,1)).toEqual({ ok:true });
 });
});

it("does not replay a consequential workflow action after remote success followed by an exception", async () => {
 const store = new InMemoryWorkflowStore(); store.addWorkflow(workflow());
 let remoteCreates=0;
 const engine = new WorkflowEngine(store, { send_email: async () => { remoteCreates++; throw new Error("synthetic-private-timeout-after-commit"); } });
 await engine.dispatch(event());
 store.now=()=>Date.now()+3600000;
 await engine.processDue({ emit:async()=>{} });
 expect(remoteCreates).toBe(1);expect(store.allRuns()[0]).toMatchObject({status:"dead_letter",error:"action_outcome_unknown",nextAttemptAt:null});
});

it("keeps unprotected liveness/read success independent of audit storage", async () => {
 const store = { append: vi.fn(async () => { throw new Error("audit_down"); }) };
 await withSecurityAudit(store, false, () => finishSecurityAudit(200), "GET", "health");
 expect(store.append).not.toHaveBeenCalled();
});
