#!/usr/bin/env node
/**
 * Industry-neutrality + package-boundary gate (HALO Phase 1, plan §2.4).
 *
 * 1. packages/* must contain no industry- or business-specific content —
 *    business knowledge belongs in tenant data, agent configuration,
 *    knowledge documents and app-layer seed content (src/content).
 * 2. packages/* must not import from the application (src/, alias @/*) —
 *    the dependency direction is packages ← app, never the reverse.
 *    (Also enforced by the ESLint no-restricted-imports rule.)
 *
 * Exits non-zero on the first violation, printing the offending file:line.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");

const INDUSTRY_TERMS = [
  "dental", "dentist", "orthodont", "endodont", "periodont",
  "hvac", "plumb", "sewer", "roofing", "shingle", "gutter",
  "arunodhaya", "opscorp", "solar",
  "medspa", "med spa", "veterinar", "realtor", "realty", "real estate",
  "crossfit", "hubspot", "salesforce",
];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".md"]);

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

let failures = 0;

for (const file of walk(packagesDir)) {
  if (!CODE_EXTENSIONS.has(path.extname(file))) continue;
  const rel = path.relative(root, file);
  const lines = readFileSync(file, "utf8").split("\n");

  lines.forEach((line, i) => {
    // Boundary rule: no application imports from packages.
    if (/from\s+["'](@\/|.*\/src\/)/.test(line)) {
      console.error(`${rel}:${i + 1}: packages must not import from the application (src/)`);
      failures += 1;
    }
    // Industry-neutrality rule (word-ish boundaries to limit false hits).
    for (const term of INDUSTRY_TERMS) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`\\b${escaped}\\b`, "i");
      if (pattern.test(line)) {
        console.error(`${rel}:${i + 1}: industry-specific term "${term}" found in packages/`);
        failures += 1;
      }
    }
  });
}

if (failures > 0) {
  console.error(`\ncheck:neutral failed with ${failures} violation(s).`);
  process.exit(1);
}

console.log("check:neutral OK — packages/ are industry-neutral and boundary-clean.");
