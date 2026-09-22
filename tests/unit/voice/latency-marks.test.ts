import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_EVENT_TYPES } from "@halo/core/domain/voice";
import type { VoiceTurnTimings } from "@halo/voice/turn-handler";
import { buildSession, ScriptedTurnHandler } from "../../mocks/voice-harness";

/**
 * Phase 4.5 Sprint 1 — the two latency marks that filled the hole in the
 * middle of the chain, through the real session state machine.
 *
 * The property under test is honesty, not precision: `llm_first_token` is
 * emitted only when the model actually streamed, and its absence is a
 * recorded fact rather than a number to invent.
 */

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const STREAMED: VoiceTurnTimings = { contextReadyMs: 40, firstTokenMs: 210, modelMs: 500, validationMs: 12 };

async function runTurn(timings: VoiceTurnTimings | undefined) {
  const handler = new ScriptedTurnHandler().then({ reply: "Our team can visit this week.", ...(timings ? { timings } : {}) });
  const h = buildSession({ handler });
  h.session.start();
  await h.settle(2_000);
  await h.caller.say("What are your prices?");
  await h.settle(3_000);
  return h;
}

describe("voice latency marks", () => {
  it("registers both marks in the closed call-event set", () => {
    expect(CALL_EVENT_TYPES).toContain("context_ready");
    expect(CALL_EVENT_TYPES).toContain("llm_first_token");
  });

  it("emits context_ready and llm_first_token when the handler reports a breakdown", async () => {
    const h = await runTurn(STREAMED);
    const contextReady = h.eventsOf("context_ready")[0];
    const firstToken = h.eventsOf("llm_first_token")[0];

    expect(contextReady).toBeDefined();
    expect(contextReady.detail.contextMs).toBe(40);
    expect(firstToken).toBeDefined();
    expect(firstToken.detail.sinceTurnStartMs).toBe(210);
    // Both are measured from end-of-speech — what the caller waits through —
    // so first token can never precede context being ready.
    expect(firstToken.latencyMs!).toBeGreaterThanOrEqual(contextReady.latencyMs!);
  });

  it("measures both marks from the same origin, so the chain is one wait", async () => {
    const h = await runTurn(STREAMED);
    const at = (type: Parameters<typeof h.eventsOf>[0]) => h.eventsOf(type)[0]?.latencyMs ?? null;
    // Both are offsets from end-of-speech — what the caller waits through —
    // so the gap between them is exactly the gap the runtime reported, with
    // no second time origin sneaking in.
    expect(at("llm_first_token")! - at("context_ready")!).toBe(STREAMED.firstTokenMs! - STREAMED.contextReadyMs);
    expect(at("endpoint")).not.toBeNull();
    expect(h.eventsOf("turn_complete")[0]).toBeDefined();
  });

  it("carries the whole breakdown on agent_turn so one row explains the turn", async () => {
    const h = await runTurn(STREAMED);
    expect(h.eventsOf("agent_turn")[0].detail).toMatchObject({
      contextMs: 40,
      firstTokenMs: 210,
      modelMs: 500,
      validationMs: 12,
    });
  });

  it("does NOT invent a first-token time when the provider did not stream", async () => {
    const h = await runTurn({ contextReadyMs: 30, firstTokenMs: null, modelMs: 700, validationMs: 5 });
    expect(h.eventsOf("llm_first_token")).toHaveLength(0);
    // The absence is recorded explicitly rather than left to be guessed at.
    expect(h.eventsOf("agent_turn")[0].detail.firstTokenMs).toBeNull();
  });

  it("stays silent about timings a handler does not report", async () => {
    const h = await runTurn(undefined);
    expect(h.eventsOf("context_ready")).toHaveLength(0);
    expect(h.eventsOf("llm_first_token")).toHaveLength(0);
    expect(h.eventsOf("agent_turn")[0].detail).not.toHaveProperty("contextMs");
  });

  it("never puts transcript text in a latency mark", async () => {
    const h = await runTurn(STREAMED);
    const marks = [...h.eventsOf("context_ready"), ...h.eventsOf("llm_first_token")];
    expect(JSON.stringify(marks)).not.toContain("prices");
    expect(JSON.stringify(marks)).not.toContain("visit");
  });
});
