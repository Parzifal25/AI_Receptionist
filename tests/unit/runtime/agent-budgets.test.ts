import { defaultAgentConfig } from "@halo/core/domain/agents";
import { it, expect } from "vitest";
import { makeAgent, makeInput, makeRuntime, ScriptedLLM, reply } from "../../mocks/runtime-fakes";
import { emptyConversationState } from "@halo/runtime/conversation-state";
it("stops before model or tools when a persisted turn budget is exhausted", async () => {
  const llm = new ScriptedLLM([reply("Hello there.")]);
  const harness = makeRuntime({ llm });
  const input = makeInput({ agent: makeAgent({ config: { ...defaultAgentConfig(), budgets: { maxTurns: 1 } } }) });
  await harness.stateStore.save(input.trusted.conversationId, input.trusted.businessId, { ...emptyConversationState(), turnCount: 1 });
  await expect(harness.runtime.run(input)).rejects.toThrow("turn budget");
  expect(llm.calls).toHaveLength(0);
});
it("limits the provider output allowance from the agent version", async () => {
  const llm = new ScriptedLLM([reply("Hello there.")]);
  const harness = makeRuntime({ llm });
  await harness.runtime.run(makeInput({ agent: makeAgent({ config: { ...defaultAgentConfig(), budgets: { maxOutputTokens: 100 } } }) }));
  expect(llm.calls[0].options.maxTokens).toBe(100);
});
it("rejects a fixed safety prompt that cannot fit the configured budget", async () => {
  const llm = new ScriptedLLM([reply("Hello there.")]);
  const harness = makeRuntime({ llm });
  await expect(harness.runtime.run(makeInput({ agent: makeAgent({ promptTemplate: "Required safety policy. ".repeat(500),
    config: { ...defaultAgentConfig(), budgets: { maxInputTokens: 256 } } }) }))).rejects.toThrow("safety context");
  expect(llm.calls).toHaveLength(0);
});
