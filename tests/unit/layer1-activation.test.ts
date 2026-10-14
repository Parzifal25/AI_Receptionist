import { describe, expect, it, vi } from "vitest";
import { agentActivationErrors, parseAgentConfig } from "@halo/core/domain/agents";
import { AgentVersioningService } from "@halo/agents/agent-versioning";
import { toAgentVersion, type AgentVersionRow } from "@halo/agents/agent-repository";
import { InMemoryAgentRepository } from "../mocks/in-memory-agent-repository";
import { readyAgentConfig } from "../mocks/layer1-agent-config";
import { requireArunodhaya } from "@/content/tenants/arunodhaya";

describe("Layer 1 activation boundary", () => {
  it.each([
    ["identity", { identity: { name: " " } }],
    ["objective", { objective: " " }],
    ["missing language", { language: {} }],
    ["invalid language", { language: { primary: "bad tag!" } }],
    ["invalid value", { voice: { speakingRate: -1 } }],
    ["conflicting instructions", { instructions: { promptTemplate: "Another version" } }],
    ["malformed collection binding", { knowledge: { collectionIds: ["foreign-collection"] } }],
    ["pending approval", { activationBlockers: ["Policy pending"] }],
  ])("rejects %s before publication or live-pointer writes", async (_name, override) => {
    const repo = new InMemoryAgentRepository();
    const service = new AgentVersioningService(repo);
    const agent = await service.createAgent({ businessId: "synthetic-a", type: "custom", slug: "assistant", displayName: "Test" });
    const draft = await service.createDraftVersion({ agentId: agent.id, businessId: agent.businessId, promptTemplate: "Versioned instructions", promptVersion: "v1", config: readyAgentConfig() });
    // Simulate a malformed persisted draft without the fake's tolerant parsing.
    repo.versions.set(draft.id, { ...draft, config: { ...draft.config, ...override } as typeof draft.config });
    const publish = vi.spyOn(repo, "setPublished");
    const activate = vi.spyOn(repo, "setLiveVersion");
    await expect(service.publishVersion(agent.id, agent.businessId, 1)).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "invalid_agent_configuration" } });
    expect(publish).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("retains incomplete drafts and blocks a missing effective prompt", () => {
    expect(parseAgentConfig({})).not.toBeNull();
    expect(agentActivationErrors(readyAgentConfig(), " ")).toContain("promptTemplate: required versioned instructions");
    expect(agentActivationErrors({ identity: { name: "Test" }, objective: "Test" }, "Instructions")).toContain("language.primary: explicit valid language tag required");
  });

  it("refuses invalid legacy published config on repository reads but permits draft editing", () => {
    const row: AgentVersionRow = { id: "v1", agent_id: "a", business_id: "b", version: 1, config: {}, prompt_template: "Instructions", prompt_version: "1", model: {}, published_at: "2026-10-14T00:00:00Z", created_at: "2026-10-14T00:00:00Z", created_by: null };
    expect(() => toAgentVersion(row)).toThrow("Published agent configuration is unavailable");
    expect(toAgentVersion({ ...row, published_at: null }).config.identity.name).toBe("");
  });

  it("rejects rollback to an invalid published version without replacing the valid live version", async () => {
    const repo = new InMemoryAgentRepository();
    const service = new AgentVersioningService(repo);
    const agent = await service.createAgent({ businessId: "synthetic-a", type: "custom", slug: "assistant", displayName: "Test" });
    const draft = await service.createDraftVersion({ agentId: agent.id, businessId: agent.businessId, promptTemplate: "Instructions", promptVersion: "1", config: readyAgentConfig() });
    await service.publishVersion(agent.id, agent.businessId, 1);
    repo.versions.set(draft.id, { ...draft, publishedAt: "2026-10-14T00:00:00Z", config: { ...draft.config, objective: "" } });
    const activate = vi.spyOn(repo, "setLiveVersion");
    await expect(service.rollbackTo(agent.id, agent.businessId, 1)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(activate).not.toHaveBeenCalled();
    await expect(service.getLiveVersion(agent.id, agent.businessId)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("requires every phone prompt", () => {
    const config = readyAgentConfig();
    config.voice.prompts.transferFailed = "";
    expect(agentActivationErrors(config, "Instructions", true)).toContain("voice.prompts.transferFailed: required");
  });

  it("keeps the unapproved pilot blocked while its draft is readable", () => {
    const pilot = requireArunodhaya();
    expect(pilot.pending).toHaveLength(12);
    expect(pilot.verified).toHaveLength(0);
    expect(agentActivationErrors(pilot.config, pilot.config.instructions.promptTemplate, true)).toContain("activationBlockers: unresolved business approvals");
  });
});
