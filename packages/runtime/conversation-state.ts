import { z } from "zod";
import type { EscalationReason } from "./contracts";

/**
 * HALO Phase 2 — conversation state (Workstream 4).
 *
 * Three kinds of state exist around a conversation and they are kept apart:
 *
 *   1. DURABLE BUSINESS STATE — appointments, leads, customers, workflow
 *      runs. Owned by their services and tables; the runtime never writes
 *      them directly and the model never defines them.
 *   2. CONVERSATION STATE (this module) — the runtime's typed working memory
 *      for one conversation: what the visitor is trying to do, what has been
 *      collected, what is pending, whether a human was requested, and the
 *      rolling summary. Persisted per conversation, tenant-scoped.
 *   3. EPHEMERAL MODEL CONTEXT — the bounded prompt assembled per turn
 *      (ConversationContext). Never persisted.
 *
 * Updates are applied ONLY through `applyStatePatch`, which validates and
 * bounds every field. Patches come from deterministic code (tool executors,
 * the memory manager, the escalation manager) — never straight from model
 * text. The booking draft (`booking_drafts`) is untouched: it remains the
 * scheduling engine's own durable draft; this state does not duplicate it.
 */

export const CONVERSATION_STATE_VERSION = 1 as const;

export const STATE_LIMITS = {
  maxSlots: 24,
  maxSlotKeyChars: 40,
  maxSlotValueChars: 240,
  maxIntentChars: 64,
  maxWorkflowStepChars: 64,
  maxSummaryChars: 1200,
  maxPendingPayloadKeys: 12,
} as const;

const slotKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const slotValue = z.string().max(STATE_LIMITS.maxSlotValueChars);

const escalationReason = z.enum([
  "explicit_human_request",
  "repeated_misunderstanding",
  "unsupported_request",
  "sensitive_situation",
  "action_failed",
  "low_confidence",
]) satisfies z.ZodType<EscalationReason>;

export const pendingConfirmationSchema = z.object({
  /** The controlled tool awaiting a visitor "yes". */
  toolName: z.string().min(1).max(64),
  arguments: z
    .record(slotKey, slotValue)
    .refine((r) => Object.keys(r).length <= STATE_LIMITS.maxPendingPayloadKeys, "too many keys"),
  requestedAt: z.string(),
});

export const lastToolIntentSchema = z.object({
  name: z.string().min(1).max(64),
  correlationId: z.string().min(1).max(128),
  status: z.enum(["succeeded", "failed", "rejected"]),
  at: z.string(),
});

export const conversationStateSchema = z.object({
  version: z.literal(CONVERSATION_STATE_VERSION),
  /** What the visitor is currently trying to accomplish, if known. */
  intent: z.string().max(STATE_LIMITS.maxIntentChars).nullable(),
  /** Facts collected during the conversation (not authoritative business data). */
  slots: z
    .record(slotKey, slotValue)
    .refine((r) => Object.keys(r).length <= STATE_LIMITS.maxSlots, "too many slots"),
  /** Qualification answers, same bounds as slots, kept separate for clarity. */
  qualification: z
    .record(slotKey, slotValue)
    .refine((r) => Object.keys(r).length <= STATE_LIMITS.maxSlots, "too many fields"),
  pendingConfirmation: pendingConfirmationSchema.nullable(),
  workflowStep: z.string().max(STATE_LIMITS.maxWorkflowStepChars).nullable(),
  lastToolIntent: lastToolIntentSchema.nullable(),
  escalation: z.object({
    status: z.enum(["none", "requested", "triggered"]),
    reason: escalationReason.nullable(),
    at: z.string().nullable(),
  }),
  summary: z.object({
    text: z.string().max(STATE_LIMITS.maxSummaryChars),
    /** Absolute count of transcript messages folded into `text`. */
    throughMessageCount: z.int().min(0),
    updatedAt: z.string().nullable(),
  }),
  /** Absolute transcript length the runtime has observed (user + assistant rows). */
  messagesObserved: z.int().min(0),
  /** Consecutive substantive questions with no grounding and no action. */
  unansweredStreak: z.int().min(0),
  turnCount: z.int().min(0),
});

export type ConversationState = z.infer<typeof conversationStateSchema>;

export function emptyConversationState(): ConversationState {
  return {
    version: CONVERSATION_STATE_VERSION,
    intent: null,
    slots: {},
    qualification: {},
    pendingConfirmation: null,
    workflowStep: null,
    lastToolIntent: null,
    escalation: { status: "none", reason: null, at: null },
    summary: { text: "", throughMessageCount: 0, updatedAt: null },
    messagesObserved: 0,
    unansweredStreak: 0,
    turnCount: 0,
  };
}

/**
 * A bounded, declarative change. Slots/qualification merge key-by-key
 * (undefined leaves a key alone, null deletes it); everything else replaces.
 */
