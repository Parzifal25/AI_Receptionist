import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnCancelledError } from "@halo/voice/turn-handler";
import { buildSession, ScriptedTurnHandler, TEST_PROMPTS, waitForAbort } from "../../mocks/voice-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceSession — lifecycle", () => {
  it("speaks the greeting, then listens", async () => {
    const h = buildSession();
    h.session.start();
    expect(h.session.getState()).toBe("speaking");
    await h.settle(2_000);
    expect(h.session.getState()).toBe("listening");
    expect(h.tts.requests[0].text).toBe(TEST_PROMPTS.greeting);
    expect(h.output.sentBytes).toBeGreaterThan(0);
    expect(h.eventsOf("session_started")).toHaveLength(1);
    expect(h.eventsOf("tts_complete")).toHaveLength(1);
  });

  it("runs a full caller turn and records latency stages", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Sure. What is your name?", turnId: "t1" });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("I want solar panels", { confidence: 0.8, language: "en-IN" });
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]).toMatchObject({ utterance: "I want solar panels", sttConfidence: 0.8, language: "en-IN", turnIndex: 0 });
    await h.settle(3_000);
    expect(h.session.getState()).toBe("listening");
    expect(handler.deliveries).toEqual([{ turnId: "t1", status: "complete", deliveredText: "Sure. What is your name?" }]);
    for (const type of ["endpoint", "stt_final", "agent_turn", "tts_first_byte", "turn_complete"] as const) {
      expect(h.eventsOf(type).length, type).toBeGreaterThan(0);
    }
    const total = h.eventsOf("turn_complete")[0];
    expect(total.latencyMs).not.toBeNull();
    // Events never carry transcript text.
    expect(JSON.stringify(h.events)).not.toContain("solar");
  });

  it("de-duplicates a re-sent STT final", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Okay." });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.speak(300);
    h.stt.current.final("hello", { utteranceId: "u-1" });
    h.stt.current.final("hello", { utteranceId: "u-1" });
    await h.caller.silence(600);
    expect(handler.requests[0].utterance).toBe("hello");
  });

  it("treats speech with no transcript as noise", async () => {
    const handler = new ScriptedTurnHandler();
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.speak(300);
    await h.caller.silence(600);
    await h.settle(2_000);
    expect(handler.requests).toHaveLength(0);
    expect(h.session.getState()).toBe("listening");
  });

  it("commits a final the local VAD missed after the grace period", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Okay." });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    h.stt.current.final("quiet words");
    await h.settle(500);
    expect(handler.requests.map((r) => r.utterance)).toEqual(["quiet words"]);
  });

  it("end() is idempotent and ignores audio afterwards", async () => {
    const h = buildSession();
    h.session.start();
    await h.settle(100);
    const [a, b] = await Promise.all([h.session.end("caller_hangup"), h.session.end("gateway_shutdown")]);
    expect(a).toBe(b);
    expect(a.endReason).toBe("caller_hangup");
    expect(h.ended).toHaveLength(1);
    expect(h.handler.closed).toBe(1);
    h.session.receiveAudio(new Uint8Array(160).fill(0));
    expect(h.session.getState()).toBe("ended");
    expect(h.stt.current.closed).toBe(true);
  });
});

