import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

// Exercise the actual CLI entrypoints. The psql sentinel never connects.
for (const script of ["check-migrations.mjs", "check-rls.mjs"]) {
  it.each([
    [undefined, "1"],
    ["postgresql://test:synthetic-secret@example.invalid:5432/halo_check_test", "1"],
    ["postgresql://test:synthetic-secret@127.0.0.1:55440/shared", "1"],
    ["postgresql://test:synthetic-secret@127.0.0.1:55322/halo_check_test", "1"],
    ["postgresql://test:synthetic-secret@127.0.0.1:55440/halo_check_test?host=example.invalid", "1"],
    ["postgresql://test:synthetic-secret@127.0.0.1:55440/halo_check_test", "0"],
    ["not-a-url-synthetic-secret", "1"],
  ])(`${script} refuses unsafe target %s before psql`, (target, consent) => {
    const dir = mkdtempSync(join(tmpdir(), "halo-check-test-"));
    const marker = join(dir, "called");
    try {
      writeFileSync(join(dir, "psql"), '#!/bin/sh\ntouch "$HALO_TEST_MARKER"\nexit 77\n', { mode: 0o700 });
      const result = spawnSync(process.execPath, [`scripts/${script}`, ...(target ? [target] : [])], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HALO_TEST_MARKER: marker,
          HALO_DISPOSABLE_DATABASE: consent, HALO_DISPOSABLE_DB_URL: "",
          SUPABASE_DB_URL: "postgresql://test:synthetic-secret@example.invalid:5432/shared" },
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(result.stdout + result.stderr).not.toContain("synthetic-secret");
      expect(result.stderr).toContain("fresh disposable instance");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

it.each([
  ["1", "http://127.0.0.1:55463", "x".repeat(32), true],
  ["1", "http://[::1]:55463/", "x".repeat(32), true],
  ["0", "http://127.0.0.1:55463", "x".repeat(32), false],
  ["1", "http://127.0.0.1:55321", "x".repeat(32), false],
  ["1", "http://127.0.0.1:54321", "x".repeat(32), false],
  ["1", "https://example.invalid:443", "x".repeat(32), false],
  ["1", "http://localhost:55463", "x".repeat(32), false],
  ["1", "http://127.0.0.1:55463/rest/v1", "x".repeat(32), false],
  ["1", "http://127.0.0.1", "x".repeat(32), false],
  ["1", "http://127.0.0.1:55463", "synthetic-short-secret", false],
  ["1", "", "x".repeat(32), false],
])("the PostgREST guard (consent %s, %s) accepts only a loopback disposable target", async (consent, url, secret, accepted) => {
  const { requireDisposablePostgrest } = await import("../../scripts/disposable-database.mjs");
  const env = { HALO_DISPOSABLE_DATABASE: consent, HALO_DISPOSABLE_POSTGREST_URL: url, HALO_DISPOSABLE_JWT_SECRET: secret };
  if (accepted) {
    expect(requireDisposablePostgrest(env)).toEqual({ url: new URL(url).origin, jwtSecret: secret });
  } else {
    expect(() => requireDisposablePostgrest(env)).toThrow(/disposable instance/);
    try { requireDisposablePostgrest(env); } catch (error) {
      expect(String(error)).not.toContain("synthetic-short-secret");
      if (url) expect(String(error)).not.toContain(url);
    }
  }
});
