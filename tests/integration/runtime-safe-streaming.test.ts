import { describe, expect, it } from "vitest";
import { AppError } from "@halo/core/errors/app-error";
import { FallbackLLMRouter } from "@halo/providers/llm/fallback-router";
import { PHONE_VOICE_PROFILE } from "@halo/runtime/channel-profile";
import { isRuntimeCancelled } from "@halo/runtime/cancellation";
import type { RuntimeEvent, RuntimeEventSink, SpeechStreamEvent } from "@halo/runtime/contracts";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { BUILTIN_TOOLS, ToolRegistry, type AnyToolExecutor } from "@halo/runtime/tools/registry";
import { ARUNODHAYA_CLAIM_PHRASES } from "@/content/tenants/arunodhaya/agent";
import {
  FakeConversationStore,
  makeAgent,
  makeInput,
  makeRuntime,
  StreamingLLM,
  type StreamStep,
} from "../mocks/runtime-fakes";

/**
 * HALO Phase 4.5 Sprint 3 — safe LLM streaming through the REAL Agent
 * Runtime, response validator and tool boundary. Only the model is fake.
 *
 * Every test records ONE ordered timeline of what the caller could hear
 * ("heard:"), what was prepared but not heard ("held:"), releases,
 * retractions, tool executions and runtime events, so ordering properties
 * are asserted directly rather than inferred.
 */

type Timeline = string[];

function harness(opts: {
  script: Array<StreamStep | Error>;
  tools?: string[];
  executors?: Partial<Record<string, AnyToolExecutor>>;
  phrases?: boolean;
  llm?: ConstructorParameters<typeof StreamingLLM>[1];
  stateStore?: InMemoryConversationStateStore;
}) {
  const timeline: Timeline = [];
  const llm = new StreamingLLM(opts.script, opts.llm);
  const events: RuntimeEventSink = { emit: (e: RuntimeEvent) => timeline.push(`event:${e.type}`) };
  const executors: Record<string, AnyToolExecutor> = {};
  for (const [name, executor] of Object.entries(opts.executors ?? {})) {
    executors[name] = async (args, ctx) => {
      timeline.push(`tool:${name}`);
      return executor!(args, ctx);
    };
  }
  const conversations = new FakeConversationStore();
  const { runtime } = makeRuntime({
    llm,
    conversations,
    events,
    registry: new ToolRegistry(BUILTIN_TOOLS, executors),
    // The phone channel's policy: one tool round, then a narration round
    // that is offered no tools (phone-channel-adapter.ts).
    policy: { maxToolRounds: 1 },
    ...(opts.stateStore ? { stateStore: opts.stateStore } : {}),
  });
  const agent = makeAgent();
  agent.config.tools.grantedToolIds = opts.tools ?? [];
  if (opts.phrases) agent.config.guardrails.actionClaimPhrases = ARUNODHAYA_CLAIM_PHRASES as never;
  const speech = (e: SpeechStreamEvent) => {
    if (e.type === "segment") timeline.push(`${e.held ? "held" : "heard"}:${e.text}`);
    else timeline.push(e.type === "retract" ? `retract:${e.reason}` : "release");
  };
  const run = (userMessage = "hello", extra: Partial<Parameters<typeof makeInput>[0]> = {}) =>
    runtime.run(makeInput({ agent, channel: PHONE_VOICE_PROFILE, userMessage, speech, ...extra }));
  const heard = () => timeline.filter((t) => t.startsWith("heard:") || t === "release");
  const audible = (): string[] => {
    // What the caller can hear: heard segments, plus held ones once released.
    const out: string[] = [];
    let pending: string[] = [];
    for (const t of timeline) {
      if (t.startsWith("heard:")) out.push(t.slice(6));
      else if (t.startsWith("held:")) pending.push(t.slice(5));
      else if (t === "release") {
        out.push(...pending);
        pending = [];
      }
      else if (t.startsWith("retract:")) pending = [];
    }
    return out;
  };
  return { timeline, llm, conversations, run, heard, audible };
}

const handoff: AnyToolExecutor = async () => ({ ok: true, summary: "Recorded for a callback.", claimsPermitted: [] });
const concession: AnyToolExecutor = async () => ({ ok: true, summary: "Authorized.", claimsPermitted: ["concession.offered"] });

