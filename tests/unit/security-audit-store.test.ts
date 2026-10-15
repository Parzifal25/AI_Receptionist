import { describe, expect, it, vi } from "vitest";
vi.unmock("@halo/tenancy/security-audit-store");
vi.mock("@halo/tenancy/supabase/admin", () => ({ getAdminClient: vi.fn() }));
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { securityAuditStore } from "@halo/tenancy/security-audit-store";
import type { SecurityAuditRecord } from "@halo/platform/security-audit";
const row: SecurityAuditRecord = {operationId:"11111111-1111-4111-8111-111111111111",businessId:null,actorId:null,action:"api_access",outcome:"denied",reason:"unauthenticated",correlationId:"11111111-1111-4111-8111-111111111111",method:"POST",routeGroup:"admin"};
describe("durable audit adapter contract",()=>{
 it("inserts only accountability columns with a deadline and sanitized persistence errors",async()=>{
  const deadline=vi.fn().mockResolvedValue({error:null});const insert=vi.fn((_row: Record<string, unknown>)=>({abortSignal:deadline}));const from=vi.fn(()=>({insert}));
  vi.mocked(getAdminClient).mockReturnValue({from} as unknown as ReturnType<typeof getAdminClient>);
  await securityAuditStore.append({...row,token:"synthetic-private-token"} as SecurityAuditRecord);
  expect(from).toHaveBeenCalledWith("audit_logs");expect(Object.keys(insert.mock.calls[0][0])).toEqual(["operation_id","business_id","actor_id","method","route_group","action","outcome","reason","correlation_id"]);
  expect(JSON.stringify(insert.mock.calls)).not.toContain("synthetic-private-token");expect(deadline.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  deadline.mockResolvedValue({error:{message:"synthetic-private-token"}});
  await expect(securityAuditStore.append(row)).rejects.toThrow(/^Security audit persistence failed$/);
 });
});
