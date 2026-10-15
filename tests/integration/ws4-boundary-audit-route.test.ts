import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api/respond";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import type { SecurityAuditRecord } from "@halo/platform/security-audit";
const fixture = vi.hoisted(() => ({ rows: [] as SecurityAuditRecord[], fail: "" }));
vi.mock("react", () => ({ cache: (fn: unknown) => fn }));
vi.mock("@halo/tenancy/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@halo/tenancy/security-audit-store", () => ({ securityAuditStore: {
 append: async (row: SecurityAuditRecord) => { if (fixture.fail === row.outcome) throw new Error("synthetic-secret-token"); fixture.rows.push(structuredClone(row)); },
} }));
const actor = "11111111-1111-4111-8111-111111111111", tenant = "22222222-2222-4222-8222-222222222222";
describe("real API wrapper → verified auth → durable audit contract", () => {
 beforeEach(() => {
  fixture.rows.length=0; fixture.fail="";
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle: async () => ({ data: { business_id: tenant, role:"owner" }, error:null }) };
  vi.mocked(createSupabaseServerClient).mockResolvedValue({ auth:{ getUser:async()=>({data:{user:{id:actor}},error:null}) },from:()=>query } as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);
 });
 it("links request, trusted identity, service context and audit, ignoring forged request fields", async () => {
  const effect = vi.fn();
  const route=withErrorHandling("admin.synthetic",async(_request:Request)=>{ const ctx=await requireBusiness(); effect(ctx); return NextResponse.json({ok:true}); });
  const response=await route(new Request("http://synthetic.test", {method:"POST", headers:{"x-request-id":"forged-secret-token"},body:JSON.stringify({actorId:"forged",businessId:"forged"})}));
  expect(response.status).toBe(200); expect(effect).toHaveBeenCalledWith({userId:actor,businessId:tenant,role:"owner"});
  const final=fixture.rows.at(-1)!;
  expect(final).toMatchObject({actorId:actor,businessId:tenant,outcome:"succeeded",method:"POST",routeGroup:"admin",correlationId:response.headers.get("x-request-id")});
  expect(JSON.stringify(fixture.rows)).not.toContain("forged");
 });
 it("pre-audit outage returns 503 before the mutation; terminal audit outage preserves 200", async () => {
  const effect=vi.fn();
  const route=withErrorHandling("admin.synthetic",async(_request:Request)=>{await requireBusiness();effect();return NextResponse.json({ok:true});});
  fixture.fail="attempted";
  expect((await route(new Request("http://synthetic.test",{method:"POST"}))).status).toBe(503); expect(effect).not.toHaveBeenCalled();
  fixture.fail="succeeded";
  expect((await route(new Request("http://synthetic.test",{method:"POST"}))).status).toBe(200); expect(effect).toHaveBeenCalledTimes(1);
 });
 it("records explicit role/resource denials without recording caller resource data", async()=>{
  const route=withErrorHandling("admin.synthetic",async()=>{await requireBusiness();return NextResponse.json({error:"denied"},{status:403});});
  await route(); expect(fixture.rows.at(-1)).toMatchObject({actorId:actor,businessId:tenant,outcome:"denied",reason:"forbidden"});
 });
});
