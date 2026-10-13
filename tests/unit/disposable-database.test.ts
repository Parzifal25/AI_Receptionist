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
