import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import proxy from "@/proxy";

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

describe("dashboard session proxy (mock Auth, real Next cookies)", () => {
  let cookies: CookieMethodsServer;
  const getUser = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createServerClient).mockImplementation((_url, _key, options) => {
      cookies = options.cookies as CookieMethodsServer;
      return { auth: { getUser } } as unknown as ReturnType<typeof createServerClient>;
    });
    getUser.mockResolvedValue({ data: { user: { id: "synthetic-user" } }, error: null });
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = (path: string) => new NextRequest(`https://halo.example${path}`);
  const refresh = async (user: { id: string } | null) => {
    await cookies.setAll!([{ name: "sb-fixture-auth-token", value: user ? "synthetic-refresh" : "", options: { path: "/", sameSite: "lax", secure: true, ...(user ? {} : { maxAge: 0 }) } }], { "Cache-Control": "private, no-store", Expires: "0", Pragma: "no-cache" });
    return { data: { user }, error: null };
  };

  it("passes a validated session and makes the refreshed cookie available downstream", async () => {
    getUser.mockImplementation(() => refresh({ id: "synthetic-user" }));
    const req = request("/dashboard");
    const res = await proxy(req);
    expect(res.status).toBe(200);
    expect(req.cookies.get("sb-fixture-auth-token")?.value).toBe("synthetic-refresh");
    expect(res.cookies.get("sb-fixture-auth-token")?.value).toBe("synthetic-refresh");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
  it("preserves refresh cookies and anti-cache headers on the login redirect", async () => {
    getUser.mockImplementation(() => refresh({ id: "synthetic-user" }));
    const res = await proxy(request("/login"));
    expect(res.headers.get("location")).toBe("https://halo.example/dashboard");
    expect(res.cookies.get("sb-fixture-auth-token")?.value).toBe("synthetic-refresh");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
  it("preserves cookie deletion for an expired/revoked session on a protected redirect", async () => {
    getUser.mockImplementation(() => refresh(null));
    const res = await proxy(request("/dashboard?token=synthetic-sensitive"));
    expect(res.headers.get("location")).toBe("https://halo.example/login?next=%2Fdashboard");
    expect(res.cookies.get("sb-fixture-auth-token")?.maxAge).toBe(0);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
  it("does not trust a user returned alongside an Auth error", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "untrusted" } }, error: { status: 401 } });
    expect((await proxy(request("/dashboard"))).headers.get("location")).toContain("/login");
  });
  it("fails closed with an opaque 503 during Auth outage", async () => {
    getUser.mockRejectedValue(new Error("synthetic-secret-upstream"));
    const res = await proxy(request("/dashboard"));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("synthetic-secret-upstream");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
  it("fails closed without public Auth configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const res = await proxy(request("/dashboard"));
    expect(res.status).toBe(503);
    expect(createServerClient).not.toHaveBeenCalled();
  });
  it("restores identity from the request cookie on a new request", async () => {
    getUser.mockImplementation(async () => {
      expect(await cookies.getAll()).toEqual([{ name: "sb-fixture-auth-token", value: "synthetic-existing" }]);
      return { data: { user: { id: "synthetic-user" } }, error: null };
    });
    expect((await proxy(new NextRequest("https://halo.example/dashboard", { headers: { cookie: "sb-fixture-auth-token=synthetic-existing" } }))).status).toBe(200);
  });
});
