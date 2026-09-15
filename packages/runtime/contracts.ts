import type { AgentChannel, AgentConfig } from "@halo/core/domain/agents";
import type { Business, ChatMessage, KnowledgeSnippet, Receptionist } from "@halo/core/domain/types";
import type { ConversationState, ConversationStatePatch } from "./conversation-state";

/**
 * HALO Phase 2 — Agent Runtime contracts.
 *
 * Everything the runtime consumes or produces is declared here, once, in
 * provider-neutral and channel-neutral terms. The web chat channel is the
 * first consumer; phone, WhatsApp and future channels reuse these contracts
 * unchanged and differ only in their ChannelProfile and channel adapter.
 *
 * Trust model (non-negotiable, enforced by construction):
 *   - tenant identity, agent identity and agent version arrive in
 *     TrustedRequestContext / ResolvedAgentRuntimeContext, which only
 *     server-side code (routes + AgentResolver) constructs;
 *   - the model never sees or sets any of them;
 *   - the model may only PROPOSE actions (ToolIntent); application code
 *     authorizes, executes, verifies and records them (ToolResult /
 *     ActionRecord); the reply may narrate only what was verified.
 */

// ---------------------------------------------------------------------------
// Trusted request context
// ---------------------------------------------------------------------------

/**
 * Identity the runtime executes under. Built by server code from rows it
 * looked up itself (widget key → receptionist → conversation → agent
 * version). Never populated from a client payload.
 */
export interface TrustedRequestContext {
  businessId: string;
  conversationId: string;
  /** null on the receptionist compatibility path (no agent linkage yet). */
  agentId: string | null;
  agentVersionId: string | null;
  /** Correlation id for this turn; generated server-side per request. */
  turnId: string;
}

/**
 * The resolved agent context the runtime executes against: trusted tenant
 * identity, agent + version identity, validated configuration, the
 * persisted prompt template and model config. Built by the AgentResolver at
 * the boundary; the runtime never consults the client for any of it.
 */
export interface ResolvedAgentRuntimeContext {
  /** Trusted tenant identity — server-resolved, never client-supplied. */
  business: Business;
  agentId: string;
  agentVersionId: string;
  agentVersion: number;
  config: AgentConfig;
  /** The published prompt content from agent_versions.prompt_template. */
  promptTemplate: string;
  model?: ModelConfig;
  /**
   * Receptionist compatibility data. Present for the web channel during the
   * compatibility period (widget_key → receptionist → agent); the runtime
   * reads presentation settings (name, lead capture, custom instructions)
   * from here, never agent identity or tenant identity.
   */
  receptionist: Receptionist;
}

