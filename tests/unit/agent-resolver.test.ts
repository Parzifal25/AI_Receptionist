import { beforeEach, describe, expect, it } from "vitest";
import { AgentResolver } from "@halo/agents/agent-resolver";
import { AgentVersioningService } from "@halo/agents/agent-versioning";
import {
  InMemoryAgentRepository,
  resetAgentIdSequence,
} from "../mocks/in-memory-agent-repository";
import { AppError } from "@halo/core/errors/app-error";

/**
 * HALO Phase 1 — the generic agent resolution chain:
 *   widget_key → receptionist mapping → agent → live agent version.
 *
 * All cases run against an in-memory repository that mirrors the 0013
 * database invariants. The tenant resolver is the seam a channel adapter
 * provides (the web channel resolves widget_key → { businessId, agentSlug }).
 */

let repo: InMemoryAgentRepository;
let versioning: AgentVersioningService;
let seeded: { r1: Awaited<ReturnType<AgentVersioningService["createAgent"]>>; sales: { id: string }; r2: { id: string } };

/** Two tenants: b1 owns receptionist "r1" (agent slug "r1") and a sales agent. */
async function seedTenants() {
  const r1 = await versioning.createAgent({
    businessId: "b1",
    type: "receptionist",
    slug: "r1",
    displayName: "Riley",
  });
  const sales = await versioning.createAgent({
    businessId: "b1",
    type: "sales",
    slug: "sales-1",
    displayName: "Sella",
  });
  // b2's receptionist — same receptionist row id would be a different tenant.
  const r2 = await versioning.createAgent({
    businessId: "b2",
    type: "receptionist",
    slug: "r2",
    displayName: "Rex",
  });

  for (const [agent, template] of [
    [r1, "You are Riley, the receptionist for Acme."],
    [sales, "You are Sella, a sales qualification agent for Acme."],
    [r2, "You are Rex, the receptionist for Beta."],
  ] as const) {
    await versioning.createDraftVersion({
      agentId: agent.id,
      businessId: agent.businessId,
      promptTemplate: template,
      promptVersion: "2026-07-28.1",
    });
    await versioning.publishVersion(agent.id, agent.businessId, 1);
    // The 0014 backfill marks active receptionists' agents 'active'; do the
    // same here so the fixture mirrors production state.
    await repo.setAgentStatus(agent.id, agent.businessId, "active");
  }
  return { r1, sales, r2 };
}

/** Web-channel tenant resolver: widget key → receptionist (compat mapping). */
function webTenantResolver(map: Record<string, { businessId: string; agentSlug: string }>) {
  return async (widgetKey: string) => {
    const hit = map[widgetKey];
    if (!hit) throw AppError.notFound("Receptionist");
    return hit;
  };
}

function buildResolver(map: Record<string, { businessId: string; agentSlug: string }>) {
  return new AgentResolver({ agentRepository: repo, tenantResolver: webTenantResolver(map) });
}

beforeEach(async () => {
  resetAgentIdSequence();
  repo = new InMemoryAgentRepository();
  versioning = new AgentVersioningService(repo);
  seeded = await seedTenants();
});

describe("AgentResolver", () => {
  it("resolves a valid widget key to the agent and its published live version", async () => {
    const resolver = buildResolver({ "key-acme": { businessId: "b1", agentSlug: "r1" } });
    const ctx = await resolver.resolveForWidgetKey("key-acme");

    expect(ctx.businessId).toBe("b1");
    expect(ctx.agent.id).toBe(ctx.version.agentId);
    expect(ctx.version.version).toBe(1);
    expect(ctx.version.publishedAt).not.toBeNull();
    expect(ctx.config.identity.name).toBeDefined();
    expect(ctx.agent.type).toBe("receptionist");
  });

  it("resolves deterministically — same key, same agent and version ids", async () => {
    const resolver = buildResolver({ "key-acme": { businessId: "b1", agentSlug: "r1" } });
    const a = await resolver.resolveForWidgetKey("key-acme");
    const b = await resolver.resolveForWidgetKey("key-acme");
    expect(a.agent.id).toBe(b.agent.id);
    expect(a.version.id).toBe(b.version.id);
  });

  it("maps the receptionist compatibility path (slug = receptionist id)", async () => {
    const resolver = buildResolver({ "key-acme": { businessId: "b1", agentSlug: "r1" } });
    const ctx = await resolver.resolveForWidgetKey("key-acme");
    expect(ctx.agent.slug).toBe("r1");
  });

  it("rejects an unknown widget key (missing receptionist)", async () => {
    const resolver = buildResolver({});
    await expect(resolver.resolveForWidgetKey("missing-key")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("never resolves across tenants — b2's agent is invisible to b1's scope", async () => {
    const resolver = buildResolver({ "key-beta": { businessId: "b2", agentSlug: "r1" } });
    // b2 has no agent with slug "r1" (that slug belongs to b1).
    await expect(resolver.resolveForWidgetKey("key-beta")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("never resolves an agent id from another tenant", async () => {
    const resolver = buildResolver({ "key-acme": { businessId: "b1", agentSlug: "r1" } });
    // Direct id resolution with b1's tenant scope against b2's agent id.
    await expect(resolver.resolveForAgentId("b1", seeded.r2.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects an inactive (paused) agent", async () => {
    await repo.setAgentStatus(seeded.r1.id, "b1", "paused");
    const resolver = buildResolver({ "key-acme": { businessId: "b1", agentSlug: "r1" } });
    await expect(resolver.resolveForWidgetKey("key-acme")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects an archived agent", async () => {
    await repo.setAgentStatus(seeded.r1.id, "b1", "archived");
    const resolver = buildResolver({ "key-acme": { businessId: "b1", agentSlug: "r1" } });
    await expect(resolver.resolveForWidgetKey("key-acme")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects an agent with no live version", async () => {
    const draft = await versioning.createAgent({
      businessId: "b1",
      type: "custom",
      slug: "draft-only",
      displayName: "Draft",
    });
    // Active but never published: the missing-live-version case.
    await repo.setAgentStatus(draft.id, "b1", "active");
    const resolver = buildResolver({ "key-acme": { businessId: "b1", agentSlug: "draft-only" } });
    await expect(resolver.resolveForWidgetKey("key-acme")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("resolves the PUBLISHED version, never a newer draft", async () => {
    await versioning.createDraftVersion({
      agentId: seeded.r1.id,
      businessId: "b1",
      promptTemplate: "Draft v2 content that must not serve traffic.",
      promptVersion: "2026-07-28.1",
    });
    const resolver = buildResolver({ "key-acme": { businessId: "b1", agentSlug: "r1" } });
    const ctx = await resolver.resolveForWidgetKey("key-acme");
    expect(ctx.version.version).toBe(1);
    expect(ctx.version.promptTemplate).not.toContain("Draft v2");
  });

  it("resolves any agent type through the same chain (sales qualifier)", async () => {
    const resolver = buildResolver({ "key-acme": { businessId: "b1", agentSlug: "sales-1" } });
    const ctx = await resolver.resolveForWidgetKey("key-acme");
    expect(ctx.agent.type).toBe("sales");
    expect(ctx.version.promptTemplate).toContain("sales qualification agent");
  });
});
