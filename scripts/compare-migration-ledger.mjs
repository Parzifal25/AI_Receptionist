#!/usr/bin/env node
/**
 * Offline comparison of a target's migration ledger with supabase/migrations/
 * (docs/HOSTED_MIGRATION_RUNBOOK.md §3). It reads SAVED text only and never
 * connects to anything:
 *
 *   --preflight <file>   output of infrastructure/hosted/preflight-readonly.sql
 *                        (its §5 prints one `ledger|<version>|<name>` line per
 *                        applied version, or `ledger|absent`; its §4 prints
 *                        `objects|0001=t|…`, which must agree with the ledger)
 *   --dry-run <file>     optional: output of `supabase db push --dry-run`
 *                        (one ` • NNNN_name.sql` line per version it would push)
 *   --expect-pending a,b optional: the versions the authorization covers
 *
 * Verdicts (exit code):
 *   CONSISTENT (0)    the ledger is exactly 0001..N of the repository, by
 *                     version and name, and every optional check agrees
 *   STOP (1)          anything else that was observed: unknown or duplicate
 *                     versions, name mismatches, gaps, a dry run or pending
 *                     set that differs from the expectation
 *   NOT VERIFIED (2)  the evidence is missing or unreadable. Missing evidence
 *                     is never a pass.
 *
 * A CONSISTENT ledger is one gate of many; it is not an authorization.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VERDICT = { CONSISTENT: "CONSISTENT", STOP: "STOP", NOT_VERIFIED: "NOT VERIFIED" };

export function repositoryMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: f.slice(0, 4), name: f.slice(5, -4), file: f }));
}

/** Ledger lines from preflight output; null when the preflight never reached §5. */
export function parseLedger(text) {
  const rows = [];
  let absent = false;
  let empty = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/ledger\|([^|\s]+)(?:\|([^|\s]*))?/);
    if (!m) continue;
    if (m[1] === "absent" && m[2] === undefined) absent = true;
    else if (m[1] === "empty" && m[2] === undefined) empty = true;
    else rows.push({ version: m[1], name: m[2] ?? "" });
  }
  if (empty && (absent || rows.length)) return { error: "preflight reports an empty ledger alongside absent/row evidence" };
  if (empty) return { absent: false, rows: [] };
  if (absent && rows.length) return { error: "preflight reports both an absent ledger and ledger rows" };
  if (absent) return { absent: true, rows: [] };
  if (!rows.length) return null;
  return { absent: false, rows };
}

/** Preflight §4 object flags, e.g. { "0001": true, "0032": false }; null if absent. */
export function parseObjects(text) {
  const m = text.match(/objects\|((?:\d{4}=[tf]\|?)+)/);
  if (!m) return null;
  return Object.fromEntries(m[1].split("|").filter(Boolean).map((pair) => {
    const [version, flag] = pair.split("=");
    return [version, flag === "t"];
  }));
}

export function parseDryRun(text) {
  return [...text.matchAll(/^\s*•\s+(\d{4}_\S+\.sql)\s*$/gm)].map((m) => m[1]);
}

