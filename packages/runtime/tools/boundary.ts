import { createHash } from "node:crypto";
import { isExplicitConfirmation, type ConfirmationDetector } from "@halo/language/confirmation";
import type { LLMToolCall } from "@halo/ports/llm-provider";
import { toolCallArguments } from "../llm-adapter";
import type {
  ChannelProfile,
  ToolAuthorization,
  ToolDescriptor,
  ToolIntent,
  ToolRejectionReason,
  ToolResult,
} from "../contracts";
import type { ConversationState } from "../conversation-state";
import type { ControlledToolDefinition, ToolExecutionContext, ToolExecutor, ToolRegistry } from "./registry";

/**
 * HALO Phase 2 — the tool-intent boundary (Workstream 8).
 *
 * Four strictly separated steps, each producing a typed record:
 *   1. selectTools     — which controlled capabilities are OFFERED this turn
 *                        (granted ∩ bound ∩ channel-allowed ∩ precondition met,
 *                        and only when the provider takes native tools);
 *   2. toToolIntent    — a raw model call becomes a ToolIntent only after
 *                        its name is known and its arguments validate;
 *   3. authorizeIntent — application policy decides (offered? duplicate?
 *                        channel? confirmation? precondition? bound?);
 *   4. executeIntent   — the bound executor runs against existing trusted
 *                        services; the outcome becomes a ToolResult.
 * The model influences step 2's input and nothing else.
 */

export const TOOL_BOUNDARY_LIMITS = {
  maxIntentsPerRound: 3,
  maxSummaryChars: 600,
  maxReasonChars: 200,
  maxRawArgsChars: 4000,
} as const;

/**
 * Deterministic "yes" detection for confirmation-gated tools.
 *
 * Until Sprint 2 this was an English-only regular expression, so a caller who
 * said "సరే" could not confirm anything: the guard did not reject them, it
 * simply never matched, and the action stayed blocked with no sign that the
 * language was the reason. `classifyConfirmation` replaces it with a
 * multilingual, rule-ordered reading that still treats rejection, hedging and
 * question forms as "not a yes" — and the English contract is unchanged,
 * because the same start-anchored rule still applies to English utterances.
 *
 * It remains ONE conjunct of the authorization below, never a shortcut past
 * it: a confirmation must already be pending AND must name this exact tool.
 */
const defaultConfirmationDetector: ConfirmationDetector = isExplicitConfirmation;

export interface SelectToolsParams {
  registry: ToolRegistry;
  grantedToolIds: string[];
  channel: ChannelProfile;
  providerSupportsTools: boolean;
  execution: ToolExecutionContext;
}

export interface SelectedTools {
  descriptors: ToolDescriptor[];
  /** Tools were granted and bound but the provider cannot take native tools. */
  downgraded: boolean;
  /** Tool names excluded because their state precondition is unmet. */
  gated: string[];
}

export function selectTools(params: SelectToolsParams): SelectedTools {
  const bound = new Set(params.registry.boundNames());
  const granted = [...new Set(params.grantedToolIds)].filter((name) => bound.has(name)).sort();
  if (granted.length === 0 || !params.channel.allowsToolExecution) {
    return { descriptors: [], downgraded: false, gated: [] };
  }
  const gated: string[] = [];
  const descriptors: ToolDescriptor[] = [];
  for (const name of granted) {
    const def = params.registry.definition(name)!;
    if (def.precondition && def.precondition(params.execution) !== null) {
      gated.push(name);
      continue;
    }
    const descriptor = params.registry.descriptor(name);
    if (descriptor) descriptors.push(descriptor);
  }
  if (!params.providerSupportsTools) {
    return { descriptors: [], downgraded: descriptors.length > 0, gated };
  }
  return { descriptors, downgraded: false, gated };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function idempotencyKeyFor(turnId: string, name: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${turnId}|${name}|${canonicalJson(args)}`).digest("hex").slice(0, 32);
}

function rejected(call: LLMToolCall, reason: ToolRejectionReason, message: string): ToolResult {
  return {
    intentId: call.id,
    name: typeof call.name === "string" ? call.name.slice(0, 64) : "unknown",
    status: "rejected",
    summary: message,
    claimsPermitted: [],
    rejection: reason,
  };
}

/**
 * Validates a raw model tool call into a ToolIntent. Unknown tools and
 * invalid arguments never become intents — they become rejected results the
 * model is told about.
 */
export function toToolIntent(params: {
  call: LLMToolCall;
  registry: ToolRegistry;
  turnId: string;
  round: number;
}): { intent: ToolIntent } | { rejected: ToolResult } {
  const { call, registry } = params;
  const name = typeof call.name === "string" ? call.name : "";
  const def = registry.definition(name);
  if (!def) {
    return { rejected: rejected(call, "unknown_tool", `"${name.slice(0, 64)}" is not an available action.`) };
  }
  if (typeof call.arguments === "string" && call.arguments.length > TOOL_BOUNDARY_LIMITS.maxRawArgsChars) {
    return { rejected: rejected(call, "invalid_arguments", "Arguments too large.") };
  }
  const raw = toolCallArguments(call);
  if (raw === null) {
    return { rejected: rejected(call, "invalid_arguments", "Arguments were not a valid JSON object.") };
  }
  const parsed = def.argsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`)
      .join("; ");
    return { rejected: rejected(call, "invalid_arguments", `Invalid arguments — ${issues.slice(0, 200)}`) };
  }
  const args = parsed.data as Record<string, unknown>;
  const reason = typeof raw.reason === "string" ? raw.reason.slice(0, TOOL_BOUNDARY_LIMITS.maxReasonChars) : undefined;
  return {
    intent: {
      id: call.id || `${params.turnId}-${params.round}-${name}`,
      name,
      arguments: args,
      ...(reason ? { reason } : {}),
      correlationId: params.turnId,
      idempotencyKey: idempotencyKeyFor(params.turnId, name, args),
      round: params.round,
    },
  };
}

