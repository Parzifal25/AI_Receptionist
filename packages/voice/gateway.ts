import type {
  CallDisposition,
  CallEndReason,
  CallState,
  CallTranscriptTurn,
  CallUsage,
} from "@halo/core/domain/voice";
import { emptyCallUsage } from "@halo/core/domain/voice";
import type { StreamingSttProvider } from "@halo/ports/streaming-stt-provider";
import type { StreamingTtsProvider } from "@halo/ports/streaming-tts-provider";
import type { MediaInboundEvent, TelephonyProvider, TelephonyWebhookEvent } from "@halo/ports/telephony-provider";
import { logger } from "@halo/platform/logger";
import { audioDurationMs } from "./audio";
import { isTerminalCallState, pathToCallState } from "./call-state";
import type { CallRecord, CallStore, InboundRoute, OutcomeRecord } from "./call-store";
import type { VoiceTurnHandler } from "./turn-handler";
import {
  VoiceSession,
  type VoiceOutput,
  type VoiceSessionConfig,
  type VoiceSessionEvent,
  type VoiceSessionSummary,
} from "./voice-session";

/**
 * HALO Phase 3 — the Voice Gateway (plan §P5.1).
 *
 * The boundary between a telephony provider and HALO:
 *
 *   provider webhook / media socket
 *      → gateway            server-side routing, call identity, persistence,
 *                           capacity, correlation, latency + usage capture
 *      → VoiceSession       media loop, barge-in, interruption, silence
 *      → VoiceTurnHandler   conversation (the Agent Runtime, via the phone
 *                           channel adapter)
 *
 * The gateway owns no business logic and no conversation state. It holds:
 *   - tenant identity, which comes ONLY from `resolveInboundRoute` (a DID the
 *     platform provisioned), never from a provider payload or the model;
 *   - the call's technical state, advanced one legal transition at a time;
 *   - the event/transcript/outcome write path, which never fails a call;
 *   - bounded session capacity and a single media-reconnect window.
 *
 * Sessions are in-memory and belong to one process (the media socket for a
 * call must reach the instance that holds it — see docs/VOICE_ARCHITECTURE.md).
 */

const log = logger.child({ service: "voice-gateway" });

export interface VoiceCallContext {
  call: CallRecord;
  route: InboundRoute;
  conversationId: string;
  correlationId: string;
  /** Live transfer target, or null when the tenant configured none. */
  handoffNumber: string | null;
}

export interface OutcomeDraft {
  disposition: CallDisposition;
  dispositionReason: string | null;
  qualification: Record<string, unknown>;
  appointmentId: string | null;
  escalated: boolean;
  doNotCall: boolean;
}

export interface GatewayLimits {
  maxConcurrentSessions: number;
  /** Buffered call events flushed when this many accumulate. */
  eventFlushSize: number;
  eventFlushMs: number;
  /** How long a dropped media socket may reconnect before the call is finalized. */
  mediaReconnectMs: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = Object.freeze({
  maxConcurrentSessions: 50,
  eventFlushSize: 25,
  eventFlushMs: 2_000,
  mediaReconnectMs: 5_000,
});

export interface VoiceGatewayDeps {
  callStore: CallStore;
  stt: StreamingSttProvider;
  tts: StreamingTtsProvider;
  telephony: TelephonyProvider;
  /** Per-call conversation handler (production: the runtime-backed phone adapter). */
  createTurnHandler(ctx: VoiceCallContext): VoiceTurnHandler;
  /** Per-call session configuration (language, prompts, endpointing) from agent config. */
  sessionConfig(ctx: VoiceCallContext): VoiceSessionConfig;
  /** Deterministic business outcome. Default: `no_outcome` (never invented). */
  computeOutcome?(ctx: VoiceCallContext, summary: VoiceSessionSummary): OutcomeDraft;
  limits?: Partial<GatewayLimits>;
  now?: () => number;
}

export type StartSessionResult =
  | { ok: true; sessionId: string; call: CallRecord; reattached: boolean }
  | { ok: false; reason: "unknown_number" | "capacity" | "already_ended" | "provider_mismatch" };

interface Session {
  id: string;
  ctx: VoiceCallContext;
  session: VoiceSession;
  output: VoiceOutput;
  state: CallState;
  events: VoiceSessionEvent[];
  eventSeq: number;
  transcriptSeq: number;
  pendingTranscript: Array<CallTranscriptTurn & { seq: number }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  writes: Promise<void>;
  /** Set synchronously when the session ends, so callers can await finalization. */
  finalizing: Promise<void> | null;
  startedAt: number;
  answeredAt: string | null;
  latencies: Map<string, number[]>;
  finalized: boolean;
}

export class VoiceGateway {
  private readonly sessions = new Map<string, Session>();
  private readonly byProviderCall = new Map<string, string>();
  private readonly limits: GatewayLimits;
  private readonly now: () => number;

