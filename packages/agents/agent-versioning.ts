import { type Agent, type AgentConfig, type AgentVersion, AGENT_TYPES } from "@halo/core/domain/agents";
import { AppError } from "@halo/core/errors/app-error";
import type { AgentRepository } from "./agent-repository";

/**
 * HALO Phase 1 — agent version lifecycle (plan §P1.2 "Versioning and
 * rollback").
 *
 * Draft → publish → live. Publishing stamps `published_at` and repoints
 * `agents.live_version_id`; rollback repoints `live_version_id` to an earlier
 * version — no data rewrite, no migration, and in-flight conversations keep
 * their pinned version. Published versions are immutable: the row can never
 * be edited or re-published (enforced here and by the database trigger).
 */
export class AgentVersioningService {
  constructor(private readonly repository: AgentRepository) {}

  /** Creates a new agent (status draft, no live version). */
  async createAgent(input: {
    businessId: string;
    type: (typeof AGENT_TYPES)[number];
    slug: string;
    displayName: string;
  }): Promise<Agent> {
    return this.repository.createAgent(input);
  }

  /**
   * Finds an agent by its tenant-scoped slug. The (business_id, slug) pair is
   * unique in the schema, so the lookup is deterministic.
   */
  async findBySlug(businessId: string, slug: string): Promise<Agent | null> {
    const agents = await this.repository.listAgents(businessId);
    return agents.find((a) => a.slug === slug) ?? null;
  }

  /**
   * Resolves the published/live version for ANY agent type, enforcing the
   * same rules the DB enforces on the chain: the agent must exist, must not
   * be archived, and must have a live (published) version. The returned
   * version is always the one its business published — never a draft.
   */
  async resolveLiveVersion(agent: Agent): Promise<AgentVersion> {
    if (agent.status === "archived") {
      throw AppError.conflict("Agent is archived");
    }
    if (!agent.liveVersionId) {
      // Phase 1.5: classified reason so callers can distinguish "never
      // published" from a data-integrity problem, without string matching.
      throw AppError.notFound("Live version for this agent", {
        reason: "no_live_version",
        agentId: agent.id,
      });
    }
    const version = await this.repository.getVersion(agent.liveVersionId, agent.businessId);
    if (!version) {
      throw AppError.notFound("Agent live version", {
        reason: "live_version_missing",
        agentId: agent.id,
        versionId: agent.liveVersionId,
      });
    }
    return version;
  }

  /**
   * Creates the next version of an agent from the prompt/model content.
   * Version numbers are 1-based and never reused (DB unique constraint).
   * Creating a version never touches `live_version_id` — drafts are inert.
   */
  async createDraftVersion(input: {
    agentId: string;
    businessId: string;
    promptTemplate: string;
    promptVersion: string;
    model?: { provider?: string; model?: string; temperature?: number; maxTokens?: number };
    config?: AgentConfig;
    createdBy?: string | null;
  }): Promise<AgentVersion> {
    const agent = await this.repository.getAgent(input.agentId, input.businessId);
    if (!agent) throw AppError.notFound("Agent not found");
    if (agent.status === "archived") {
      throw AppError.conflict("Archived agents cannot receive new versions");
    }

    const versions = await this.repository.listVersions(input.agentId, input.businessId);
    const next = versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;

    return this.repository.createVersion({ ...input, version: next });
  }

  /**
   * Publishes a draft or re-points to an existing version.
   * First publication stamps `published_at` (irreversible); subsequent
   * calls for an already-published version just repoint `live_version_id`
   * (this is the rollback path).
   */
  async publishVersion(agentId: string, businessId: string, version: number): Promise<AgentVersion> {
    const agent = await this.repository.getAgent(agentId, businessId);
    if (!agent) throw AppError.notFound("Agent not found");
    if (agent.status === "archived") {
      throw AppError.conflict("Archived agents cannot be published");
    }

    const versions = await this.repository.listVersions(agentId, businessId);
    const target = versions.find((v) => v.version === version);
    if (!target) throw AppError.notFound(`Version ${version} not found`);

    const publishedAt = target.publishedAt ?? new Date().toISOString();
    if (target.publishedAt === null) {
      await this.repository.setPublished(target.id, businessId, publishedAt);
    }
    await this.repository.setLiveVersion(agentId, businessId, target.id);

    return { ...target, publishedAt };
  }

  /** Rollback: repoint the live version without touching any version row. */
  async rollbackTo(agentId: string, businessId: string, version: number): Promise<Agent> {
    const agent = await this.repository.getAgent(agentId, businessId);
    if (!agent) throw AppError.notFound("Agent not found");

    const versions = await this.repository.listVersions(agentId, businessId);
    const target = versions.find((v) => v.version === version);
    if (!target) throw AppError.notFound(`Version ${version} not found`);
    if (target.publishedAt === null) {
      throw AppError.conflict("Cannot roll back to an unpublished draft");
    }

    await this.repository.setLiveVersion(agentId, businessId, target.id);
    return { ...agent, liveVersionId: target.id };
  }

  /** The version currently serving traffic, if any. */
  async getLiveVersion(agentId: string, businessId: string): Promise<AgentVersion | null> {
    const agent = await this.repository.getAgent(agentId, businessId);
    if (!agent || !agent.liveVersionId) return null;
    return this.repository.getVersion(agent.liveVersionId, businessId);
  }
}
