import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/campaigns/route";
import { GET as tick } from "@/app/api/cron/campaigns/route";
import { requireBusiness } from "@halo/tenancy/auth";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { getServerEnv } from "@halo/platform/env";
import { dispatchCampaign } from "@halo/campaigns/dispatch";
vi.mock("@halo/tenancy/auth", () => ({ requireBusiness: vi.fn() }));
vi.mock("@halo/tenancy/supabase/admin", () => ({ getAdminClient: vi.fn() }));
vi.mock("@halo/platform/env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@halo/campaigns/dispatch", () => ({ dispatchCampaign: vi.fn() }));
const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const request = () => new NextRequest("http://localhost/api/campaigns", { method: "POST", body: JSON.stringify({ action: "dispatch", campaignId, limit: 1, businessId: "forged-tenant" }) });
beforeEach(() => vi.resetAllMocks());
describe("campaign authorization boundaries", () => {
  it("rejects ordinary members before any service-role lookup or dial", async () => {
    vi.mocked(requireBusiness).mockResolvedValue({ businessId: "tenant", role: "member", userId: "user" });
    expect((await POST(request())).status).toBe(403);
    expect(getAdminClient).not.toHaveBeenCalled();
    expect(dispatchCampaign).not.toHaveBeenCalled();
  });
  it("dispatches only within the authenticated tenant, ignoring payload identity", async () => {
    vi.mocked(requireBusiness).mockResolvedValue({ businessId: "actual-tenant", role: "admin", userId: "user" });
    vi.mocked(dispatchCampaign).mockResolvedValue({ claimed: 1, accepted: 1, uncertain: 0 });
    expect((await POST(request())).status).toBe(200);
    expect(dispatchCampaign).toHaveBeenCalledWith("actual-tenant", campaignId, 1);
  });
  it.each([undefined, "configured-secret"])("fails closed for unauthenticated cron with secret %s", async secret => {
    vi.mocked(getServerEnv).mockReturnValue({ CRON_SECRET: secret } as ReturnType<typeof getServerEnv>);
    expect((await tick(new NextRequest("http://localhost/api/cron/campaigns"))).status).toBe(secret ? 401 : 500);
    expect(getAdminClient).not.toHaveBeenCalled();
    expect(dispatchCampaign).not.toHaveBeenCalled();
  });
});
