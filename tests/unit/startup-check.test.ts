import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateProductionReadiness } from "@/lib/startup-check";
import { getServerEnv } from "@halo/platform/env";
import { getAdminClient } from "@halo/tenancy/supabase/admin";

vi.mock("@halo/platform/env", () => ({
  getServerEnv: vi.fn(),
  resetEnvCacheForTests: vi.fn(),
}));

vi.mock("@halo/tenancy/supabase/admin", () => ({
  getAdminClient: vi.fn(),
}));

/** Minimal env fragment for the checks under test; cast keeps the test focused. */
const envFragment = (overrides: Record<string, string>) =>
  overrides as unknown as ReturnType<typeof getServerEnv>;

describe("startup-check", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    vi.mocked(getAdminClient).mockReturnValue({
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as unknown as ReturnType<typeof getAdminClient>);
  });

  it("returns ready with valid production configuration", async () => {
    vi.mocked(getServerEnv).mockReturnValue(
      envFragment({
        NODE_ENV: "production",
        MESSAGING_PROVIDER: "resend+whatsapp",
        RESEND_API_KEY: "resend-key",
        RESEND_FROM_EMAIL: "test@example.com",
        WHATSAPP_PHONE_NUMBER_ID: "wa-id",
        WHATSAPP_ACCESS_TOKEN: "wa-token",
        CRON_SECRET: "12345678901234567890123456789012",
      }),
    );

    const report = await validateProductionReadiness();
    expect(report.ready).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(report.providers.email).toBe(true);
    expect(report.providers.whatsapp).toBe(true);
  });

  it("returns errors when required variables are missing", async () => {
    vi.mocked(getServerEnv).mockReturnValue(
      envFragment({
        NODE_ENV: "production",
        MESSAGING_PROVIDER: "resend",
        // Missing RESEND_API_KEY and CRON_SECRET
      }),
    );

    const report = await validateProductionReadiness();
    expect(report.ready).toBe(false);
    expect(report.errors.some((e) => e.includes("RESEND_API_KEY"))).toBe(true);
    expect(report.errors.some((e) => e.includes("CRON_SECRET"))).toBe(true);
  });

  it("returns warnings for non-production environments with missing cron secret", async () => {
    vi.mocked(getServerEnv).mockReturnValue(
      envFragment({
        NODE_ENV: "development",
        MESSAGING_PROVIDER: "log",
      }),
    );

    const report = await validateProductionReadiness();
    expect(report.ready).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes("CRON_SECRET"))).toBe(true);
  });

  it("returns errors if database connectivity fails", async () => {
    vi.mocked(getServerEnv).mockReturnValue(
      envFragment({
        NODE_ENV: "development",
        MESSAGING_PROVIDER: "log",
      }),
    );

    vi.mocked(getAdminClient).mockReturnValue({
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ error: { message: "Connection refused" } }),
    } as unknown as ReturnType<typeof getAdminClient>);

    const report = await validateProductionReadiness();
    expect(report.ready).toBe(false);
    expect(report.errors.some((e) => e.includes("Connection refused"))).toBe(true);
  });
});
