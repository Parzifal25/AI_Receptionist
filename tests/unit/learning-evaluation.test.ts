import { describe, expect, it } from "vitest";
import { defaultAgentConfig } from "@halo/core/domain/agents";
import { evaluateCandidate, type CandidateRun, type CandidateRunner, type EvaluationCase } from "@halo/learning/evaluation";
const candidate = { businessId: "tenant-a", sourceVersionId: "version-a", config: defaultAgentConfig(), prompt: "Support" };
const corpus: EvaluationCase[] = [{ id: "safe", input: "Please refund me", expected: { requiredText: ["review"], forbiddenText: ["refund approved"], allowedTools: [], requireEscalation: true } }];
const valid: CandidateRun = { businessId: "tenant-a", sourceVersionId: "version-a", reply: "A colleague will review this.", executedTools: [], validationPassed: true, escalated: true };
describe("controlled candidate evaluation", () => {
  it("records only completed successful evaluations", async () => {
    expect(await evaluateCandidate(candidate, corpus, { run: async () => valid })).toMatchObject({ passed: 1, total: 1 });
  });
  it.each([{ businessId: "tenant-b" }, { sourceVersionId: "draft-b" }, { executedTools: ["refund"] }, { validationPassed: false }, { reply: "Refund approved. review" }, { escalated: false }])("rejects unsafe result %j", async patch => {
    expect((await evaluateCandidate(candidate, corpus, { run: async () => ({ ...valid, ...patch }) })).passed).toBe(0);
  });
  it("counts exceptions as failures and continues the corpus", async () => {
    const runner: CandidateRunner = { run: async () => { throw new Error("provider unavailable"); } };
    expect(await evaluateCandidate(candidate, corpus, runner)).toMatchObject({ passed: 0, total: 1 });
  });
  it("refuses empty evaluation evidence", async () => {
    await expect(evaluateCandidate(candidate, [], { run: async () => valid })).rejects.toThrow("Invalid evaluation corpus");
  });
});
it("summarizes outcome evidence without copying transcript or customer fields", async () => {
  const { summarizeOutcomes } = await import("@halo/learning/analysis");
  expect(summarizeOutcomes([{ disposition: "qualified", escalated: false, do_not_call: false },
    { disposition: "do_not_call", escalated: true, do_not_call: true }])).toEqual({ conversations: 2,
      dispositions: { qualified: 1, do_not_call: 1 }, escalated: 1, suppressed: 1 });
});
