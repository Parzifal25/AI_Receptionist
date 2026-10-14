import { describe, expect, it } from "vitest";
import { emptySnapshot } from "@halo/qualification/engine";
import { computeDisposition } from "@halo/qualification/disposition";

describe("qualification completion", () => {
  it("does not qualify a completed questionnaire with an unresolved required field", () => {
    const snapshot = { ...emptySnapshot(), status: "complete" as const, unresolved: ["phone"], fields: { name: { value: "Synthetic", raw: "Synthetic", confidence: 1, confirmed: true } } };
    const result = computeDisposition({ snapshot, turns: 10 });
    expect(result.disposition).toBe("not_qualified");
    expect(result.reason).toContain("unresolved: phone");
  });

  it("keeps a complete questionnaire with no unresolved required fields qualified", () => {
    expect(computeDisposition({ snapshot: { ...emptySnapshot(), status: "complete" }, turns: 10 }).disposition).toBe("qualified");
  });
});
