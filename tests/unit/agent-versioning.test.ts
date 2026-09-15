import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@halo/core/errors/app-error";
import { AgentVersioningService } from "@halo/agents/agent-versioning";
import { InMemoryAgentRepository, resetAgentIdSequence } from "../mocks/in-memory-agent-repository";

const BIZ = "biz-1";
const MODEL_V1 = { provider: "ollama", model: "llama3" };

describe("AgentVersioningService", () => {
  let repository: InMemoryAgentRepository;
  let service: AgentVersioningService;

  beforeEach(() => {
    resetAgentIdSequence();
    repository = new InMemoryAgentRepository();
    service = new AgentVersioningService(repository);
  });

  async function createReceptionist() {
    return service.createAgent({
      businessId: BIZ,
      type: "receptionist",
      slug: "receptionist",
      displayName: "The Receptionist",
    });
  }

  it("creates an agent as a draft with no live version", async () => {
    const agent = await createReceptionist();
    expect(agent.status).toBe("draft");
    expect(agent.liveVersionId).toBeNull();
    expect(agent.defaultChannel).toBe("web");
  });

  it("numbers versions 1, 2, 3 across draft creations", async () => {
    const agent = await createReceptionist();
    const v1 = await service.createDraftVersion({
      agentId: agent.id,
      businessId: BIZ,
      promptTemplate: "t1",
      promptVersion: "2026-07-28.1",
      model: MODEL_V1,
    });
    const v2 = await service.createDraftVersion({
      agentId: agent.id,
      businessId: BIZ,
      promptTemplate: "t2",
      promptVersion: "2026-07-28.1",
    });
    const v3 = await service.createDraftVersion({
      agentId: agent.id,
      businessId: BIZ,
      promptTemplate: "t3",
      promptVersion: "2026-07-28.1",
    });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(v1.publishedAt).toBeNull();
    expect(agent.liveVersionId).toBeNull();
  });

  it("publishing v1 makes it live; publishing v2 repoints; rollback returns to v1", async () => {
    const agent = await createReceptionist();
    const v1 = await service.createDraftVersion({
      agentId: agent.id,
      businessId: BIZ,
      promptTemplate: "t1",
      promptVersion: "p",
    });
    const v2 = await service.createDraftVersion({
      agentId: agent.id,
      businessId: BIZ,
      promptTemplate: "t2",
      promptVersion: "p",
    });

    const published1 = await service.publishVersion(agent.id, BIZ, 1);
    expect(published1.publishedAt).not.toBeNull();
    expect((await repository.getAgent(agent.id, BIZ))!.liveVersionId).toBe(v1.id);

    await service.publishVersion(agent.id, BIZ, 2);
    expect((await repository.getAgent(agent.id, BIZ))!.liveVersionId).toBe(v2.id);

    const rolledBack = await service.rollbackTo(agent.id, BIZ, 1);
    expect(rolledBack.liveVersionId).toBe(v1.id);
    expect((await repository.getAgent(agent.id, BIZ))!.liveVersionId).toBe(v1.id);
  });

  it("an already-published version is never re-published (immutable)", async () => {
    const agent = await createReceptionist();
    const v1 = await service.createDraftVersion({
      agentId: agent.id,
      businessId: BIZ,
      promptTemplate: "t1",
      promptVersion: "p",
    });
    await service.publishVersion(agent.id, BIZ, 1);

    await expect(repository.setPublished(v1.id, BIZ, new Date().toISOString())).rejects.toThrow(
      /immutable/,
    );
  });

  it("cannot publish a non-existent version, or a draft on a missing agent", async () => {
    await expect(service.publishVersion("nope", BIZ, 1)).rejects.toBeInstanceOf(AppError);
    const agent = await createReceptionist();
    await expect(service.publishVersion(agent.id, BIZ, 99)).rejects.toBeInstanceOf(AppError);
    await expect(
      service.createDraftVersion({
        agentId: "missing",
        businessId: BIZ,
        promptTemplate: "t",
        promptVersion: "p",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("cannot roll back to an unpublished draft", async () => {
    const agent = await createReceptionist();
    await service.createDraftVersion({ agentId: agent.id, businessId: BIZ, promptTemplate: "t1", promptVersion: "p" });
    await service.createDraftVersion({ agentId: agent.id, businessId: BIZ, promptTemplate: "t2", promptVersion: "p" });
    await service.publishVersion(agent.id, BIZ, 1);

    await expect(service.rollbackTo(agent.id, BIZ, 2)).rejects.toBeInstanceOf(AppError);
  });

  it("archived agents cannot receive versions or be published", async () => {
    const agent = await createReceptionist();
    await repository.setAgentStatus(agent.id, BIZ, "archived");
    await expect(
      service.createDraftVersion({ agentId: agent.id, businessId: BIZ, promptTemplate: "t", promptVersion: "p" }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(service.publishVersion(agent.id, BIZ, 1)).rejects.toBeInstanceOf(AppError);
  });

  it("getLiveVersion returns the serving version, or null before first publish", async () => {
    const agent = await createReceptionist();
    expect(await service.getLiveVersion(agent.id, BIZ)).toBeNull();

    const v1 = await service.createDraftVersion({
      agentId: agent.id,
      businessId: BIZ,
      promptTemplate: "t1",
      promptVersion: "p",
    });
    await service.publishVersion(agent.id, BIZ, 1);
    const live = await service.getLiveVersion(agent.id, BIZ);
    expect(live?.id).toBe(v1.id);
    expect(live?.promptTemplate).toBe("t1");
  });

  it("duplicate version numbers are rejected by the store", async () => {
    const agent = await createReceptionist();
    await repository.createVersion({
      agentId: agent.id,
      businessId: BIZ,
      version: 1,
      promptTemplate: "t1",
      promptVersion: "p",
    });
    await expect(
      repository.createVersion({
        agentId: agent.id,
        businessId: BIZ,
        version: 1,
        promptTemplate: "t1",
        promptVersion: "p",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("tenancy: a version from another business resolves to nothing", async () => {
    const agent = await createReceptionist();
    const v1 = await service.createDraftVersion({
      agentId: agent.id,
      businessId: BIZ,
      promptTemplate: "t1",
      promptVersion: "p",
    });
    // Same version id, different tenant → not found (the repository scopes
    // every read by business_id, mirroring the Regime B pattern).
    expect(await repository.getVersion(v1.id, "other-biz")).toBeNull();
  });
});