export const conversationStatePatchSchema = z.object({
  intent: z.string().max(STATE_LIMITS.maxIntentChars).nullable().optional(),
  slots: z.record(slotKey, slotValue.nullable()).optional(),
  qualification: z.record(slotKey, slotValue.nullable()).optional(),
  pendingConfirmation: pendingConfirmationSchema.nullable().optional(),
  workflowStep: z.string().max(STATE_LIMITS.maxWorkflowStepChars).nullable().optional(),
  lastToolIntent: lastToolIntentSchema.nullable().optional(),
  escalation: z
    .object({
      status: z.enum(["none", "requested", "triggered"]),
      reason: escalationReason.nullable(),
      at: z.string().nullable(),
    })
    .optional(),
  summary: z
    .object({
      text: z.string().max(STATE_LIMITS.maxSummaryChars),
      throughMessageCount: z.int().min(0),
      updatedAt: z.string().nullable(),
    })
    .optional(),
  messagesObserved: z.int().min(0).optional(),
  unansweredStreak: z.int().min(0).optional(),
  turnCount: z.int().min(0).optional(),
});

export type ConversationStatePatch = z.infer<typeof conversationStatePatchSchema>;

/**
 * Parses persisted state. Malformed or foreign-version rows degrade to a
 * fresh state (logged by the caller) — the turn never fails on state.
 */
export function parseConversationState(raw: unknown): ConversationState | null {
  const parsed = conversationStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function mergeRecord(
  base: Record<string, string>,
  patch: Record<string, string | null> | undefined,
  limit: number,
): Record<string, string> {
  if (!patch) return base;
  const next: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  // Deterministic overflow policy: keep the first `limit` keys in insertion
  // order (existing keys keep precedence over newly added ones).
  const keys = Object.keys(next);
  if (keys.length > limit) {
    for (const key of keys.slice(limit)) delete next[key];
  }
  return next;
}

/**
 * Applies a patch deterministically. Throws a ZodError for an invalid patch
 * (a programming error in the producer — never model input, which is
 * validated at the tool boundary before it can become a patch).
 */
export function applyStatePatch(
  state: ConversationState,
  rawPatch: ConversationStatePatch,
): ConversationState {
  const patch = conversationStatePatchSchema.parse(rawPatch);
  return {
    version: CONVERSATION_STATE_VERSION,
    intent: patch.intent !== undefined ? patch.intent : state.intent,
    slots: mergeRecord(state.slots, patch.slots, STATE_LIMITS.maxSlots),
    qualification: mergeRecord(state.qualification, patch.qualification, STATE_LIMITS.maxSlots),
    pendingConfirmation:
      patch.pendingConfirmation !== undefined ? patch.pendingConfirmation : state.pendingConfirmation,
    workflowStep: patch.workflowStep !== undefined ? patch.workflowStep : state.workflowStep,
    lastToolIntent: patch.lastToolIntent !== undefined ? patch.lastToolIntent : state.lastToolIntent,
    escalation: patch.escalation ?? state.escalation,
    summary: patch.summary ?? state.summary,
    messagesObserved: patch.messagesObserved ?? state.messagesObserved,
    unansweredStreak: patch.unansweredStreak ?? state.unansweredStreak,
    turnCount: patch.turnCount ?? state.turnCount,
  };
}

/** Whether the state carries anything worth showing the model. */
export function hasStateContent(state: ConversationState): boolean {
  return (
    state.intent !== null ||
    Object.keys(state.slots).length > 0 ||
    Object.keys(state.qualification).length > 0 ||
    state.pendingConfirmation !== null ||
    state.workflowStep !== null ||
    state.escalation.status !== "none"
  );
}

/**
 * Persistence port. Implementations are tenant-scoped by construction:
 * every method takes the trusted businessId and must scope its query by it.
 * Load failures return null (degrade), save failures throw (caller logs).
 */
export interface ConversationStateStore {
  load(conversationId: string, businessId: string): Promise<ConversationState | null>;
  save(conversationId: string, businessId: string, state: ConversationState): Promise<void>;
}

/** In-memory store for tests and single-process harnesses. */
export class InMemoryConversationStateStore implements ConversationStateStore {
  readonly rows = new Map<string, { businessId: string; state: ConversationState }>();

  async load(conversationId: string, businessId: string): Promise<ConversationState | null> {
    const row = this.rows.get(conversationId);
    if (!row || row.businessId !== businessId) return null;
    return parseConversationState(structuredClone(row.state));
  }

  async save(conversationId: string, businessId: string, state: ConversationState): Promise<void> {
    const existing = this.rows.get(conversationId);
    if (existing && existing.businessId !== businessId) {
      throw new Error("conversation state belongs to another tenant");
    }
    this.rows.set(conversationId, { businessId, state: structuredClone(conversationStateSchema.parse(state)) });
  }
}
