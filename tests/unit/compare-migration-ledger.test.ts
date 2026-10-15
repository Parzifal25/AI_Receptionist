import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareLedger, parseDryRun, repositoryMigrations, VERDICT } from "../../scripts/compare-migration-ledger.mjs";

/**
 * The offline ledger comparison an operator runs on saved preflight output
 * (docs/HOSTED_MIGRATION_RUNBOOK.md §3). Missing evidence must never read as
 * a pass, and any disagreement must stop the rollout.
 */
const currentRepo = repositoryMigrations(path.resolve(__dirname, "../../supabase/migrations"));
// These saved-ledger fixtures describe WS3's 0001–0035 rollout, not the new WS4 migration.
const repo = currentRepo.filter((migration) => Number(migration.version) <= 35);
const ledgerLines = (count: number) => repo.slice(0, count).map((m) => ` ledger|${m.version}|${m.name}`).join("\n");
const objectsFor = (count: number) =>
  ` objects|${["0001", "0017", "0032", "0033", "0034", "0035"].map((v) => `${v}=${Number(v) <= count ? "t" : "f"}`).join("|")}`;
// Object flags follow the number of applied versions unless a test overrides them.
const preflight = (body: string, objects = objectsFor((body.match(/ledger\|\d{4}/g) ?? []).length)) =>
  `== 4. HALO objects\n objects_row\n${objects}\n== 5. Migration ledger\n ledger_row\n------------\n${body}\n(rows)\npreflight|complete\n`;
const files = (from: number) => repo.slice(from).map((m) => m.file);

describe("migration ledger comparison (offline)", () => {
  it("accepts an explicitly empty ledger and rejects incomplete object/completion evidence", () => {
    expect(compareLedger({ repo, preflightText: preflight(" ledger|empty") }).verdict).toBe(VERDICT.CONSISTENT);
    expect(compareLedger({ repo, preflightText: preflight(" ledger|empty", " objects|0001=f") }).verdict).toBe(VERDICT.NOT_VERIFIED);
    expect(compareLedger({ repo, preflightText: preflight(ledgerLines(35)).replace("preflight|complete", "") }).verdict).toBe(VERDICT.NOT_VERIFIED);
    expect(compareLedger({ repo, preflightText: preflight(" ledger|empty\n ledger|absent") }).verdict).toBe(VERDICT.STOP);
  });
  it("does not accept an unreadable dry run just because nothing is pending", () => {
    const preflightText = preflight(ledgerLines(35));
    expect(compareLedger({ repo, preflightText, dryRunText: "connection failed" }).verdict).toBe(VERDICT.NOT_VERIFIED);
    expect(compareLedger({ repo, preflightText, dryRunText: "Remote database is up to date.\n" }).verdict).toBe(VERDICT.CONSISTENT);
  });

  it("reads the repository chain as contiguous 0001..N", () => {
    expect(repo[0]).toEqual({ version: "0001", name: "init", file: "0001_init.sql" });
    expect(repo.map((m) => Number(m.version))).toEqual(repo.map((_, i) => i + 1));
  });

  it("treats missing or truncated preflight output as NOT VERIFIED", () => {
    expect(compareLedger({ repo, preflightText: "" }).verdict).toBe(VERDICT.NOT_VERIFIED);
    expect(compareLedger({ repo, preflightText: "== 1. Session\n postgres | postgres\n" }).verdict).toBe(VERDICT.NOT_VERIFIED);
    // A ledger without the §4 object flags (an older or truncated preflight) is not evidence either.
    expect(compareLedger({ repo, preflightText: ledgerLines(31) }).verdict).toBe(VERDICT.NOT_VERIFIED);
  });

  it.each([
    ["objects of 0032 without its ledger row (partial or hand-applied)", 31, objectsFor(31).replace("0032=f", "0032=t"), /objects of 0032 exist, but the ledger does not record 0032/],
    ["a ledger row whose objects are missing", 34, objectsFor(34).replace("0034=t", "0034=f"), /the ledger records 0034, but its objects are missing/],
    ["HALO objects under an absent ledger", 0, objectsFor(31), /objects of 0001 exist/],
  ])("stops on %s", (_label, count, objects, finding) => {
    const body = count ? ledgerLines(count) : " ledger|absent";
    const result = compareLedger({ repo, preflightText: preflight(body, objects) });
    expect(result.verdict).toBe(VERDICT.STOP);
    expect(result.findings.join("\n")).toMatch(finding);
  });

  it("accepts the hosted 2026-10-13 shape (0001–0031) with 0032–0035 pending", () => {
    const result = compareLedger({ repo, preflightText: preflight(ledgerLines(31)), expectPending: ["0032", "0033", "0034", "0035"] });
    expect(result.verdict).toBe(VERDICT.CONSISTENT);
    expect(result.pending).toEqual(files(31));
  });

  it("reports an absent ledger as the fresh path, with everything pending", () => {
    const result = compareLedger({ repo, preflightText: preflight(" ledger|absent") });
    expect(result.verdict).toBe(VERDICT.CONSISTENT);
    expect(result.ledgerAbsent).toBe(true);
    expect(result.pending).toEqual(files(0));
  });

  it.each([
    ["a gap in the middle", ledgerLines(31).replace(/ ledger\|0007\|[^\n]*\n/, ""), /not a contiguous prefix of the repository; missing 0007/],
    ["a renamed version", ledgerLines(3).replace("|init", "|init_v2"), /0001 is named "init_v2"/],
    ["a version the repository does not have", `${ledgerLines(35)}\n ledger|0036|hotfix`, /0036 \(hotfix\) has no file/],
    ["a duplicate version", `${ledgerLines(2)}\n ledger|0002|function_grants`, /duplicate ledger version 0002/],
    ["an absent ledger next to ledger rows", ` ledger|absent\n${ledgerLines(1)}`, /both an absent ledger and ledger rows/],
  ])("stops on %s", (_label, body, finding) => {
    const result = compareLedger({ repo, preflightText: preflight(body) });
    expect(result.verdict).toBe(VERDICT.STOP);
    expect(result.findings.join("\n")).toMatch(finding);
  });

  it("stops when the pending set differs from the authorized set", () => {
    const result = compareLedger({ repo, preflightText: preflight(ledgerLines(30)), expectPending: ["0032", "0033", "0034", "0035"] });
    expect(result.verdict).toBe(VERDICT.STOP);
    expect(result.findings[0]).toMatch(/pending versions 0031, 0032, 0033, 0034, 0035 differ/);
  });

  it("checks the dry run against the ledger, line for line", () => {
    const pushLines = (names: string[]) => `Would push these migrations:\n${names.map((f) => ` • ${f}`).join("\n")}\n`;
    const base = { repo, preflightText: preflight(ledgerLines(31)) };
    expect(compareLedger({ ...base, dryRunText: pushLines(files(31)) }).verdict).toBe(VERDICT.CONSISTENT);
    expect(compareLedger({ ...base, dryRunText: pushLines(files(30)) }).verdict).toBe(VERDICT.STOP);
    expect(compareLedger({ ...base, dryRunText: "Remote database is up to date.\n" }).verdict).toBe(VERDICT.STOP);
  });

  it("parses the bullet format the Supabase CLI printed on 2026-10-13", () => {
    expect(parseDryRun(" • 0001_init.sql\n • 0002_function_grants.sql\n\n [Y/n] y\n")).toEqual(["0001_init.sql", "0002_function_grants.sql"]);
  });
});

