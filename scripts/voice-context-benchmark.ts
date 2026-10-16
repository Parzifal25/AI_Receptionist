/** W4.4: actual runtime with injected storage latency; no provider calls. */
import { performance } from "node:perf_hooks";
import { makeInput, makeRuntime, FakeConversationStore } from "../tests/mocks/runtime-fakes";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { CallContextCache } from "@halo/voice/call-context-cache";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const summarize = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { n: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted[Math.floor((sorted.length - 1) * .95)], max: sorted.at(-1) };
};
async function measure(serial: boolean, reuse: boolean): Promise<number> {
  const conversations = new FakeConversationStore();
  const states = new InMemoryConversationStateStore();
  const input = makeInput();
  let stateReady = Promise.resolve();
  const loadState = states.load.bind(states);
  states.load = (...args) => {
    const result = (async () => { await sleep(20); return loadState(...args); })();
    stateReady = result.then(() => {});
    return result;
  };
  const loadHistory = conversations.loadHistory.bind(conversations);
  conversations.loadHistory = async (...args) => {
    if (serial) await stateReady;
    await sleep(20);
    return loadHistory(...args);
  };
  const cache = new CallContextCache(input.trusted.businessId, input.trusted.conversationId, conversations, states, 40);
  if (reuse) {
    await cache.load(input.trusted.conversationId, input.trusted.businessId);
    await cache.loadHistory(input.trusted.conversationId, input.trusted.businessId, 40);
  }
  const { runtime } = makeRuntime({ conversations: cache, stateStore: cache });
  const start = performance.now();
  await runtime.run(input);
  return performance.now() - start;
}
async function main() {
  const results: Record<string, ReturnType<typeof summarize>> = {};
  for (const [mode, serial, reuse] of [["serialReadControl", true, false], ["parallelReads", false, false], ["callReuse", false, true]] as const) {
    await measure(serial, reuse); await measure(serial, reuse); // discard warm-up
    const samples: number[] = [];
    for (let n = 0; n < 10; n++) samples.push(await measure(serial, reuse));
    results[mode] = summarize(samples);
  }
  console.log(JSON.stringify({ evidence: "local test, actual runtime, 20ms per storage read, 10 sequential samples per mode after two warm-ups; serial control models the former dependency", results }, null, 2));
}
void main();
