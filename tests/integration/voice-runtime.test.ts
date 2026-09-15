import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { CollectingEventSink } from "@halo/runtime/events";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import type { SystemActionProvider } from "@halo/runtime/system-actions";
import {
  CONVERSATION_CLOSED_STEP,
  DeferredAssistantStore,
  INTERRUPTED_MARKER,
  NOT_HEARD_MARKER,
  PhoneTurnHandler,
  type VoiceTurnSignals,
} from "@halo/voice/phone-channel-adapter";
import { emptyKnowledgeProvider, FakeConversationStore, makeAgent, reply, ScriptedLLM, type ScriptStep } from "../mocks/runtime-fakes";
import { buildSession } from "../mocks/voice-harness";

/**
 * Phase 3 — the media loop driving the REAL Agent Runtime through the phone
 * channel adapter. Scripted model, in-memory stores, fake STT/TTS, fake
 * timers. Verifies transcript truthfulness, cancellation and directives.
 */

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function phoneCall(opts: {
  script: ScriptStep[];
  liveHandoff?: boolean;
  grantHandoff?: boolean;
  systemActions?: (signals: () => VoiceTurnSignals) => SystemActionProvider[];
}) {
  const llm = new ScriptedLLM(opts.script);
  const store = new FakeConversationStore();
  const sink = new CollectingEventSink();
  const agent = makeAgent();
  if (opts.grantHandoff) agent.config.tools.grantedToolIds = ["request_human_handoff"];
  const handler = new PhoneTurnHandler({
    agent,
    conversationId: "conv-1",
    store,
    llm,
    knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()),
    stateStore: new InMemoryConversationStateStore(),
    events: sink,
    liveHandoffAvailable: opts.liveHandoff ?? false,
    systemActions: opts.systemActions,
  });
  // The harness types its handler as ScriptedTurnHandler; the session only needs the interface.
  const h = buildSession({ handler: handler as never });
  return { ...h, llm, store, sink, phone: handler };
}

describe("voice session × agent runtime (phone channel)", () => {
  it("runs turns on the phone-voice profile and persists a complete transcript", async () => {
    const c = phoneCall({ script: [reply("Happy to help. May I know your name?")] });
    c.session.start();
    await c.settle(2_000);
    await c.caller.say("I need rooftop panels");
    await c.settle(4_000);
    expect(c.llm.calls[0].systemPrompt).toMatch(/live phone call/);
    expect(c.store.messages.get("conv-1")).toEqual([
      { role: "user", content: "I need rooftop panels" },
      { role: "assistant", content: "Happy to help. May I know your name?" },
    ]);
    expect(c.sink.events.find((e) => e.type === "runtime.started")?.data.channel).toBe("phone-voice");
  });

  it("stores only what the caller heard when they barge in, and the model sees it next turn", async () => {
    const c = phoneCall({
      script: [reply("First we check your roof. Then we look at the bill and the sanctioned load. Then we plan a visit."), reply("Sure, go ahead.")],
    });
    c.session.start();
    await c.settle(2_000);
    await c.caller.say("what happens next");
    await c.caller.silence(900);
    await c.caller.speak(300);
    c.stt.current.final("wait a second");
    await c.caller.silence(600);
    await c.settle(3_000);
    const rows = c.store.messages.get("conv-1")!;
    expect(rows[1]).toEqual({ role: "assistant", content: `First we check your roof. ${INTERRUPTED_MARKER}` });
    const secondCall = c.llm.calls[1];
    expect(secondCall.messages.some((m) => m.content === `First we check your roof. ${INTERRUPTED_MARKER}`)).toBe(true);
  });

  it("cancels an in-flight model call on barge-in, persists nothing and merges the utterances", async () => {
    const slow: ScriptStep = () => new Promise((resolve) => setTimeout(() => resolve(reply("too late")), 5_000));
    const c = phoneCall({ script: [slow, reply("Got it, three thousand.")] });
    c.session.start();
    await c.settle(2_000);
    await c.caller.say("my bill is");
    await c.caller.say("three thousand");
    await c.settle(3_000);
    expect(c.llm.calls).toHaveLength(2);
    expect(c.llm.calls[1].messages.at(-1)).toEqual({ role: "user", content: "my bill is three thousand" });
    expect(c.store.messages.get("conv-1")).toEqual([
      { role: "user", content: "my bill is three thousand" },
      { role: "assistant", content: "Got it, three thousand." },
    ]);
    expect(c.sink.events.map((e) => e.type)).toContain("runtime.cancelled");
  });

  it("transfers once when the caller asks for a person and a live handoff is configured", async () => {
    const c = phoneCall({
      grantHandoff: true,
      liveHandoff: true,
      script: [
        reply("", { toolCalls: [{ id: "t1", name: "request_human_handoff", arguments: { reason: "wants a person" } }] }),
        reply("Of course, I'm connecting you now."),
      ],
    });
    c.session.start();
    await c.settle(2_000);
    await c.caller.say("please let me talk to a person");
    await c.settle(6_000);
    expect(c.transferReasons).toEqual(["explicit_human_request"]);
    expect(c.ended[0]).toMatchObject({ endReason: "transferred" });
  });

  it("without a live handoff the model may not claim a transfer and the call continues", async () => {
    const c = phoneCall({
      grantHandoff: true,
      liveHandoff: false,
      script: [
        reply("", { toolCalls: [{ id: "t1", name: "request_human_handoff", arguments: { reason: "wants a person" } }] }),
        reply("I'm connecting you now."),
        reply("Sorry — nobody is free right now; the team will call you back."),
      ],
    });
    c.session.start();
    await c.settle(2_000);
    await c.caller.say("please let me talk to a person");
    await c.settle(6_000);
    expect(c.transferReasons).toEqual([]);
    const spoken = c.tts.requests.map((r) => r.text);
    expect(spoken.join(" ")).not.toContain("I'm connecting you now");
    expect(c.session.getState()).toBe("listening");
  });

  it("ends the call when conversation state closes, and exposes STT signals to system actions", async () => {
    const seen: VoiceTurnSignals[] = [];
    const closer: SystemActionProvider = {
      name: "closer",
      async prepare() {
        return { sections: ["The conversation is complete; say goodbye."], actions: [], statePatch: { workflowStep: CONVERSATION_CLOSED_STEP } };
      },
    };
    const c = phoneCall({
      script: [reply("Thank you for your time. Goodbye.")],
      systemActions: (signals) => [
        { name: "observer", async prepare() { seen.push(signals()); return null; } },
        closer,
      ],
    });
    c.session.start();
    await c.settle(2_000);
    await c.caller.say("no thanks", { confidence: 0.61, language: "te-IN" });
    await c.settle(4_000);
    expect(seen[0]).toMatchObject({ sttConfidence: 0.61, language: "te-IN", turnIndex: 0 });
    expect(c.ended[0].endReason).toBe("agent_completed");
  });
});

describe("DeferredAssistantStore", () => {
  it("writes caller rows now and the assistant row only on delivery, in order", async () => {
    const inner = new FakeConversationStore();
    const store = new DeferredAssistantStore(inner);
    await store.appendMessages("c", "b", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello there" }]);
    expect(inner.messages.get("c")).toEqual([{ role: "user", content: "hi" }]);
    store.bindPending("turn-1");
    await store.resolve("turn-other", "complete", "");
    expect(inner.messages.get("c")).toHaveLength(1);
    await store.resolve("turn-1", "not_delivered", "");
    expect(inner.messages.get("c")![1]).toEqual({ role: "assistant", content: NOT_HEARD_MARKER });
  });
});
