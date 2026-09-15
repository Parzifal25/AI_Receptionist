import type { Business, ChatMessage } from "@halo/core/domain/types";
import type {
  ActionRecord,
  ConversationContext,
  ResolvedAgentRuntimeContext,
  RuntimeOutput,
  ToolIntent,
  ToolResult,
  TrustedRequestContext,
} from "./contracts";
import type { ConversationState, ConversationStatePatch } from "./conversation-state";

/**
 * HALO Phase 2 — extension ports around the runtime.
 *
 * SystemActionProvider — deterministic, application-owned actions that run
 *   BEFORE the model is called and hand it verified ground truth (the
 *   existing scheduling orchestrator is the first one). This is the
 *   "orchestrator-mediated" action path: no model proposal is involved,
 *   application code decides and acts, and the model only narrates.
 *
 * TurnHook — application-owned post-turn work (e.g. lead capture) that
 *   observes the completed turn. Failures are logged, never propagated.
 *
 * ConversationStore — transcript persistence, tenant-scoped.
 *
 * The runtime knows none of these by name; it only knows the ports.
 */

export interface SystemActionInput {
  trusted: TrustedRequestContext;
  business: Business;
  /** Chronological conversational history before this turn (bounded). */
  history: ChatMessage[];
  userMessage: string;
  state: ConversationState;
  now: Date;
}

export interface SystemActionOutcome {
  /** Prompt sections describing verified ground truth for this turn. */
  sections: string[];
  actions: ActionRecord[];
  statePatch?: ConversationStatePatch;
}

export interface SystemActionProvider {
  readonly name: string;
  /** null = nothing to contribute this turn. Throwing degrades the turn (logged), never fails it. */
  prepare(input: SystemActionInput): Promise<SystemActionOutcome | null>;
}

export interface TurnHookInput {
  trusted: TrustedRequestContext;
  agent: ResolvedAgentRuntimeContext;
  context: ConversationContext;
  output: RuntimeOutput;
  /** Full conversational transcript including this turn. */
  transcript: ChatMessage[];
}

export interface TurnHook {
  readonly name: string;
  afterTurn(input: TurnHookInput): Promise<void>;
}

export interface ToolTranscriptRecord {
  intent: ToolIntent;
  result: ToolResult;
}

export interface ConversationStore {
  loadHistory(conversationId: string, businessId: string, limit: number): Promise<ChatMessage[]>;
  appendMessages(conversationId: string, businessId: string, messages: ChatMessage[]): Promise<void>;
  /** Optional: transcribe tool-call turns (messages.role = 'tool'). */
  appendToolRecords?(
    conversationId: string,
    businessId: string,
    records: ToolTranscriptRecord[],
  ): Promise<void>;
}
