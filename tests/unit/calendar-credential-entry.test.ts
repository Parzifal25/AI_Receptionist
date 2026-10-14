import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cli: vi.fn(), client: vi.fn(), env: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.cli }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.client }));
vi.mock("@halo/platform/env", () => ({ getServerEnv: mocks.env }));

const local = "http://127.0.0.1:55321";
const originalArgv = process.argv;
const originalExit = process.exitCode;
let errors: ReturnType<typeof vi.spyOn>;
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.argv = ["node", "script", `--target=${local}`, "--verify-current"];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", local);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fixture-anon");
  for (const key of Object.keys(process.env)) {
    if (/(^|_)PROXY$|^NO_PROXY$/i.test(key)) vi.stubEnv(key, "");
  }
  mocks.env.mockReturnValue({ NEXT_PUBLIC_SUPABASE_URL: local, SUPABASE_SERVICE_ROLE_KEY: "fixture-service", CALENDAR_CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64) });
  mocks.cli.mockReturnValue(JSON.stringify({ API_URL: local, DB_URL: "postgresql://postgres:postgres@127.0.0.1:55322/postgres", ANON_KEY: "fixture-anon", SERVICE_ROLE_KEY: "fixture-service" }));
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  network = vi.fn(() => { throw new Error("unexpected network"); });
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExit;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run() {
  await import("../../scripts/calendar-credentials");
  await new Promise((resolve) => setImmediate(resolve));
}

describe("calendar credential entry preflight", () => {
  it.each(["target", "proxy", "missing-key", "CLI-error", "invalid-JSON", "identity"]) (
    "rejects %s before client construction and network requests", async (failure) => {
      if (failure === "target") vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://unproven.invalid");
      if (failure === "proxy") vi.stubEnv("HTTPS_PROXY", "http://proxy.invalid");
      if (failure === "missing-key") mocks.env.mockReturnValue({ NEXT_PUBLIC_SUPABASE_URL: local });
      if (failure === "CLI-error") mocks.cli.mockImplementationOnce(() => { throw new Error("sensitive-cli-output"); });
      if (failure === "invalid-JSON") mocks.cli.mockReturnValueOnce("sensitive-cli-output");
      if (failure === "identity") mocks.cli.mockReturnValueOnce(JSON.stringify({ API_URL: local }));
      await run();
      expect(process.exitCode).toBe(1);
      expect(errors).toHaveBeenCalled();
      expect(JSON.stringify(errors.mock.calls)).not.toContain("sensitive-cli-output");
      expect(mocks.client).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      if (["target", "proxy", "missing-key"].includes(failure)) expect(mocks.cli).not.toHaveBeenCalled();
    },
  );

  it("captures status privately with telemetry disabled before constructing a read-only client", async () => {
    const query = { select: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [], error: null }) };
    mocks.client.mockReturnValue({ from: vi.fn().mockReturnValue(query) });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await run();
    expect(errors).not.toHaveBeenCalled();
    expect(mocks.cli).toHaveBeenCalledWith("supabase", expect.any(Array), expect.objectContaining({ env: expect.objectContaining({ SUPABASE_TELEMETRY_DISABLED: "1" }), stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 }));
    expect(mocks.client).toHaveBeenCalledOnce();
    expect(mocks.client.mock.calls[0][2].auth).toEqual({ autoRefreshToken: false, persistSession: false });
    expect(network).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("0 row(s)"));
  });
});