describe("VoiceSession — barge-in and interruption", () => {
  it("cuts playback when the caller talks over the agent and records what was heard", async () => {
    const long = "First sentence is here. Second sentence goes on for quite a while. Third sentence ends it.";
    const handler = new ScriptedTurnHandler().then({ reply: long, turnId: "t1" }, { reply: "Okay." });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("tell me more");
    // First chunk: 23 chars × 20 ms = 460 ms of audio; let it play, then barge in.
    await h.caller.silence(700);
    expect(h.session.getState()).toBe("speaking");
    const clearsBefore = h.output.clears;
    await h.caller.speak(300);
    expect(h.output.clears).toBe(clearsBefore + 1);
    expect(h.session.getState()).toBe("user_speaking");
    const delivery = handler.deliveries.find((d) => d.turnId === "t1")!;
    expect(delivery.status).toBe("interrupted");
    expect(delivery.deliveredText).toBe("First sentence is here.");
    expect(h.eventsOf("barge_in")).toHaveLength(1);
    const cancel = h.eventsOf("tts_cancel")[0];
    expect(cancel.latencyMs).toBeLessThanOrEqual(150);
    // The caller's interrupting words become the next turn.
    h.stt.current.final("wait, how much does it cost");
    await h.caller.silence(600);
    expect(handler.requests[1].utterance).toBe("wait, how much does it cost");
  });

  it("does not barge in on a click shorter than the barge-in threshold", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "A reasonably long reply that keeps playing for a while." });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("hi");
    await h.caller.speak(120);
    expect(h.session.getState()).toBe("speaking");
    expect(h.eventsOf("barge_in")).toHaveLength(0);
  });

  it("interrupt() is idempotent", async () => {
    const h = buildSession();
    h.session.start();
    await h.settle(100);
    expect(h.session.interrupt()).toBe(true);
    expect(h.session.interrupt()).toBe(false);
    expect(h.eventsOf("barge_in")).toHaveLength(1);
  });

  it("aborts an uncommitted turn on barge-in and merges the utterances", async () => {
    const handler = new ScriptedTurnHandler().then(waitForAbort, { reply: "Got it." });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("my bill is");
    expect(h.session.getState()).toBe("thinking");
    expect(handler.requests[0].signal.aborted).toBe(false);
    await h.caller.say("three thousand rupees");
    expect(handler.requests[0].signal.aborted).toBe(true);
    await h.settle(100);
    expect(handler.requests).toHaveLength(2);
    expect(handler.requests[1].utterance).toBe("my bill is three thousand rupees");
    expect(h.eventsOf("turn_cancelled")[0].detail.committed).toBe(false);
  });

  it("a committed-but-superseded turn is marked not delivered and not merged", async () => {
    const handler = new ScriptedTurnHandler().then(
      (req) => new Promise((resolve) => req.signal.addEventListener("abort", () => resolve({ reply: "Booked!", turnId: "t1" }))),
      { reply: "Okay." },
    );
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("book it");
    await h.caller.say("actually no");
    await h.settle(100);
    expect(handler.deliveries).toContainEqual({ turnId: "t1", status: "not_delivered", deliveredText: "" });
    expect(handler.requests[1].utterance).toBe("actually no");
    expect(h.tts.requests.map((r) => r.text)).not.toContain("Booked!");
  });

  it("is not wedged by a handler that ignores its abort signal", async () => {
    const handler = new ScriptedTurnHandler().then(() => new Promise(() => {}), { reply: "Back." });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("first");
    await h.caller.say("second");
    await h.settle(1_500);
    expect(handler.requests).toHaveLength(2);
    expect(handler.requests[1].utterance).toBe("first second");
  });
});