  constructor(private readonly deps: VoiceGatewayDeps) {
    this.limits = { ...DEFAULT_GATEWAY_LIMITS, ...(deps.limits ?? {}) };
    this.now = deps.now ?? Date.now;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  /**
   * Answer an inbound call: resolve the tenant from the dialled number,
   * create (or recover) the call row and conversation, and start the media
   * loop. Idempotent per provider call id; a second media socket for a live
   * call re-attaches instead of starting a second session.
   */
  async startSession(params: {
    provider: string;
    providerCallId: string;
    from: string;
    to: string;
    direction?: "inbound" | "outbound";
    output: VoiceOutput;
  }): Promise<StartSessionResult> {
    if (params.provider !== this.deps.telephony.name) return { ok: false, reason: "provider_mismatch" };
    const existingId = this.byProviderCall.get(this.key(params.provider, params.providerCallId));
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) {
      this.attachMedia(existing, params.output);
      return { ok: true, sessionId: existing.id, call: existing.ctx.call, reattached: true };
    }

    const route = await this.deps.callStore.resolveInboundRoute(params.provider, params.to);
    if (!route) return { ok: false, reason: "unknown_number" };
    if (this.sessions.size >= this.limits.maxConcurrentSessions) return { ok: false, reason: "capacity" };

    const direction = params.direction ?? "inbound";
    const { call, created } = await this.deps.callStore.createOrGetCall({
      businessId: route.business.id,
      agentId: route.agentId,
      agentVersionId: route.version.id,
      phoneNumberId: route.phoneNumberId,
      direction,
      provider: params.provider,
      providerCallId: params.providerCallId,
      fromNumber: params.from,
      toNumber: params.to,
      state: direction === "inbound" ? "ringing" : "created",
      language: route.version.config.language.primary || null,
    });
    if (isTerminalCallState(call.state)) return { ok: false, reason: "already_ended" };

    let conversationId = call.conversationId;
    if (!conversationId) {
      conversationId = await this.deps.callStore.createPhoneConversation({
        businessId: route.business.id,
        agentId: route.agentId,
        agentVersionId: route.version.id,
      });
      await this.deps.callStore.attachConversation(call.id, route.business.id, conversationId);
    }

    const ctx: VoiceCallContext = {
      call: { ...call, conversationId },
      route,
      conversationId,
      correlationId: call.correlationId,
      handoffNumber: this.deps.telephony.capabilities().transfer ? route.handoffNumber : null,
    };

    const entry: Session = {
      id: call.id,
      ctx,
      session: undefined as unknown as VoiceSession,
      output: params.output,
      state: call.state,
      events: [],
      eventSeq: 0,
      transcriptSeq: 0,
      pendingTranscript: [],
      flushTimer: null,
      reconnectTimer: null,
      writes: Promise.resolve(),
      finalizing: null,
      startedAt: this.now(),
      answeredAt: null,
      latencies: new Map(),
      finalized: false,
    };

    const handler = this.deps.createTurnHandler(ctx);
    const config = this.deps.sessionConfig(ctx);
    const codecFormat = this.deps.telephony.createMediaCodec().format;
    entry.session = new VoiceSession({
      stt: this.deps.stt,
      tts: this.deps.tts,
      turns: handler,
      output: proxyOutput(entry),
      inputFormat: codecFormat,
      config,
      now: this.now,
      hooks: {
        onEvent: (event) => this.onSessionEvent(entry, event),
        onTranscriptTurn: (turn) => this.onTranscriptTurn(entry, turn),
        onTransferRequested: (reason) => this.transfer(entry, reason),
        onEnded: (summary) => {
          entry.finalizing = this.finalize(entry, summary);
        },
      },
    });

    this.sessions.set(entry.id, entry);
    this.byProviderCall.set(this.key(params.provider, params.providerCallId), entry.id);

    await this.advanceTo(entry, "in_conversation");
    entry.answeredAt = new Date(this.now()).toISOString();
    if (created) {
      void this.deps.callStore
        .recordUsageEvent(route.business.id, "call_started", {
          callId: call.id,
          direction,
          agentId: route.agentId,
          agentVersionId: route.version.id,
          agentVersion: route.version.version,
          provider: params.provider,
          correlationId: call.correlationId,
        })
        .catch((error) => log.warn("call_started usage event failed", { error }));
    }
    entry.session.start();
    return { ok: true, sessionId: entry.id, call: ctx.call, reattached: false };
  }

