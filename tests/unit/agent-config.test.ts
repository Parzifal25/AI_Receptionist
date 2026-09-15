import { describe, expect, it } from "vitest";
import { agentConfigSchema, parseAgentConfig } from "@halo/core/domain/agents";

describe("agentConfigSchema", () => {
  it("accepts an empty object and fills defaults", () => {
    const config = parseAgentConfig({});
    expect(config).not.toBeNull();
    expect(config!.language.primary).toBe("en");
    expect(config!.language.codeSwitchPolicy).toBe("allow");
    expect(config!.knowledge.collectionIds).toEqual([]);
    expect(config!.tools.grantedToolIds).toEqual([]);
    expect(config!.voice.bargeIn).toBe(true);
    expect(config!.workflows.allowedTriggers).toEqual([]);
    expect(config!.objective).toBe("");
  });

  it("parses a full plan-shaped config", () => {
    const config = parseAgentConfig({
      identity: { name: "Sales Agent", persona: "Friendly solar advisor", avatarUrl: "https://x.test/a.png" },
      objective: "Qualify and book site visits",
      instructions: { promptTemplate: "You are…", customInstructions: "Never invent prices" },
      language: { primary: "te", fallbacks: ["en"], codeSwitchPolicy: "prefer-primary" },
      voice: { ttsVoice: "sarvam-te", speakingRate: 1.1, bargeIn: false },
      knowledge: { collectionIds: ["c1"], retrievalPolicy: "vector" },
      tools: { grantedToolIds: ["check_availability", "book_appointment"], policy: { allowWeb: true } },
      workflows: { allowedTriggers: ["lead.created"] },
      guardrails: { refusals: ["pricing"], escalationTriggers: ["angry"], piiRules: { maskPhone: true } },
    });
    expect(config).not.toBeNull();
    expect(config!.language.primary).toBe("te");
    expect(config!.knowledge.retrievalPolicy).toBe("vector");
    expect(config!.tools.grantedToolIds).toHaveLength(2);
  });

  it("rejects an invalid code-switch policy", () => {
    const result = agentConfigSchema.safeParse({ language: { codeSwitchPolicy: "sometimes" } });
    expect(result.success).toBe(false);
  });

  it("rejects a negative speaking rate", () => {
    expect(agentConfigSchema.safeParse({ voice: { speakingRate: -1 } }).success).toBe(false);
  });

  it("parseAgentConfig returns null for malformed rows, not a throw", () => {
    expect(parseAgentConfig(null)).not.toBeNull(); // null → defaults, per tolerant defaulting
    expect(parseAgentConfig({ language: { codeSwitchPolicy: "bogus" } })).toBeNull();
    expect(parseAgentConfig("not-an-object")).toBeNull();
  });
});