describe("VoiceSession — silence, failures, directives", () => {
  it("reprompts on silence and hangs up after the reprompt budget", async () => {
    const h = buildSession({ config: { silence: { timeoutMs: 5_000, maxReprompts: 2 } } });
    h.session.start();
    await h.settle(2_000);
    await h.settle(5_000);
    await h.settle(2_000);
    await h.settle(5_000);
    await h.settle(2_000);
    await h.settle(5_000);
    await h.settle(3_000);
    const spoken = h.tts.requests.map((r) => r.text);
    expect(spoken.filter((t) => t === TEST_PROMPTS.reprompt)).toHaveLength(2);
    expect(spoken[spoken.length - 1]).toBe(TEST_PROMPTS.goodbye);
    expect(h.ended[0].endReason).toBe("silence_timeout");
  });

  it("recovers from one turn timeout, hangs up after repeated failures", async () => {
    const handler = new ScriptedTurnHandler().then(waitForAbort, waitForAbort);
    const h = buildSession({ handler, config: { turnTimeoutMs: 3_000, maxConsecutiveTurnFailures: 2 } });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("hello");
    await h.settle(3_100);
    expect(h.tts.requests.map((r) => r.text)).toContain(TEST_PROMPTS.turnFailure);
    await h.settle(2_000);
    await h.caller.say("hello again");
    await h.settle(6_000);
    expect(h.ended[0]?.endReason).toBe("agent_failure");
    expect(h.eventsOf("provider_error").filter((e) => e.detail.code === "timeout")).toHaveLength(2);
  });

  it("never narrates success when the handler fails", async () => {
    const handler = new ScriptedTurnHandler().then(() => {
      throw new Error("runtime exploded");
    });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("book a visit");
    await h.settle(3_000);
    const spoken = h.tts.requests.map((r) => r.text);
    expect(spoken).toEqual([TEST_PROMPTS.greeting, TEST_PROMPTS.turnFailure]);
  });

  it("reconnects STT once, then ends the call on a second failure", async () => {
    const h = buildSession();
    h.session.start();
    await h.settle(2_000);
    h.stt.current.error("network", true);
    expect(h.stt.streams).toHaveLength(2);
    expect(h.eventsOf("media_reconnected")).toHaveLength(1);
    h.stt.current.error("network", true);
    await h.settle(5_000);
    expect(h.ended[0].endReason).toBe("stt_failure");
  });

  it("ends the call honestly when TTS fails mid-reply", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Your visit is confirmed.", turnId: "t1" });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    h.tts.failNext("provider", false);
    await h.caller.say("yes");
    await h.settle(3_000);
    expect(h.ended[0].endReason).toBe("tts_failure");
    expect(handler.deliveries).toContainEqual({ turnId: "t1", status: "not_delivered", deliveredText: "" });
  });

  it("retries a retryable TTS failure once before the first byte", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Okay then.", turnId: "t1" });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    h.tts.failNext("network", true);
    await h.caller.say("yes");
    await h.settle(3_000);
    expect(handler.deliveries[0]).toMatchObject({ turnId: "t1", status: "complete" });
    expect(h.ended).toHaveLength(0);
  });

  it("hangs up after an end_call reply is spoken", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Thank you, goodbye.", directive: { kind: "end_call", reason: "done" } });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("bye");
    await h.settle(3_000);
    expect(h.ended[0].endReason).toBe("agent_completed");
    expect(h.ended[0].lastDirective).toBe("end_call");
  });

  it("transfers after the reply, or speaks an honest failure line", async () => {
    const ok = buildSession({
      handler: new ScriptedTurnHandler().then({ reply: "Connecting you now.", directive: { kind: "transfer", reason: "human" } }),
    });
    ok.session.start();
    await ok.settle(2_000);
    await ok.caller.say("human please");
    await ok.settle(3_000);
    expect(ok.transferReasons).toEqual(["human"]);
    expect(ok.ended[0]).toMatchObject({ endReason: "transferred", transferred: true });

    const bad = buildSession({
      handler: new ScriptedTurnHandler().then({ reply: "Connecting you now.", directive: { kind: "transfer", reason: "human" } }),
      transfer: async () => false,
    });
    bad.session.start();
    await bad.settle(2_000);
    await bad.caller.say("human please");
    await bad.settle(5_000);
    expect(bad.tts.requests.map((r) => r.text)).toContain(TEST_PROMPTS.transferFailed);
    expect(bad.ended).toHaveLength(0);
    expect(bad.session.getState()).toBe("listening");
  });

  it("estimates delivery by time when the provider has no marks", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "One two three four five. Six seven eight nine ten eleven twelve.", turnId: "t1" });
    const h = buildSession({ handler, supportsMarks: false });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("count");
    await h.caller.silence(700);
    await h.caller.speak(300);
    expect(handler.deliveries[0]).toMatchObject({ turnId: "t1", status: "interrupted", deliveredText: "One two three four five." });
  });

  it("records usage in the summary without inventing tokens", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Hi.", usage: { modelCalls: 2 } });
    const h = buildSession({ handler });
    h.session.start();
    await h.settle(2_000);
    await h.caller.say("hi");
    await h.settle(2_000);
    const summary = await h.session.end("caller_hangup");
    expect(summary.modelCalls).toBe(2);
    expect(summary.inputTokens).toBeUndefined();
    expect(summary.inboundAudioMs).toBeGreaterThan(0);
    expect(summary.outboundAudioMs).toBeGreaterThan(0);
    expect(summary.transcript.map((t) => [t.speaker, t.source, t.delivery])).toEqual([
      ["agent", "voice_policy", "complete"],
      ["caller", "caller", "complete"],
      ["agent", "runtime", "complete"],
    ]);
  });
});

