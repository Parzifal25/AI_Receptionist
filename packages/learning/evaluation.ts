import { z } from "zod";
import type { AgentConfig } from "@halo/core/domain/agents";

export const evaluationCaseSchema = z.object({
  id: z.string().min(1).max(100), input: z.string().min(1).max(4000),
  expected: z.object({ requiredText: z.array(z.string().min(1).max(200)).max(20).default([]),
    forbiddenText: z.array(z.string().min(1).max(200)).max(20).default([]),
    allowedTools: z.array(z.string().min(1).max(100)).max(32).default([]),
    requireEscalation: z.boolean().optional() }),
});
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export interface Candidate {
  businessId: string; sourceVersionId: string; config: AgentConfig; prompt: string;
}
export interface CandidateRun {
  businessId: string; sourceVersionId: string; reply: string; executedTools: string[];
  validationPassed: boolean; escalated: boolean;
}
/** The runner must sandbox side effects (CRM/dial/email) while exercising
 * HALO's runtime and validator. Never evaluate candidates in live sessions. */
export interface CandidateRunner { run(candidate: Candidate, test: EvaluationCase): Promise<CandidateRun>; }
export async function evaluateCandidate(candidate: Candidate, corpus: readonly EvaluationCase[], runner: CandidateRunner) {
  if (!corpus.length || corpus.length > 200 || new Set(corpus.map(c => c.id)).size !== corpus.length) throw new Error("Invalid evaluation corpus");
  const cases = corpus.map(c => evaluationCaseSchema.parse(c));
  const results: Array<{ id: string; passed: boolean; reason: string }> = [];
  for (const test of cases) {
    try {
      const result = await runner.run(candidate, test);
      const reply = result.reply.normalize("NFKC").toLocaleLowerCase();
      const normalize = (s: string) => s.normalize("NFKC").toLocaleLowerCase();
      const passed = result.businessId === candidate.businessId && result.sourceVersionId === candidate.sourceVersionId &&
        result.validationPassed && Boolean(reply.trim()) && result.executedTools.every(t => test.expected.allowedTools.includes(t)) &&
        test.expected.requiredText.every(t => reply.includes(normalize(t))) && !test.expected.forbiddenText.some(t => reply.includes(normalize(t))) &&
        (test.expected.requireEscalation === undefined || result.escalated === test.expected.requireEscalation);
      results.push({ id: test.id, passed, reason: passed ? "passed" : "expectation_failed" });
    } catch { results.push({ id: test.id, passed: false, reason: "runtime_failed" }); }
  }
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
