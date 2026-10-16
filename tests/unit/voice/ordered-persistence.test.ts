import { afterEach, expect, it, vi } from "vitest";
import { OrderedVoicePersistence } from "@halo/voice/ordered-persistence";
import { CallContextCache } from "@halo/voice/call-context-cache";
import { emptyConversationState, InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { FakeConversationStore } from "../../mocks/runtime-fakes";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("admits immediately but serializes writes, contains ambiguous failures and never retries", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const queue = new OrderedVoicePersistence();
  const order: string[] = [];
  let release!: () => void;
  queue.enqueue("messages", () => new Promise<void>((resolve) => { order.push("caller"); release = resolve; }));
  queue.enqueue("state", async () => { order.push("state"); throw new Error("synthetic-private-text"); });
  queue.enqueue("messages", async () => { order.push("heard prefix"); });
  await new Promise((resolve) => setImmediate(resolve));
  expect(order).toEqual(["caller"]); expect(queue.status().pending).toBe(3);
  release();
  expect(await queue.close()).toBe(true);
  expect(order).toEqual(["caller", "state", "heard prefix"]);
  expect(queue.status()).toEqual({ pending: 0, failures: 1 });
  expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private-text");
});

it("bounds queued work and close time without overtaking or retrying a hung write", async () => {
  vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {});
  const queue = new OrderedVoicePersistence(1);
  let release!: () => void;
  const second = vi.fn(async () => {});
  expect(queue.enqueue("messages", () => new Promise<void>((resolve) => { release = resolve; }))).toBe(true);
  expect(queue.enqueue("state", second)).toBe(false);
  await Promise.resolve();
  const close = queue.close(100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await close).toBe(false); expect(second).not.toHaveBeenCalled();
  expect(queue.enqueue("state", second)).toBe(false);
  release(); await vi.advanceTimersByTimeAsync(1);
  expect(queue.status().pending).toBe(0);
  expect(queue.close()).toBe(close);
});

it("local queued history and state stay scoped and cloned while durable storage is delayed", async () => {
  const store = new FakeConversationStore(); const states = new InMemoryConversationStateStore();
  const queue = new OrderedVoicePersistence();
  const cache = new CallContextCache("t", "c", store, states, 2, queue);
  await cache.loadHistory("c", "t", 2); await cache.load("c", "t");
  let release!: () => void;
  const append = store.appendMessages.bind(store);
  store.appendMessages = (...args) => new Promise<void>((resolve) => { release = () => { void append(...args).then(resolve); }; });
  const messages = [{ role: "user" as const, content: "actual caller" }];
  await cache.appendMessages("c", "t", messages); messages[0].content = "forged";
  const state = emptyConversationState(); state.turnCount = 3;
  await cache.save("c", "t", state); state.turnCount = 200;
  expect((await cache.loadHistory("c", "t", 2))[0].content).toBe("actual caller");
  expect((await cache.load("c", "t"))!.turnCount).toBe(3);
  expect(store.messages.size).toBe(0); expect(await states.load("c", "t")).toBeNull();
  await expect(cache.appendMessages("c", "other", [])).rejects.toThrow("scope mismatch");
  release(); expect(await queue.close()).toBe(true);
  expect(store.messages.get("c")![0].content).toBe("actual caller");
  expect((await states.load("c", "t"))!.turnCount).toBe(3);
});
