import { describe, expect, it } from "vitest";
import { ARUNODHAYA_GOLDEN } from "../golden/arunodhaya/conversations";
import { runGoldenConversation } from "../golden/arunodhaya/runner";
import type { GoldenCategory } from "../golden/arunodhaya/types";

/**
 * Phase 4 — the golden corpus as a CI gate. `npm run eval:arunodhaya` runs
 * the same corpus and prints the scored report.
 */

const EXPECTED_COUNTS: Record<GoldenCategory, number> = {
  telugu: 10,
  tenglish: 10,
  objection: 5,
  negotiation: 5,
  qualification: 5,
  appointment: 5,
  handoff: 5,
  failure: 5,
};

describe("arunodhaya golden conversations", () => {
  it("covers every category the brief asks for", () => {
    const counts = ARUNODHAYA_GOLDEN.reduce<Record<string, number>>((acc, c) => {
      acc[c.category] = (acc[c.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual(EXPECTED_COUNTS);
    expect(new Set(ARUNODHAYA_GOLDEN.map((c) => c.id)).size).toBe(ARUNODHAYA_GOLDEN.length);
  });

  for (const conversation of ARUNODHAYA_GOLDEN) {
    it(`${conversation.id}: ${conversation.intent}`, async () => {
      const result = await runGoldenConversation(conversation, {
        // A live transfer target exists only where the scenario is about one.
        handoffNumber: conversation.id === "hd-01-explicit-request-live" ? "+914000009999" : null,
      });
      if (!result.passed) {
        throw new Error(result.findings.map((f) => `turn ${f.turn} ${f.check}: ${f.detail}`).join("\n"));
      }
      expect(result.passed).toBe(true);
    });
  }
});
