import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildRemoteSession } from "../../mocks/remote-voice-harness";
import { buildSession, ScriptedTurnHandler, waitForAbort } from "../../mocks/voice-harness";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("a raw remote VAD start and a short cough never abort a thinking turn", async () => {
  const handler = new ScriptedTurnHandler().then(waitForAbort);
  const h = buildRemoteSession({ handler });
  h.session.start(); await h.settle(2000); await h.caller.say("tell me more");
  h.session.receiveControl({ type: "speech_started" });
  await h.settle(100);
  expect(handler.requests[0].signal.aborted).toBe(false);
  h.session.receiveControl({ type: "speech_stopped" });
  await h.settle(1000);
  expect(handler.requests[0].signal.aborted).toBe(false);
  await h.session.end("caller_hangup");
});

it.each(["hmm", "అవును", "sare"])("remote short backchannel %s preserves the current generation", async (text) => {
  const handler = new ScriptedTurnHandler().then(waitForAbort);
  const h = buildRemoteSession({ handler });
  h.session.start(); await h.settle(2000); await h.caller.say("వివరాలు చెప్పండి");
  h.session.receiveControl({ type: "speech_started" });
  h.session.receiveControl({ type: "transcript", text, final: false, language: "te-IN", confidence: null });
  expect(handler.requests[0].signal.aborted).toBe(false);
  await h.session.end("caller_hangup");
});

it.each(["wait please", "ఆగండి", "aagandi"])("remote substantive transcript %s aborts once and preserves final words", async (text) => {
  const handler = new ScriptedTurnHandler().then(waitForAbort, { reply: "Okay." });
  const h = buildRemoteSession({ handler });
  h.session.start(); await h.settle(2000); await h.caller.say("first question");
  h.session.receiveControl({ type: "speech_started" });
  h.session.receiveControl({ type: "transcript", text, final: false, language: "te-IN", confidence: null });
  expect(handler.requests[0].signal.aborted).toBe(true);
  await h.caller.transcribe(text); await h.caller.stopSpeaking(); await h.settle(100);
  expect(h.eventsOf("barge_in")).toHaveLength(1);
  expect(handler.requests[1].utterance).toBe(`first question ${text}`);
  await h.session.end("caller_hangup");
});

it.each(["hmm", "అవును", "sare"])("in-process short backchannel %s preserves thinking", async (text) => {
  const handler = new ScriptedTurnHandler().then(waitForAbort);
  const h = buildSession({ handler });
  h.session.start(); await h.settle(2000); await h.caller.say("first question");
  await h.caller.speak(120);
  h.stt.current.partial(text, "te-IN");
  expect(handler.requests[0].signal.aborted).toBe(false);
  await h.session.end("caller_hangup");
});

it("remote measured sustained speech cancels once; short and stale progress do not", async () => {
  const handler = new ScriptedTurnHandler().then(waitForAbort);
  const h = buildRemoteSession({ handler, config: { bargeIn: { enabled: true, minSpeechMs: 250 } } });
  h.session.start(); await h.settle(2000); await h.caller.say("first question");
  h.session.receiveControl({ type: "speech_progress", speechMs: 1000 });
  expect(handler.requests[0].signal.aborted).toBe(false);
  h.session.receiveControl({ type: "speech_started" });
  h.session.receiveControl({ type: "speech_progress", speechMs: 249 });
  expect(handler.requests[0].signal.aborted).toBe(false);
  h.session.receiveControl({ type: "speech_progress", speechMs: 250 });
  h.session.receiveControl({ type: "speech_progress", speechMs: 400 });
  expect(handler.requests[0].signal.aborted).toBe(true);
  expect(h.eventsOf("barge_in")).toHaveLength(1);
  await h.session.end("caller_hangup");
});

it("disabled remote barge-in preserves generation even with progress and substantive text", async () => {
  const handler = new ScriptedTurnHandler().then(waitForAbort);
  const h = buildRemoteSession({ handler, config: { bargeIn: { enabled: false, minSpeechMs: 250 } } });
  h.session.start(); await h.settle(2000); await h.caller.say("first question");
  h.session.receiveControl({ type: "speech_started" });
  h.session.receiveControl({ type: "speech_progress", speechMs: 500 });
  await h.caller.transcribe("ఆగండి");
  expect(handler.requests[0].signal.aborted).toBe(false);
  await h.session.end("caller_hangup");
});

it("in-process VAD hangover silence after a short cough does not count as speech", async () => {
  const handler = new ScriptedTurnHandler().then(waitForAbort);
  const h = buildSession({ handler });
  h.session.start(); await h.settle(2000); await h.caller.say("first question");
  await h.caller.speak(120);
  await h.caller.silence(300);
  expect(handler.requests[0].signal.aborted).toBe(false);
  expect(h.eventsOf("barge_in")).toHaveLength(0);
  await h.session.end("caller_hangup");
});