// WS4 compatibility: new migrations must remain visible to the real comparator.
it("requires 0036 in the current pending set rather than silently adopting WS3 authorization", () => {
 const result = compareLedger({ repo: currentRepo, preflightText: preflight(ledgerLines(35)), expectPending: [] });
 expect(result.verdict).toBe(VERDICT.STOP);
 expect(result.findings.join(" ")).toContain("0036");
});

// Release-readiness audit (2026-10-15): the read-only collector now also
// samples 0036 (audit_logs + workflow telemetry columns). The comparator checks
// object/ledger agreement for every sampled flag, so a hand-applied or
// half-applied 0036 is a STOP, not a silent pass.
it("stops when 0036's objects and the ledger disagree", () => {
  const current = currentRepo;
  const flags = (n: number, has0036: boolean) =>
    ` objects|${["0001", "0017", "0032", "0033", "0034", "0035"].map((v) => `${v}=${Number(v) <= n ? "t" : "f"}`).join("|")}|0036=${has0036 ? "t" : "f"}`;
  const lines = (n: number) => current.slice(0, n).map((m) => ` ledger|${m.version}|${m.name}`).join("\n");
  const handApplied = compareLedger({ repo: current, preflightText: `${lines(35)}\n${flags(35, true)}\npreflight|complete\n` });
  expect(handApplied.verdict).toBe(VERDICT.STOP);
  expect(handApplied.findings.join(" ")).toContain("objects of 0036 exist, but the ledger does not record 0036");
  const missingObjects = compareLedger({ repo: current, preflightText: `${lines(36)}\n${flags(36, false)}\npreflight|complete\n` });
  expect(missingObjects.verdict).toBe(VERDICT.STOP);
  expect(missingObjects.findings.join(" ")).toContain("the ledger records 0036, but its objects are missing");
  const consistent = compareLedger({ repo: current, preflightText: `${lines(36)}\n${flags(36, true)}\npreflight|complete\n` });
  expect(consistent.verdict).toBe(VERDICT.CONSISTENT);
});