export interface ModelConfig {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Channel profile
// ---------------------------------------------------------------------------

export type ChannelProfileId = "web-chat" | "web-voice";

/**
 * What the runtime needs to know about the channel a turn is delivered on.
 * Phase 2 ships the web-chat profile and the browser-speech accessory
 * profile (existing behaviour: spoken replies, no markdown). Phone, WhatsApp
 * and SMS profiles are added by later phases — never by branching inside
 * the runtime on a channel name.
 */
export interface ChannelProfile {
  id: ChannelProfileId;
  channel: AgentChannel;
  modality: "text" | "voice";
  /** Hard upper bound on the delivered reply; longer replies are trimmed at a sentence boundary. */
  maxReplyChars: number;
  supportsMarkdown: boolean;
  supportsInterruption: boolean;
  /** Side-effecting tools must be confirmed by the visitor before execution. */
  requiresConfirmationForSideEffects: boolean;
  /** Whether model-proposed tool intents may be executed on this channel at all. */
  allowsToolExecution: boolean;
  latencySensitivity: "normal" | "high";
  /** Prompt guidance for reply formatting on this channel (rendered by the composer). */
  formattingRules: string;
  /** Extra delivery rules for spoken channels (rendered as its own section); null for text. */
  spokenDeliveryRules: string | null;
}

// ---------------------------------------------------------------------------
// Runtime input / output
// ---------------------------------------------------------------------------

/** Customer facts the application has AUTHORIZED the runtime to recall. */
export interface CustomerContext {
  name?: string;
  /** Short, factual lines; bounded by the context builder. */
  facts: string[];
}

export interface RuntimeInput {
  trusted: TrustedRequestContext;
  agent: ResolvedAgentRuntimeContext;
  channel: ChannelProfile;
  userMessage: string;
  /**
   * Supplied only when the application has verified who the visitor is
   * (never for anonymous web visitors). Omitted = no recall.
   */
  customer?: CustomerContext | null;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface RuntimeTimings {
  contextMs: number;
  retrievalMs: number;
  modelMs: number;
  actionsMs: number;
  validationMs: number;
  totalMs: number;
}

export interface RuntimeDegradation {
  /** The reply is the canned provider-outage fallback. */
  provider: boolean;
  /** Retrieval failed; the turn ran without knowledge. */
  knowledge: boolean;
  /** Conversation state could not be loaded or saved. */
  state: boolean;
  /** A system action provider failed; its section was omitted. */
  systemActions: boolean;
}

export interface RuntimeOutput {
  reply: string;
  turnId: string;
  /** Conversation state after this turn (already persisted when the store succeeded). */
  state: ConversationState;
  /** Every verified action this turn — system-initiated and tool-initiated. */
  actions: ActionRecord[];
  toolIntents: ToolIntent[];
  toolResults: ToolResult[];
  validation: ValidationOutcome;
  escalation: EscalationDecision;
  usage: UsageMetadata;
  events: RuntimeEvent[];
  timings: RuntimeTimings;
  degraded: RuntimeDegradation;
  /** The two rows appended to the transcript this turn (user, assistant). */
  transcript: ChatMessage[];
  /** A substantive question retrieved no knowledge (owner-facing gap signal). */
  knowledgeGap: boolean;
}

// ---------------------------------------------------------------------------
// Conversation context (ephemeral, per turn)
// ---------------------------------------------------------------------------

export interface ContextLimits {
  /** Recent verbatim messages kept in the model context. */
  maxRecentMessages: number;
  /** Older messages fetched for summary refresh (beyond the recent window). */
  maxHistoryFetch: number;
  /** Characters kept per message (older content trimmed from the end). */
  maxMessageChars: number;
  maxSummaryChars: number;
  maxKnowledgeSnippets: number;
  maxKnowledgeChars: number;
  maxToolDescriptors: number;
  maxCustomerFacts: number;
  /** Ceiling on the whole assembled context (system prompt + history), in characters. */
  maxTotalChars: number;
}

export interface KnowledgeContext {
  snippets: KnowledgeSnippet[];
  /** Source labels in snippet order, for citation and telemetry. */
  sources: string[];
  charsUsed: number;
  truncated: boolean;
  /** The query actually sent to retrieval (after preparation). */
  query: string;
}

export interface ConversationContext {
  trusted: TrustedRequestContext;
  business: Business;
  agent: {
    id: string | null;
    versionId: string | null;
    version: number;
    name: string;
    objective: string;
    language: string;
    promptTemplate: string;
    customInstructions: string;
    model: ModelConfig;
    leadCaptureEnabled: boolean;
  };
  channel: ChannelProfile;
  state: ConversationState;
  recentMessages: ChatMessage[];
  /** Older history folded into the rolling summary (bounded). */
  summary: string;
  knowledge: KnowledgeContext;
  /** Only the controlled capabilities offered THIS turn. */
  tools: ToolDescriptor[];
  /** Ground-truth sections from system actions (already executed and verified). */
  systemSections: string[];
  /** Verified actions before the model is called. */
  verifiedActions: ActionRecord[];
  customer: CustomerContext | null;
  budget: {
    limits: ContextLimits;
    totalChars: number;
    /** Which components were trimmed to respect the budget, in order. */
    trimmed: string[];
  };
}

// ---------------------------------------------------------------------------
// Tools / actions
// ---------------------------------------------------------------------------

/**
 * Categories of "I did X" claims a reply may make ONLY when a verified
 * action of that category happened this turn (act → verify → narrate).
 */
export type ActionClaimKind =
  | "appointment.book"
  | "appointment.reschedule"
  | "appointment.cancel"
  | "handoff"
  | "contact.saved";

/** What the model is told about a controlled capability. Never executable. */
export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the arguments (derived from the zod schema in the registry). */
  parameters: Record<string, unknown>;
  sideEffecting: boolean;
}

/** A model-proposed action, after schema validation. Not yet authorized. */
export interface ToolIntent {
  /** Provider call id when available, else generated. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  reason?: string;
  correlationId: string;
  /** Hash of (turn, name, arguments): the same proposal twice is one action. */
  idempotencyKey: string;
  round: number;
}

export type ToolRejectionReason =
  | "unknown_tool"
  | "not_granted"
  | "channel_disallowed"
  | "invalid_arguments"
  | "duplicate"
  | "confirmation_required"
  | "precondition_failed"
  | "budget_exhausted"
  | "not_bound";

export type ToolAuthorization =
  | { allowed: true }
  | { allowed: false; reason: ToolRejectionReason; message: string };

export interface ToolResult {
  intentId: string;
  name: string;
  status: "succeeded" | "failed" | "rejected";
  /** Model-facing description of what happened (bounded, no secrets). */
  summary: string;
  /** Structured, bounded data the model may narrate from. */
  data?: Record<string, unknown>;
  claimsPermitted: ActionClaimKind[];
  statePatch?: ConversationStatePatch;
  escalation?: { reason: EscalationReason; priority: EscalationPriority };
  rejection?: ToolRejectionReason;
  error?: { code: string; message: string };
}

/** A verified action record — the only thing narration may rely on. */
export interface ActionRecord {
  source: "system" | "tool";
  name: string;
  status: "succeeded" | "failed";
  claimsPermitted: ActionClaimKind[];
  summary: string;
  /** A failure the system cannot recover from on its own (escalation signal). */
  needsHuman?: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationViolationKind =
  | "empty_reply"
  | "unsupported_action_claim"
  | "instruction_leak"
  | "max_length"
  | "markdown_not_supported"
  | "invalid_json";

export interface ValidationViolation {
  kind: ValidationViolationKind;
  detail: string;
  /** Transform-repairable violations (length, formatting) never cost a model call. */
  repairable: "transform" | "regenerate" | "fallback";
}

export interface ValidationOutcome {
  ok: boolean;
  violations: ValidationViolation[];
  /** A regenerate round was used. */
  regenerated: boolean;
  /** The canned safe fallback replaced the model's reply. */
  fallbackUsed: boolean;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export type EscalationReason =
  | "explicit_human_request"
  | "repeated_misunderstanding"
  | "unsupported_request"
  | "sensitive_situation"
  | "action_failed"
  | "low_confidence";

export type EscalationPriority = "low" | "normal" | "high";

export interface EscalationDecision {
  escalate: boolean;
  reason?: EscalationReason;
  priority: EscalationPriority;
  /** Tenant-safe, transcript-free description for operators. */
  summary: string;
  recommendedAction: "none" | "notify_team" | "offer_callback";
}

// ---------------------------------------------------------------------------
// Usage + events
// ---------------------------------------------------------------------------

export interface ModelCallUsage {
  provider: string;
  model: string;
  purpose: "reply" | "tool_round" | "repair";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  streamed: boolean;
}

/** Aggregated per turn. Token fields are omitted when no call reported them. */
export interface UsageMetadata {
  provider: string;
  model: string;
  modelCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelLatencyMs: number;
  toolRounds: number;
  calls: ModelCallUsage[];
}

export type RuntimeEventType =
  | "runtime.started"
  | "context.built"
  | "knowledge.retrieved"
  | "model.requested"
  | "model.completed"
  | "model.failed"
  | "tool.intent_proposed"
  | "tool.intent_rejected"
  | "tool.capability_downgraded"
  | "action.executed"
  | "action.failed"
  | "response.validated"
  | "memory.updated"
  | "escalation.triggered"
  | "runtime.completed"
  | "runtime.failed";

/**
 * Structured, tenant-safe runtime telemetry. `data` carries counts, names,
 * codes and durations — never message text, prompts, secrets or PII.
 */
export interface RuntimeEvent {
  type: RuntimeEventType;
  at: string;
  turnId: string;
  conversationId: string;
  businessId: string;
  agentId?: string;
  agentVersionId?: string;
  data: Record<string, string | number | boolean | string[] | null>;
}

export interface RuntimeEventSink {
  emit(event: RuntimeEvent): void;
}
