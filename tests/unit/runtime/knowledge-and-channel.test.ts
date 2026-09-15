import { describe, expect, it } from "vitest";
import type { KnowledgeSnippet } from "@halo/core/domain/types";
import {
  channelProfile,
  channelProfileForConversation,
  WEB_CHAT_PROFILE,
  WEB_VOICE_PROFILE,
} from "@halo/runtime/channel-profile";
import { budgetSnippets, ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { emptyKnowledgeProvider } from "../../mocks/runtime-fakes";

function snippet(i: number, chars: number, score = 1 - i * 0.1): KnowledgeSnippet {
  return { source: "chunk", refId: `c${i}`, title: `Doc ${i}`, content: "k".repeat(chars), score };
}

describe("channel profiles (Phase 2, WS2)", () => {
  it("exposes explicit constraints and maps the conversation channel onto a profile", () => {
    expect(channelProfileForConversation("chat")).toBe(WEB_CHAT_PROFILE);
    expect(channelProfileForConversation("voice")).toBe(WEB_VOICE_PROFILE);
    expect(channelProfileForConversation(undefined)).toBe(WEB_CHAT_PROFILE);
    expect(channelProfile("web-voice").modality).toBe("voice");
    expect(WEB_CHAT_PROFILE).toMatchObject({ supportsMarkdown: false, allowsToolExecution: true, requiresConfirmationForSideEffects: true });
    expect(WEB_VOICE_PROFILE.maxReplyChars).toBeLessThan(WEB_CHAT_PROFILE.maxReplyChars);
    expect(Object.isFrozen(WEB_CHAT_PROFILE)).toBe(true);
  });
});

describe("knowledge resolver (Phase 2, WS6)", () => {
  it("prepares follow-up queries from recent visitor context and bounds results", async () => {
    let seen = "";
    const provider = emptyKnowledgeProvider([snippet(0, 300), snippet(1, 300), snippet(2, 300)]);
    provider.search = async (_b, query) => {
      seen = query;
      return [snippet(0, 300), snippet(1, 300), snippet(2, 300)];
    };
    const resolver = new ProviderKnowledgeResolver(provider);
    const result = await resolver.resolve({
      businessId: "biz-a",
      collectionIds: [],
      history: [{ role: "user", content: "Do you install tankless water heaters?" }],
      userMessage: "how much?",
      limits: { maxSnippets: 2, maxChars: 500 },
    });
    expect(seen).toContain("tankless water heaters");
    expect(result.snippets).toHaveLength(2);
    expect(result.charsUsed).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
    expect(result.sources).toEqual(["Doc 0", "Doc 1"]);
  });

  it("filters below the minimum score and returns empty for blank queries", async () => {
    const resolver = new ProviderKnowledgeResolver(emptyKnowledgeProvider([snippet(0, 10, 0.9), snippet(1, 10, 0.01)]), { minScore: 0.5 });
    const result = await resolver.resolve({ businessId: "b", collectionIds: [], history: [], userMessage: "hours", limits: { maxSnippets: 6, maxChars: 1000 } });
    expect(result.snippets.map((s) => s.refId)).toEqual(["c0"]);
    const blank = await resolver.resolve({ businessId: "b", collectionIds: [], history: [], userMessage: "   ", limits: { maxSnippets: 6, maxChars: 1000 } });
    expect(blank.snippets).toEqual([]);
  });

  it("budgeting always keeps the top-ranked snippet (trimmed if necessary)", () => {
    const budget = budgetSnippets([snippet(0, 1000), snippet(1, 10)], 6, 100);
    expect(budget.snippets).toHaveLength(1);
    expect(budget.snippets[0].content).toHaveLength(100);
    expect(budget.truncated).toBe(true);
  });

  it("propagates provider failures so the runtime can degrade explicitly", async () => {
    const provider = emptyKnowledgeProvider();
    provider.search = async () => {
      throw new Error("db down");
    };
    await expect(new ProviderKnowledgeResolver(provider).resolve({ businessId: "b", collectionIds: [], history: [], userMessage: "hours?", limits: { maxSnippets: 6, maxChars: 1000 } })).rejects.toThrow("db down");
  });
});
