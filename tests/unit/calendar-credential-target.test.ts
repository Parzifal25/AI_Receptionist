import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LOCAL_CALENDAR_CREDENTIAL_TARGET,
  assertLocalSupabaseIdentity,
  assertNoProxyConfiguration,
  createCalendarCredentialFetch,
  planCalendarCredentialRun,
} from "@halo/platform/calendar-credential-target";

const LOCAL = LOCAL_CALENDAR_CREDENTIAL_TARGET;
const HOSTED = "https://abcdefghijklmnop.supabase.co";
const TARGET = `--target=${LOCAL}`;
const TABLE = `${LOCAL}/rest/v1/calendar_connections`;

const WRITE_MODES = [["--write"], ["--reencrypt", "--write"], ["--decrypt", "--write"]];
const ALL_MODES = [...WRITE_MODES, ["--verify-current"]];

describe("calendar credential target guard", () => {
  it("keeps argument and target validation before CLI/network and client construction in the entry point", () => {
    const source = readFileSync(resolve("scripts/calendar-credentials.ts"), "utf8");
    const validate = source.indexOf("planCalendarCredentialRun(process.argv.slice(2)");
    const cliStatus = source.indexOf('execFileSync("supabase"');
    const client = source.indexOf("createClient(plan.origin");
    expect(validate).toBeGreaterThanOrEqual(0);
    expect(cliStatus).toBeGreaterThan(validate);
    expect(client).toBeGreaterThan(cliStatus);
  });

  it("rejects proxy configuration and requires CLI key and endpoint identity", () => {
    expect(() => assertNoProxyConfiguration({ HTTPS_PROXY: "http://proxy.invalid" })).toThrow(/Proxy environment/);
    expect(() => assertNoProxyConfiguration({ NO_PROXY: "127.0.0.1" })).toThrow(/Proxy environment/);
    const status = {
      API_URL: LOCAL,
      DB_URL: "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
      ANON_KEY: "local-anon",
      SERVICE_ROLE_KEY: "local-service",
    };
    expect(() => assertLocalSupabaseIdentity(status, LOCAL, "local-anon", "local-service")).not.toThrow();
    expect(() => assertLocalSupabaseIdentity({ ...status, DB_URL: "postgresql://elsewhere" }, LOCAL, "local-anon", "local-service")).toThrow(/does not identify/);
    expect(() => assertLocalSupabaseIdentity(status, LOCAL, "hosted-anon", "local-service")).toThrow(/do not match/);
    expect(() => assertLocalSupabaseIdentity(status, LOCAL, "local-anon", "hosted-service")).toThrow(/do not match/);
  });
  it("accepts the explicitly supplied local target when the effective URL matches", () => {
    expect(planCalendarCredentialRun(["--write", TARGET], LOCAL)).toEqual({ origin: LOCAL, mode: "encrypt", verifyOnly: false });
    expect(planCalendarCredentialRun(["--reencrypt", "--write", TARGET], `${LOCAL}/`)).toMatchObject({ mode: "reencrypt", verifyOnly: false });
    expect(planCalendarCredentialRun(["--decrypt", "--write", TARGET], LOCAL)).toMatchObject({ mode: "decrypt", verifyOnly: false });
    expect(planCalendarCredentialRun(["--verify-current", TARGET], LOCAL)).toMatchObject({ origin: LOCAL, verifyOnly: true });
  });

  it.each(ALL_MODES)("rejects a hosted effective URL even when the local target is named (%s)", (...mode) => {
    expect(() => planCalendarCredentialRun([...mode, TARGET], HOSTED)).toThrow(/hosted and unproven targets are prohibited/);
  });

  it.each(ALL_MODES)("rejects a hosted --target (%s)", (...mode) => {
    expect(() => planCalendarCredentialRun([...mode, `--target=${HOSTED}`], HOSTED)).toThrow(/hosted and unproven targets are prohibited/);
    expect(() => planCalendarCredentialRun([...mode, `--target=${HOSTED}`], LOCAL)).toThrow(/hosted and unproven targets are prohibited/);
  });

  it.each(ALL_MODES)("rejects a missing target instead of inferring it from the environment (%s)", (...mode) => {
    expect(() => planCalendarCredentialRun(mode, LOCAL)).toThrow(/Missing --target=/);
    expect(() => planCalendarCredentialRun([...mode, "--target"], LOCAL)).toThrow(/Unknown calendar credential script argument/);
    expect(() => planCalendarCredentialRun([...mode, "--target="], LOCAL)).toThrow(/not a valid URL/);
  });

  it("rejects a missing or malformed effective URL", () => {
    expect(() => planCalendarCredentialRun(["--write", TARGET], undefined)).toThrow(/cannot be proven/);
    expect(() => planCalendarCredentialRun(["--write", TARGET], "")).toThrow(/cannot be proven/);
    expect(() => planCalendarCredentialRun(["--write", TARGET], "not a url")).toThrow(/not a valid URL/);
  });

  it("rejects ambiguous targets", () => {
    expect(() => planCalendarCredentialRun(["--write", TARGET, TARGET], LOCAL)).toThrow(/Ambiguous target/);
    expect(() => planCalendarCredentialRun(["--write", TARGET, `--target=${HOSTED}`], LOCAL)).toThrow(/Ambiguous target/);
  });

  it.each([
    "http://localhost:55321",
    "http://[::1]:55321",
    "http://127.0.0.1:54321",
    "http://127.0.0.1",
    "https://127.0.0.1:55321",
    "http://127.0.0.1:55321/rest/v1",
    "http://127.0.0.1:55321/?apikey=x",
    "http://user:pass@127.0.0.1:55321",
    "http://127.0.0.1.supabase.co:55321",
    "http://127.0.0.1:55321@abcdefghijklmnop.supabase.co",
    "http://0.0.0.0:55321",
  ])("rejects the look-alike or unprovable target %s", (candidate) => {
    expect(() => planCalendarCredentialRun(["--write", `--target=${candidate}`], LOCAL)).toThrow(/prohibited/);
    expect(() => planCalendarCredentialRun(["--write", TARGET], candidate)).toThrow(/prohibited/);
  });

  it("never echoes the rejected URL, which may embed credentials", () => {
    const secretUrl = "https://user:s3cret-value@abcdefghijklmnop.supabase.co";
    for (const attempt of [
      () => planCalendarCredentialRun(["--write", TARGET], secretUrl),
      () => planCalendarCredentialRun(["--write", `--target=${secretUrl}`], LOCAL),
    ]) {
      let message = "";
      try { attempt(); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(/prohibited/);
      expect(message).not.toContain("s3cret-value");
      expect(message).not.toContain("abcdefghijklmnop");
    }
  });

  it("keeps the existing mode rules", () => {
    expect(() => planCalendarCredentialRun([TARGET], LOCAL)).toThrow(/require the explicit --write flag/);
    expect(() => planCalendarCredentialRun(["--reencrypt", TARGET], LOCAL)).toThrow(/require the explicit --write flag/);
    expect(() => planCalendarCredentialRun(["--verify-current", "--write", TARGET], LOCAL)).toThrow(/read-only/);
    expect(() => planCalendarCredentialRun(["--decrypt", "--reencrypt", "--write", TARGET], LOCAL)).toThrow(/Choose only one/);
    expect(() => planCalendarCredentialRun(["--write", "--force", TARGET], LOCAL)).toThrow(/Unknown calendar credential script argument/);
  });
});

describe("calendar credential bound fetch", () => {
  function setup(verifyOnly: boolean) {
    const base = vi.fn(async () => new Response("[]"));
    return { base, guarded: createCalendarCredentialFetch({ origin: LOCAL, verifyOnly }, base as unknown as typeof fetch) };
  }

  it("passes reads to the local table and refuses redirects", async () => {
    const { base, guarded } = setup(true);
    await guarded(`${TABLE}?select=id`, { headers: { apikey: "k" } });
    expect(base).toHaveBeenCalledWith(`${TABLE}?select=id`, { headers: { apikey: "k" }, redirect: "error" });
  });

  it("blocks every write method in read-only verification", async () => {
    const { base, guarded } = setup(true);
    for (const method of ["PATCH", "POST", "PUT", "DELETE", "patch"]) {
      await expect(guarded(TABLE, { method })).rejects.toThrow(/not permitted/);
    }
    await expect(guarded(new Request(TABLE, { method: "PATCH", body: "{}" }))).rejects.toThrow(/not permitted/);
    expect(base).not.toHaveBeenCalled();
  });

  it("allows only compare-and-swap updates in write modes", async () => {
    const { base, guarded } = setup(false);
    await guarded(`${TABLE}?id=eq.1`, { method: "PATCH", body: "{}" });
    expect(base).toHaveBeenCalledTimes(1);
    for (const method of ["POST", "PUT", "DELETE"]) {
      await expect(guarded(TABLE, { method })).rejects.toThrow(/not permitted/);
    }
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("blocks any other origin or table regardless of mode", async () => {
    for (const verifyOnly of [true, false]) {
      const { base, guarded } = setup(verifyOnly);
      for (const url of [
        "https://abcdefghijklmnop.supabase.co/rest/v1/calendar_connections",
        "http://127.0.0.1:54321/rest/v1/calendar_connections",
        "http://localhost:55321/rest/v1/calendar_connections",
        `${LOCAL}/rest/v1/tenants`,
        `${LOCAL}/auth/v1/token`,
        `${LOCAL}/rest/v1/rpc/anything`,
      ]) {
        await expect(guarded(url)).rejects.toThrow(/outside the proven local target/);
        await expect(guarded(new URL(url))).rejects.toThrow(/outside the proven local target/);
      }
      expect(base).not.toHaveBeenCalled();
    }
  });
});
