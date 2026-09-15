import { describe, expect, it } from "vitest";
import type { ChatMessage, KnowledgeSnippet } from "@halo/core/domain/types";
import { WEB_CHAT_PROFILE } from "@halo/runtime/channel-profile";
import { buildConversationContext, DEFAULT_CONTEXT_LIMITS } from "@halo/runtime/context-builder";
import { applyStatePatch, emptyConversationState } from "@halo/runtime/conversation-state";
import { emptyKnowledge } from "@halo/runtime/knowledge-resolver";
import { makeAgent, makeTrusted } from "../../mocks/runtime-fakes";

function history(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message ${i}`,
  }));
}

function snippet(i: number, chars = 100): KnowledgeSnippet {
  return { source: "chunk", refId: `c${i}`, title: `Doc ${i}`, content: "x".repeat(chars), score: 1 / (i + 1) };
}

function build(overrides: Partial<Parameters<typeof buildConversationContext>[0]> = {}) {
  return buildConversationContext({
    trusted: makeTrusted(),
    agent: makeAgent(),
    channel: WEB_CHAT_PROFILE,
    state: emptyConversationState(),
    history: [],
    knowledge: emptyKnowledge(),
    tools: [],
    systemSections: [],
    verifiedActions: [],
    ...overrides,
  });
}

describe("context builder (Phase 2, WS3)", () => {
  it("keeps only the recent window of history and only user/assistant rows", () => {
    const rows = [...history(30), { role: "tool" as never, content: "tool row" }];
    const context = build({ history: rows });
    expect(context.recentMessages).toHaveLength(DEFAULT_CONTEXT_LIMITS.maxRecentMessages);
    expect(context.recentMessages.at(-1)?.content).toBe("message 29");
    expect(context.recentMessages.some((m) => m.content === "tool row")).toBe(false);
    expect(context.budget.trimmed).toContain("history:window");
  });

  it("trims each message and the summary to their character limits", () => {
    const state = applyStatePatch(emptyConversationState(), {
      summary: { text: "s".repeat(1000), throughMessageCount: 0, updatedAt: null },
    });
    const context = build({
      history: [{ role: "user", content: "m".repeat(5000) }],
      state,
      limits: { maxSummaryChars: 100, maxMessageChars: 50 },
    });
    expect(context.summary).toHaveLength(100);
    expect(context.recentMessages[0].content).toHaveLength(50);
  });

  it("bounds retrieved knowledge by count and characters", () => {
    const knowledge = { ...emptyKnowledge(), snippets: Array.from({ length: 10 }, (_, i) => snippet(i, 500)) };
    const context = build({ knowledge, limits: { maxKnowledgeSnippets: 4, maxKnowledgeChars: 1200 } });
    expect(context.knowledge.snippets).toHaveLength(3);
    expect(context.knowledge.charsUsed).toBeLessThanOrEqual(1200);
    expect(context.knowledge.truncated).toBe(true);
  });

  it("offers only the tool descriptors it was given, bounded", () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({
      name: `tool_${i}`,
      description: "d",
      parameters: {},
      sideEffecting: false,
    }));
    const context = build({ tools, limits: { maxToolDescriptors: 3 } });
    expect(context.tools.map((t) => t.name)).toEqual(["tool_0", "tool_1", "tool_2"]);
  });

  it("degrades deterministically under a total budget: knowledge, then summary, then oldest history", () => {
    const state = applyStatePatch(emptyConversationState(), {
      summary: { text: "recap ".repeat(50), throughMessageCount: 0, updatedAt: null },
    });
    const knowledge = { ...emptyKnowledge(), snippets: [snippet(0, 400), snippet(1, 400)] };
    // Fixed content (template + custom instructions + system sections) is
    // never trimmed; the budget applies to the variable components.
    const fixed = makeAgent().promptTemplate.length;
    const context = build({
      history: history(10),
      state,
      knowledge,
      limits: { maxTotalChars: fixed + 20 },
    });
    expect(context.knowledge.snippets).toHaveLength(0);
    expect(context.summary).toBe("");
    expect(context.recentMessages).toHaveLength(2);
    expect(context.budget.trimmed).toEqual(
      expect.arrayContaining(["budget:knowledge", "budget:summary", "budget:history"]),
    );
    expect(context.budget.totalChars).toBeLessThanOrEqual(fixed + 20);
  });

  it("is deterministic for identical inputs", () => {
    const params = { history: history(20), knowledge: { ...emptyKnowledge(), snippets: [snippet(0), snippet(1)] } };
    expect(build(params)).toEqual(build(params));
  });

  it("carries trusted identity and the agent's persisted content — nothing client-supplied", () => {
    const context = build();
    expect(context.trusted.businessId).toBe("biz-a");
    expect(context.agent.versionId).toBe("av-a-1");
    expect(context.agent.promptTemplate).toContain("Riley");
    // No secrets or credentials exist anywhere in the context object.
    expect(JSON.stringify(context)).not.toMatch(/service_role|api[_-]?key|password|token/i);
  });

  it("bounds authorized customer facts", () => {
    const context = build({
      customer: { name: "n".repeat(500), facts: Array.from({ length: 20 }, (_, i) => `fact ${i}`) },
      limits: { maxCustomerFacts: 2 },
    });
    expect(context.customer?.facts).toHaveLength(2);
    expect(context.customer?.name?.length).toBe(120);
  });
});