describe("safe streaming — live release (a round offered no tools)", () => {
  it("speaks validated sentences while the model is still generating, and the reply is exactly what was heard", async () => {
    const h = harness({ script: [{ content: "Sure, I can help with that today. What is your monthly electricity bill, roughly?" }] });
    const output = await h.run();
    const firstHeard = h.timeline.findIndex((t) => t.startsWith("heard:"));
    expect(firstHeard).toBeGreaterThanOrEqual(0);
    expect(firstHeard).toBeLessThan(h.timeline.indexOf("event:model.completed"));
    expect(h.audible()).toEqual(["Sure, I can help with that today.", "What is your monthly electricity bill, roughly?"]);
    expect(output.reply).toBe(h.audible().join(" "));
    expect(output.speech).toMatchObject({ attempted: true, streamed: true, fallbackReason: null, segmentsReleased: 2, truncated: false });
    expect(output.speech!.firstSegmentMs).not.toBeNull();
    expect(h.conversations.messages.get("conv-1")!.at(-1)!.content).toBe(output.reply);
  });

  it("never lets an unauthorized promise be heard; falls back to the complete path when nothing was heard", async () => {
    const h = harness({
      phrases: true,
      script: [
        { content: "Sure, we can give you ₹20,000 discount. Shall I note your name?" },
        { content: "I cannot promise a discount, but the team can review your case. May I have your name?" },
      ],
    });
    const output = await h.run("₹20,000 discount ఇస్తారా?");
    expect(h.heard()).toEqual([]);
    expect(output.speech).toMatchObject({ streamed: false, fallbackReason: "segment_rejected" });
    // The complete path's repair ladder took over, exactly as in baseline.
    expect(output.validation.regenerated).toBe(true);
    expect(output.reply).not.toMatch(/₹20,000 discount/);
    expect(h.llm.calls).toHaveLength(1);
  });

  it("truncates to the heard prefix when a later sentence is rejected, and never repeats or speaks it", async () => {
    const h = harness({
      phrases: true,
      script: [{ content: "Thank you for sharing your bill amount with me. అవును, ₹20,000 off ఇస్తాం. Book cheddama?" }],
    });
    const output = await h.run();
    expect(h.audible()).toEqual(["Thank you for sharing your bill amount with me."]);
    expect(output.reply).toBe("Thank you for sharing your bill amount with me.");
    expect(output.speech).toMatchObject({ streamed: true, truncated: true, fallbackReason: "segment_rejected" });
    expect(output.validation.violations.map((v) => v.kind)).toContain("unsupported_action_claim");
    expect(JSON.stringify(h.timeline)).not.toContain("ఇస్తాం");
  });

  it("caps the running reply at the channel limit on a sentence boundary", async () => {
    const sentence = "This sentence is here only to make the reply long enough to reach the limit. ";
    const h = harness({ script: [{ content: sentence.repeat(12) }] });
    const output = await h.run();
    expect(output.reply.length).toBeLessThanOrEqual(PHONE_VOICE_PROFILE.maxReplyChars);
    expect(output.reply.endsWith(".")).toBe(true);
    expect(output.reply).toBe(h.audible().join(" "));
  });
});

