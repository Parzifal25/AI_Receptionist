import { expect, it, vi } from "vitest";
import { PhoneTurnHandler, INTERRUPTED_MARKER } from "@halo/voice/phone-channel-adapter";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { FakeConversationStore, emptyKnowledgeProvider, makeAgent, reply, ScriptedLLM } from "../mocks/runtime-fakes";

it("returns a validated reply without waiting for storage, preserves heard-only next-turn context and drains in order", async () => {
  const store = new FakeConversationStore();
  const append = store.appendMessages.bind(store);
  let release!: () => void;
  let first = true;
  store.appendMessages = (...args) => {
    if (!first) return append(...args);
    first = false;
    return new Promise<void>((resolve) => { release = () => { void append(...args).then(resolve); }; });
  };
  const llm = new ScriptedLLM([reply("First sentence. Second sentence."), reply("Okay.")]);
  const phone = new PhoneTurnHandler({ agent: makeAgent(), conversationId: "conv-1", store, stateStore: new InMemoryConversationStateStore(), llm, knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()), liveHandoffAvailable: false });
  const request = { utterance: "hello", language: "en-IN", sttConfidence: .9, turnIndex: 0, signal: new AbortController().signal };
  const result = await phone.handleTurn(request);
  expect(result.reply).toBe("First sentence. Second sentence.");
  expect(store.messages.size).toBe(0);
  await phone.recordDelivery(result.turnId, { status: "interrupted", deliveredText: "First sentence." });
  await phone.handleTurn({ ...request, utterance: "continue", turnIndex: 1 });
  const context = llm.calls[1].messages.map((m) => "content" in m ? m.content : "").join(" ");
  expect(context).toContain(`First sentence. ${INTERRUPTED_MARKER}`);
  expect(context).not.toContain("Second sentence.");
  release(); await phone.close();
  expect(store.messages.get("conv-1")?.map((m) => m.content)).toEqual(["hello", `First sentence. ${INTERRUPTED_MARKER}`, "continue", "[not heard by caller]"]);
});

it("storage exceptions never fail the call or produce automatic write replay", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const store = new FakeConversationStore(); store.failAppend = true;
    const append = vi.spyOn(store, "appendMessages");
    const phone = new PhoneTurnHandler({ agent: makeAgent(), conversationId: "conv-1", store, stateStore: new InMemoryConversationStateStore(), llm: new ScriptedLLM([reply("Hello.")]), knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()), liveHandoffAvailable: false });
    const result = await phone.handleTurn({ utterance: "hello", language: "en-IN", sttConfidence: null, turnIndex: 0, signal: new AbortController().signal });
    expect(result.reply).toBe("Hello.");
    await phone.recordDelivery(result.turnId, { status: "complete", deliveredText: result.reply });
    await phone.close();
    expect(append).toHaveBeenCalledTimes(2); // caller + confirmed assistant; no retries
  } finally { vi.restoreAllMocks(); }
});
