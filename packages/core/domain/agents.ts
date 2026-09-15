import { z } from "zod";

/**
 * HALO Phase 1 — the agent model (plan §P1.2).
 *
 * A tenant owns agents; an agent owns an immutable chain of agent_versions.
 * `agents.live_version_id` points at the published version serving traffic.
 *
 * The `config` jsonb is the only free-form field and is validated by this
 * schema on read (the workflowDefinitionSchema precedent): a malformed row
 * is skipped loudly, never silently interpreted.
 *
 * Zod 4 note: `.default()` on a nested object applies the default *raw*
 * (inner field defaults are not re-run), so sections are `.optional()` here
 * and `parseAgentConfig` normalizes each section against its schema, which
 * yields a fully-populated `AgentConfig`.
 */

export const AGENT_TYPES = [
  "receptionist",
  "sales",
  "support",
  "qualification",
  "appointment",
  "custom",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_CHANNELS = ["web", "phone", "whatsapp", "sms"] as const;
export type AgentChannel = (typeof AGENT_CHANNELS)[number];

const identitySchema = z.object({
  name: z.string().default(""),
  persona: z.string().default(""),
  avatarUrl: z.string().url().optional(),
  voiceId: z.string().optional(),
});

const instructionsSchema = z.object({
  // The versioned content that leaves prompt-builder.ts (the assembler's
  // PROMPT_VERSION stays the code version; the content version is
  // agent_versions.version).
  promptTemplate: z.string().default(""),
  customInstructions: z.string().default(""),
});

const languageSchema = z.object({
  primary: z.string().default("en"),
  fallbacks: z.array(z.string()).default([]),
  codeSwitchPolicy: z.enum(["allow", "prefer-primary", "reject"]).default("allow"),
});

const voiceSchema = z.object({
  ttsVoice: z.string().optional(),
  speakingRate: z.number().min(0.5).max(2).optional(),
  bargeIn: z.boolean().default(true),
});

const knowledgeSchema = z.object({
  // Empty = all tenant collections, preserving today's behaviour.
  collectionIds: z.array(z.string()).default([]),
  retrievalPolicy: z.enum(["hybrid", "vector", "fts"]).default("hybrid"),
});

const toolsSchema = z.object({
  grantedToolIds: z.array(z.string()).default([]),
  policy: z.record(z.string(), z.unknown()).default({}),
});

const workflowsSchema = z.object({
  allowedTriggers: z.array(z.string()).default([]),
});

const guardrailsSchema = z.object({
  refusals: z.array(z.string()).default([]),
  escalationTriggers: z.array(z.string()).default([]),
  piiRules: z.record(z.string(), z.unknown()).default({}),
});

/**
 * The configuration block hierarchy from the plan. Sections are optional at
 * the jsonb boundary so malformed or minimal rows stay valid; defaults are
 * applied by `parseAgentConfig`.
 */
export const agentConfigSchema = z.object({
  identity: identitySchema.optional(),
  objective: z.string().optional(),
  instructions: instructionsSchema.optional(),
  language: languageSchema.optional(),
  voice: voiceSchema.optional(),
  knowledge: knowledgeSchema.optional(),
  tools: toolsSchema.optional(),
  workflows: workflowsSchema.optional(),
  guardrails: guardrailsSchema.optional(),
});

/** Fully-defaulted, validated agent configuration (what callers consume). */
export interface AgentConfig {
  identity: z.infer<typeof identitySchema>;
  objective: string;
  instructions: z.infer<typeof instructionsSchema>;
  language: z.infer<typeof languageSchema>;
  voice: z.infer<typeof voiceSchema>;
  knowledge: z.infer<typeof knowledgeSchema>;
  tools: z.infer<typeof toolsSchema>;
  workflows: z.infer<typeof workflowsSchema>;
  guardrails: z.infer<typeof guardrailsSchema>;
}

/** Parses-and-validates stored config; returns null when malformed. */
export function parseAgentConfig(raw: unknown): AgentConfig | null {
  const base = agentConfigSchema.safeParse(raw ?? {});
  if (!base.success) return null;
  const d = base.data;
  return {
    identity: identitySchema.parse(d.identity ?? {}),
    objective: d.objective ?? "",
    instructions: instructionsSchema.parse(d.instructions ?? {}),
    language: languageSchema.parse(d.language ?? {}),
    voice: voiceSchema.parse(d.voice ?? {}),
    knowledge: knowledgeSchema.parse(d.knowledge ?? {}),
    tools: toolsSchema.parse(d.tools ?? {}),
    workflows: workflowsSchema.parse(d.workflows ?? {}),
    guardrails: guardrailsSchema.parse(d.guardrails ?? {}),
  };
}

/** A fully-defaulted valid config — e.g. for brand-new drafts. */
export function defaultAgentConfig(): AgentConfig {
  return parseAgentConfig({})!;
}

export interface Agent {
  id: string;
  businessId: string;
  type: AgentType;
  slug: string;
  displayName: string;
  status: AgentStatus;
  /** Id of the published version serving traffic; null until first publish. */
  liveVersionId: string | null;
  defaultChannel: AgentChannel;
  createdAt: string;
  updatedAt: string;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  businessId: string;
  version: number;
  config: AgentConfig;
  promptTemplate: string;
  promptVersion: string;
  model: { provider?: string; model?: string; temperature?: number; maxTokens?: number };
  /** null = draft; set once on publish and never changed again. */
  publishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}