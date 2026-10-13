import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { requireBusiness, requireUser } from "@halo/tenancy/auth";

vi.mock("react", () => ({ cache: (fn: unknown) => fn }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("@halo/tenancy/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
const getUser = vi.fn();
const eq = vi.fn();
const maybeSingle = vi.fn();
const from = vi.fn();
describe("server dashboard authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const query = { select: vi.fn().mockReturnThis(), eq, order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle };
    eq.mockReturnValue(query); from.mockReturnValue(query);
    getUser.mockResolvedValue({ data: { user: { id: "user-a" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { business_id: "tenant-a", role: "member" }, error: null });
    vi.mocked(createSupabaseServerClient).mockResolvedValue({ auth: { getUser }, from } as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);
  });
  it("uses verified user membership rather than caller tenant identity", async () => {
    expect(await requireBusiness()).toEqual({ userId: "user-a", businessId: "tenant-a", role: "member" });
    expect(eq).toHaveBeenCalledWith("user_id", "user-a");
  });
  it("denies missing/expired users before querying memberships", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(requireBusiness()).rejects.toThrow("REDIRECT:/login");
    expect(from).not.toHaveBeenCalled();
  });
  it("does not trust Auth data accompanied by an error", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-a" } }, error: { status: 401 } });
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
  });
  it("distinguishes a membership database outage from new-user onboarding", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "synthetic-secret-db" } });
    await expect(requireBusiness()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "Account access is temporarily unavailable" });
  });
  it("onboards a validated user with no membership", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(requireBusiness()).rejects.toThrow("REDIRECT:/onboarding");
  });
});
