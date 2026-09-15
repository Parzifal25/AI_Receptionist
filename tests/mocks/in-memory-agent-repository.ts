import {
  type Agent,
  type AgentChannel,
  type AgentConfig,
  type AgentStatus,
  type AgentType,
  type AgentVersion,
  defaultAgentConfig,
  parseAgentConfig,
} from "@halo/core/domain/agents";
import type { AgentRepository } from "@halo/agents/agent-repository";
import { AppError } from "@halo/core/errors/app-error";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

/** @internal for tests */
export function resetAgentIdSequence(): void {
  seq = 0;
}

/**
 * In-memory AgentRepository faithfully mirroring the 0013 database
 * invariants: unique (agent_id, version), immutable version rows except the
 * single publish transition (published_at null → set), no deletes.
 * Shared by the agent-versioning service tests.
 */
export class InMemoryAgentRepository implements AgentRepository {
  readonly agents = new Map<string, Agent>();
  readonly versions = new Map<string, AgentVersion>();

  /** Thrown on any attempt to mutate an agent_version illegally. */
  immutableError(): Error {
    return new Error("agent_versions are immutable");
  }

  private agentKey(agentId: string, businessId: string): string {
    return `${businessId}/${agentId}`;
  }

  async listAgents(businessId: string): Promise<Agent[]> {
    return [...this.agents.values()].filter((a) => a.businessId === businessId);
  }

  async getAgent(agentId: string, businessId: string): Promise<Agent | null> {
    return this.agents.get(this.agentKey(agentId, businessId)) ?? null;
  }

  async createAgent(input: {
    businessId: string;
    type: AgentType;
    slug: string;
    displayName: string;
    defaultChannel?: AgentChannel;
  }): Promise<Agent> {
    const businessAgents = [...this.agents.values()].filter((a) => a.businessId === input.businessId);
    if (businessAgents.some((a) => a.slug === input.slug)) {
      throw AppError.conflict("slug already exists for this business");
    }
    const now = new Date().toISOString();
    const agent: Agent = {
      id: nextId("agent"),
      businessId: input.businessId,
      type: input.type,
      slug: input.slug,
      displayName: input.displayName,
      status: "draft",
      liveVersionId: null,
      defaultChannel: input.defaultChannel ?? "web",
      createdAt: now,
      updatedAt: now,
    };
    this.agents.set(this.agentKey(agent.id, agent.businessId), agent);
    return agent;
  }

  private getUnchecked(agentId: string, businessId: string): Agent | null {
    return this.agents.get(this.agentKey(agentId, businessId)) ?? null;
  }

  async renameAgent(agentId: string, businessId: string, displayName: string): Promise<Agent> {
    const agent = this.getUnchecked(agentId, businessId);
    if (!agent) throw AppError.notFound("Agent not found");
    const updated = { ...agent, displayName, updatedAt: new Date().toISOString() };
    this.agents.set(this.agentKey(agentId, businessId), updated);
    return updated;
  }

  async setAgentStatus(agentId: string, businessId: string, status: AgentStatus): Promise<Agent> {
    const agent = this.getUnchecked(agentId, businessId);
    if (!agent) throw AppError.notFound("Agent not found");
    const updated = { ...agent, status, updatedAt: new Date().toISOString() };
    this.agents.set(this.agentKey(agentId, businessId), updated);
    return updated;
  }

  async listVersions(agentId: string, businessId: string): Promise<AgentVersion[]> {
    return [...this.versions.values()]
      .filter((v) => v.agentId === agentId && v.businessId === businessId)
      .sort((a, b) => b.version - a.version);
  }

  async getVersion(versionId: string, businessId: string): Promise<AgentVersion | null> {
    const hit = this.versions.get(versionId);
    return hit && hit.businessId === businessId ? hit : null;
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
    const agent = this.getUnchecked(input.agentId, input.businessId);
    if (!agent) throw AppError.notFound("Agent not found");

    const duplicate = [...this.versions.values()].some(
      (v) => v.agentId === input.agentId && v.businessId === input.businessId && v.version === input.version,
    );
    if (duplicate) throw AppError.conflict("version already exists for this agent");

    const version: AgentVersion = {
      id: nextId("version"),
      agentId: input.agentId,
      businessId: input.businessId,
      version: input.version,
      config: parseAgentConfig(input.config ?? {}) ?? defaultAgentConfig(),
      promptTemplate: input.promptTemplate,
      promptVersion: input.promptVersion,
      model: input.model ?? {},
      publishedAt: null,
      createdBy: input.createdBy ?? null,
      createdAt: new Date().toISOString(),
    };
    this.versions.set(version.id, version);
    return version;
  }

  async setPublished(versionId: string, businessId: string, publishedAt: string): Promise<void> {
    const version = this.versions.get(versionId);
    if (!version || version.businessId !== businessId) throw AppError.notFound("Version not found");
    if (version.publishedAt !== null) throw this.immutableError();
    this.versions.set(versionId, { ...version, publishedAt });
  }

  async setLiveVersion(agentId: string, businessId: string, versionId: string): Promise<void> {
    const agent = this.getUnchecked(agentId, businessId);
    if (!agent) throw AppError.notFound("Agent not found");
    const version = this.versions.get(versionId);
    if (!version || version.businessId !== businessId) throw AppError.notFound("Version not found");
    this.agents.set(this.agentKey(agentId, businessId), {
      ...agent,
      liveVersionId: versionId,
      updatedAt: new Date().toISOString(),
    });
  }
}