  /** Caller audio in the provider's media format. */
  receiveAudio(sessionId: string, audio: Uint8Array): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.session.receiveAudio(audio);
  }

  /** Non-audio media-stream events, already decoded by the provider codec. */
  receiveEvent(sessionId: string, event: MediaInboundEvent): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    switch (event.type) {
      case "audio":
        entry.session.receiveAudio(event.audio);
        return;
      case "mark":
        entry.session.receiveMark(event.name);
        return;
      case "dtmf":
        entry.session.receiveDtmf(event.digit);
        return;
      case "stop":
        void this.endSession(sessionId, "caller_hangup");
        return;
      case "malformed":
        this.onSessionEvent(entry, {
          type: "provider_error",
          at: new Date(this.now()).toISOString(),
          latencyMs: null,
          detail: { component: "media", code: "malformed", retryable: false },
        });
        return;
      default:
        return;
    }
  }

  /** Send audio to the caller outside a turn (announcements, hold tones). */
  sendAudio(sessionId: string, audio: Uint8Array): void {
    this.sessions.get(sessionId)?.output.sendAudio(audio);
  }

  interrupt(sessionId: string, reason = "external"): boolean {
    return this.sessions.get(sessionId)?.session.interrupt(reason) ?? false;
  }

  /** Idempotent: ending an unknown or already-ended session is a no-op. */
  async endSession(sessionId: string, reason: CallEndReason): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    await entry.session.end(reason);
    await entry.finalizing;
    await entry.writes;
  }

  /**
   * The media socket dropped without a `stop`. The call is marked
   * interrupted and given one reconnect window before it is finalized.
   */
  mediaDisconnected(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.finalized || entry.reconnectTimer) return;
    this.onSessionEvent(entry, {
      type: "media_disconnected",
      at: new Date(this.now()).toISOString(),
      latencyMs: null,
      detail: { graceMs: this.limits.mediaReconnectMs },
    });
    void this.advanceTo(entry, "interrupted");
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.endSession(entry.id, "media_disconnected");
    }, this.limits.mediaReconnectMs);
  }

  /**
   * A verified provider webhook (status callback). Advances the technical
   * state and finalizes a call the provider says is over. Never trusts the
   * payload for tenant identity: the call row is looked up by provider id.
   */
  async handleProviderEvent(event: TelephonyWebhookEvent): Promise<void> {
    if (event.kind !== "call_status") return;
    const sessionId = this.byProviderCall.get(this.key(this.deps.telephony.name, event.providerCallId));
    const entry = sessionId ? this.sessions.get(sessionId) : undefined;
    if (entry) {
      if (["completed", "failed", "busy", "no_answer", "canceled"].includes(event.status)) {
        await this.endSession(entry.id, "provider_status");
      }
      return;
    }
    // No live session (never answered, or already torn down).
    const call = await this.deps.callStore.getCallByProviderId(this.deps.telephony.name, event.providerCallId);
    if (!call || isTerminalCallState(call.state)) return;
    const target: CallState =
      event.status === "busy" ? "busy" : event.status === "no_answer" ? "no_answer" : event.status === "failed" ? "failed" : event.status === "canceled" ? "cancelled" : "completed";
    await this.walk(call.id, call.businessId, call.state, target).catch((error) =>
      log.warn("provider status transition rejected", { error, providerCallId: event.providerCallId }),
    );
  }

  /** Ends every live session (deployment shutdown). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.endSession(id, "gateway_shutdown")));
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private key(provider: string, providerCallId: string): string {
    return `${provider}|${providerCallId}`;
  }

  private attachMedia(entry: Session, output: VoiceOutput): void {
    entry.output = output;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
      this.onSessionEvent(entry, {
        type: "media_reconnected",
        at: new Date(this.now()).toISOString(),
        latencyMs: null,
        detail: { component: "media" },
      });
      void this.advanceTo(entry, "in_conversation");
    }
  }

  private async transfer(entry: Session, reason: string): Promise<boolean> {
    const target = entry.ctx.handoffNumber;
    if (!target) return false;
    try {
      await this.deps.telephony.transfer(entry.ctx.call.providerCallId, { phoneNumber: target });
      return true;
    } catch (error) {
      log.warn("transfer failed", { callId: entry.ctx.call.id, reason, error });
      return false;
    }
  }

  private onSessionEvent(entry: Session, event: VoiceSessionEvent): void {
    entry.events.push(event);
    if (event.latencyMs !== null) {
      const bucket = entry.latencies.get(event.type) ?? [];
      bucket.push(event.latencyMs);
      entry.latencies.set(event.type, bucket);
    }
    if (entry.events.length >= this.limits.eventFlushSize) {
      this.flush(entry);
      return;
    }
    if (!entry.flushTimer) {
      entry.flushTimer = setTimeout(() => this.flush(entry), this.limits.eventFlushMs);
    }
  }

  private onTranscriptTurn(entry: Session, turn: CallTranscriptTurn): void {
    entry.pendingTranscript.push({ ...turn, seq: entry.transcriptSeq++ });
    if (entry.pendingTranscript.length >= this.limits.eventFlushSize) this.flush(entry);
  }

  /** Persistence never blocks or fails the call; writes stay ordered per call. */
  private flush(entry: Session): void {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    const events = entry.events.splice(0, entry.events.length).map((event) => ({
      seq: entry.eventSeq++,
      type: event.type,
      at: event.at,
      latencyMs: event.latencyMs,
      detail: event.detail,
    }));
    const turns = entry.pendingTranscript.splice(0, entry.pendingTranscript.length);
    if (events.length === 0 && turns.length === 0) return;
    const { id, ctx } = entry;
    entry.writes = entry.writes
      .then(async () => {
        if (events.length > 0) await this.deps.callStore.appendEvents(id, ctx.call.businessId, events);
        if (turns.length > 0) await this.deps.callStore.appendTranscript(id, ctx.call.businessId, turns);
      })
      .catch((error) => log.warn("call telemetry persistence failed", { callId: id, error }));
  }

  private async advanceTo(entry: Session, target: CallState): Promise<void> {
    try {
      entry.state = await this.walk(entry.id, entry.ctx.call.businessId, entry.state, target);
    } catch (error) {
      log.warn("call state transition failed", { callId: entry.id, from: entry.state, target, error });
    }
  }

  /** Walks the legal path so every persisted transition is individually valid. */
  private async walk(callId: string, businessId: string, from: CallState, target: CallState): Promise<CallState> {
    const path = pathToCallState(from, target);
    if (path === null) throw new Error(`no legal path from ${from} to ${target}`);
    let current = from;
    for (const next of path) {
      await this.deps.callStore.transitionCall(callId, businessId, current, next);
      current = next;
    }
    return current;
  }

  private async finalize(entry: Session, summary: VoiceSessionSummary): Promise<void> {
    if (entry.finalized) return;
    entry.finalized = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    this.sessions.delete(entry.id);
    this.byProviderCall.delete(this.key(entry.ctx.call.provider, entry.ctx.call.providerCallId));

    const endedAt = new Date(this.now()).toISOString();
    const usage = usageFrom(summary);
    const target = terminalStateFor(summary.endReason);
    await this.advanceTo(entry, target);
    this.flush(entry);

    const store = this.deps.callStore;
    const businessId = entry.ctx.call.businessId;
    entry.writes = entry.writes
      .then(async () => {
        await store.finalizeCall(entry.id, businessId, {
          endedAt,
          answeredAt: entry.answeredAt,
          durationSeconds: Math.max(0, Math.round((this.now() - entry.startedAt) / 1000)),
          hangupCause: summary.endReason,
          usage,
        });
        const draft = this.outcomeFor(entry.ctx, summary);
        const outcome: OutcomeRecord = {
          businessId,
          callId: entry.id,
          conversationId: entry.ctx.conversationId,
          agentId: entry.ctx.call.agentId,
          agentVersionId: entry.ctx.call.agentVersionId,
          ...draft,
        };
        await store.recordOutcome(outcome);
        // A do-not-call outcome suppresses the number immediately and permanently.
        if (draft.doNotCall && entry.ctx.call.fromNumber) {
          await store.suppress({ businessId, e164: entry.ctx.call.fromNumber, reason: "do_not_call", callId: entry.id });
        }
        await store.recordUsageEvent(businessId, "call_completed", {
          callId: entry.id,
          agentId: entry.ctx.call.agentId,
          agentVersionId: entry.ctx.call.agentVersionId,
          agentVersion: entry.ctx.route.version.version,
          correlationId: entry.ctx.correlationId,
          endReason: summary.endReason,
          disposition: draft.disposition,
          turns: summary.turns,
          bargeIns: summary.bargeIns,
          usage,
          latency: latencySummary(entry.latencies),
        });
      })
      .catch((error) => log.error("call finalization failed", { callId: entry.id, error }));
    await entry.writes;
  }

  private outcomeFor(ctx: VoiceCallContext, summary: VoiceSessionSummary): OutcomeDraft {
    if (this.deps.computeOutcome) {
      try {
        return this.deps.computeOutcome(ctx, summary);
      } catch (error) {
        log.warn("outcome computation failed; recording no_outcome", { callId: ctx.call.id, error });
      }
    }
    return {
      // No outcome policy configured: record the honest default rather than
      // guessing what the conversation achieved.
      disposition: summary.transferred ? "escalated_to_human" : "no_outcome",
      dispositionReason: summary.transferred ? "transferred to a human" : "no outcome policy configured",
      qualification: {},
      appointmentId: null,
      escalated: summary.transferRequested,
      doNotCall: false,
    };
  }
}

