import { describe, it, expect } from "vitest";
import { GENERIC_TENANTS } from "../golden/generic/tenants";
import { makeRuntime, makeInput, makeAgent, makeTrusted, BUSINESS_A, ScriptedLLM, reply } from "../mocks/runtime-fakes";

describe("generic multi-industry golden conversations (scripted model)", () => {
  for (const tenant of GENERIC_TENANTS) {
    it(`${tenant.id}: uses only this tenant's version, knowledge and capabilities`, async () => {
      const llm = new ScriptedLLM([call => {
        expect(call.systemPrompt).toContain(tenant.name);
        expect(call.systemPrompt).toContain(tenant.knowledge);
        for (const other of GENERIC_TENANTS.filter(t => t.id !== tenant.id)) expect(call.systemPrompt).not.toContain(other.name);
        return reply(tenant.answer);
      }]);
      const { runtime, sink } = makeRuntime({ llm, knowledge: { name: "tenant-fixture", resolve: async params => {
        expect(params.businessId).toBe(tenant.id);
        expect(params.collectionIds).toEqual([`${tenant.id}-knowledge`]);
        return { snippets: [{ refId: `${tenant.id}-fact`, title: "tenant handbook", content: tenant.knowledge, source: "faq", score: 1 }],
          sources: ["tenant handbook"], charsUsed: tenant.knowledge.length, truncated: false, query: params.userMessage };
      } } });
      const output = await runtime.run(makeInput({ userMessage: tenant.question,
        trusted: makeTrusted({ businessId: tenant.id, conversationId: `${tenant.id}-conversation`, agentVersionId: `${tenant.id}-version` }),
        agent: makeAgent({ business: { ...BUSINESS_A, id: tenant.id, name: tenant.name },
          agentVersionId: `${tenant.id}-version`, promptTemplate: `You are the assistant for ${tenant.name}.`, config: tenant.config }),
      }));
      expect(output.reply).toBe(tenant.answer);
      expect(output.degraded.provider).toBe(false);
      expect(sink.events.every(e => e.businessId === tenant.id && e.agentVersionId === `${tenant.id}-version`)).toBe(true);
    });
  }
});

// Candidate evaluation exercises the same runtime without production stores or
// side-effect adapters. Failures never become evidence for a production rollout.
describe("candidate evaluation through the real HALO runtime", () => {
  it("evaluates independently scoped tenant candidates", async () => {
    const { evaluateCandidate } = await import("@halo/learning/evaluation");
    for (const tenant of GENERIC_TENANTS) {
      const candidate = { businessId: tenant.id, sourceVersionId: `${tenant.id}-version`, config: tenant.config, prompt: `You serve ${tenant.name}.` };
      const result = await evaluateCandidate(candidate, [{ id: "tenant-answer", input: tenant.question,
        expected: { requiredText: [tenant.answer], forbiddenText: GENERIC_TENANTS.filter(t => t.id !== tenant.id).map(t => t.name), allowedTools: [] } }], {
        run: async (draft, test) => {
          const { runtime } = makeRuntime({ llm: new ScriptedLLM([reply(tenant.answer)]) });
          const output = await runtime.run(makeInput({ userMessage: test.input,
            trusted: makeTrusted({ businessId: draft.businessId, conversationId: `evaluation-${tenant.id}`, agentVersionId: draft.sourceVersionId }),
            agent: makeAgent({ business: { ...BUSINESS_A, id: draft.businessId, name: tenant.name }, agentVersionId: draft.sourceVersionId,
              promptTemplate: draft.prompt, config: draft.config }) }));
          return { businessId: draft.businessId, sourceVersionId: draft.sourceVersionId, reply: output.reply,
            executedTools: output.toolResults.map(t => t.name), validationPassed: output.validation.ok,
            escalated: output.escalation.escalate };
        },
      });
      expect(result).toMatchObject({ passed: 1, total: 1 });
    }
  });
});
