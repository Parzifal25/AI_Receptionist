#!/usr/bin/env node
/**
 * Phase 2 Workstream 3 — offline rehearsal of the first hosted database
 * rollout (docs/HOSTED_MIGRATION_RUNBOOK.md), on the real Supabase Postgres
 * image and synthetic data only.
 *
 * It models a historical 0001–0031 prefix (not current hosted evidence) and then
 * the pending upgrade:
 *   1. fresh project: preflight; ledger absent
 *   2. 0001–0031 applied one transaction per file under
 *      `search_path = public, extensions` with a ledger row each (the
 *      2026-10-13 push used the D10-edited 0001, whose only change was that
 *      session setting), then synthetic legacy data: two tenants, legacy
 *      knowledge (clean, empty, foreign-collection, missing-source and
 *      over-long-source documents; FAQs) and a cross-tenant calendar row
 *   3. preflight + offline ledger comparison; 0032–0034 rehearsed together
 *      in a transaction that is rolled back (catalog and data unchanged)
 *   4. logical backup of public + ledger, restored into a second fresh
 *      container: identical row fingerprints and identical preflight output
 *   5. 0032–0034 applied under `search_path = "$user", public` (without
 *      `extensions`, the CLI login-role condition) on both the source and
 *      the restored copy; legacy rows unchanged
 *   6. censuses, privileges, a write to the legacy mismatched row, the
 *      knowledge backfill (dry run, apply, idempotency, the source_ref
 *      defect), indexing, approval and governed retrieval
 *   7. 0036 (WS4 audit schema) rolled forward on source and recovered copy,
 *      then a backup taken AFTER 0036 restored with the mitigated method:
 *      audit rows, grants and schema must survive. Added by the 2026-10-15
 *      local release-readiness audit when 0036 made the 0032–0035 pending-set
 *      expectations stale (docs/LOCAL_RELEASE_READINESS_REPORT.md).
 *   8. 0037 (P2-R1 calendar business-level uniqueness, owner-approved for
 *      local use 2026-10-16): a legacy duplicate is visible in the preflight
 *      census and aborts 0037 with ledger and data unchanged; after the
 *      (separately authorized) disposition it applies on source and copy.
 *
 * Safety: like check-supabase-image-chain.mjs, every container is started
 * from a locally cached image (`--pull=never`) with `--network none` and no
 * published ports, used only through `docker exec`, and removed whatever
 * happens. No connection string is accepted, so it cannot reach the shared
 * HALO stack, the 5432x project or any hosted database. Output is counts
 * and verdicts only.
 *
 * Usage: node scripts/check-rollout-rehearsal.mjs [image]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { NORMALIZE_CHECK, SCHEMA_SNAPSHOT, SECURITY_SNAPSHOT, NEUTRALIZE_RESTORE_DEFAULTS, RESTORE_SOURCE_DEFAULTS, recoveryVerdict } from "./recovery-security.mjs";
import { compareLedger, repositoryMigrations, VERDICT } from "./compare-migration-ledger.mjs";

const image = process.argv[2] ?? "public.ecr.aws/supabase/postgres:17.6.1.155";
const root = new URL("..", import.meta.url).pathname;
const migrationsDir = join(root, "supabase/migrations");
const preflightFile = join(root, "infrastructure/hosted/preflight-readonly.sql");
const stubs = readFileSync(join(root, "infrastructure/ci/supabase-stubs.sql"), "utf8");
const storageStub = stubs.slice(stubs.indexOf("create schema if not exists storage;"));
const migrations = readdirSync(migrationsDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const repo = repositoryMigrations(migrationsDir);
const PENDING = ["0032", "0033", "0034", "0035", "0036", "0037"];
const upTo = (v) => migrations.filter((f) => f.slice(0, 4) <= v);
const pending = migrations.filter((f) => PENDING.includes(f.slice(0, 4)));
const beforeK1 = pending.filter((f) => f.slice(0,4) < "0035");
const k1 = pending.filter((f) => f.slice(0,4) === "0035");
const auditSchema = pending.filter((f) => f.slice(0,4) === "0036");
const calendarUnique = pending.filter((f) => f.slice(0,4) === "0037");

const docker = (args, input) => spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const containers = [];

function startContainer(label) {
  const name = `halo_check_rollout_${label}_${randomBytes(3).toString("hex")}`;
  const run = docker(["run", "-d", "--name", name, "--network", "none", "--pull=never",
    "-e", `POSTGRES_PASSWORD=${randomBytes(16).toString("hex")}`, image]);
  if (run.status !== 0) throw new Error(`cannot start ${image} (is it cached?): ${run.stderr.trim()}`);
  containers.push(name);
  const networks = JSON.parse(docker(["inspect", "-f", "{{json .NetworkSettings.Networks}}", name]).stdout);
  const ports = docker(["inspect", "-f", "{{json .HostConfig.PortBindings}}", name]).stdout.trim();
  if (Object.keys(networks).join() !== "none" || !["{}", "null"].includes(ports)) {
    throw new Error(`refusing ${name}: not isolated (networks ${Object.keys(networks)}, ports ${ports})`);
  }
  for (let i = 0; i < 120; i += 1) {
    const ready = docker(["exec", name, "psql", "-h", "localhost", "-U", "supabase_admin", "-d", "postgres",
      "-tAc", "select 1 from pg_namespace where nspname = 'extensions'"]);
    if (ready.status === 0 && ready.stdout.trim() === "1") break;
    if (i === 119) throw new Error(`${name} did not become ready`);
    execFileSync("sleep", ["1"]);
  }
  const stub = psql(name, `${storageStub}\ngrant all on schema storage to postgres;\ngrant all on all tables in schema storage to postgres;`, "supabase_admin");
  if (stub.status !== 0) throw new Error(`storage stub failed: ${stub.stderr}`);
  docker(["cp", migrationsDir, `${name}:/tmp/mig`]);
  docker(["cp", preflightFile, `${name}:/tmp/preflight.sql`]);
  return name;
}

function psql(name, sql, user = "postgres") {
  return docker(["exec", "-i", name, "psql", "-h", "localhost", "-U", user, "-d", "postgres",
    "-X", "-q", "-tA", "-F", "|", "-v", "ON_ERROR_STOP=1"], sql);
}
function query(name, sql, user) {
  const r = psql(name, sql, user);
  if (r.status !== 0) throw new Error(`query failed: ${(r.stderr.match(/ERROR:.*$/m) ?? [r.stderr.trim()])[0]}`);
  return r.stdout.trim();
}
const errorOf = (r) => (r.status === 0 ? "" : (r.stderr.match(/ERROR:.*$/m) ?? [r.stderr.trim()])[0]);

/** Model SQL + ledger atomicity; actual CLI behavior requires separate proof. */
function applyFiles(name, files, searchPath) {
  const script = files.map((f) => `begin;\nset local search_path = ${searchPath};\n\\i /tmp/mig/${f}\n` +
    `insert into supabase_migrations.schema_migrations (version, name) values ('${f.slice(0, 4)}', '${f.slice(5, -4)}');\ncommit;\n`).join("");
  return psql(name, script);
}

