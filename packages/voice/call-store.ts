import type { AgentVersion } from "@halo/core/domain/agents";
import type { Business } from "@halo/core/domain/types";
import type {
  CallDirection,
  CallDisposition,
  CallEndReason,
  CallEventType,
  CallState,
  CallTranscriptTurn,
  CallUsage,
} from "@halo/core/domain/voice";

/**
 * HALO Phase 3 — call persistence port.
 *
 * Every method is tenant-scoped by an explicit `businessId` that the gateway
 * obtained from server-side routing (`resolveInboundRoute`), never from the
 * provider payload or the model. Implementations must be idempotent where
 * the provider may retry (call creation, event/transcript flushes, outcome).
 * The Postgres implementation additionally relies on the 0020 triggers
 * (ownership, state graph) as a second line of defence.
 */

export interface InboundRoute {
  phoneNumberId: string;
  business: Business;
  agentId: string;
  agentStatus: "draft" | "active" | "paused" | "archived";
  /** The agent's live published version at routing time; pinned for the whole call. */
  version: AgentVersion;
  handoffNumber: string | null;
}

export interface CallRecord {
  id: string;
  businessId: string;
  agentId: string;
  agentVersionId: string;
  conversationId: string | null;
  phoneNumberId: string | null;
  direction: CallDirection;
  provider: string;
  providerCallId: string;
  fromNumber: string;
  toNumber: string;
  state: CallState;
  correlationId: string;
}

export interface NewCall {
  businessId: string;
  agentId: string;
  agentVersionId: string;
  phoneNumberId: string | null;
  direction: CallDirection;
  provider: string;
  providerCallId: string;
  fromNumber: string;
  toNumber: string;
  state: CallState;
  language: string | null;
}

export interface CallEventRecord {
  seq: number;
  type: CallEventType;
  at: string;
  latencyMs: number | null;
  detail: Record<string, string | number | boolean | null>;
}

export interface CallFinalization {
  endedAt: string;
  answeredAt: string | null;
  durationSeconds: number | null;
  hangupCause: CallEndReason;
  usage: CallUsage;
}

export interface OutcomeRecord {
  businessId: string;
  callId: string;
  conversationId: string | null;
  agentId: string;
  agentVersionId: string;
  disposition: CallDisposition;
  dispositionReason: string | null;
  qualification: Record<string, unknown>;
  appointmentId: string | null;
  escalated: boolean;
  doNotCall: boolean;
}

export interface CallStore {
  /** Active number → active agent with a live version, or null (call is rejected). */
  resolveInboundRoute(provider: string, toNumber: string): Promise<InboundRoute | null>;
  /** Idempotent on (provider, providerCallId). */
  createOrGetCall(input: NewCall): Promise<{ call: CallRecord; created: boolean }>;
  getCallByProviderId(provider: string, providerCallId: string): Promise<CallRecord | null>;
  /** Creates the phone conversation row the runtime transcript and state hang off. */
  createPhoneConversation(input: { businessId: string; agentId: string; agentVersionId: string }): Promise<string>;
  attachConversation(callId: string, businessId: string, conversationId: string): Promise<void>;
  /** One legal transition (callers walk multi-step paths). Rejects illegal/terminal moves. */
  transitionCall(callId: string, businessId: string, from: CallState, to: CallState): Promise<void>;
  appendEvents(callId: string, businessId: string, events: CallEventRecord[]): Promise<void>;
  appendTranscript(callId: string, businessId: string, turns: Array<CallTranscriptTurn & { seq: number }>): Promise<void>;
  finalizeCall(callId: string, businessId: string, finalization: CallFinalization): Promise<void>;
  /** Idempotent: one outcome per call (later writes for the same call are ignored). */
  recordOutcome(outcome: OutcomeRecord): Promise<void>;
  isSuppressed(businessId: string, e164: string): Promise<boolean>;
  /** Idempotent. */
  suppress(input: { businessId: string; e164: string; reason: "do_not_call" | "wrong_number"; callId: string }): Promise<void>;
  recordUsageEvent(businessId: string, type: "call_started" | "call_completed", metadata: Record<string, unknown>): Promise<void>;
}