export interface AuthorizeParams {
  intent: ToolIntent;
  registry: ToolRegistry;
  offered: string[];
  channel: ChannelProfile;
  state: ConversationState;
  userMessage: string;
  /** Idempotency keys already executed this turn. */
  executedKeys: Set<string>;
  execution: ToolExecutionContext;
  /**
   * How a "yes" is recognised. Defaults to the multilingual deterministic
   * detector; injectable so a deployment in a language this repository does
   * not ship can supply its own WITHOUT any of the surrounding authorization
   * becoming configurable.
   */
  confirmationDetector?: ConfirmationDetector;
}

export function authorizeIntent(params: AuthorizeParams): ToolAuthorization {
  const { intent, registry } = params;
  const def = registry.definition(intent.name);
  if (!def) return { allowed: false, reason: "unknown_tool", message: "Unknown action." };
  if (!params.offered.includes(intent.name)) {
    return { allowed: false, reason: "not_granted", message: "This action is not available to this agent." };
  }
  if (!params.channel.allowsToolExecution) {
    return { allowed: false, reason: "channel_disallowed", message: "Actions cannot be executed on this channel." };
  }
  if (params.executedKeys.has(intent.idempotencyKey)) {
    return { allowed: false, reason: "duplicate", message: "This exact action already ran this turn; reuse its result." };
  }
  if (!registry.executor(intent.name)) {
    return { allowed: false, reason: "not_bound", message: "This action is not enabled here." };
  }
  if (def.precondition) {
    const unmet = def.precondition(params.execution);
    if (unmet) return { allowed: false, reason: "precondition_failed", message: unmet };
  }
  if (def.requiresConfirmation) {
    const pending = params.state.pendingConfirmation;
    const detectConfirmation = params.confirmationDetector ?? defaultConfirmationDetector;
    const confirmed =
      pending !== null && pending.toolName === intent.name && detectConfirmation(params.userMessage);
    if (!confirmed) {
      return {
        allowed: false,
        reason: "confirmation_required",
        message: "Ask the visitor to confirm before this action can run.",
      };
    }
  }
  return { allowed: true };
}

/** Runs the bound executor. Never throws; failures are typed results. */
export async function executeIntent(params: {
  intent: ToolIntent;
  definition: ControlledToolDefinition<unknown>;
  executor: ToolExecutor<unknown>;
  execution: ToolExecutionContext;
}): Promise<ToolResult> {
  const { intent } = params;
  try {
    const outcome = await params.executor(intent.arguments, params.execution);
    return {
      intentId: intent.id,
      name: intent.name,
      status: outcome.ok ? "succeeded" : "failed",
      summary: outcome.summary.slice(0, TOOL_BOUNDARY_LIMITS.maxSummaryChars),
      ...(outcome.data ? { data: outcome.data } : {}),
      claimsPermitted: outcome.ok ? (outcome.claimsPermitted ?? []) : [],
      ...(outcome.statePatch ? { statePatch: outcome.statePatch } : {}),
      ...(outcome.escalation ? { escalation: outcome.escalation } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  } catch (error) {
    return {
      intentId: intent.id,
      name: intent.name,
      status: "failed",
      summary: "The action could not be completed. Tell the visitor honestly that it did not go through.",
      claimsPermitted: [],
      error: {
        code: "EXECUTION_ERROR",
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
      },
    };
  }
}

/** ToolResult for a rejected authorization, so the model learns why. */
export function rejectionResult(
  intent: ToolIntent,
  auth: Exclude<ToolAuthorization, { allowed: true }>,
): ToolResult {
  return {
    intentId: intent.id,
    name: intent.name,
    status: "rejected",
    summary: auth.message,
    claimsPermitted: [],
    rejection: auth.reason,
  };
}