/** The preflight exactly as the runbook runs it (aligned output, its own read-only transaction). */
function preflight(name) {
  const r = docker(["exec", name, "psql", "-h", "localhost", "-U", "postgres", "-d", "postgres", "-X", "-f", "/tmp/preflight.sql"]);
  if (r.status !== 0) throw new Error(`preflight failed: ${errorOf(r)}`);
  return r.stdout;
}

const CATALOG_FINGERPRINT = `
  select md5(string_agg(x, E'\\n' order by x)) from (
    select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity::text
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
    union all select 'proc ' || p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, '')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    union all select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || convalidated::text from pg_constraint
      where connamespace = 'public'::regnamespace
    union all select 'pol ' || polrelid::regclass::text || ' ' || polname from pg_policy
    union all select 'trg ' || tgrelid::regclass::text || ' ' || tgname from pg_trigger where not tgisinternal
    union all select 'def ' || coalesce(defaclacl::text, '') from pg_default_acl
    union all select 'ledger ' || version from supabase_migrations.schema_migrations) s(x);`;

const DATA_FINGERPRINT = `
  select string_agg(t || ':' || n || ':' || h, ' ' order by t) from (
    select 'knowledge_documents' t, count(*) n, md5(coalesce(string_agg(row(id, business_id, title, content, source_type, source_ref, status, collection_id)::text, ',' order by id), '')) h from public.knowledge_documents
    union all select 'faqs', count(*), md5(coalesce(string_agg(row(id, business_id, question, answer, category, is_published)::text, ',' order by id), '')) from public.faqs
    union all select 'knowledge_chunks', count(*), md5(coalesce(string_agg(row(id, business_id, document_id, content, embedding::text)::text, ',' order by id), '')) from public.knowledge_chunks
    union all select 'calendar_connections', count(*), md5(coalesce(string_agg(row(id, business_id, staff_id, provider)::text, ',' order by id), '')) from public.calendar_connections
    union all select 'businesses', count(*), md5(coalesce(string_agg(row(id, name, slug)::text, ',' order by id), '')) from public.businesses) s;`;

// Synthetic fixture ids.
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const U = "0b000000-0000-4000-8000-0000000000b0";
const id = (prefix, n) => `${prefix}0000000-0000-4000-8000-0000000000${n}`;
const DOC_B = id("d", "0b");
const CC = id("c", "c1");

const LEGACY_FIXTURE = `
insert into public.businesses (id, name, slug) values ('${A}', 'Rehearsal A', 'rehearsal-a'), ('${B}', 'Rehearsal B', 'rehearsal-b');
insert into public.staff_members (id, business_id, name) values ('${id("5", "a1")}', '${A}', 'Staff A'), ('${id("5", "b1")}', '${B}', 'Staff B');
-- A legacy cross-tenant reference 0034 would refuse today: tenant A's calendar row on tenant B's staff member.
insert into public.calendar_connections (id, business_id, staff_id, provider) values ('${CC}', '${A}', '${id("5", "b1")}', 'google');
insert into public.knowledge_collections (id, business_id, name) values ('${id("c", "0a")}', '${A}', 'A docs'), ('${id("c", "0b")}', '${B}', 'B docs');
insert into public.knowledge_documents (id, business_id, title, content, source_type, source_ref, collection_id) values
  ('${id("d", "01")}', '${A}', 'Hours', 'Synthetic rehearsal opening hours are nine to five.', 'manual', '', '${id("c", "0a")}'),
  ('${id("d", "02")}', '${A}', 'Empty', '', 'manual', '', null),
  ('${id("d", "03")}', '${A}', 'Foreign collection', 'Synthetic rehearsal text.', 'manual', '', '${id("c", "0b")}'),
  ('${id("d", "04")}', '${A}', 'Long source', 'Synthetic rehearsal text from a long URL.', 'url', 'https://example.invalid/' || repeat('x', 600), null),
  ('${id("d", "05")}', '${A}', 'No source', 'Synthetic rehearsal text from a file.', 'file', '', null),
  ('${DOC_B}', '${B}', 'Parking', 'Synthetic rehearsal parking is free for visitors.', 'manual', '', null);
insert into public.knowledge_chunks (id, business_id, document_id, content) values
  ('${id("e", "01")}', '${A}', '${id("d", "01")}', 'Synthetic rehearsal opening hours are nine to five.'),
  ('${id("e", "02")}', '${A}', '${DOC_B}', 'Synthetic rehearsal parking is free for visitors.');
insert into public.faqs (id, business_id, question, answer, category) values
  ('${id("f", "01")}', '${A}', 'When are you open?', 'Synthetic rehearsal hours.', ''),
  ('${id("f", "02")}', '${A}', 'Long category?', 'Synthetic rehearsal answer.', repeat('c', 150)),
  ('${id("f", "0b")}', '${B}', 'Is there synthetic rehearsal parking?', 'Yes, synthetic rehearsal parking is free.', '');`;

const asService = (sql) => `set role service_role;\n${sql}`;
// The bare image's auth.uid() reads only request.jwt.claim.sub (hosted GoTrue
// installs a version that also reads request.jwt.claims); set both.
const asOwnerOfB = (sql) => `set role authenticated;\nset request.jwt.claim.sub = '${U}';\n` +
  `set request.jwt.claims = '{"sub":"${U}","role":"authenticated"}';\n${sql}`;

