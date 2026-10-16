import { expect, it, vi } from "vitest";
import { CallContextCache } from "@halo/voice/call-context-cache";
import { emptyConversationState, InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { FakeConversationStore, makeInput, makeRuntime } from "../../mocks/runtime-fakes";

it("starts state and history reads independently and observes both failures safely", async () => {
  let finish!: () => void;
  const stateStore = new InMemoryConversationStateStore();
  stateStore.load = vi.fn(() => new Promise<null>((resolve) => { finish = () => resolve(null); }));
  const conversations = new FakeConversationStore();
  const history = vi.spyOn(conversations, "loadHistory");
  const { runtime } = makeRuntime({ stateStore, conversations });
  const result = runtime.run(makeInput());
  await new Promise((resolve) => setImmediate(resolve));
  expect(history).toHaveBeenCalledTimes(1);
  finish();
  await result;
});

it("reuses only this call's successful bounded history/state, with no object aliasing", async () => {
  const store = new FakeConversationStore();
  const states = new InMemoryConversationStateStore();
  const history = vi.spyOn(store, "loadHistory");
  const load = vi.spyOn(states, "load");
  store.seed("c", "t", [{ role: "user", content: "first" }]);
  const cache = new CallContextCache("t", "c", store, states, 2);
  (await cache.loadHistory("c", "t", 2))[0].content = "forged";
  await cache.load("c", "t");
  await cache.save("c", "t", emptyConversationState());
  const local = await cache.load("c", "t");
  local!.turnCount = 50;
  expect((await cache.load("c", "t"))!.turnCount).toBe(0);
  await cache.appendMessages("c", "t", [{ role: "assistant", content: "second" }, { role: "user", content: "third" }]);
  expect((await cache.loadHistory("c", "t", 2)).map((m) => m.content)).toEqual(["second", "third"]);
  expect(history).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1);
  await expect(cache.loadHistory("c", "other", 2)).rejects.toThrow("scope mismatch");
  await expect(cache.save("other", "t", emptyConversationState())).rejects.toThrow("scope mismatch");
  expect(history).toHaveBeenCalledTimes(1);
});

it("invalidates a failed or ambiguous write rather than caching fictitious durable success", async () => {
  const store = new FakeConversationStore();
  const states = new InMemoryConversationStateStore();
  const history = vi.spyOn(store, "loadHistory");
  const load = vi.spyOn(states, "load");
  const cache = new CallContextCache("t", "c", store, states, 2);
  await cache.loadHistory("c", "t", 2); await cache.load("c", "t");
  store.failAppend = true;
  await expect(cache.appendMessages("c", "t", [{ role: "user", content: "not committed" }])).rejects.toThrow();
  store.failAppend = false;
  expect(await cache.loadHistory("c", "t", 2)).toEqual([]);
  states.save = async () => { throw new Error("synthetic failure"); };
  await expect(cache.save("c", "t", emptyConversationState())).rejects.toThrow();
  await cache.load("c", "t");
  expect(history).toHaveBeenCalledTimes(2); expect(load).toHaveBeenCalledTimes(2);
});

it("an exhausted turn budget does not wait for a hung parallel history read", async () => {
  const stateStore = new InMemoryConversationStateStore();
  const state = emptyConversationState(); state.turnCount = 1;
  stateStore.load = async () => state;
  const conversations = new FakeConversationStore();
  conversations.loadHistory = () => new Promise(() => {});
  const input = makeInput(); input.agent.config.budgets = { ...input.agent.config.budgets, maxTurns: 1 };
  const { runtime } = makeRuntime({ stateStore, conversations });
  await expect(runtime.run(input)).rejects.toThrow("budget exhausted");
});


it("a late timed-out state read cannot overwrite newer call-owned state", async () => {
  const store = new FakeConversationStore();
  const states = new InMemoryConversationStateStore();
  let finish!: (state: ReturnType<typeof emptyConversationState>) => void;
  states.load = () => new Promise((resolve) => { finish = resolve; });
  const cache = new CallContextCache("t", "c", store, states, 2);
  const pending = cache.load("c", "t");
  const latest = emptyConversationState(); latest.turnCount = 3;
  await cache.save("c", "t", latest);
  finish(emptyConversationState());
  expect((await pending)!.turnCount).toBe(3);
  expect((await cache.load("c", "t"))!.turnCount).toBe(3);
});
