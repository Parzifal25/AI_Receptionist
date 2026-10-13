import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("shared Supabase cookie scope", () => {
  it("requires secure transport in production", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.resetModules();
    const { authCookieOptions } = await import("@halo/tenancy/supabase/cookie-options");
    expect(authCookieOptions).toEqual({ secure: true, sameSite: "lax", path: "/" });
  });
  it("supports HTTP only for local development", async () => {
    vi.stubEnv("NODE_ENV", "development"); vi.resetModules();
    const { authCookieOptions } = await import("@halo/tenancy/supabase/cookie-options");
    expect(authCookieOptions.secure).toBe(false);
  });
});
