import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGateway, TENANT_A_DID, TENANT_B_DID } from "../mocks/voice-gateway-harness";
import { ScriptedTurnHandler } from "../mocks/voice-harness";

/**
 * Phase 3 — the Voice Gateway end to end against deterministic fakes:
 * routing, call identity, state, persistence, capacity, reconnection,
 * provider webhooks, transfer, tenant isolation and telemetry.
 */

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("VoiceGateway", () => {
  it("answers a call on a provisioned number and records a complete call record", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Namaskaram, how can I help?", turnId: "t1" });
    const g = buildGateway({ handler });
    const { result } = await g.connect({ providerCallId: "CA-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await g.settle(2_000);
    await g.caller.say(result.sessionId, "I want solar");
    await g.settle(3_000);
    g.gateway.receiveEvent(result.sessionId, { type: "stop" });
    await g.settle(1_000);

    const call = g.callStore.calls.get(result.call.id)!;
    expect(call).toMatchObject({
      state: "completed",
      businessId: "biz-a",
      agentId: "agent-a",
      agentVersionId: "av-a-3",
      direction: "inbound",
      provider: "fake",
      providerCallId: "CA-1",
    });
    expect(call.conversationId).toBeTruthy();
    expect(call.finalization).toMatchObject({ hangupCause: "caller_hangup" });
    expect(call.finalization!.usage).toMatchObject({ agentTurns: 1, modelCalls: 1, costEstimate: null });
    expect(call.finalization!.usage.outboundAudioSeconds).toBeGreaterThan(0);

    const transcript = g.callStore.transcripts.get(call.id)!;
    expect(transcript.map((t) => [t.speaker, t.delivery])).toEqual([
      ["agent", "complete"],
      ["caller", "complete"],
      ["agent", "complete"],
    ]);
    const events = g.callStore.events.get(call.id)!;
    expect(events[0].type).toBe("session_started");
    expect(events.map((e) => e.seq)).toEqual([...events.keys()]);
    expect(events.some((e) => e.type === "turn_complete" && e.latencyMs !== null)).toBe(true);
    expect(g.callStore.outcomes.get(call.id)).toMatchObject({ disposition: "no_outcome" });
    expect(g.callStore.usageEvents.map((u) => u.type)).toEqual(["call_started", "call_completed"]);
    const completed = g.callStore.usageEvents[1].metadata as Record<string, unknown>;
    expect(completed).toMatchObject({ agentVersionId: "av-a-3", agentVersion: 3, turns: 1 });
    expect(Object.keys(completed.latency as object).length).toBeGreaterThan(0);
  });

  it("rejects a call to a number no tenant owns, without creating anything", async () => {
    const g = buildGateway();
    const { result } = await g.connect({ providerCallId: "CA-X", to: "+914000009999" });
    expect(result).toEqual({ ok: false, reason: "unknown_number" });
    expect(g.callStore.calls.size).toBe(0);
    expect(g.gateway.activeSessions).toBe(0);
  });

  it("is idempotent per provider call id and re-attaches a second media socket", async () => {
    const g = buildGateway({ handler: new ScriptedTurnHandler().then({ reply: "ok" }) });
    const first = await g.connect({ providerCallId: "CA-2" });
    await g.settle(2_000);
    const second = await g.connect({ providerCallId: "CA-2" });
    expect(second.result).toMatchObject({ ok: true, reattached: true });
    expect(g.callStore.calls.size).toBe(1);
    expect(g.gateway.activeSessions).toBe(1);
    if (first.result.ok) await g.gateway.endSession(first.result.sessionId, "caller_hangup");
  });

  it("refuses new calls beyond the concurrency ceiling", async () => {
    const g = buildGateway({ limits: { maxConcurrentSessions: 1 } });
    await g.connect({ providerCallId: "CA-3" });
    await g.settle(2_000);
    const second = await g.connect({ providerCallId: "CA-4" });
    expect(second.result).toEqual({ ok: false, reason: "capacity" });
  });

  it("refuses to restart a call that already ended", async () => {
    const g = buildGateway();
    const { result } = await g.connect({ providerCallId: "CA-5" });
    if (!result.ok) throw new Error("expected a session");
    await g.settle(2_000);
    await g.gateway.endSession(result.sessionId, "caller_hangup");
    const again = await g.connect({ providerCallId: "CA-5" });
    expect(again.result).toEqual({ ok: false, reason: "already_ended" });
  });

  it("survives a media drop inside the reconnect window and finalizes after it", async () => {
    const g = buildGateway({ limits: { mediaReconnectMs: 3_000 } });
    const { result } = await g.connect({ providerCallId: "CA-6" });
    if (!result.ok) throw new Error("expected a session");
    await g.settle(2_000);

    g.gateway.mediaDisconnected(result.sessionId);
    expect(g.callStore.calls.get(result.call.id)!.state).toBe("interrupted");
    await g.settle(1_000);
    await g.connect({ providerCallId: "CA-6" });
    expect(g.callStore.calls.get(result.call.id)!.state).toBe("in_conversation");

    g.gateway.mediaDisconnected(result.sessionId);
    await g.settle(4_000);
    const call = g.callStore.calls.get(result.call.id)!;
    expect(call.state).toBe("completed");
    expect(call.finalization!.hangupCause).toBe("media_disconnected");
    expect(g.callStore.outcomes.has(call.id)).toBe(true);
  });

  it("applies provider status webhooks to live and already-detached calls", async () => {
    const live = buildGateway();
    const { result } = await live.connect({ providerCallId: "CA-7" });
    if (!result.ok) throw new Error("expected a session");
    await live.settle(2_000);
    await live.gateway.handleProviderEvent({ kind: "call_status", providerCallId: "CA-7", status: "completed", durationSeconds: 12 });
    expect(live.callStore.calls.get(result.call.id)!.state).toBe("completed");
    expect(live.gateway.activeSessions).toBe(0);

    // A call that was never answered: no session, state walks to no_answer.
    const cold = buildGateway();
    const { call } = await cold.callStore.createOrGetCall({
      businessId: "biz-a",
      agentId: "agent-a",
      agentVersionId: "av-a-3",
      phoneNumberId: "pn-a",
      direction: "inbound",
      provider: "fake",
      providerCallId: "CA-8",
      fromNumber: "+919800000001",
      toNumber: TENANT_A_DID,
      state: "ringing",
      language: "te-IN",
    });
    await cold.gateway.handleProviderEvent({ kind: "call_status", providerCallId: "CA-8", status: "no_answer", durationSeconds: null });
    expect(cold.callStore.calls.get(call.id)!.state).toBe("no_answer");
  });

  it("transfers to the tenant's configured number and never anywhere else", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Connecting you.", directive: { kind: "transfer", reason: "explicit_human_request" } });
    const g = buildGateway({ handler, handoffNumber: "+914000000099" });
    const { result } = await g.connect({ providerCallId: "CA-9" });
    if (!result.ok) throw new Error("expected a session");
    await g.settle(2_000);
    await g.caller.say(result.sessionId, "give me a person");
    await g.settle(6_000);
    expect(g.telephony.transfers).toEqual([{ providerCallId: "CA-9", target: { phoneNumber: "+914000000099" } }]);
    const call = g.callStore.calls.get(result.call.id)!;
    expect(call.state).toBe("transferred");
    expect(g.callStore.outcomes.get(call.id)).toMatchObject({ disposition: "escalated_to_human", escalated: true });
  });

  it("never transfers when the tenant configured no handoff number", async () => {
    const handler = new ScriptedTurnHandler()
      .then({ reply: "Connecting you.", directive: { kind: "transfer", reason: "explicit_human_request" } });
    const g = buildGateway({ handler, handoffNumber: null });
    const { result } = await g.connect({ providerCallId: "CA-10" });
    if (!result.ok) throw new Error("expected a session");
    await g.settle(2_000);
    await g.caller.say(result.sessionId, "give me a person");
    await g.settle(6_000);
    expect(g.telephony.transfers).toEqual([]);
    expect(g.callStore.calls.get(result.call.id)!.state).not.toBe("transferred");
  });

  it("keeps two tenants' calls fully separate", async () => {
    const g = buildGateway({ handler: new ScriptedTurnHandler().then({ reply: "a" }, { reply: "b" }) });
    const a = await g.connect({ providerCallId: "CA-A", to: TENANT_A_DID });
    const b = await g.connect({ providerCallId: "CA-B", to: TENANT_B_DID, from: "+919800000002" });
    await g.settle(2_000);
    if (!a.result.ok || !b.result.ok) throw new Error("expected sessions");
    expect(g.callStore.calls.get(a.result.call.id)!.businessId).toBe("biz-a");
    expect(g.callStore.calls.get(b.result.call.id)!.businessId).toBe("biz-b");
    expect(g.callStore.calls.get(b.result.call.id)!.agentVersionId).toBe("av-b-3");
    // Cross-tenant access is rejected by the store's scoping.
    await expect(g.callStore.appendEvents(a.result.call.id, "biz-b", [])).rejects.toThrow(/not found for tenant/);
  });

  it("does not fail a call when telemetry persistence fails", async () => {
    const handler = new ScriptedTurnHandler().then({ reply: "Still talking." });
    const g = buildGateway({ handler });
    g.callStore.failEvents = true;
    const { result } = await g.connect({ providerCallId: "CA-11" });
    if (!result.ok) throw new Error("expected a session");
    await g.settle(2_000);
    await g.caller.say(result.sessionId, "hello");
    await g.settle(3_000);
    await g.gateway.endSession(result.sessionId, "caller_hangup");
    const call = g.callStore.calls.get(result.call.id)!;
    expect(call.state).toBe("completed");
    expect(call.finalization).toBeTruthy();
    expect(g.callStore.events.has(call.id)).toBe(false);
  });

  it("shuts down every live session cleanly", async () => {
    const g = buildGateway({ handler: new ScriptedTurnHandler() });
    const a = await g.connect({ providerCallId: "CA-12" });
    await g.settle(2_000);
    await g.gateway.shutdown();
    expect(g.gateway.activeSessions).toBe(0);
    if (a.result.ok) {
      expect(g.callStore.calls.get(a.result.call.id)!.finalization!.hangupCause).toBe("gateway_shutdown");
    }
  });
});
