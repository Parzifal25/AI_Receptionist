/**
 * HALO Phase 4 — the Arunodhaya evaluation runner (brief §13, §14).
 *
 * Runs the golden corpus through the real pipeline and prints a scorecard
 * plus the measured context size per turn. Same corpus as the CI test; this
 * is the reportable form.
 *
 *   npx tsx scripts/arunodhaya-eval.ts
 *
 * It scores only what is deterministic. Language quality, naturalness and
 * factual accuracy of model prose need a real model and native reviewers and
 * are NOT scored here — claiming otherwise would be the same kind of
 * invented confidence this phase exists to prevent.
 */
import { ARUNODHAYA_GOLDEN } from "../tests/golden/arunodhaya/conversations";
import { runGoldenConversation } from "../tests/golden/arunodhaya/runner";
import type { GoldenCategory, GoldenResult } from "../tests/golden/arunodhaya/types";

const LIVE_HANDOFF = new Set(["hd-01-explicit-request-live"]);

async function main(): Promise<void> {
  const results: GoldenResult[] = [];
  for (const conversation of ARUNODHAYA_GOLDEN) {
    results.push(
      await runGoldenConversation(conversation, {
        handoffNumber: LIVE_HANDOFF.has(conversation.id) ? "+914000009999" : null,
      }),
    );
  }

  const byCategory = new Map<GoldenCategory, GoldenResult[]>();
  for (const result of results) {
    const bucket = byCategory.get(result.category) ?? [];
    bucket.push(result);
    byCategory.set(result.category, bucket);
  }

  console.log("\n=== Arunodhaya golden corpus ===\n");
  console.log("category        pass  total");
  for (const [category, bucket] of [...byCategory].sort()) {
    const passed = bucket.filter((r) => r.passed).length;
    console.log(`${category.padEnd(15)} ${String(passed).padStart(4)}  ${String(bucket.length).padStart(5)}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`${"TOTAL".padEnd(15)} ${String(passed).padStart(4)}  ${String(results.length).padStart(5)}\n`);

  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log("--- failures ---");
    for (const failure of failures) {
      console.log(`\n${failure.conversation}: ${failure.intent}`);
      for (const finding of failure.findings) console.log(`  turn ${finding.turn} ${finding.check}: ${finding.detail}`);
    }
    console.log("");
  }

  const dispositions = new Map<string, number>();
  for (const result of results) {
    const key = result.disposition ?? "(none)";
    dispositions.set(key, (dispositions.get(key) ?? 0) + 1);
  }
  console.log("--- dispositions recorded ---");
  for (const [disposition, count] of [...dispositions].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${disposition.padEnd(22)} ${count}`);
  }

  const prompts = results.flatMap((r) => r.promptChars).sort((a, b) => a - b);
  if (prompts.length > 0) {
    const at = (q: number) => prompts[Math.floor((prompts.length - 1) * q)];
    console.log("\n--- assembled system prompt, characters per turn ---");
    console.log(`  turns measured  ${prompts.length}`);
    console.log(`  min / p50 / p95 / max  ${prompts[0]} / ${at(0.5)} / ${at(0.95)} / ${prompts[prompts.length - 1]}`);
  }

  console.log("\nNOT scored here (needs a real model and native reviewers): Telugu naturalness,");
  console.log("speech quality, and whether a real model phrases the pending question well.\n");
  process.exit(failures.length > 0 ? 1 : 0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