const results = [];
function check(label, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

try {
  console.log(`image ${image}; ${migrations.length} migrations; pending in this rehearsal: ${PENDING.join(", ")}`);

  // 1. Fresh project.
  const src = startContainer("src");
  const fresh = preflight(src);
  const freshLedger = compareLedger({ repo, preflightText: fresh });
  check(`fresh: preflight runs read-only; ledger absent; nothing applied; all ${migrations.length} pending`,
    /ledger\|absent/.test(fresh) && /objects\|0001=f\|0017=f\|0032=f\|0033=f\|0034=f\|0035=f\|0036=f\|0037=f/.test(fresh)
      && freshLedger.verdict === VERDICT.CONSISTENT && freshLedger.pending.length === migrations.length);

  // 2. The hosted 2026-10-13 shape: 0001–0031 under public, extensions, with a ledger.
  query(src, "create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);");
  const base = applyFiles(src, upTo("0031"), "public, extensions");
  check("0001–0031 apply one transaction per file under search_path = public, extensions", base.status === 0, errorOf(base));
  query(src, LEGACY_FIXTURE);
  check("synthetic legacy fixture loads at 0031 (no 0033/0034 guards yet)", true);

  // 3. Preflight and offline comparison at 0031.
  const at31 = preflight(src);
  const ledger31 = compareLedger({ repo, preflightText: at31, expectPending: PENDING });
  check("0031: ledger CONSISTENT, pending exactly 0032–0037", ledger31.verdict === VERDICT.CONSISTENT, ledger31.findings.join("; "));
  check("0031: preflight finds the cross-tenant calendar row (pre-0034 section)", /calendar_connections\s*\|\s*staff_id\s*\|\s*staff_members\s*\|\s*1\b/.test(at31));
  check("0031: every public table and sequence owned by the applying role",
    query(src, "select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','S') and c.relowner <> 'postgres'::regrole;") === "0");
  check("0031: preflight predicts the backfill blockers (empty, missing source, long source_ref, long category)",
    query(src, `select (select count(*) from public.knowledge_documents where btrim(content) = '') || ',' ||
      (select count(*) from public.knowledge_documents where source_type <> 'manual' and source_ref = '') || ',' ||
      (select count(*) from public.knowledge_documents where char_length(source_ref) > 500) || ',' ||
      (select count(*) from public.faqs where char_length(category) > 100);`) === "1,1,1,1");
  const truncate31 = Number(query(src, "select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type = 'TRUNCATE';"));
  check("0031: clients hold TRUNCATE under Supabase default privileges (what 0034 revokes)", truncate31 > 0, `${truncate31} grants`);

  const catalogBefore = query(src, CATALOG_FINGERPRINT);
  const dataBefore = query(src, DATA_FINGERPRINT);
  const schemaBefore = query(src, SCHEMA_SNAPSHOT);
  check("PostgreSQL CHECK normalization preserves different logic",
    query(src, `${NORMALIZE_CHECK}
      create temp table ws3_logic_a(x int,y int,check(x>0 and y>0));
      create temp table ws3_logic_b(x int,y int,check(x>0 or y>0));
      select pg_temp.ws3_normalize_check((select oid from pg_constraint where conrelid='pg_temp.ws3_logic_a'::regclass))
       <> pg_temp.ws3_normalize_check((select oid from pg_constraint where conrelid='pg_temp.ws3_logic_b'::regclass));`) === "t");
  const rehearse = psql(src, `begin;\nset local search_path = "$user", public;\n${pending.map((f) => `\\i /tmp/mig/${f}`).join("\n")}\nrollback;`);
  check("0032–0037 apply together in one transaction under \"$user\", public (then rolled back)", rehearse.status === 0, errorOf(rehearse));
  check("rolled-back rehearsal leaves catalog, grants, ledger and data unchanged",
    query(src, CATALOG_FINGERPRINT) === catalogBefore && query(src, DATA_FINGERPRINT) === dataBefore);

  // 4. Backup and restore drill (logical dump of public + ledger).
  const dump = spawnSync("docker", ["exec", src, "pg_dump", "-h", "localhost", "-U", "postgres", "-d", "postgres",
    "--format=custom", "--schema=public", "--schema=supabase_migrations"], { maxBuffer: 256 * 1024 * 1024 });
  check("pre-upgrade logical backup taken", dump.status === 0 && dump.stdout.length > 0, `${dump.stdout?.length ?? 0} bytes`);
  const rst = startContainer("restore");
  // A schema-only dump of public does not create extensions; the restore target needs them where the source has them.
  query(rst, "create extension if not exists vector with schema public; create extension if not exists btree_gist with schema public;");
  spawnSync("docker", ["exec", "-i", rst, "sh", "-c", "cat > /tmp/pre.dump"], { input: dump.stdout, maxBuffer: 256 * 1024 * 1024 });
  // Two kinds of TOC entry belong to the platform, not to HALO, and cannot be
  // restored by `postgres` onto a Supabase target that already has them:
  //   - `CREATE SCHEMA public` (every project has schema public);
  //   - supabase_admin's default privileges in public ("permission denied to
  //     change default privileges").
  // Restore through a TOC list without exactly those; everything else,
  // grants and postgres's own default privileges included, is kept.
  const toc = docker(["exec", rst, "pg_restore", "-l", "/tmp/pre.dump"]).stdout.split("\n");
  const platform = (line) => /^\d+; \d+ \d+ SCHEMA - public /.test(line)
    || /^\d+; \d+ \d+ DEFAULT ACL public DEFAULT PRIVILEGES FOR \w+ supabase_admin$/.test(line.trim());
  const kept = toc.filter((line) => !platform(line));
  const excluded = toc.filter(platform).map((line) => line.replace(/^\d+; \d+ \d+ /, "").trim());
  docker(["exec", "-i", rst, "sh", "-c", "cat > /tmp/pre.list"], kept.join("\n"));
  const restore = docker(["exec", rst, "pg_restore", "-h", "localhost", "-U", "postgres", "-d", "postgres", "--exit-on-error", "-L", "/tmp/pre.list", "/tmp/pre.dump"]);
  const restoreError = restore.status === 0 ? "" : (restore.stderr.match(/error:.*$/m) ?? ["pg_restore failed"])[0];
  check("restore into an isolated fresh container succeeds (platform-owned TOC entries excluded)",
    restore.status === 0 && excluded.length >= 1, restoreError || `excluded: ${excluded.join("; ")}`);
  check("restored rows match the source fingerprint", query(rst, DATA_FINGERPRINT) === dataBefore);
  const securitySource = JSON.parse(query(src, SECURITY_SNAPSHOT));
  const securityUnsafe = JSON.parse(query(rst, SECURITY_SNAPSHOT));
  const unsafeVerdict = recoveryVerdict({ restoreStatus: restore.status, source: securitySource, restored: securityUnsafe });
  check("unsafe restore is rejected by deterministic effective privilege comparison",
    !unsafeVerdict.accepted && unsafeVerdict.categories.includes("effective"), unsafeVerdict.categories.join(","));

  // A separate clean target: neutralize only postgres creator defaults BEFORE
  // object creation, including extensions; restore source defaults afterwards.
  const safe = startContainer("safe_restore");
  const platformDefaultsBefore = query(safe, "select coalesce(string_agg(defaclacl::text, ',' order by defaclobjtype,defaclnamespace),'') from pg_default_acl where defaclrole='supabase_admin'::regrole;");
  const sourceDefaults = query(src, RESTORE_SOURCE_DEFAULTS);
  // Extension members are not dumped: reproduce the original fresh-image
  // extension creation conditions before neutralizing application defaults.
  query(safe, "create extension if not exists vector with schema public; create extension if not exists btree_gist with schema public;");
  query(safe, NEUTRALIZE_RESTORE_DEFAULTS);
  const copyDump = spawnSync("docker", ["exec", "-i", safe, "sh", "-c", "cat > /tmp/pre.dump"], { input: dump.stdout, maxBuffer: 256 * 1024 * 1024 });
  const copyList = docker(["exec", "-i", safe, "sh", "-c", "cat > /tmp/pre.list"], kept.join("\n"));
  if (copyDump.status !== 0 || copyList.status !== 0) throw new Error("restore input copy failed");
  const safeRestore = docker(["exec", safe, "pg_restore", "-h", "localhost", "-U", "postgres", "-d", "postgres", "--exit-on-error", "-L", "/tmp/pre.list", "/tmp/pre.dump"]);
  check("mitigated restore command succeeds", safeRestore.status === 0, safeRestore.stderr.match(/error:.*$/m)?.[0] ?? "");
  query(safe, NEUTRALIZE_RESTORE_DEFAULTS);
  // Source may explicitly revoke the hardwired PUBLIC function default.
  query(safe, "alter default privileges for role postgres revoke execute on functions from public;");
  query(safe, sourceDefaults);
  const securitySafe = JSON.parse(query(safe, SECURITY_SNAPSHOT));
  const verdict = recoveryVerdict({ restoreStatus: safeRestore.status, source: securitySource, restored: securitySafe });
  if (!verdict.accepted) {
    for (const category of verdict.categories) {
      const before = new Set(securitySource.filter((r) => r.category === category).map((r) => JSON.stringify(r)));
      const after = new Set(securitySafe.filter((r) => r.category === category).map((r) => JSON.stringify(r)));
      console.log(`diagnostic ${category} source-only: ${[...before].filter((r) => !after.has(r)).slice(0, 12).join(";")}`);
      console.log(`diagnostic ${category} restored-only: ${[...after].filter((r) => !before.has(r)).slice(0, 12).join(";")}`);
    }
  }
  check("mitigated restore preserves ownership, normalized ACL, effective rights and creator defaults", verdict.accepted, verdict.categories.join(","));
  for (const [label, predicate] of [
    ["TRUNCATE", (r) => r.category === "effective" && r.rls === "TRUNCATE"],
    ["sequence", (r) => r.category === "effective" && securitySource.some((o) => o.category === "owner" && o.name === r.name && o.subkind === "S")],
    ["function EXECUTE", (r) => r.category === "effective" && r.kind === "function"],
  ]) {
    check(`mitigated restore preserves ${label} privileges`,
      JSON.stringify(securitySource.filter(predicate)) === JSON.stringify(securitySafe.filter(predicate)));
  }
  check("security snapshot is stable across repeated queries", query(safe, SECURITY_SNAPSHOT) === query(safe, SECURITY_SNAPSHOT));
  check("other creator platform defaults unchanged", query(safe, "select coalesce(string_agg(defaclacl::text, ',' order by defaclobjtype,defaclnamespace),'') from pg_default_acl where defaclrole='supabase_admin'::regrole;") === platformDefaultsBefore);
  check("failed restore status cannot pass acceptance", !recoveryVerdict({ restoreStatus: 1, source: securitySource, restored: securitySource }).accepted);
  if (query(safe,SCHEMA_SNAPSHOT)!==schemaBefore) {
    const a=JSON.parse(schemaBefore),b=JSON.parse(query(safe,SCHEMA_SNAPSHOT));
    for(const r of a.filter((r)=>!b.some((x)=>JSON.stringify(x)===JSON.stringify(r))).slice(0,8)) {
      const other=b.find((x)=>x.kind===r.kind&&x.name===r.name);
      console.log(`schema difference ${r.kind} ${r.name}: source=${r.definition} restored=${other?.definition}`);
    }
  }
  check("mitigated restored schema definitions match source", query(safe, SCHEMA_SNAPSHOT) === schemaBefore);
  check("mitigated restored data matches source", query(safe, DATA_FINGERPRINT) === dataBefore);
  const restored31 = preflight(safe);
  check("mitigated restored database gives identical preflight output", restored31 === at31);

  // 5. The upgrade, as the CLI login role would run it (extensions not on the path).
  const upgrade = applyFiles(src, beforeK1, '"$user", public');
  check("0032–0034 apply on the source under \"$user\", public", upgrade.status === 0, errorOf(upgrade));
  const rolled = applyFiles(safe, beforeK1, '"$user", public');
  check("0032–0034 also apply on the restored copy (restore, then roll forward)", rolled.status === 0, errorOf(rolled));
  check("restored upgrade schema and security equal source upgrade", query(src,SCHEMA_SNAPSHOT)===query(safe,SCHEMA_SNAPSHOT) && query(src,SECURITY_SNAPSHOT)===query(safe,SECURITY_SNAPSHOT));
  check("0032–0034 rewrite no legacy row", query(src, DATA_FINGERPRINT) === dataBefore);

  const at34 = preflight(src);
  const ledger34 = compareLedger({ repo, preflightText: at34, expectPending: ["0035", "0036", "0037"] });
  check("0034: ledger CONSISTENT, only 0035, 0036 and 0037 pending", ledger34.verdict === VERDICT.CONSISTENT, ledger34.findings.join("; "));
  check("0034: tenant_reference_census reports exactly the legacy calendar row",
    query(src, asService("select table_name || '.' || column_name || '=' || mismatched from public.tenant_reference_census();")) === "calendar_connections.staff_id=1");
  check("0034: no client TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, no anon sequence access, no client setval",
    query(src, `select (select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated')
        and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')) + (select count(*) from pg_class c cross join lateral aclexplode(c.relacl) x
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and (x.grantee = 'anon'::regrole or (x.grantee = 'authenticated'::regrole and x.privilege_type = 'UPDATE')));`) === "0");
  check("0034: the applying role's default privileges no longer hand clients TRUNCATE",
    query(src, `select count(*) from pg_default_acl d cross join lateral aclexplode(d.defaclacl) x where d.defaclnamespace = 'public'::regnamespace
      and d.defaclrole = 'postgres'::regrole and x.grantee in ('anon'::regrole, 'authenticated'::regrole) and x.privilege_type = 'TRUNCATE';`) === "0");
  check("0034: the application can still update the legacy mismatched row without touching the reference",
    query(src, asService(`update public.calendar_connections set calendar_ref = 'rotated' where id = '${CC}' returning 'ok';`)) === "ok");
  const newMismatch = psql(src, asService(`insert into public.calendar_connections (business_id, staff_id, provider) values ('${B}', '${id("5", "a1")}', 'outlook');`));
  check("0034: a new cross-tenant reference is refused", newMismatch.status !== 0, errorOf(newMismatch));
  check("0033: both composite knowledge FKs stay NOT VALID because legacy mismatches exist",
    query(src, "select count(*) from pg_constraint where conname in ('knowledge_documents_collection_tenant_fk','knowledge_chunks_document_tenant_fk') and not convalidated;") === "2");

  // 6. Knowledge: census, backfill, indexing, approval, retrieval.
  const census = (biz) => query(src, asService(`select string_agg(check_name || '=' || row_count, ',' order by check_name) from public.knowledge_governance_census('${biz}');`));
  check("census A before backfill", census(A) === "chunks_with_foreign_document=1,documents_with_foreign_collection=1,documents_without_revision=5,empty_legacy_documents=1,faqs_without_revision=2,legacy_chunks_without_revision=2,legacy_faqs_marked_published_but_unapproved=2,revisions_pending_review=0", census(A));
  const served = (biz, q, scope = "{}") => query(src, asService(`select count(*) from public.search_governed_knowledge('${biz}', '${q}', '${scope}'::uuid[], 10);`));
  check("nothing legacy is served after 0033 (governed and pre-D14 RPC names)",
    served(A, "synthetic") === "0" && served(B, "parking") === "0"
      && query(src, asService(`select count(*) from public.search_knowledge('${B}', 'parking', 10);`)) === "0");

  const dryA = query(src, asService(`select string_agg(action, ',' order by item_id) from public.knowledge_backfill_legacy('${A}');`));
  check("backfill dry run A classifies every legacy item",
    dryA === "would_create_draft,quarantined_unusable_content,quarantined_foreign_collection,would_create_draft,quarantined_missing_source,would_create_pending_review,quarantined_unusable_content", dryA);
  const applyA = psql(src, asService(`select count(*) from public.knowledge_backfill_legacy('${A}', true);`));
  check("pre-0035 negative regression: K1 apply aborts on the source_ref limit missed by old dry run",
    applyA.status !== 0 && /source_ref/.test(errorOf(applyA)), errorOf(applyA));
  check("…and the aborted apply leaves no revision for A (atomic)",
    query(src, `select (select count(*) from public.knowledge_document_revisions where business_id = '${A}') + (select count(*) from public.faq_revisions where business_id = '${A}');`) === "0");

  const aclBeforeK1 = query(src,SECURITY_SNAPSHOT);
  const oidBeforeK1 = query(src,"select 'public.knowledge_backfill_legacy(uuid,boolean)'::regprocedure::oid;");
  const k1Upgrade = applyFiles(src,k1,'"$user", public');
  const k1Restore = applyFiles(safe,k1,'"$user", public');
  check("0035 applies after 0034 on source and recovered copy", k1Upgrade.status===0 && k1Restore.status===0, errorOf(k1Upgrade)||errorOf(k1Restore));
  check("0035 preserves function identity, owner, grants and every security snapshot row", query(src,SECURITY_SNAPSHOT)===aclBeforeK1
    && query(src,"select 'public.knowledge_backfill_legacy(uuid,boolean)'::regprocedure::oid;")===oidBeforeK1);
  const replayK1=psql(src,`begin;\n\\i /tmp/mig/${k1[0]}\ncommit;`);
  check("0035 function replacement can be replayed without data/privilege changes", replayK1.status===0 && query(src,SECURITY_SNAPSHOT)===aclBeforeK1);
  check("0035 source and recovered copy schema and security match", query(src,SCHEMA_SNAPSHOT)===query(safe,SCHEMA_SNAPSHOT) && query(src,SECURITY_SNAPSHOT)===query(safe,SECURITY_SNAPSHOT));
  const ledger35=compareLedger({repo,preflightText:preflight(src),expectPending:["0036","0037"]});
  check("0035 ledger consistent with only 0036 and 0037 pending",ledger35.verdict===VERDICT.CONSISTENT, ledger35.findings.join("; "));
  const fixedDryA=query(src,asService(`select count(*) from public.knowledge_backfill_legacy('${A}',false) where action='quarantined_source_ref_too_long';`));
  const fixedApplyA=query(src,asService(`select count(*) from public.knowledge_backfill_legacy('${A}',true) where action='quarantined_source_ref_too_long';`));
  check("K1 fixed: dry/apply quarantine the same overlong source and valid A items proceed",fixedDryA==="1" && fixedApplyA==="1"
    && query(src,`select count(*) from public.knowledge_document_revisions where business_id='${A}' and state='draft';`)==="1");

  // Exact PostgreSQL character-count boundaries, mixed valid/invalid atomicity,
  // and a separate tenant's valid batch. No historical SQL is patched.
  const boundaryMixed = "c0000000-0000-4000-8000-00000000000c";
  const boundaryValid = "d0000000-0000-4000-8000-00000000000d";
  query(src, `insert into public.businesses(id,name,slug) values
    ('${boundaryMixed}','Boundary mixed','boundary-mixed'),('${boundaryValid}','Boundary valid','boundary-valid');
    insert into public.knowledge_documents(business_id,title,content,source_type,source_ref,collection_id)
    select b, 'Boundary '||n, 'Synthetic boundary content', 'url', repeat('x',n), null
      from (values ('${boundaryMixed}'::uuid,499),('${boundaryMixed}'::uuid,500),('${boundaryMixed}'::uuid,501),
                   ('${boundaryValid}'::uuid,499),('${boundaryValid}'::uuid,500)) v(b,n);`);
  check("corrected dry run accepts 499/500 and quarantines 501",
    query(src, asService(`select string_agg(action,',' order by item_id) from public.knowledge_backfill_legacy('${boundaryMixed}',false);`)).split(",").filter(x=>x==="would_create_draft").length===2
    && query(src,asService(`select count(*) from public.knowledge_backfill_legacy('${boundaryMixed}',false) where action='quarantined_source_ref_too_long';`))==="1");
  const inventorySql = readFileSync(join(root,"infrastructure/hosted/knowledge-inventory-readonly.sql"),"utf8");
  const inventory = psql(src, `\\set business_id '${boundaryMixed}'\n${inventorySql}`);
  check("read-only inventory reports exactly one >500 blocker in the mixed tenant", inventory.status === 0
    && /legacy_source_ref_over_500_apply_blocker\|1/.test(inventory.stdout), errorOf(inventory));
  const invalidInventory = psql(src, `\\set business_id '00000000-0000-4000-8000-000000000099'\n${inventorySql}`);
  check("inventory fails for unknown tenant rather than returning a false clean bill", invalidInventory.status !== 0);
  const mixedApply = psql(src, asService(`select count(*) from public.knowledge_backfill_legacy('${boundaryMixed}',true);`));
  check("mixed 499/500/501 apply succeeds with two drafts and unchanged source provenance",
    mixedApply.status===0 && mixedApply.stdout.trim()==="3" && query(src,`select count(*) from public.knowledge_document_revisions where business_id='${boundaryMixed}' and state='draft';`)==="2"
      && query(src,`select count(*) from public.knowledge_documents where business_id='${boundaryMixed}' and char_length(source_ref)=501 and status='ready';`)==="1");
  check("mixed retry reports only quarantine and creates no duplicate",query(src,asService(`select string_agg(action,',') from public.knowledge_backfill_legacy('${boundaryMixed}',true);`))==="quarantined_source_ref_too_long");
  check("499 and exactly 500 apply for another tenant without touching the rejected tenant",
    query(src, asService(`select count(*) from public.knowledge_backfill_legacy('${boundaryValid}',true) where action='draft_created_needs_indexing';`)) === "2"
      && query(src, `select count(*) from public.knowledge_document_revisions where business_id='${boundaryMixed}';`) === "2");
  check("valid boundary batch preserves provenance and stays unapproved",
    query(src, `select count(*) from public.knowledge_document_revisions r join public.knowledge_documents d on d.id=r.document_id
      where r.business_id='${boundaryValid}' and r.source_ref=d.source_ref and r.source_type=d.source_type
        and r.business_id=d.business_id and r.state='draft' and r.origin='legacy_backfill';`) === "2");
  check("valid boundary replay is idempotent", query(src, asService(`select count(*) from public.knowledge_backfill_legacy('${boundaryValid}',true);`)) === "0");

  const applyB = query(src, asService(`select string_agg(action, ',' order by item_kind) from public.knowledge_backfill_legacy('${B}', true);`));
  check("backfill apply B creates one unindexed draft and one pending FAQ, approving nothing", applyB === "draft_created_needs_indexing,pending_review_created", applyB);
  check("backfill is idempotent", query(src, asService(`select count(*) from public.knowledge_backfill_legacy('${B}', true) where action not like 'quarantined%';`)) === "0");
  check("backfilled content is still not served", served(B, "parking") === "0");

  // Indexing the backfilled draft: the database allows it for the service role; the dashboard has no such action.
  const rev = query(src, `select id from public.knowledge_document_revisions where document_id = '${DOC_B}';`);
  const revisionIdentity = query(src, `select row(id,business_id,document_id,revision,title,content_sha256,source_type,source_ref,origin,created_at)::text from public.knowledge_document_revisions where id='${rev}';`);
  const wrongTenant = psql(src, asService(`select public.knowledge_begin_indexing('${A}','${DOC_B}','${rev}');`));
  check("indexing refuses wrong tenant without changing revision", wrongTenant.status !== 0 && /not found/.test(errorOf(wrongTenant)));
  const partial = query(src, asService(`select public.knowledge_begin_indexing('${B}','${DOC_B}','${rev}');
    select public.knowledge_finish_indexing('${B}','${DOC_B}','${rev}',1);`));
  check("incomplete indexing is failed and unserved", partial.endsWith("failed") && served(B,"parking") === "0");
  const indexed = query(src, asService(`select public.knowledge_begin_indexing('${B}', '${DOC_B}', '${rev}');
    insert into public.knowledge_chunks (document_id, business_id, revision_id, content, chunk_index)
      values ('${DOC_B}', '${B}', '${rev}', 'Synthetic rehearsal parking is free for visitors.', 0);
    select public.knowledge_finish_indexing('${B}', '${DOC_B}', '${rev}', 1);`));
  check("service-role indexing marks the backfilled draft ready (keyword-only, no embedding)", indexed.endsWith("ready"), indexed);

  check("retry indexing preserves revision identity, source provenance, draft state and collection",
    query(src, `select row(id,business_id,document_id,revision,title,content_sha256,source_type,source_ref,origin,created_at)::text from public.knowledge_document_revisions where id='${rev}';`) === revisionIdentity
      && query(src, `select state from public.knowledge_document_revisions where id='${rev}';`) === "draft");

  query(src, `insert into auth.users (id, email) values ('${U}', 'owner-b@rehearsal.invalid');
    insert into public.business_members (business_id, user_id, role) values ('${B}', '${U}', 'owner');`);
  const faqRev = query(src, `select id from public.faq_revisions where business_id = '${B}';`);
  const approved = psql(src, asOwnerOfB(`select public.knowledge_submit_revision('${rev}');
    select public.knowledge_review_revision('${rev}', true);
    select public.faq_review_revision('${faqRev}', true);`));
  check("tenant owner submits and approves through the governed RPCs", approved.status === 0, errorOf(approved));
  const approvedReindex = psql(src, asService(`select public.knowledge_begin_indexing('${B}','${DOC_B}','${rev}');`));
  check("approved revision cannot be reindexed or have approval silently changed", approvedReindex.status !== 0 && /only a draft/.test(errorOf(approvedReindex))
    && query(src, `select state from public.knowledge_document_revisions where id='${rev}';`) === "approved");
  check("approved content is served to its tenant (document + FAQ)", served(B, "parking") === "2");
  check("a nonempty collection scope excludes FAQs and unbound documents", served(B, "parking", `{${id("c", "0b")}}`) === "0");
  const foreignScope = psql(src, asService(`select count(*) from public.search_governed_knowledge('${B}', 'parking', '{${id("c", "0a")}}'::uuid[], 10);`));
  check("another tenant's collection in the scope is refused, not widened", foreignScope.status !== 0, errorOf(foreignScope));
  check("tenant B's approved content is never served to tenant A", served(A, "parking") === "0");

  // 7. 0036 — the WS4 authorization-audit schema. Roll it forward on the
  // source and on the recovered copy, then back up AFTER 0036 and restore with
  // the same mitigated method: audit rows, grants and schema must survive.
  // Auth users are platform data outside this dump's scope (as in section 4),
  // so the restore target receives the one synthetic member user first.
  const dataBefore36 = query(src, DATA_FINGERPRINT);
  const auditUp = applyFiles(src, auditSchema, '"$user", public');
  const auditUpCopy = applyFiles(safe, auditSchema, '"$user", public');
  check("0036 applies after 0035 on source and recovered copy", auditSchema.length === 1 && auditUp.status === 0 && auditUpCopy.status === 0,
    errorOf(auditUp) || errorOf(auditUpCopy));
  check("0036 source and recovered copy schema and security match",
    query(src, SCHEMA_SNAPSHOT) === query(safe, SCHEMA_SNAPSHOT) && query(src, SECURITY_SNAPSHOT) === query(safe, SECURITY_SNAPSHOT));
  check("0036 rewrites no existing row", query(src, DATA_FINGERPRINT) === dataBefore36);
  const at36 = preflight(src);
  const ledger36 = compareLedger({ repo, preflightText: at36, expectPending: ["0037"] });
  check("0036: preflight samples its objects and the ledger leaves only 0037 pending",
    /objects\|[^\n]*\|0036=t/.test(at36) && ledger36.verdict === VERDICT.CONSISTENT, ledger36.findings.join("; "));
  check("0036: application roles hold only authenticated SELECT and service_role INSERT/SELECT on audit_logs",
    query(src, `select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'audit_logs' and grantee in ('anon','authenticated','service_role');`)
      === "authenticated:SELECT,service_role:INSERT,service_role:SELECT");
  const auditRows = [1, 2, 3].map((n) => `('${id("a", `a${n}`)}', '${id("9", `0${n}`)}', ${n === 3 ? "null" : `'${n === 1 ? A : B}'`}, ${n === 2 ? `'${U}'` : "null"},
    'POST', 'widget', 'api_access', '${n === 3 ? "denied" : "succeeded"}', '${n === 3 ? "unauthenticated" : "completed"}', '${id("9", `0${n}`)}')`);
  query(src, asService(`insert into public.audit_logs (id, operation_id, business_id, actor_id, method, route_group, action, outcome, reason, correlation_id)
    values ${auditRows.join(",\n")};`));
  const auditUpdate = psql(src, asService("update public.audit_logs set outcome = 'failed';"));
  const auditDelete = psql(src, asService("delete from public.audit_logs;"));
  check("0036: the service role can append audit rows but cannot update or delete them",
    auditUpdate.status !== 0 && auditDelete.status !== 0 && query(src, "select count(*) from public.audit_logs;") === "3", errorOf(auditUpdate));
  const AUDIT_FINGERPRINT = `select count(*) || ':' || md5(coalesce(string_agg(row(id, operation_id, business_id, actor_id, method, route_group, action,
    outcome, reason, correlation_id, created_at)::text, ',' order by id), '')) from public.audit_logs;`;
  const auditBefore = query(src, AUDIT_FINGERPRINT);
  const dump36 = spawnSync("docker", ["exec", src, "pg_dump", "-h", "localhost", "-U", "postgres", "-d", "postgres",
    "--format=custom", "--schema=public", "--schema=supabase_migrations"], { maxBuffer: 256 * 1024 * 1024 });
  check("post-0036 logical backup taken", dump36.status === 0 && dump36.stdout.length > 0, `${dump36.stdout?.length ?? 0} bytes`);
  const r36 = startContainer("audit_restore");
  query(r36, `insert into auth.users (id, email) values ('${U}', 'owner-b@rehearsal.invalid');`);
  query(r36, "create extension if not exists vector with schema public; create extension if not exists btree_gist with schema public;");
  query(r36, NEUTRALIZE_RESTORE_DEFAULTS);
  const copy36 = spawnSync("docker", ["exec", "-i", r36, "sh", "-c", "cat > /tmp/pre.dump"], { input: dump36.stdout, maxBuffer: 256 * 1024 * 1024 });
  const kept36 = docker(["exec", r36, "pg_restore", "-l", "/tmp/pre.dump"]).stdout.split("\n").filter((line) => !platform(line));
  const list36 = docker(["exec", "-i", r36, "sh", "-c", "cat > /tmp/pre.list"], kept36.join("\n"));
  if (copy36.status !== 0 || list36.status !== 0) throw new Error("post-0036 restore input copy failed");
  const restore36 = docker(["exec", r36, "pg_restore", "-h", "localhost", "-U", "postgres", "-d", "postgres", "--exit-on-error", "-L", "/tmp/pre.list", "/tmp/pre.dump"]);
  check("post-0036 mitigated restore succeeds", restore36.status === 0, restore36.stderr.match(/error:.*$/m)?.[0] ?? "");
  query(r36, NEUTRALIZE_RESTORE_DEFAULTS);
  query(r36, "alter default privileges for role postgres revoke execute on functions from public;");
  query(r36, query(src, RESTORE_SOURCE_DEFAULTS));
  const verdict36 = recoveryVerdict({ restoreStatus: restore36.status, source: JSON.parse(query(src, SECURITY_SNAPSHOT)), restored: JSON.parse(query(r36, SECURITY_SNAPSHOT)) });
  check("post-0036 restore preserves ownership, normalized ACL, effective rights and creator defaults", verdict36.accepted, verdict36.categories.join(","));
  check("post-0036 restore preserves every audit row byte for byte, including server timestamps", query(r36, AUDIT_FINGERPRINT) === auditBefore);
  check("post-0036 restored schema definitions match source", query(r36, SCHEMA_SNAPSHOT) === query(src, SCHEMA_SNAPSHOT));
  const restoredLedger = compareLedger({ repo, preflightText: preflight(r36), expectPending: ["0037"] });
  check("post-0036 restored ledger agrees with its objects (only 0037 pending)", restoredLedger.verdict === VERDICT.CONSISTENT, restoredLedger.findings.join("; "));
  const restoredUpdate = psql(r36, asService("update public.audit_logs set outcome = 'failed';"));
  check("post-0036 restored audit rows stay append-only for the service role", restoredUpdate.status !== 0);

  // 8. 0037 — business-level calendar uniqueness. A legacy duplicate (two
  // first connects that raced before 0037) must be visible in the census and
  // must abort 0037 without touching the ledger or any row. Removing one row
  // stands in for the operator's separately authorized disposition.
  query(src, `insert into public.calendar_connections (id, business_id, staff_id, provider, calendar_ref) values
    ('${id("d", "a1")}', '${A}', null, 'google', 'raced-1'), ('${id("d", "a2")}', '${A}', null, 'google', 'raced-2');`);
  const duplicateCensus = (text) => text.match(/calendar_business_level_duplicate_groups\s*\n[-+]+\s*\n\s*(\d+)/)?.[1];
  const at36dup = preflight(src);
  check("0037 preflight census counts the legacy duplicate business-level group", duplicateCensus(at36dup) === "1");
  const dataBefore37 = query(src, DATA_FINGERPRINT);
  const refused37 = applyFiles(src, calendarUnique, '"$user", public');
  const ledgerRefused = compareLedger({ repo, preflightText: preflight(src), expectPending: ["0037"] });
  check("0037 aborts on the duplicate with a count only; ledger, objects and rows unchanged",
    calendarUnique.length === 1 && refused37.status !== 0 && /0037: 1 business-level calendar connection group/.test(errorOf(refused37))
      && !errorOf(refused37).includes(A) && ledgerRefused.verdict === VERDICT.CONSISTENT && query(src, DATA_FINGERPRINT) === dataBefore37,
    errorOf(refused37).slice(0, 160));
  query(src, `delete from public.calendar_connections where id = '${id("d", "a2")}';`);
  const dataBeforeUp37 = query(src, DATA_FINGERPRINT);
  const up37 = applyFiles(src, calendarUnique, '"$user", public');
  const up37Copy = applyFiles(safe, calendarUnique, '"$user", public');
  check("0037 applies after the disposition on source and on the recovered copy (which never held the duplicate)",
    up37.status === 0 && up37Copy.status === 0, errorOf(up37) || errorOf(up37Copy));
  check("0037 rewrites no row and source/copy schema and security match", query(src, DATA_FINGERPRINT) === dataBeforeUp37
    && query(src, SCHEMA_SNAPSHOT) === query(safe, SCHEMA_SNAPSHOT) && query(src, SECURITY_SNAPSHOT) === query(safe, SECURITY_SNAPSHOT));
  const at37 = preflight(src);
  const ledger37 = compareLedger({ repo, preflightText: at37, expectPending: [] });
  check("0037: preflight samples its index, census is clean and the ledger is complete with no pending files",
    /objects\|[^\n]*\|0037=t/.test(at37) && duplicateCensus(at37) === "0" && ledger37.verdict === VERDICT.CONSISTENT, ledger37.findings.join("; "));
  const second37 = psql(src, asService(`insert into public.calendar_connections (business_id, staff_id, provider) values ('${A}', null, 'google');`));
  check("0037: a further business-level google connection for the tenant is refused by the index",
    second37.status !== 0 && /calendar_connections_business_level_unique/.test(errorOf(second37)), errorOf(second37).slice(0, 160));
  check("0037: the service role can still add another tenant's or provider's business-level connection",
    query(src, asService(`insert into public.calendar_connections (business_id, staff_id, provider) values ('${B}', null, 'google'), ('${A}', null, 'outlook') returning 'ok';`)) === "ok\nok");

  const after = preflight(src);
  check("post-rollout preflight: serving state and legacy blockers visible",
    /legacy_documents_source_ref_over_500_backfill_aborts/.test(after) && /served_chunks_without_embedding/.test(after)
      && query(src, `select (select count(*) from public.knowledge_documents where published_revision_id is not null) || ',' ||
        (select count(*) from public.faqs where published_revision_id is not null);`) === "1,1");
} catch (error) {
  check("rehearsal completed", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const name of containers) docker(["rm", "-f", name]);
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