function proxyOutput(entry: Session): VoiceOutput {
  return {
    get format() {
      return entry.output.format;
    },
    get supportsMarks() {
      return entry.output.supportsMarks;
    },
    sendAudio: (audio) => entry.output.sendAudio(audio),
    clear: () => entry.output.clear(),
    mark: (name) => entry.output.mark(name),
  };
}

function terminalStateFor(reason: CallEndReason): CallState {
  switch (reason) {
    case "transferred":
      return "transferred";
    case "stt_failure":
    case "tts_failure":
    case "rejected":
      return "failed";
    default:
      return "completed";
  }
}

function usageFrom(summary: VoiceSessionSummary): CallUsage {
  return {
    ...emptyCallUsage(),
    inboundAudioSeconds: round2(summary.inboundAudioMs / 1000),
    outboundAudioSeconds: round2(summary.outboundAudioMs / 1000),
    ttsCharacters: summary.ttsCharacters,
    agentTurns: summary.turns,
    modelCalls: summary.modelCalls,
    ...(summary.inputTokens !== undefined ? { inputTokens: summary.inputTokens } : {}),
    ...(summary.outputTokens !== undefined ? { outputTokens: summary.outputTokens } : {}),
    bargeIns: summary.bargeIns,
    // No pricing configuration exists: cost is reported unavailable.
    costEstimate: null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** p50/p95 per latency-bearing event type — measured, never assumed. */
export function latencySummary(latencies: Map<string, number[]>): Record<string, { p50: number; p95: number; n: number }> {
  const out: Record<string, { p50: number; p95: number; n: number }> = {};
  for (const [type, values] of latencies) {
    if (values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    out[type] = {
      p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
      p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
      n: sorted.length,
    };
  }
  return out;
}

export { audioDurationMs };