describe("VoiceSession — handoff window and playback exclusivity", () => {
  /**
   * Regression: a slow provider transfer left the session in `listening`, so
   * caller speech during the bridge started a NEW runtime turn. That turn
   * could execute a business action for a caller already being handed to a
   * human, and `end("transferred")` would cut it off mid-flight.
   */
  it("starts no new turn while a handoff is in flight, and answers held speech only after it fails", async () => {
    const handler = new ScriptedTurnHandler().then(
      { reply: "Let me get you a person.", directive: { kind: "transfer", reason: "explicit_human_request" } },
      { reply: "Answering the held question." },
    );
    let resolveTransfer!: (ok: boolean) => void;
    const h = buildSession({ handler, transfer: () => new Promise<boolean>((r) => (resolveTransfer = r)) });
    h.session.start();
    await h.settle(3000);

    await h.caller.say("I want a human");
    await h.settle(3000);
    expect(h.session.getState()).toBe("transferring");

    // Caller keeps talking while the bridge is being set up.
    await h.caller.say("Actually, one more thing");
    await h.settle(2000);
    expect(h.session.getState()).toBe("transferring");
    expect(handler.requests).toHaveLength(1); // no turn ran during the handoff

    resolveTransfer(false);
    await h.settle(6000);
    // Held speech is answered, not dropped — and only after the honest apology.
    expect(handler.requests).toHaveLength(2);
    expect(handler.requests[1].utterance).toContain("one more thing");
    const spoken = h.tts.requests.map((r) => r.text);
    expect(spoken.indexOf(TEST_PROMPTS.transferFailed)).toBeLessThan(spoken.indexOf("Answering the held question."));
  });

  it("succeeds the handoff without running a queued turn", async () => {
    const handler = new ScriptedTurnHandler().then(
      { reply: "Connecting you.", directive: { kind: "transfer", reason: "explicit_human_request" } },
      { reply: "This turn must never run." },
    );
    let resolveTransfer!: (ok: boolean) => void;
    const h = buildSession({ handler, transfer: () => new Promise<boolean>((r) => (resolveTransfer = r)) });
    h.session.start();
    await h.settle(3000);
    await h.caller.say("Get me a human");
    await h.settle(3000);
    await h.caller.say("Hello are you there");
    await h.settle(1000);

    resolveTransfer(true);
    await h.settle(3000);
    expect(handler.requests).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ endReason: "transferred", transferred: true });
  });

  /**
   * Regression: `play()` overwrote `this.playback` without settling the
   * previous one, so two synthesis loops wrote to the media socket at once
   * (garbled speech), fought over the single `playbackWatchdog` slot and
   * settled each other's transcript rows.
   */
  it("never lets two playbacks be active at once", async () => {
    const handler = new ScriptedTurnHandler().then(
      { reply: "Hold on please.", directive: { kind: "transfer", reason: "explicit_human_request" } },
      { reply: "A deliberately long second reply that is still speaking when the handoff resolves." },
    );
    let resolveTransfer!: (ok: boolean) => void;
    const h = buildSession({ handler, transfer: () => new Promise<boolean>((r) => (resolveTransfer = r)) });
    h.session.start();
    await h.settle(3000);
    await h.caller.say("Human please");
    await h.settle(3000);
    resolveTransfer(false);
    await h.settle(200);
    await h.caller.say("Tell me more");
    await h.settle(400); // long reply mid-playback

    // At every point, started playbacks minus settled ones is at most one.
    const timeline = h.events.filter((e) => e.type === "tts_start" || e.type === "tts_complete" || e.type === "tts_cancel");
    let open = 0;
    for (const e of timeline) {
      open += e.type === "tts_start" ? 1 : -1;
      expect(open).toBeLessThanOrEqual(1);
      expect(open).toBeGreaterThanOrEqual(0);
    }
  });
});

void TurnCancelledError;
