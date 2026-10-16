/** W4.5: actual runtime/cache/queue, injected write latency, no provider calls. */
import { performance } from "node:perf_hooks";
import { FakeConversationStore, makeInput, makeRuntime } from "../tests/mocks/runtime-fakes";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { CallContextCache } from "@halo/voice/call-context-cache";
import { OrderedVoicePersistence } from "@halo/voice/ordered-persistence";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function sample(deferred: boolean) {
  const store = new FakeConversationStore(); const states = new InMemoryConversationStateStore();
  const append = store.appendMessages.bind(store), save = states.save.bind(states);
  store.appendMessages = async (...args) => { await sleep(20); return append(...args); };
  states.save = async (...args) => { await sleep(20); return save(...args); };
  const queue = new OrderedVoicePersistence(); const input = makeInput();
  const cache = new CallContextCache(input.trusted.businessId, input.trusted.conversationId, store, states, 40, deferred ? queue : undefined);
  const { runtime } = makeRuntime({ conversations: cache, stateStore: cache });
  const start = performance.now(); await runtime.run(input); const replyMs = performance.now() - start;
  await queue.close();
  return replyMs;
}
async function main() {
  const results: Record<string, unknown> = {};
  for (const deferred of [false, true]) {
    await sample(deferred); await sample(deferred);
    const values: number[] = [];
    for (let i = 0; i < 10; i++) values.push(await sample(deferred));
    values.sort((a, b) => a - b);
    results[deferred ? "queuedAdmission" : "awaitedWrites"] = { n: 10, p50: values[4], p95: values[8], max: values[9] };
  }
  console.log(JSON.stringify({ evidence: "local test, actual runtime, two sequential 20ms writes, 10 samples per mode after two warmups; queued reply is not durability", results }, null, 2));
}
void main();
