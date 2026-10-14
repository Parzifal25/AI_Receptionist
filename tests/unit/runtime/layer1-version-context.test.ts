import { describe, expect, it } from "vitest";
import { buildConversationContext } from "@halo/runtime/context-builder";
import { emptyConversationState } from "@halo/runtime/conversation-state";
import { emptyKnowledge } from "@halo/runtime/knowledge-resolver";
import { WEB_CHAT_PROFILE } from "@halo/runtime/channel-profile";
import { makeAgent, makeInput, makeRuntime, makeTrusted, reply, ScriptedLLM } from "../../mocks/runtime-fakes";

describe("Layer 1 pinned runtime identity", () => {
  it("never restores mutable receptionist name, language or instructions", () => {
    const agent = makeAgent();
    agent.config.identity.name = "Pinned assistant";
    agent.config.language.primary = "te-IN";
    agent.config.instructions.customInstructions = "";
    const build = () => buildConversationContext({ agent, trusted: makeTrusted(), channel: WEB_CHAT_PROFILE, state: emptyConversationState(), history: [], knowledge: emptyKnowledge(), tools: [], systemSections: [], verifiedActions: [] }).agent;
    const before = build();
    agent.receptionist = { ...agent.receptionist, name: "Mutable replacement", language: "en", customInstructions: "MUTABLE SECRET INSTRUCTIONS", leadCaptureEnabled: true };
    expect(build()).toEqual(before);
    expect(build()).toMatchObject({ name: "Pinned assistant", language: "te-IN", customInstructions: "", leadCaptureEnabled: false });
  });

  it.each(["identity", "configuration", "business approval", "collection"])('rejects missing or invalid %s before model or transcript writes', async (kind) => {
    const llm = new ScriptedLLM([reply("Must not be reached")]);
    const harness = makeRuntime({ llm });
    const input = makeInput();
    if (kind === "identity") input.trusted.agentVersionId = "";
    if (kind === "configuration") input.agent.config.objective = "";
    if (kind === "business approval") input.agent.config.activationBlockers = ["Pending approval"];
    if (kind === "collection") input.agent.config.knowledge.collectionIds = ["foreign"];
    await expect(harness.runtime.run(input)).rejects.toThrow();
    expect(llm.calls).toHaveLength(0);
    expect(harness.conversations.messages.size).toBe(0);
  });
});