describe("safe streaming — held release (a round offered tools)", () => {
  it("holds a plain reply until the round completes and the whole reply validates, then releases it", async () => {
    const h = harness({ tools: ["request_human_handoff"], executors: { request_human_handoff: handoff },
      script: [{ content: "సరే అండి. మీ నెలవారీ కరెంట్ బిల్ ఎంత వస్తుంది? మీ ఇల్లు సొంతమా?" }] });
    const output = await h.run("సోలార్ గురించి తెలుసుకోవాలి");
    const release = h.timeline.indexOf("release");
    expect(h.timeline.filter((t) => t.startsWith("heard:"))).toEqual([]);
    expect(h.timeline.findIndex((t) => t.startsWith("held:"))).toBeLessThan(h.timeline.indexOf("event:model.completed"));
    expect(release).toBeGreaterThan(h.timeline.indexOf("event:model.completed"));
    expect(output.reply).toBe("సరే అండి. మీ నెలవారీ కరెంట్ బిల్ ఎంత వస్తుంది? మీ ఇల్లు సొంతమా?");
    expect(output.reply).toBe(h.audible().join(" "));
    expect(output.speech).toMatchObject({ streamed: true, segmentsReleased: 2 });
  });

  it("never narrates before the tool ran: the preamble is retracted unheard, the post-tool narration is heard", async () => {
    const h = harness({
      tools: ["request_human_handoff"],
      executors: { request_human_handoff: handoff },
      script: [
        { content: "Of course, I understand completely. I'll connect you with the team right now, please hold on.",
          toolCalls: [{ id: "c1", name: "request_human_handoff", arguments: { reason: "caller asked" } }] },
        { content: "I have recorded your request. The team will call you back shortly." },
      ],
    });
    const output = await h.run("Please connect me to a human.");
    const tool = h.timeline.indexOf("tool:request_human_handoff");
    expect(tool).toBeGreaterThan(-1);
    const firstAudible = h.timeline.findIndex((t) => t.startsWith("heard:") || t === "release");
    expect(firstAudible).toBeGreaterThan(tool);
    expect(h.timeline).toContain("retract:tool_call");
    expect(h.audible().join(" ")).not.toMatch(/connect you/);
    expect(output.reply).toBe("I have recorded your request. The team will call you back shortly.");
    expect(output.speech).toMatchObject({ streamed: true, toolRoundsRetracted: 1 });
    // The first preamble sentence was PREPARED (held) and then thrown away.
    expect(h.timeline).toContain("held:Of course, I understand completely.");
  });

  it("a one-sentence tool preamble is never even emitted: its end is undecidable until the stream ends", async () => {
    const h = harness({
      tools: ["request_human_handoff"],
      executors: { request_human_handoff: handoff },
      script: [
        { content: "I'll connect you with the team right now.",
          toolCalls: [{ id: "c1", name: "request_human_handoff", arguments: { reason: "caller asked" } }] },
        { content: "I have recorded your request for a callback." },
      ],
    });
    await h.run("Please connect me to a human.");
    expect(h.timeline.some((t) => t.includes("connect you"))).toBe(false);
  });

  it("an authorized concession may be narrated after offer_concession succeeded — and only then", async () => {
    const h = harness({
      phrases: true,
      tools: ["offer_concession"],
      executors: { offer_concession: concession },
      script: [
        { content: "", toolCalls: [{ id: "c1", name: "offer_concession", arguments: { concessionId: "free_survey" } }] },
        { content: "సరే అండి, ఉచిత సర్వే తగ్గింపు ఇస్తాం. మీకు ఏ రోజు వీలవుతుంది?" },
      ],
    });
    const output = await h.run("Discount emaina istara?");
    const firstAudible = h.timeline.findIndex((t) => t.startsWith("heard:") || t === "release");
    expect(firstAudible).toBeGreaterThan(-1);
    expect(h.timeline.indexOf("tool:offer_concession")).toBeLessThan(firstAudible);
    // The narration round is offered no tools, so it streams live.
    expect(h.timeline.some((t) => t.startsWith("heard:"))).toBe(true);
    expect(output.reply).toContain("తగ్గింపు ఇస్తాం");
    expect(output.speech).toMatchObject({ streamed: true, truncated: false });
  });

  it("an unauthorized Telugu promise in a held round is never released; the repair ladder owns the reply", async () => {
    const h = harness({
      phrases: true,
      tools: ["offer_concession"],
      executors: { offer_concession: concession },
      script: [
        { content: "సరే అండి. మీకు ₹20,000 off ఇస్తాం, ఈరోజే book చేయండి." },
        { content: "క్షమించండి, ధర గురించి మా టీమ్ చెబుతుంది. మీ పేరు చెప్తారా?" },
      ],
    });
    const output = await h.run("₹20,000 discount ఇస్తారా?");
    expect(h.audible()).toEqual([]);
    expect(output.reply).not.toContain("ఇస్తాం");
    expect(output.validation.regenerated).toBe(true);
    expect(output.speech!.fallbackReason).toBe("segment_rejected");
  });

  it("a side-effecting action awaiting confirmation takes the complete path", async () => {
    const stateStore = new InMemoryConversationStateStore();
    await stateStore.save("conv-1", "biz-a", {
      ...(await stateStore.load("conv-1", "biz-a") ?? (await import("@halo/runtime/conversation-state")).emptyConversationState()),
      pendingConfirmation: { toolName: "save_contact_details", arguments: {}, requestedAt: "2026-09-15T10:00:00Z" },
    });
    const h = harness({ stateStore, script: [{ content: "Thank you, noted." }] });
    const output = await h.run("సరే");
    expect(h.timeline.filter((t) => t.startsWith("held:") || t.startsWith("heard:"))).toEqual([]);
    expect(output.speech).toMatchObject({ attempted: false, fallbackReason: "pending_confirmation" });
    expect(output.reply).toBe("Thank you, noted.");
  });
});

