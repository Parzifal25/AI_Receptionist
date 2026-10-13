import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { GET } from "@/app/auth/callback/route";

vi.mock("@halo/tenancy/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
const exchangeCodeForSession = vi.fn();
describe("Auth callback failure and redirect boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({ auth: { exchangeCodeForSession } } as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);
    exchangeCodeForSession.mockResolvedValue({ error: null });
  });
  it("exchanges a code then redirects within the origin with no caching", async () => {
    const res = await GET(new NextRequest("https://halo.example/auth/callback?code=synthetic&next=/dashboard/leads"));
    expect(res.headers.get("location")).toBe("https://halo.example/dashboard/leads");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(exchangeCodeForSession).toHaveBeenCalledWith("synthetic");
  });
  it("rejects normalized external redirect attempts", async () => {
    const res = await GET(new NextRequest("https://halo.example/auth/callback?code=synthetic&next=%2F%09%2Fevil.example"));
    expect(res.headers.get("location")).toBe("https://halo.example/dashboard");
  });
  it("returns a safe error for a rejected code", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: "synthetic-secret" } });
    const res = await GET(new NextRequest("https://halo.example/auth/callback?code=synthetic"));
    expect(res.headers.get("location")).toBe("https://halo.example/login?error=auth_callback_failed");
  });
  it("returns a safe error when Auth throws", async () => {
    exchangeCodeForSession.mockRejectedValue(new Error("synthetic-secret"));
    const res = await GET(new NextRequest("https://halo.example/auth/callback?code=synthetic"));
    expect(res.headers.get("location")).toBe("https://halo.example/login?error=auth_callback_failed");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
  it("does not invoke Auth without a code", async () => {
    await GET(new NextRequest("https://halo.example/auth/callback"));
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
  });
});
