#!/usr/bin/env node
/**
 * D21 — replay the committed migration chain on the real Supabase Postgres
 * image, under the session conditions that decide whether `0001` can run on
 * hosted Supabase without editing it.
 *
 * Safety: every scenario starts its OWN container from a locally cached
 * image (`--pull=never`) with `--network none` and no published ports, and
 * talks to it only through `docker exec`. The container is removed whatever
 * happens. No connection string is accepted, so this cannot reach the shared
 * HALO stack (55321/55322), the 5432x project, or any hosted database.
 *
 * Scenarios and the outcome each must produce:
 *   A  session search_path without `extensions` (the CLI login-role
 *      condition recorded in D10/D21)              -> 0001 fails (gen_random_bytes)
 *   P  plain login as `postgres`, no SET           -> 0001–latest apply; governed
 *                                                     retrieval and censuses run
 *   C  `vector` already enabled in schema
 *      `extensions` before 0001                    -> 0001 fails (<=> operator)
 *
 * Usage: node scripts/check-supabase-image-chain.mjs [image]
 * Default image: the locally cached public.ecr.aws/supabase/postgres:17.6.1.155.
 * Exits non-zero if any scenario does not produce its expected outcome.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const image = process.argv[2] ?? "public.ecr.aws/supabase/postgres:17.6.1.155";
const root = new URL("..", import.meta.url).pathname;
const migrationsDir = join(root, "supabase/migrations");
const stubs = readFileSync(join(root, "infrastructure/ci/supabase-stubs.sql"), "utf8");
// Hosted projects get storage.buckets/objects from the Storage service; the
// bare image does not run it, so only those tables are stubbed.
const storageStub = stubs.slice(stubs.indexOf("create schema if not exists storage;"));
const migrations = readdirSync(migrationsDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

const docker = (args, input) => spawnSync("docker", args, { input, encoding: "utf8" });

function startContainer(name) {
  const run = docker(["run", "-d", "--name", name, "--network", "none", "--pull=never",
    "-e", `POSTGRES_PASSWORD=${randomBytes(16).toString("hex")}`, image]);
  if (run.status !== 0) throw new Error(`cannot start ${image} (is it cached?): ${run.stderr.trim()}`);
  const networks = JSON.parse(docker(["inspect", "-f", "{{json .NetworkSettings.Networks}}", name]).stdout);
  const ports = docker(["inspect", "-f", "{{json .HostConfig.PortBindings}}", name]).stdout.trim();
  if (Object.keys(networks).join() !== "none" || !["{}", "null"].includes(ports)) {
    throw new Error(`refusing ${name}: not isolated (networks ${Object.keys(networks)}, ports ${ports})`);
  }
  for (let i = 0; i < 120; i += 1) {
    const ready = docker(["exec", name, "psql", "-h", "localhost", "-U", "supabase_admin", "-d", "postgres",
      "-tAc", "select 1 from pg_namespace where nspname = 'extensions'"]);
    if (ready.status === 0 && ready.stdout.trim() === "1") return;
    execFileSync("sleep", ["1"]);
  }
  throw new Error(`${name} did not become ready`);
}

function psql(name, user, sql) {
  return docker(["exec", "-i", name, "psql", "-h", "localhost", "-U", user, "-d", "postgres",
    "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1"], sql);
}

function scenario(id, { preamble, searchPath, only }) {
  const name = `halo_check_d21_${id.toLowerCase()}_${randomBytes(3).toString("hex")}`;
  const work = mkdtempSync(join(tmpdir(), "halo-d21-"));
  try {
    startContainer(name);
    const stub = psql(name, "supabase_admin", `${storageStub}\ngrant all on schema storage to postgres;\ngrant all on all tables in schema storage to postgres;`);
    if (stub.status !== 0) throw new Error(`storage stub failed: ${stub.stderr}`);
    docker(["cp", migrationsDir, `${name}:/tmp/mig`]);
    const set = searchPath ? `set search_path = ${searchPath};\n` : "";
    const files = only ? migrations.filter((f) => f === only) : migrations;
    const script = `${preamble ?? ""}\n${set}${files.map((f) => `\\i /tmp/mig/${f}\n${set}`).join("")}`;
    writeFileSync(join(work, "run.sql"), script);
    docker(["cp", join(work, "run.sql"), `${name}:/tmp/run.sql`]);
    const chain = docker(["exec", name, "psql", "-h", "localhost", "-U", "postgres", "-d", "postgres",
      "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "/tmp/run.sql"]);
    const result = { applied: chain.status === 0, error: (chain.stderr.match(/ERROR:.*$/m) ?? [""])[0] };
    if (result.applied) {
      const probe = psql(name, "postgres", `
        select string_agg(e.extname || '@' || n.nspname, ',' order by e.extname)
          from pg_extension e join pg_namespace n on n.oid = e.extnamespace
         where e.extname in ('pgcrypto', 'vector', 'btree_gist');
        set role service_role;
        select count(*) from public.match_governed_knowledge_chunks(gen_random_uuid(),
          ('[' || array_to_string(array_fill(0.1::real, array[768]), ',') || ']')::vector, '{}'::uuid[], 3);
        select count(*) from public.search_governed_knowledge(gen_random_uuid(), 'probe', '{}'::uuid[], 3);
        select count(*) from public.knowledge_governance_census();
        select count(*) from public.tenant_reference_census();
        reset role;
        select bool_and(convalidated) from pg_constraint
         where conname in ('knowledge_documents_collection_tenant_fk', 'knowledge_chunks_document_tenant_fk');
        insert into public.businesses (name, slug) values ('Probe', 'probe-d21') returning 'ok';`);
      result.probe = probe.status === 0 ? probe.stdout.trim().split("\n") : [`probe failed: ${probe.stderr.trim()}`];
    }
    return result;
  } finally {
    docker(["rm", "-f", name]);
    rmSync(work, { recursive: true, force: true });
  }
}

const checks = [
  ["A", { searchPath: '"$user", public', only: "0001_init.sql" },
    (r) => !r.applied && /gen_random_bytes/.test(r.error)],
  ["P", {},
    (r) => r.applied && r.probe?.[0] === "btree_gist@public,pgcrypto@extensions,vector@public"
      && r.probe.slice(1, 5).every((v) => v === "0") && r.probe[5] === "t" && r.probe[6] === "ok"],
  ["C", { preamble: "create extension if not exists vector with schema extensions;", searchPath: "public, extensions", only: "0001_init.sql" },
    (r) => !r.applied && /operator does not exist: extensions\.vector <=> extensions\.vector/.test(r.error)],
];

let failed = 0;
console.log(`image ${image}; ${migrations.length} migrations (${migrations[0]} … ${migrations.at(-1)})`);
for (const [id, options, expected] of checks) {
  const result = scenario(id, options);
  const ok = expected(result);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${id}: applied=${result.applied}${result.error ? ` ${result.error}` : ""}${result.probe ? ` probe=${result.probe.join("|")}` : ""}`);
}
process.exit(failed ? 1 : 0);
