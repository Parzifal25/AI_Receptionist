import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/health/route";
import { NextRequest } from "next/server";
import { getServerEnv } from "@halo/platform/env";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { getAdminClient } from "@halo/tenancy/supabase/admin";

vi.mock("@halo/platform/env", () => ({
  getServerEnv: vi.fn(),
}));

vi.mock("@halo/providers/llm/factory", () => ({
  getLLMProvider: vi.fn(),
}));

vi.mock("@halo/tenancy/supabase/admin", () => ({
  getAdminClient: vi.fn(),
}));

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getLLMProvider).mockReturnValue({
      name: "test-llm",
      isHealthy: vi.fn(async () => true),
    } as unknown as ReturnType<typeof getLLMProvider>);
    vi.mocked(getAdminClient).mockReturnValue({
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as unknown as ReturnType<typeof getAdminClient>);
  });

  const makeRequest = (url: string, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost:3000/api/health${url}`, {
      headers: { "x-forwarded-for": "10.0.0.1", ...headers },
    });

  it("shallow liveness is public and leaks nothing", async () => {
    vi.mocked(getServerEnv).mockReturnValue({} as ReturnType<typeof getServerEnv>);

    const res = await GET(makeRequest(""));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("ok");
    expect(body.data.readiness).toBeUndefined();
    expect(body.data.errors).toBeUndefined();
  });

  it("deep probe fails closed when no probe secret is configured", async () => {
    vi.mocked(getServerEnv).mockReturnValue({} as ReturnType<typeof getServerEnv>);

    const res = await GET(makeRequest("?deep=1"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("errors");
  });

  it("deep probe rejects anonymous callers when a secret is configured", async () => {
    vi.mocked(getServerEnv).mockReturnValue({
      CRON_SECRET: "probe-secret-value-0123456789abcdef",
    } as ReturnType<typeof getServerEnv>);

    const res = await GET(makeRequest("?deep=1"));
    expect(res.status).toBe(401);
    const body = await res.json();
    // No readiness internals for unauthenticated callers.
    expect(body.data?.readiness).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("Database connectivity");
  });

  it("deep probe rejects a wrong secret", async () => {
    vi.mocked(getServerEnv).mockReturnValue({
      CRON_SECRET: "probe-secret-value-0123456789abcdef",
    } as ReturnType<typeof getServerEnv>);

    const res = await GET(makeRequest("?deep=1", { authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
  });

  it("deep probe with the right secret returns readiness internals", async () => {
    vi.mocked(getServerEnv).mockReturnValue({
      CRON_SECRET: "probe-secret-value-0123456789abcdef",
    } as ReturnType<typeof getServerEnv>);

    const res = await GET(
      makeRequest("?deep=1", { authorization: "Bearer probe-secret-value-0123456789abcdef" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("ok");
    expect(body.data.readiness).toBeDefined();
    expect(body.data.readiness.errors).toBeInstanceOf(Array);
  });

  it("does not confuse configuration failure with database failure", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ NODE_ENV: "production", CRON_SECRET: "short" } as ReturnType<typeof getServerEnv>);
    const res = await GET(makeRequest("?deep=1", { authorization: "Bearer short" }));
    expect(res.status).toBe(503);
    expect((await res.json()).data.database.connected).toBe(true);
  });

  it("still reports database readiness when a provider health probe throws", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ CRON_SECRET: "probe-secret-value-0123456789abcdef" } as ReturnType<typeof getServerEnv>);
    vi.mocked(getLLMProvider).mockImplementation(() => { throw new Error("synthetic-secret-provider"); });
    const res = await GET(makeRequest("?deep=1", { authorization: "Bearer probe-secret-value-0123456789abcdef" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.data.database.connected).toBe(true);
    expect(body.data.llm.healthy).toBe(false);
    expect(JSON.stringify(body)).not.toContain("synthetic-secret-provider");
  });
});
