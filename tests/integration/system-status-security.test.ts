import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/system-status/route";
import { requireBusiness } from "@halo/tenancy/auth";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { validateProductionReadiness } from "@/lib/startup-check";
import { AppError } from "@halo/core/errors/app-error";

vi.mock("@halo/tenancy/auth", () => ({ requireBusiness: vi.fn() }));
vi.mock("@halo/tenancy/supabase/admin", () => ({ getAdminClient: vi.fn() }));
vi.mock("@halo/providers/llm/factory", () => ({ getLLMProvider: vi.fn() }));
vi.mock("@/lib/startup-check", () => ({ validateProductionReadiness: vi.fn() }));
const isHealthy = vi.fn();
const from = vi.fn();
let queryError: boolean;
let missingCount: boolean;
describe("tenant administrator monitoring authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks(); queryError = false; missingCount = false;
    vi.mocked(requireBusiness).mockResolvedValue({ userId: "user-a", businessId: "tenant-a", role: "owner" });
    vi.mocked(getAdminClient).mockReturnValue({ from } as unknown as ReturnType<typeof getAdminClient>);
    from.mockImplementation((table: string) => {
      const filters: Record<string, string> = {};
      let overdue = false;
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((column: string, value: string) => { filters[column] = value; return builder; }),
        gte: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
        lte: vi.fn(() => { overdue = true; return builder; }),
        then: (resolve: (value: unknown) => void) => resolve(queryError
          ? { error: { message: "synthetic-secret-database" }, count: null, data: null }
          : { error: null, count: missingCount && table === "workflow_runs" ? null : filters.business_id === "tenant-a" ? (table === "workflow_runs" && filters.status === "dead_letter" ? 2 : 1) : 999,
            data: filters.business_id === "tenant-a"
              ? table === "calendar_connections" ? [{ provider: "own" }]
                : table === "appointment_reminders" && overdue ? [{ send_at: new Date(Date.now() - 60_000).toISOString() }]
                : table === "usage_events" ? [{ created_at: new Date(Date.now() - 10_000).toISOString(), metadata: { latencyMs: 100 } }, { created_at: new Date().toISOString(), metadata: { latencyMs: 300 } }]
                    : []
              : [{ provider: "own" }, { provider: "foreign" }] }),
      };
      return builder;
    });
    isHealthy.mockResolvedValue(true);
    vi.mocked(getLLMProvider).mockReturnValue({ name: "synthetic", isHealthy } as unknown as ReturnType<typeof getLLMProvider>);
    vi.mocked(validateProductionReadiness).mockResolvedValue({ ready: true, database: { checked: true, connected: true }, errors: [], warnings: [], providers: { email: false, whatsapp: false } });
  });
  it("scopes every service-role operational query to the authenticated tenant", async () => {
    const body = await (await GET()).json();
    expect(body.data.queues.pendingReminders).toBe(1);
    expect(body.data.queues.overdueReminders).toBe(1);
    expect(body.data.queues.oldestOverdueReminderAgeMs).toBeGreaterThanOrEqual(60_000);
    expect(body.data.queues.failedWorkflowRuns).toBe(1);
    expect(body.data.queues.deadLetterWorkflowRuns).toBe(2);
    expect(body.data.providerTelemetry.successfulTurnLatencyMs24h).toMatchObject({ samples: 2, p50: 100, p95: 300 });
    expect(body.data.providerTelemetry.failureRate).toBeNull();
    expect(body.data.providerTelemetry.freshness).toBe("observed");
    expect(body.data.calendars.active).toBe(1);
    expect(body.data.status).toBe("degraded");
    expect(from).toHaveBeenCalledTimes(8);
  });
  it("rejects ordinary members before reading data or probing providers", async () => {
    vi.mocked(requireBusiness).mockResolvedValue({ userId: "user-a", businessId: "tenant-a", role: "member" });
    expect((await GET()).status).toBe(403);
    expect(from).not.toHaveBeenCalled(); expect(getLLMProvider).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated API calls before side effects", async () => {
    vi.mocked(requireBusiness).mockRejectedValue(AppError.unauthorized());
    expect((await GET()).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });
  it("reports provider failure as degraded even when the database works", async () => {
    isHealthy.mockResolvedValue(false);
    const body = await (await GET()).json();
    expect(body.data.status).toBe("degraded");
    expect(body.data.database.connected).toBe(true);
  });
  it("does not present query failure as an empty healthy queue", async () => {
    queryError = true;
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-secret-database");
  });
  it("does not interpret missing exact counts as an empty queue", async () => {
    missingCount = true;
    expect((await GET()).status).toBe(503);
  });
  it("reports missing required configuration as degraded without exposing validation details", async () => {
    vi.mocked(validateProductionReadiness).mockResolvedValue({ ready: false, database: { checked: true, connected: true }, errors: ["synthetic private config name"], warnings: [], providers: { email: false, whatsapp: false } });
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.status).toBe("degraded");
    expect(JSON.stringify(body)).not.toContain("synthetic private config name");
  });
});
