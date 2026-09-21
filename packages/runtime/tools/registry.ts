import { z } from "zod";
import type { Business } from "@halo/core/domain/types";
import type {
  ActionClaimKind,
  ChannelProfile,
  EscalationPriority,
  EscalationReason,
  ToolDescriptor,
  TrustedRequestContext,
} from "../contracts";
import type { ConversationState, ConversationStatePatch } from "../conversation-state";

/**
 * HALO Phase 2 — the controlled tool registry (Workstream 8).
 *
 * A CLOSED set of tool definitions. Each has a name, a zod argument schema
 * (the model's arguments are validated against it before anything else
 * looks at them), a side-effect flag and a confirmation flag. Executors are
 * bound by the APPLICATION, one per tool, and only ever call existing
 * trusted services. There is no dynamic registration from configuration,
 * no code, no URLs, no table names, no credentials — a tool is a name.
 *
 * What is NOT here, by design: a plugin engine, custom-code tools, HTTP
 * tools, database tools. Those are Phase 3+ Tool Runtime work.
 */

export interface ToolExecutionContext {
  trusted: TrustedRequestContext;
  business: Business;
  state: ConversationState;
  channel: ChannelProfile;
  userMessage: string;
  now: Date;
}

export interface ToolExecutionOutcome {
  ok: boolean;
  /** Model-facing summary of what happened (bounded by the boundary). */
  summary: string;
  data?: Record<string, unknown>;
  claimsPermitted?: ActionClaimKind[];
  statePatch?: ConversationStatePatch;
  escalation?: { reason: EscalationReason; priority: EscalationPriority };
  error?: { code: string; message: string };
}

export type ToolExecutor<Args> = (args: Args, ctx: ToolExecutionContext) => Promise<ToolExecutionOutcome>;

export interface ControlledToolDefinition<Args = unknown> {
  name: string;
  description: string;
  argsSchema: z.ZodType<Args>;
  sideEffecting: boolean;
  /** Ask the visitor before executing (channel policy may require it anyway). */
  requiresConfirmation: boolean;
  /** Returns a reason when the tool must not run in the current state. */
  precondition?: (ctx: ToolExecutionContext) => string | null;
}

// ---------------------------------------------------------------------------
// Built-in definitions (Phase 2: exactly two, both mapped onto behaviour the
// product already has — human handoff and contact capture).
// ---------------------------------------------------------------------------

export const requestHumanHandoffArgs = z.object({
  reason: z.string().max(200).default(""),
});

export const saveContactDetailsArgs = z
  .object({
    name: z.string().max(120).default(""),
    phone: z.string().max(40).default(""),
    email: z.string().max(200).default(""),
    note: z.string().max(200).default(""),
  })
  .refine((a) => a.phone.trim().length > 0 || a.email.trim().length > 0, {
    message: "a phone number or email is required",
  });

export const offerConcessionArgs = z.object({
  /** Must be one of the ids listed in the commercial policy section. */
  concessionId: z.string().min(1).max(40),
  reason: z.string().max(200).default(""),
});

export const BUILTIN_TOOLS = {
  offer_concession: {
    name: "offer_concession",
    description:
      "Offer the customer one of the commercial options the business has authorized, naming it by the id listed " +
      "in the commercial policy section. The system re-checks it against the business's policy before anything is " +
      "offered; if it is not authorized you will be told so, and you must not offer it anyway. Never use this to " +
      "invent a figure of your own.",
    argsSchema: offerConcessionArgs,
    sideEffecting: true,
    requiresConfirmation: false,
  } satisfies ControlledToolDefinition<z.infer<typeof offerConcessionArgs>>,
  request_human_handoff: {
    name: "request_human_handoff",
    description:
      "Ask for a member of the team to take over, when the visitor explicitly wants a person or the situation needs one. The system records the request; you then tell the visitor what will happen next.",
    argsSchema: requestHumanHandoffArgs,
    sideEffecting: false,
    requiresConfirmation: false,
    precondition: (ctx) =>
      ctx.state.escalation.status !== "none" ? "a handoff has already been requested in this conversation" : null,
  } satisfies ControlledToolDefinition<z.infer<typeof requestHumanHandoffArgs>>,
  save_contact_details: {
    name: "save_contact_details",
    description:
      "Save the visitor's own contact details (name, phone and/or email) so the team can follow up. Only use details the visitor gave you in this conversation.",
    argsSchema: saveContactDetailsArgs,
    sideEffecting: true,
    requiresConfirmation: false,
  } satisfies ControlledToolDefinition<z.infer<typeof saveContactDetailsArgs>>,
} as const;

export type BuiltinToolName = keyof typeof BUILTIN_TOOLS;

export const BUILTIN_TOOL_NAMES = Object.keys(BUILTIN_TOOLS) as BuiltinToolName[];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// Definitions are heterogeneous in their argument type; zod schemas are not
// covariant, so the registry stores them type-erased and re-validates at the
// boundary (toToolIntent) before any executor sees arguments.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ControlledToolDefinition<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolExecutor = ToolExecutor<any>;

export class ToolRegistry {
  private readonly definitions = new Map<string, ControlledToolDefinition<unknown>>();
  private readonly executors = new Map<string, ToolExecutor<unknown>>();

  constructor(
    definitions: Record<string, AnyToolDefinition> = BUILTIN_TOOLS,
    executors: Partial<Record<string, AnyToolExecutor>> = {},
  ) {
    for (const def of Object.values(definitions)) {
      this.definitions.set(def.name, def as ControlledToolDefinition<unknown>);
    }
    for (const [name, executor] of Object.entries(executors)) {
      if (!executor) continue;
      if (!this.definitions.has(name)) {
        throw new Error(`cannot bind executor for unknown tool "${name}"`);
      }
      this.executors.set(name, executor as ToolExecutor<unknown>);
    }
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  definition(name: string): ControlledToolDefinition<unknown> | null {
    return this.definitions.get(name) ?? null;
  }

  executor(name: string): ToolExecutor<unknown> | null {
    return this.executors.get(name) ?? null;
  }

  /** Tools that are both defined and bound to an executor — the only ones ever offered. */
  boundNames(): string[] {
    return [...this.definitions.keys()].filter((name) => this.executors.has(name)).sort();
  }

  descriptor(name: string): ToolDescriptor | null {
    const def = this.definitions.get(name);
    if (!def) return null;
    return {
      name: def.name,
      description: def.description,
      parameters: z.toJSONSchema(def.argsSchema as z.ZodType, { io: "input" }) as Record<string, unknown>,
      sideEffecting: def.sideEffecting,
    };
  }
}
