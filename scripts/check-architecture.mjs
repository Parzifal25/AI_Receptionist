#!/usr/bin/env node
/**
 * Architecture gate (HALO Phase 2, workstream 17).
 *
 * Static checks that the runtime's trust boundaries cannot erode silently:
 *  1. Dependency direction — packages/runtime depends only on core, ports,
 *     platform, knowledge (query heuristics) and zod; never on providers,
 *     tenancy, scheduling, workflows or the application. The one store
 *     adapter under packages/runtime/stores may use tenancy (it is the
 *     persistence edge, not the reasoning core).
 *  2. No dynamic execution or egress in the reasoning core — no eval, no
 *     Function(), no child_process/vm, no fetch, no process.env inside
 *     packages/runtime (except stores/). The model can never reach code or
 *     the network through the runtime.
 *  3. Providers implement ports; they never import the runtime.
 *  4. The tool registry is a closed set with schema-validated arguments:
 *     no `z.any()` / `z.unknown()` / passthrough argument schemas.
 *  5. Every table created by a migration enables row level security.
 *  6. Voice (Phase 3) — packages/voice depends only on core, ports,
 *     platform, runtime, language, qualification and zod (stores/ may add
 *     tenancy); no dynamic execution, egress or process.env in its core.
 *     The runtime and providers never import voice (the media loop sits
 *     above the runtime, adapters below it).
 *
 * Exits non-zero on the first violation, printing file:line.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const fail = (file, line, message) => {
  console.error(`${path.relative(root, file)}:${line}: ${message}`);
  failures += 1;
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const ts = (dir) => walk(path.join(root, dir)).filter((f) => /\.(ts|tsx|mts)$/.test(f));

// 1 + 2. Runtime core boundaries.
// @halo/language is a dependency-free leaf (normalization, detection,
// deterministic parsers). The validator needs it so the act-then-narrate
// guard works in non-English scripts; it cannot import the runtime back.
const RUNTIME_ALLOWED = ["@halo/core/", "@halo/ports/", "@halo/platform/", "@halo/knowledge/", "@halo/language/", "zod", "node:crypto"];
const STORE_ALLOWED = [...RUNTIME_ALLOWED, "@halo/tenancy/", "@supabase/supabase-js", "server-only"];
const FORBIDDEN_CORE = [
  [/\beval\s*\(/, "eval() in runtime core"],
  [/\bnew\s+Function\s*\(/, "Function constructor in runtime core"],
  [/["']node:child_process["']|["']child_process["']/, "child_process in runtime core"],
  [/["']node:vm["']|["']vm["']/, "vm module in runtime core"],
  [/\bfetch\s*\(/, "network egress (fetch) in runtime core"],
  [/\bprocess\.env\b/, "process.env in runtime core"],
  [/\brequire\s*\(/, "dynamic require in runtime core"],
];
for (const file of ts("packages/runtime")) {
  const isStore = file.includes(`${path.sep}stores${path.sep}`);
  const allowed = isStore ? STORE_ALLOWED : RUNTIME_ALLOWED;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = line.match(/from\s+["']([^"']+)["']/);
    if (m) {
      const spec = m[1];
      const ok = spec.startsWith(".") || allowed.some((a) => spec === a || spec.startsWith(a));
      if (!ok) fail(file, i + 1, `packages/runtime may not import "${spec}"`);
    }
    if (!isStore) {
      for (const [re, msg] of FORBIDDEN_CORE) if (re.test(line)) fail(file, i + 1, msg);
    }
  });
}

// 3. Providers never depend on the runtime.
for (const file of ts("packages/providers")) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/from\s+["']@halo\/runtime\//.test(line)) fail(file, i + 1, "providers must not import the runtime");
  });
}

// 3b. The reasoning core never depends on the voice media loop.
for (const file of ts("packages/runtime")) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/from\s+["']@halo\/voice\//.test(line)) fail(file, i + 1, "runtime must not import voice");
  });
}
for (const file of ts("packages/providers")) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/from\s+["']@halo\/voice\//.test(line)) fail(file, i + 1, "providers must not import voice");
  });
}

// 6. Voice package boundaries.
const VOICE_ALLOWED = [
  "@halo/core/", "@halo/ports/", "@halo/platform/", "@halo/runtime/", "@halo/language/",
  "@halo/qualification/", "@halo/knowledge/", "zod", "node:crypto",
];
const VOICE_STORE_ALLOWED = [...VOICE_ALLOWED, "@halo/tenancy/", "@halo/agents/", "@supabase/supabase-js", "server-only"];
for (const file of ts("packages/voice")) {
  const isStore = file.includes(`${path.sep}stores${path.sep}`);
  const allowed = isStore ? VOICE_STORE_ALLOWED : VOICE_ALLOWED;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const m = line.match(/from\s+["']([^"']+)["']/);
    if (m) {
      const spec = m[1];
      const ok = spec.startsWith(".") || allowed.some((a) => spec === a || spec.startsWith(a));
      if (!ok) fail(file, i + 1, `packages/voice may not import "${spec}"`);
    }
    if (!isStore) {
      for (const [re, msg] of FORBIDDEN_CORE) if (re.test(line)) fail(file, i + 1, msg.replace("runtime core", "voice core"));
    }
  });
}

// 6b. Qualification, negotiation and language packages: no dynamic execution
// or egress, and no dependency on the application or the media loop.
const QUALIFICATION_ALLOWED = ["@halo/core/", "@halo/ports/", "@halo/platform/", "@halo/runtime/", "@halo/language/", "zod"];
for (const dir of ["packages/qualification", "packages/negotiation", "packages/language"]) {
  const allowed = dir === "packages/language" ? QUALIFICATION_ALLOWED.filter((a) => a !== "@halo/runtime/") : QUALIFICATION_ALLOWED;
  for (const file of ts(dir)) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const m = line.match(/from\s+["']([^"']+)["']/);
      if (m) {
        const spec = m[1];
        const ok = spec.startsWith(".") || allowed.some((a) => spec === a || spec.startsWith(a));
        if (!ok) fail(file, i + 1, `${dir} may not import "${spec}"`);
      }
      for (const [re, msg] of FORBIDDEN_CORE) if (re.test(line)) fail(file, i + 1, msg.replace("runtime core", dir));
    });
  }
}

// 4. Closed, schema-validated tool registry.
const registry = readFileSync(path.join(root, "packages/runtime/tools/registry.ts"), "utf8");
registry.split("\n").forEach((line, i) => {
  if (/z\.(any|unknown)\(\)/.test(line) || /\.passthrough\(\)/.test(line)) {
    fail(path.join(root, "packages/runtime/tools/registry.ts"), i + 1, "tool argument schemas must be strict");
  }
});

// 5. RLS on every migrated table.
const migrationsDir = path.join(root, "supabase/migrations");
const migrationSql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(path.join(migrationsDir, f), "utf8"))
  .join("\n");
const created = [...migrationSql.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)].map((m) => m[1]);
for (const table of new Set(created)) {
  const rls = new RegExp(`alter table public\\.${table}\\s+enable row level security`, "i");
  if (!rls.test(migrationSql)) fail(migrationsDir, 0, `table ${table} is created without row level security`);
}

if (failures > 0) {
  console.error(`\ncheck:architecture failed with ${failures} violation(s).`);
  process.exit(1);
}
console.log("check:architecture OK — runtime + voice boundaries, provider direction, closed tool registry, RLS on every table.");