describe("safe streaming — stream failures", () => {
  const died = AppError.provider("AI stream interrupted", { category: "connection" });

  it("a stream that dies after text but before anything was heard is retracted and re-run on the complete path", async () => {
    const h = harness({
      tools: ["request_human_handoff"],
      executors: { request_human_handoff: handoff },
      script: [
        { content: "Sure, I can explain how rooftop solar works for your home. It starts", failAfterTokens: 13, failWith: died },
        { content: "Rooftop panels turn sunlight into power for your home. What is your monthly bill?" },
      ],
    });
    const output = await h.run();
    expect(h.timeline).toContain("retract:stream_failed");
    expect(h.audible()).toEqual([]);
    expect(h.llm.streamCalls).toHaveLength(1);
    expect(h.llm.calls).toHaveLength(1);
    expect(output.reply).toBe("Rooftop panels turn sunlight into power for your home. What is your monthly bill?");
    expect(output.speech).toMatchObject({ streamed: false, fallbackReason: "stream_failed" });
    expect(output.degraded.provider).toBe(false);
  });

  it("a stream that dies after sentences were heard keeps them, drops the unfinished tail, and does not re-run", async () => {
    const h = harness({
      script: [{ content: "Rooftop panels turn sunlight into power for your home. The typical system also", failAfterTokens: 13, failWith: died }],
    });
    const output = await h.run();
    expect(output.reply).toBe("Rooftop panels turn sunlight into power for your home.");
    expect(output.speech).toMatchObject({ streamed: true, truncated: true, fallbackReason: "stream_failed" });
    expect(h.llm.calls).toHaveLength(0);
    expect(JSON.stringify(h.timeline)).not.toContain("typical system");
    expect(h.conversations.messages.get("conv-1")!.at(-1)!.content).toBe(output.reply);
  });

  it("an INCOMPLETE stream (no finish event) is detected by the router in live mode and never flushed", async () => {
    const inner = new StreamingLLM([{ content: "Our survey team visits within a week. The fee is", omitDone: true }]);
    const router = new FallbackLLMRouter([
      { provider: inner, model: "a" },
      { provider: new StreamingLLM([{ content: "never used" }]), model: "b" },
    ]);
    const timeline: string[] = [];
    const agent = makeAgent();
    const { runtime } = makeRuntime({ llm: router });
    const output = await runtime.run(makeInput({ agent, channel: PHONE_VOICE_PROFILE,
      speech: (e) => timeline.push(e.type === "segment" ? `${e.held ? "held" : "heard"}:${e.text}` : e.type) }));
    // Heard: the one complete sentence. Never: the unfinished "The fee is".
    expect(timeline).toEqual(["heard:Our survey team visits within a week."]);
    expect(output.reply).toBe("Our survey team visits within a week.");
    expect(output.speech).toMatchObject({ truncated: true, fallbackReason: "stream_failed" });
  });

  it("a provider that fails before any text is a provider failure: the outage reply, nothing heard", async () => {
    const h = harness({ script: [AppError.provider("down", { category: "provider_5xx" })] });
    const output = await h.run();
    expect(h.audible()).toEqual([]);
    expect(output.degraded.provider).toBe(true);
    expect(output.speech!.fallbackReason).toBe("provider_failed");
  });
});

describe("safe streaming — cancellation", () => {
  it("barge-in before anything was heard cancels the turn and persists nothing", async () => {
    const controller = new AbortController();
    const h = harness({
      tools: ["request_human_handoff"],
      executors: { request_human_handoff: handoff },
      llm: { tokenMs: 1, onToken: (i) => { if (i === 8) controller.abort(); } },
      script: [{ content: "Sure, I can explain that. Solar panels make power from sunlight on your roof." }],
    });
    const error = await h.run("hello", { signal: controller.signal }).catch((e: unknown) => e);
    expect(isRuntimeCancelled(error)).toBe(true);
    expect(h.audible()).toEqual([]);
    expect(h.conversations.messages.get("conv-1") ?? []).toEqual([]);
  });

  it("barge-in after sentences were heard persists exactly the heard prefix, so the next turn is told the truth", async () => {
    const controller = new AbortController();
    const h = harness({
      llm: { tokenMs: 1, onToken: (i) => { if (i === 12) controller.abort(); } },
      script: [{ content: "Rooftop panels turn sunlight into power for your home. The typical home system is around three kilowatts." }],
    });
    const output = await h.run("hello", { signal: controller.signal });
    expect(output.reply).toBe("Rooftop panels turn sunlight into power for your home.");
    expect(output.speech).toMatchObject({ streamed: true, truncated: true });
    expect(h.conversations.messages.get("conv-1")!.map((m) => m.content)).toEqual(["hello", output.reply]);
  });
});

describe("safe streaming — the complete path is untouched", () => {
  it("without a speech sink nothing streams and the output carries no speech outcome", async () => {
    const llm = new StreamingLLM([{ content: "Hello there. How can I help?" }]);
    const { runtime } = makeRuntime({ llm });
    const output = await runtime.run(makeInput({ channel: PHONE_VOICE_PROFILE }));
    expect(output.reply).toBe("Hello there. How can I help?");
    expect(output.speech).toBeUndefined();
    expect(llm.streamCalls).toHaveLength(0);
  });

  it("baseline and streaming produce the same reply for the same model output", async () => {
    const content = "Sare andi. Mee monthly bill entha vastundi? Mee illu sontham aa?";
    const baseline = await makeRuntime({ llm: new StreamingLLM([{ content }]) }).runtime.run(makeInput({ channel: PHONE_VOICE_PROFILE }));
    const h = harness({ script: [{ content }] });
    const streamed = await h.run();
    expect(streamed.reply).toBe(baseline.reply);
    expect(streamed.validation.ok).toBe(baseline.validation.ok);
  });
});
