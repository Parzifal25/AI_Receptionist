import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type Agent,
  type AgentChannel,
  type AgentConfig,
  type AgentStatus,
  type AgentType,
  type AgentVersion,
  parseAgentConfig,
} from "@halo/core/domain/agents";
import { AppError } from "@halo/core/errors/app-error";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "agent-repository" });

/**
 * All persistence for the agent model. Service-role client; every method
 * takes explicit tenant scope (the Regime B pattern — RLS is bypassed here,
 * so a missing `.eq("business_id", …)` would be a cross-tenant leak).
 *
 * Immutability of agent_versions is enforced by the database (0013 trigger +
 * RLS); this layer only ever performs the legal mutations: insert, and the
 * publish transition (published_at null → set).
 */
export interface AgentRepository {
  listAgents(businessId: string): Promise<Agent[]>;
  getAgent(agentId: string, businessId: string): Promise<Agent | null>;
  createAgent(input: {
    businessId: string;
    type: AgentType;
    slug: string;
    displayName: string;
    defaultChannel?: AgentChannel;
  }): Promise<Agent>;
  listVersions(agentId: string, businessId: string): Promise<AgentVersion[]>;
  getVersion(versionId: string, businessId: string): Promise<AgentVersion | null>;
  createVersion(input: {
    agentId: string;
    businessId: string;
    version: number;
    config?: AgentConfig;
    promptTemplate: string;
    promptVersion: string;
    model?: { provider?: string; model?: string; temperature?: number; maxTokens?: number };
    createdBy?: string | null;
  }): Promise<AgentVersion>;
  /** The only permitted mutation of an agent_version: publish (null → set). */
  setPublished(versionId: string, businessId: string, publishedAt: string): Promise<void>;
  setLiveVersion(agentId: string, businessId: string, versionId: string): Promise<void>;
}

/** Postgres row shapes (snake_case) as returned by .select(). */
interface AgentRow {
  id: string;
  business_id: string;
  type: AgentType;
  slug: string;
  display_name: string;
  status: AgentStatus;
  live_version_id: string | null;
  default_channel: AgentChannel;
  created_at: string;
  updated_at: string;
}

interface AgentVersionRow {
  id: string;
  agent_id: string;
  business_id: string;
  version: number;
  config: unknown;
  prompt_template: string;
  prompt_version: string;
  model: unknown;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
}

const AGENT_COLUMNS =
  "id, business_id, type, slug, display_name, status, live_version_id, default_channel, created_at, updated_at" as const;
const VERSION_COLUMNS =
  "id, agent_id, business_id, version, config, prompt_template, prompt_version, model, published_at, created_by, created_at" as const;

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    businessId: row.business_id,
    type: row.type,
    slug: row.slug,
    displayName: row.display_name,
    status: row.status,
    liveVersionId: row.live_version_id,
    defaultChannel: row.default_channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toAgentVersion(row: AgentVersionRow): AgentVersion {
  const config = parseAgentConfig(row.config);
  if (!config) {
    // Malformed = skip loudly (the workflowDefinitionSchema precedent): the
    // row must not be served as if it were valid configuration.
    throw AppError.internal("agent_versions.config failed validation");
  }
  const model = (row.model ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    agentId: row.agent_id,
    businessId: row.business_id,
    version: row.version,
    config,
    promptTemplate: row.prompt_template,
    promptVersion: row.prompt_version,
    model: {
      provider: typeof model.provider === "string" ? model.provider : undefined,
      model: typeof model.model === "string" ? model.model : undefined,
      temperature: typeof model.temperature === "number" ? model.temperature : undefined,
      maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
    },
    publishedAt: row.published_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export class SupabaseAgentRepository implements AgentRepository {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  async listAgents(businessId: string): Promise<Agent[]> {
    const { data, error } = await this.db
      .from("agents")
      .select(AGENT_COLUMNS)
      .eq("business_id", businessId)
      .order("created_at", { ascending: true });
    if (error) {
      log.error("agent list failed", { error: error.message, businessId });
      throw AppError.internal();
    }
    return (data ?? []).map(toAgent);
  }

  async getAgent(agentId: string, businessId: string): Promise<Agent | null> {
    const { data, error } = await this.db
      .from("agents")
      .select(AGENT_COLUMNS)
      .eq("id", agentId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) {
      log.error("agent lookup failed", { error: error.message, businessId });
      throw AppError.internal();
    }
    return data ? toAgent(data) : null;
  }

  async createAgent(input: {
    businessId: string;
    type: AgentType;
    slug: string;
    displayName: string;
    defaultChannel?: AgentChannel;
  }): Promise<Agent> {
    const { data, error } = await this.db
      .from("agents")
      .insert({
        business_id: input.businessId,
        type: input.type,
        slug: input.slug,
        display_name: input.displayName,
        default_channel: input.defaultChannel ?? "web",
      })
      .select(AGENT_COLUMNS)
      .single();
    if (error) {
      log.error("agent create failed", { error: error.message, businessId: input.businessId });
      throw AppError.internal();
    }
    return toAgent(data);
  }

  async listVersions(agentId: string, businessId: string): Promise<AgentVersion[]> {
    const { data, error } = await this.db
      .from("agent_versions")
      .select(VERSION_COLUMNS)
      .eq("agent_id", agentId)
      .eq("business_id", businessId)
      .order("version", { ascending: false });
    if (error) {
      log.error("agent version list failed", { error: error.message, businessId });
      throw AppError.internal();
    }
    return (data ?? []).map((row) => toAgentVersion(row as AgentVersionRow));
  }

  async getVersion(versionId: string, businessId: string): Promise<AgentVersion | null> {
    const { data, error } = await this.db
      .from("agent_versions")
      .select(VERSION_COLUMNS)
      .eq("id", versionId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) {
      log.error("agent version lookup failed", { error: error.message, businessId });
      throw AppError.internal();
    }
    return data ? toAgentVersion(data as AgentVersionRow) : null;
  }

  async createVersion(input: {
    agentId: string;
    businessId: string;
    version: number;
    config?: AgentConfig;
    promptTemplate: string;
    promptVersion: string;
    model?: { provider?: string; model?: string; temperature?: number; maxTokens?: number };
    createdBy?: string | null;
  }): Promise<AgentVersion> {
    const { data, error } = await this.db
      .from("agent_versions")
      .insert({
        agent_id: input.agentId,
        business_id: input.businessId,
        version: input.version,
        config: input.config ?? {},
        prompt_template: input.promptTemplate,
        prompt_version: input.promptVersion,
        model: input.model ?? {},
        created_by: input.createdBy ?? null,
      })
      .select(VERSION_COLUMNS)
      .single();
    if (error) {
      log.error("agent version create failed", { error: error.message, businessId: input.businessId });
      throw AppError.internal();
    }
    return toAgentVersion(data as AgentVersionRow);
  }

  async setPublished(versionId: string, businessId: string, publishedAt: string): Promise<void> {
    const { error } = await this.db
      .from("agent_versions")
      .update({ published_at: publishedAt })
      .eq("id", versionId)
      .eq("business_id", businessId);
    if (error) {
      log.error("agent version publish failed", { error: error.message, businessId });
      throw AppError.internal();
    }
  }

  async setLiveVersion(agentId: string, businessId: string, versionId: string): Promise<void> {
    const { error } = await this.db
      .from("agents")
      .update({ live_version_id: versionId })
      .eq("id", agentId)
      .eq("business_id", businessId);
    if (error) {
      log.error("agent live-version update failed", { error: error.message, businessId });
      throw AppError.internal();
    }
  }
}