import "server-only";
import type { Agent, AgentConfig, AgentVersion } from "@halo/core/domain/agents";
import { AppError } from "@halo/core/errors/app-error";
import type { AgentRepository } from "./agent-repository";
import { AgentVersioningService } from "./agent-versioning";

/**
 * HALO Phase 1 — generic agent resolution (plan §P1.2).
 *
 * Resolution chain (all steps tenant-scoped, none client-controlled):
 *
 *   widget_key → receptionist (compatibility mapping)
 *     → agent (slug = receptionist id, seeded by 0014_agent_backfill.sql)
 *       → published/live agent_version
 *         → ResolvedAgentContext
 *
 * The resolver runs inside trusted tenant context: the caller (a route
 * handler) proves tenancy by presenting a `widgetKey` that only exists on a
 * `receptionists` row of exactly one tenant; the agent is resolved from THAT
 * tenant's scope only (`agentRepository.getAgent(agentId, businessId)`), so a
 * cross-tenant agent id can never resolve. The client never supplies an
 * agent id or version id — those are server-resolved. The returned context
 * carries agent identity, configuration, prompt template and model config;
 * conversation rows persist `agent_id`/`agent_version_id` from it.
 *
 * Channel-agnostic by design: web, phone, WhatsApp and SMS channels resolve
 * through this same chain (the widget_key → agent mapping is the web
 * channel's entry point; other channels will pass their own tenant proof and
 * agent selector into `resolveForAgentId`).
 */
export interface ResolvedAgentContext {
  agent: Agent;
  version: AgentVersion;
  config: AgentConfig;
  /** Trusted tenant identity, taken from server-resolved rows only. */
  businessId: string;
}

export type AgentResolverDeps = {
  agentRepository: AgentRepository;
  /** Resolves the tenant + agent selector from an untrusted channel credential. */
  tenantResolver: (widgetKey: string) => Promise<{ businessId: string; agentSlug: string }>;
};

/**
 * Machine-readable failure reason from a resolver-thrown AppError, if the
 * error was classified (see `details.reason`). Non-AppError failures (store
 * outages, programming errors) return null — callers must treat null as
 * fail-closed, never as the compatibility signature.
 */
export function resolutionFailureReason(error: unknown): string | null {
  if (!(error instanceof AppError)) return null;
  const details = error.details;
  if (details && typeof details === "object" && "reason" in details) {
    const reason = (details as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  return null;
}

export class AgentResolver {
  private readonly versioning: AgentVersioningService;

  constructor(private readonly deps: AgentResolverDeps) {
    this.versioning = new AgentVersioningService(deps.agentRepository);
  }

  /**
   * Web-channel entry point: resolve from a public widget key. The widget
   * key maps 1:1 to one tenant's receptionist; the 0014 backfill guarantees
   * a matching agent with slug = receptionist id, so resolution is
   * deterministic for every receptionist-shaped tenant.
   */
  async resolveForWidgetKey(widgetKey: string): Promise<ResolvedAgentContext> {
    const { businessId, agentSlug } = await this.deps.tenantResolver(widgetKey);
    return this.resolveForAgentSlug(businessId, agentSlug);
  }

  /**
   * Channel-independent resolution for a trusted (businessId, agentSlug)
   * pair — the shape future phone/WhatsApp/SMS channel adapters will call.
   */
  async resolveForAgentSlug(businessId: string, agentSlug: string): Promise<ResolvedAgentContext> {
    const agent = await this.versioning.findBySlug(businessId, agentSlug);
    if (!agent) {
      throw AppError.notFound("Agent for this tenant", {
        reason: "agent_not_found",
        agentSlug,
      });
    }
    return this.resolveForAgentId(businessId, agent.id);
  }

  /**
   * Resolution by agent id. `businessId` must come from trusted server
   * context; the repository scopes the lookup by it, so an id belonging to
   * another tenant resolves to null and the call fails closed.
   */
  async resolveForAgentId(businessId: string, agentId: string): Promise<ResolvedAgentContext> {
    const agent = await this.deps.agentRepository.getAgent(agentId, businessId);
    if (!agent) {
      // Phase 1.5: `details.reason` gives callers (conversation-creation
      // fail-closed policy, alerting) a machine-readable classification
      // without string-matching messages.
      throw AppError.notFound("Agent for this tenant", {
        reason: "agent_not_found",
        agentId,
      });
    }
    if (agent.status === "archived") {
      throw AppError.conflict("Agent is archived", { reason: "agent_archived", agentId });
    }
    if (agent.status !== "active") {
      throw AppError.conflict("Agent is not active", { reason: "agent_not_active", agentId, status: agent.status });
    }
    const version = await this.versioning.resolveLiveVersion(agent);
    if (version.businessId !== businessId || version.agentId !== agent.id) {
      // Defensive: the repository already scopes by tenant; this guards a
      // misbehaving store implementation from leaking cross-tenant rows.
      throw AppError.forbidden(
        "Agent version does not belong to this tenant",
        { reason: "version_ownership_mismatch", agentId, versionId: version.id },
      );
    }
    return { agent, version, config: version.config, businessId };
  }
}
