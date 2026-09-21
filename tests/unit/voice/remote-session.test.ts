import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRemoteSession, TEST_IDENTITY } from "../../mocks/remote-voice-harness";
import { ScriptedTurnHandler, TEST_PROMPTS, waitForAbort } from "../../mocks/voice-harness";

/**
 * Phase 4 — the Pipecat-backed media engine.
 *
 * These pin the behaviours that are NOT Pipecat's: turn serialization,
 * delivery truth, the handoff window, silence and failure policy. Behaviour
 * shared with the in-process engine is additionally pinned, against BOTH
 * engines, by tests/contracts/media-session-contracts.ts.
 */
describe("RemoteVoiceSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("announces itself to the worker before speaking, and never sends it tenant content in `ready`", async () => {
    const h = buildRemoteSession();
    h.session.start();
    await h.settle(1);

    const ready = h.worker.commands.find((c) => c.type === "ready");
    expect(ready).toBeDefined();
    if (ready?.type !== "ready") throw new Error("expected ready");
    expect(ready.session).toEqual(TEST_IDENTITY);
    // The greeting is a `speak` command, not part of the worker's config:
    // Pipecat holds no tenant-authored line and cannot invent one.
    expect(JSON.stringify(ready.voice)).not.toContain(TEST_PROMPTS.greeting);
    expect(h.worker.spoken[0]).toBe(TEST_PROMPTS.greeting);
  });

  it("runs a turn and records the full reply as delivered when the worker plays it out", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "మీ బిల్లు ఎంత?" });
    const h = buildRemoteSession({ handler });
    h.session.start();
    await h.settle(2_000);

    await h.caller.say("నాకు సోలార్ కావాలి");
    await h.settle(3_000);

    expect(handler.requests[0].utterance).toBe("నాకు సోలార్ కావాలి");
    expect(h.handler.deliveries).toEqual([{ turnId: "turn-1", status: "complete", deliveredText: "మీ బిల్లు ఎంత?" }]);
    const caller = h.transcript.filter((t) => t.speaker === "caller");
    expect(caller).toHaveLength(1);
    expect(caller[0].language).toBe("te-IN");
    expect(caller[0].sttConfidence).toBe(0.9);
  });

  it("records only the chunks the caller actually heard when the worker cuts playback", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "First sentence here. Second sentence here. Third sentence here." });
    const h = buildRemoteSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("hello");
    // Let first audio and the first chunk play, then talk over the rest.
    await h.settle(300);
    await h.caller.startSpeaking();
    await h.settle(10);

    const delivery = h.handler.deliveries.at(-1);
    expect(delivery?.status).toBe("interrupted");
    expect(delivery?.deliveredText).toBe("First sentence here.");
    expect(delivery?.deliveredText).not.toContain("Third");
    expect(h.eventsOf("barge_in")).toHaveLength(1);
  });

  it("cancels an uncommitted turn on barge-in and merges the superseded utterance into the next one", async () => {
    const handler = new ScriptedTurnHandler().then(waitForAbort, { reply: "ok" });
    const h = buildRemoteSession({ handler });
    h.session.start();
    await h.settle(2_000);

    await h.caller.say("my bill is");
    await h.settle(50);
    // Caller starts talking again while the model is still thinking.
    await h.caller.startSpeaking();
    await h.settle(10);
    expect(h.eventsOf("turn_cancelled")).toHaveLength(1);
    // Nothing was committed, so nothing was persisted for that turn.
    expect(h.handler.deliveries).toHaveLength(0);

    await h.caller.transcribe("three thousand");
    await h.caller.stopSpeaking();
    await h.settle(3_000);
    expect(handler.requests[1].utterance).toBe("my bill is three thousand");
  });

  it("holds the session for the whole handoff and starts no turn while the bridge is in flight", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "one moment", directive: { kind: "transfer", reason: "explicit_human_request" } });
    let releaseTransfer!: (ok: boolean) => void;
    const h = buildRemoteSession({
      handler,
      transfer: () => new Promise<boolean>((resolve) => (releaseTransfer = resolve)),
    });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("I want to talk to a person");
    await h.settle(3_000);

    expect(h.session.getState()).toBe("transferring");
    expect(h.worker.spoken).toContain(TEST_PROMPTS.transferAnnounce);

    // The caller keeps talking while the bridge is being set up.
    await h.caller.say("also what about the price");
    await h.settle(2_000);
    // No second turn ran: a business action must not execute for a caller
    // who is already being handed to a human.
    expect(handler.requests).toHaveLength(1);

    releaseTransfer(true);
    await h.settle(2_000);
    expect(h.ended[0]?.endReason).toBe("transferred");
    expect(h.ended[0]?.transferred).toBe(true);
  });

  it("tells the caller honestly when the bridge fails, and picks the conversation back up", async () => {
    const handler = new ScriptedTurnHandler()
      .then({ reply: "one moment", directive: { kind: "transfer", reason: "explicit_human_request" } })
      .then({ reply: "the price depends on your bill" });
    const h = buildRemoteSession({ handler, transfer: async () => false });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("get me a person");
    await h.settle(5_000);

    expect(h.worker.spoken).toContain(TEST_PROMPTS.transferFailed);
    expect(h.ended).toHaveLength(0);
    expect(h.session.getState()).toBe("listening");
  });

  it("never claims a transfer the provider refused", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "connecting", directive: { kind: "transfer", reason: "explicit_human_request" } });
    const h = buildRemoteSession({ handler, transfer: async () => false });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("person please");
    await h.settle(5_000);

    const transfer = h.eventsOf("transfer")[0];
    expect(transfer.detail.ok).toBe(false);
    await h.session.end("caller_hangup");
    expect(h.ended[0].transferred).toBe(false);
    expect(h.ended[0].transferRequested).toBe(true);
  });

  it("hangs up after an end_call directive and tells the worker to do so", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "thank you, goodbye", directive: { kind: "end_call", reason: "conversation_closed" } });
    const h = buildRemoteSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("that is all");
    await h.settle(5_000);

    expect(h.ended[0]?.endReason).toBe("agent_completed");
    expect(h.worker.hangups).toBeGreaterThan(0);
  });

  it("reprompts on silence and closes politely once the budget is spent", async () => {
    const h = buildRemoteSession({ config: { silence: { timeoutMs: 1_000, maxReprompts: 1 } } });
    h.session.start();
    await h.settle(2_000);

    await h.settle(1_100);
    expect(h.worker.spoken).toContain(TEST_PROMPTS.reprompt);
    await h.settle(5_000);
    expect(h.worker.spoken).toContain(TEST_PROMPTS.goodbye);
    expect(h.ended[0]?.endReason).toBe("silence_timeout");
  });

  it("keeps at most one playback live: a policy line stops the live one before it speaks", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "a long reply that is still playing out when the call hits its ceiling" });
    const h = buildRemoteSession({
      handler,
      timing: { firstAudioMs: 20, msPerChar: 200 },
      config: { maxCallDurationMs: 4_000 },
    });
    h.session.start();
    await h.settle(1_000);
    await h.caller.say("hi");
    // The reply is still playing when the call-duration ceiling fires.
    await h.settle(10_000);

    const order = h.worker.commands.map((c) => c.type);
    const stopAt = order.indexOf("stop_playback");
    expect(stopAt).toBeGreaterThan(-1);
    // The goodbye is spoken only AFTER the live line was stopped, so two
    // lines can never be on the wire at once.
    expect(order.lastIndexOf("speak")).toBeGreaterThan(stopAt);
    expect(h.worker.playing).toBe(false);
    expect(h.worker.spoken.at(-1)).toBe(TEST_PROMPTS.goodbye);
    expect(h.ended[0]?.endReason).toBe("max_duration");
    // The caller is told the truth about what they heard of the cut reply.
    expect(h.handler.deliveries.at(-1)?.status).not.toBe("complete");
  });

  it("ends the call after repeated turn failures rather than looping", async () => {
    const handler = new ScriptedTurnHandler().then(
      () => Promise.reject(new Error("llm down")),
      () => Promise.reject(new Error("llm down")),
    );
    const h = buildRemoteSession({ handler, config: { maxConsecutiveTurnFailures: 2 } });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("hello");
    await h.settle(5_000);
    expect(h.worker.spoken).toContain(TEST_PROMPTS.turnFailure);
    await h.caller.say("hello again");
    await h.settle(5_000);
    expect(h.ended[0]?.endReason).toBe("agent_failure");
  });

  it("is idempotent: end() resolves with the same summary and interrupt() is safe when idle", async () => {
    const h = buildRemoteSession();
    h.session.start();
    await h.settle(2_000);
    expect(h.session.interrupt()).toBe(false);
    const first = await h.session.end("caller_hangup");
    const second = await h.session.end("provider_status");
    expect(second).toBe(first);
    expect(h.ended).toHaveLength(1);
  });

  it("ends the call when the worker reports the caller hung up", async () => {
    const h = buildRemoteSession();
    h.session.start();
    await h.settle(2_000);
    h.session.receiveControl({ type: "bye", reason: "caller_hangup" });
    await h.settle(2_500);
    expect(h.ended[0]?.endReason).toBe("caller_hangup");
  });

  it("takes the worker's media accounting and never invents its own", async () => {
    const h = buildRemoteSession();
    h.session.start();
    await h.settle(2_000);
    h.session.receiveControl({ type: "usage", inboundAudioMs: 12_000, outboundAudioMs: 4_500, ttsCharacters: 210 });
    const summary = await h.session.end("caller_hangup");
    expect(summary.inboundAudioMs).toBe(12_000);
    expect(summary.outboundAudioMs).toBe(4_500);
    expect(summary.ttsCharacters).toBe(210);
  });

  it("settles a lost playback report honestly instead of wedging the call", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "a reply nobody confirms" });
    const h = buildRemoteSession({ handler, timing: { firstAudioMs: 1_000_000, msPerChar: 1_000_000 } });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("hello");
    await h.settle(61_000);

    // Nothing was acknowledged, so nothing is claimed as heard.
    expect(h.handler.deliveries.at(-1)).toEqual({ turnId: "turn-1", status: "not_delivered", deliveredText: "" });
    expect(h.eventsOf("provider_error").some((e) => e.detail.code === "playback_report_lost")).toBe(true);
  });

  it("de-duplicates a re-sent final rather than running the turn twice", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "ok" });
    const h = buildRemoteSession({ handler });
    h.session.start();
    await h.settle(2_000);

    await h.caller.startSpeaking();
    h.session.receiveControl({ type: "transcript", final: true, text: "repeat me", utteranceId: "dup-1", language: "te-IN", confidence: 0.8 });
    h.session.receiveControl({ type: "transcript", final: true, text: "repeat me", utteranceId: "dup-1", language: "te-IN", confidence: 0.8 });
    await h.caller.stopSpeaking();
    await h.settle(3_000);

    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0].utterance).toBe("repeat me");
  });
});
