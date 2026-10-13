import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { redirect } from "next/navigation";
import { signIn, signOut, signUp } from "@/features/auth/actions";
import { logger } from "@halo/platform/logger";

vi.mock("@halo/tenancy/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`); }) }));
vi.mock("@halo/platform/logger", () => {
  const log = { warn: vi.fn(), error: vi.fn(), child: () => log };
  return { logger: log };
});
const auth = { signInWithPassword: vi.fn(), signUp: vi.fn(), signOut: vi.fn() };
const form = (next = "/dashboard") => {
  const data = new FormData();
  data.set("email", "synthetic@example.invalid"); data.set("password", "synthetic-password"); data.set("next", next);
  return data;
};
describe("Auth actions (mock provider)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({ auth } as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);
    auth.signInWithPassword.mockResolvedValue({ error: null });
    auth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    auth.signOut.mockResolvedValue({ error: null });
  });
  it("validates before requesting Auth", async () => {
    expect((await signIn({ error: null }, new FormData())).error).toBeTruthy();
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
  });
  it("accepts login and rejects unsafe destinations", async () => {
    await expect(signIn({ error: null }, form("//evil.example"))).rejects.toThrow("REDIRECT:/dashboard");
    expect(auth.signInWithPassword).toHaveBeenCalledOnce();
  });
  it("handles invalid credentials without logging provider-controlled messages", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { message: "synthetic-secret-provider", status: 400 } });
    expect((await signIn({ error: null }, form())).error).toBe("Invalid email or password");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("synthetic-secret-provider");
    expect(redirect).not.toHaveBeenCalled();
  });
  it("handles missing configuration safely", async () => {
    vi.mocked(createSupabaseServerClient).mockRejectedValue(new Error("synthetic-secret-config"));
    expect((await signIn({ error: null }, form())).error).toBe("Sign-in is temporarily unavailable. Please try again.");
  });
  it("handles Auth transport failure safely", async () => {
    auth.signInWithPassword.mockRejectedValue(new Error("synthetic-secret-network"));
    expect((await signIn({ error: null }, form())).error).toBe("Sign-in is temporarily unavailable. Please try again.");
  });
  it("does not expose registration upstream errors", async () => {
    auth.signUp.mockResolvedValue({ data: {}, error: { message: "synthetic-secret-registration" } });
    expect((await signUp({ error: null }, form())).error).toBe("Unable to create an account. Please try again.");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("synthetic-secret-registration");
  });
  it("redirects only after successful logout", async () => {
    await expect(signOut()).rejects.toThrow("REDIRECT:/login");
    expect(auth.signOut).toHaveBeenCalledOnce();
  });
  it("reports logout failure rather than falsely redirecting to login", async () => {
    auth.signOut.mockResolvedValue({ error: { message: "synthetic-secret-logout", status: 503 } });
    await expect(signOut()).rejects.toThrow("REDIRECT:/dashboard?error=signout_failed");
  });
});
