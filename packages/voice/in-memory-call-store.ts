import { randomUUID } from "node:crypto";
import type { CallTranscriptTurn } from "@halo/core/domain/voice";
import { assertCallTransition } from "./call-state";
import type {
  CallEventRecord,
  CallFinalization,
  CallRecord,
  CallStore,
  InboundRoute,
  NewCall,
  OutcomeRecord,
} from "./call-store";

/**
 * In-memory CallStore for tests and the mock demo. Enforces the same
 * invariants the 0020 schema does — idempotent call creation, the call state
 * graph with terminal protection, per-call unique sequence numbers, one
 * outcome per call and tenant scoping on every access — so gateway tests
 * exercise real semantics, not a permissive stub.
 */
export class InMemoryCallStore implements CallStore {
  readonly routes = new Map<string, InboundRoute>();
  readonly calls = new Map<string, CallRecord & { finalization?: CallFinalization; language: string | null }>();
  readonly events = new Map<string, CallEventRecord[]>();
  readonly transcripts = new Map<string, Array<CallTranscriptTurn & { seq: number }>>();
  readonly outcomes = new Map<string, OutcomeRecord>();
  readonly conversations = new Map<string, { businessId: string; agentId: string; agentVersionId: string }>();
  readonly suppressions = new Map<string, { reason: string; callId: string }>();
  readonly usageEvents: Array<{ businessId: string; type: string; metadata: Record<string, unknown> }> = [];
  failEvents = false;

  addRoute(provider: string, e164: string, route: InboundRoute): void {
    this.routes.set(`${provider}|${e164}`, route);
  }

  async resolveInboundRoute(provider: string, toNumber: string): Promise<InboundRoute | null> {
    const route = this.routes.get(`${provider}|${toNumber}`);
    if (!route || route.agentStatus !== "active" || !route.version.publishedAt) return null;
    return route;
  }

  async createOrGetCall(input: NewCall): Promise<{ call: CallRecord; created: boolean }> {
    const existing = await this.getCallByProviderId(input.provider, input.providerCallId);
    if (existing) return { call: existing, created: false };
    const call = {
      id: randomUUID(),
      businessId: input.businessId,
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      conversationId: null,
      phoneNumberId: input.phoneNumberId,
      direction: input.direction,
      provider: input.provider,
      providerCallId: input.providerCallId,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      state: input.state,
      correlationId: randomUUID(),
      language: input.language,
    };
    this.calls.set(call.id, call);
    return { call: { ...call }, created: true };
  }

  async getCallByProviderId(provider: string, providerCallId: string): Promise<CallRecord | null> {
    for (const call of this.calls.values()) {
      if (call.provider === provider && call.providerCallId === providerCallId) return { ...call };
    }
    return null;
  }

  async createPhoneConversation(input: { businessId: string; agentId: string; agentVersionId: string }): Promise<string> {
    const id = randomUUID();
    this.conversations.set(id, input);
    return id;
  }

  async attachConversation(callId: string, businessId: string, conversationId: string): Promise<void> {
    const call = this.scoped(callId, businessId);
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.businessId !== businessId) throw new Error("conversation tenant mismatch");
    call.conversationId = conversationId;
  }

  async transitionCall(callId: string, businessId: string, from: CallState, to: CallState): Promise<void> {
    const call = this.scoped(callId, businessId);
    if (call.state !== from) throw new Error(`call state is ${call.state}, expected ${from}`);
    assertCallTransition(from, to);
    call.state = to;
  }

  async appendEvents(callId: string, businessId: string, events: CallEventRecord[]): Promise<void> {
    if (this.failEvents) throw new Error("event store unavailable");
    this.scoped(callId, businessId);
    const list = this.events.get(callId) ?? [];
    for (const event of events) if (!list.some((e) => e.seq === event.seq)) list.push(event);
    this.events.set(callId, list);
  }

  async appendTranscript(callId: string, businessId: string, turns: Array<CallTranscriptTurn & { seq: number }>): Promise<void> {
    this.scoped(callId, businessId);
    const list = this.transcripts.get(callId) ?? [];
    for (const turn of turns) if (!list.some((t) => t.seq === turn.seq)) list.push(turn);
    this.transcripts.set(callId, list);
  }

  async finalizeCall(callId: string, businessId: string, finalization: CallFinalization): Promise<void> {
    this.scoped(callId, businessId).finalization = finalization;
  }

  async recordOutcome(outcome: OutcomeRecord): Promise<void> {
    this.scoped(outcome.callId, outcome.businessId);
    if (!this.outcomes.has(outcome.callId)) this.outcomes.set(outcome.callId, outcome);
  }

  async isSuppressed(businessId: string, e164: string): Promise<boolean> {
    return this.suppressions.has(`${businessId}|${e164}`);
  }

  async suppress(input: { businessId: string; e164: string; reason: "do_not_call" | "wrong_number"; callId: string }): Promise<void> {
    const key = `${input.businessId}|${input.e164}`;
    if (!this.suppressions.has(key)) this.suppressions.set(key, { reason: input.reason, callId: input.callId });
  }

  async recordUsageEvent(businessId: string, type: "call_started" | "call_completed", metadata: Record<string, unknown>) {
    this.usageEvents.push({ businessId, type, metadata });
  }

  private scoped(callId: string, businessId: string) {
    const call = this.calls.get(callId);
    if (!call || call.businessId !== businessId) throw new Error("call not found for tenant");
    return call;
  }
}

type CallState = CallRecord["state"];