/** @param {{ repo: {version: string, name: string, file: string}[], preflightText: string, dryRunText?: string, expectPending?: string[] }} input */
export function compareLedger({ repo, preflightText, dryRunText = undefined, expectPending = undefined }) {
  const findings = [];
  const stop = (message) => findings.push(message);

  if (!preflightText?.trim()) {
    return { verdict: VERDICT.NOT_VERIFIED, findings: ["no preflight output supplied"], applied: [], pending: [] };
  }
  if (!/^preflight\|complete\s*$/m.test(preflightText)) {
    return { verdict: VERDICT.NOT_VERIFIED, findings: ["preflight completion marker missing; evidence may be truncated"], applied: [], pending: [] };
  }
  const ledger = parseLedger(preflightText);
  if (!ledger) {
    return { verdict: VERDICT.NOT_VERIFIED, findings: ["preflight output has no ledger section (§5); rerun the complete preflight"], applied: [], pending: [] };
  }
  if (ledger.error) return { verdict: VERDICT.STOP, findings: [ledger.error], applied: [], pending: [] };
  const objects = parseObjects(preflightText);
  if (!objects || ["0001","0017","0032","0033","0034","0035","0036","0037"].some((v) => !(v in objects))) {
    return { verdict: VERDICT.NOT_VERIFIED, findings: ["preflight output has no §4 objects line; rerun the current preflight"], applied: [], pending: [] };
  }

  const byVersion = new Map(repo.map((m) => [m.version, m]));
  const seen = new Set();
  for (const row of ledger.rows) {
    if (seen.has(row.version)) stop(`duplicate ledger version ${row.version}`);
    seen.add(row.version);
    const file = byVersion.get(row.version);
    if (!file) stop(`ledger version ${row.version} (${row.name}) has no file in supabase/migrations`);
    else if (file.name !== row.name) stop(`ledger ${row.version} is named "${row.name}", the repository file is ${file.file}`);
  }
  const appliedCount = ledger.rows.length;
  const prefix = repo.slice(0, appliedCount).map((m) => m.version);
  const appliedVersions = [...seen].sort();
  if (!findings.length && prefix.join() !== appliedVersions.join()) {
    const missing = prefix.filter((v) => !seen.has(v));
    stop(`ledger is not a contiguous prefix of the repository; missing ${missing.join(", ")}`);
  }
  // Objects and ledger must agree: objects without a ledger row mean a
  // partial or hand-applied migration; a ledger row without its objects
  // means the schema was changed after the migration ran.
  for (const [version, present] of Object.entries(objects)) {
    if (present && !seen.has(version)) stop(`objects of ${version} exist, but the ledger does not record ${version}`);
    if (!present && seen.has(version)) stop(`the ledger records ${version}, but its objects are missing`);
  }

  const pending = repo.filter((m) => !seen.has(m.version)).map((m) => m.file);
  if (expectPending) {
    const expected = expectPending.map((v) => v.trim()).filter(Boolean).sort();
    const actual = pending.map((f) => f.slice(0, 4));
    if (expected.join() !== actual.join()) {
      stop(`pending versions ${actual.join(", ") || "(none)"} differ from the authorized set ${expected.join(", ") || "(none)"}`);
    }
  }
  if (dryRunText !== undefined) {
    const wouldPush = parseDryRun(dryRunText);
    if (!wouldPush.length && !pending.length && !/^Remote database is up to date\.\s*$/m.test(dryRunText)) {
      return { verdict: VERDICT.NOT_VERIFIED, findings: ["empty pending set requires explicit successful up-to-date dry-run evidence"], applied: appliedVersions, pending };
    }
    if (!wouldPush.length && pending.length) stop("the dry run lists no migrations, but the ledger leaves some pending (or the dry-run output is unreadable)");
    else if (wouldPush.join() !== pending.join()) {
      stop(`the dry run would push ${wouldPush.join(", ") || "(none)"}, the ledger comparison expects ${pending.join(", ") || "(none)"}`);
    }
  }

  return {
    verdict: findings.length ? VERDICT.STOP : VERDICT.CONSISTENT,
    findings,
    ledgerAbsent: ledger.absent,
    applied: appliedVersions,
    pending,
  };
}

function main(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const read = (file) => {
    if (!file) return undefined;
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const root = new URL("..", import.meta.url).pathname;
  const preflightText = read(arg("--preflight"));
  const dryRunPath = arg("--dry-run");
  const dryRunText = read(dryRunPath);
  const expect = arg("--expect-pending");

  let result;
  if (dryRunPath && dryRunText === null) {
    result = { verdict: VERDICT.NOT_VERIFIED, findings: [`cannot read dry-run output ${dryRunPath}`], applied: [], pending: [] };
  } else {
    result = compareLedger({
      repo: repositoryMigrations(join(root, "supabase/migrations")),
      preflightText: preflightText ?? "",
      dryRunText: dryRunText ?? undefined,
      expectPending: expect === undefined ? undefined : expect.split(","),
    });
  }
  console.log(`verdict: ${result.verdict}`);
  if (result.ledgerAbsent) console.log("ledger: absent (fresh path only if preflight §4 is all false)");
  else if (result.applied.length) console.log(`applied: ${result.applied[0]}–${result.applied.at(-1)} (${result.applied.length})`);
  console.log(`pending: ${result.pending.join(", ") || "(none)"}`);
  for (const finding of result.findings) console.log(`- ${finding}`);
  return result.verdict === VERDICT.CONSISTENT ? 0 : result.verdict === VERDICT.STOP ? 1 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
