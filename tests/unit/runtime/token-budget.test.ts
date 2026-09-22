import { describe, expect, it } from "vitest";
import type { ChatMessage, KnowledgeSnippet } from "@halo/core/domain/types";
import { estimateTokens } from "@halo/language/tokens";
import { PHONE_VOICE_PROFILE, WEB_CHAT_PROFILE } from "@halo/runtime/channel-profile";
import { buildConversationContext, DEFAULT_CONTEXT_LIMITS, VOICE_CONTEXT_LIMITS } from "@halo/runtime/context-builder";
import { applyStatePatch, emptyConversationState } from "@halo/runtime/conversation-state";
import { emptyKnowledge } from "@halo/runtime/knowledge-resolver";
import {
  buildTokenBudgetReport,
  measureComponent,
  REDUCTION_ORDER,
  type ReducibleComponent,
} from "@halo/runtime/token-budget";
import { makeAgent, makeTrusted } from "../../mocks/runtime-fakes";

const TELUGU_TURN = "నాకు సోలార్ గురించి తెలుసుకోవాలి, నెల బిల్లు ఎక్కువ వస్తోంది.";
const ENGLISH_TURN = "I want to know about solar, my monthly bill keeps going up every month.";

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

function turns(n: number, content: string): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content,
  }));
}

function snippet(i: number, content: string): KnowledgeSnippet {
  return { source: "chunk", refId: `c${i}`, title: `Doc ${i}`, content, score: 1 / (i + 1) };
}

describe("token budget policy (Phase 4.5 Sprint 2)", () => {
  const policy = { maxInputTokens: 100, reservedOutputTokens: 40 };

  it("answers the five questions the budget exists to answer", () => {
    const report = buildTokenBudgetReport({
      components: [measureComponent("prompt_template", "a".repeat(200)), measureComponent("knowledge", "b".repeat(80))],
      policy,
      present: new Set<ReducibleComponent>(["knowledge"]),
    });
    expect(report.estimatedInputTokens).toBe(70); // 200/4 + 80/4
    expect(report.outputAllowanceTokens).toBe(40);
    expect(report.remainingTokens).toBe(30);
    expect(report.needsReduction).toBe(false);
    expect(report.nextToReduce).toBeNull();
  });

  it("names what gets reduced first, in a fixed order", () => {
    expect(REDUCTION_ORDER).toEqual(["knowledge", "summary", "history"]);
    const over = (present: ReducibleComponent[]) =>
      buildTokenBudgetReport({
        components: [measureComponent("prompt_template", "a".repeat(1000))],
        policy,
        present: new Set(present),
      });
    expect(over(["knowledge", "summary", "history"]).nextToReduce).toBe("knowledge");
    expect(over(["summary", "history"]).nextToReduce).toBe("summary");
    expect(over(["history"]).nextToReduce).toBe("history");
    // Over budget with nothing left to cut is reported, not hidden.
    const exhausted = over([]);
    expect(exhausted.needsReduction).toBe(true);
    expect(exhausted.nextToReduce).toBeNull();
    expect(exhausted.remainingTokens).toBeLessThan(0);
  });

  it("marks tenant content, verified actions and tools as never reducible", () => {
    for (const fixed of ["prompt_template", "custom_instructions", "system_actions", "tools", "customer"] as const) {
      expect(measureComponent(fixed, "x").reducible).toBe(false);
    }
    for (const reducible of REDUCTION_ORDER) expect(measureComponent(reducible, "x").reducible).toBe(true);
  });
});

describe("token-aware context budget (Phase 4.5 Sprint 2)", () => {
  it("reports a token estimate alongside the character total on every turn", () => {
    const context = build();
    expect(context.budget.tokens.estimatedInputTokens).toBeGreaterThan(0);
    expect(context.budget.tokens.policy.maxInputTokens).toBe(DEFAULT_CONTEXT_LIMITS.maxInputTokens);
    expect(context.budget.tokens.estimator).toMatch(/estimate/);
  });

  it("prices the SAME character count far higher in Telugu than in English", () => {
    // The defect this exists for: both of these sit inside the character
    // budget, and only one of them is anywhere near the token budget.
    const english = build({ history: turns(10, ENGLISH_TURN) });
    const telugu = build({ history: turns(10, TELUGU_TURN) });
    const englishChars = english.budget.totalChars;
    const teluguChars = telugu.budget.totalChars;
    expect(Math.abs(englishChars - teluguChars) / englishChars).toBeLessThan(0.25);
    expect(telugu.budget.tokens.estimatedInputTokens).toBeGreaterThan(
      english.budget.tokens.estimatedInputTokens * 2,
    );
  });

  it("is NOT satisfied by the character budget alone on Telugu content", () => {
    // A Telugu turn that passes maxTotalChars comfortably and is still over a
    // token ceiling set for the same content in English.
    const context = build({
      history: turns(16, TELUGU_TURN),
      limits: { maxTotalChars: 100_000, maxInputTokens: 200 },
    });
    expect(context.budget.totalChars).toBeLessThan(100_000);
    expect(context.budget.tokens.estimatedInputTokens).toBeLessThanOrEqual(200);
    expect(context.budget.trimmed).toContain("tokens:history");
  });

  it("degrades in the documented order when the token ceiling binds", () => {
    const state = applyStatePatch(emptyConversationState(), {
      summary: { text: TELUGU_TURN.repeat(4), throughMessageCount: 0, updatedAt: null },
    });
    const knowledge = { ...emptyKnowledge(), snippets: [snippet(0, TELUGU_TURN), snippet(1, TELUGU_TURN)] };
    const context = build({
      history: turns(10, TELUGU_TURN),
      state,
      knowledge,
      limits: { maxTotalChars: 100_000, maxInputTokens: 60 },
    });
    expect(context.knowledge.snippets).toHaveLength(0);
    expect(context.summary).toBe("");
    expect(context.recentMessages).toHaveLength(2);
    expect(context.budget.trimmed).toEqual(
      expect.arrayContaining(["tokens:knowledge", "tokens:summary", "tokens:history"]),
    );
    // The floor holds: the last two turns are what the conversation is about.
    expect(context.recentMessages.every((m) => m.content.length > 0)).toBe(true);
  });

  it("reports honestly rather than trimming tenant content when the budget is exhausted", () => {
    // Everything reducible is gone and the fixed content alone is over. The
    // right answer is a visible over-budget report, never a trimmed template
    // or a dropped verified system action.
    const context = build({
      systemSections: [TELUGU_TURN.repeat(10)],
      limits: { maxInputTokens: 10 },
    });
    expect(context.budget.tokens.needsReduction).toBe(true);
    expect(context.budget.tokens.nextToReduce).toBeNull();
    expect(context.budget.tokens.remainingTokens).toBeLessThan(0);
    expect(context.systemSections[0]).toBe(TELUGU_TURN.repeat(10));
    expect(context.agent.promptTemplate).toBe(makeAgent().promptTemplate);
  });

  it("leaves today's voice configuration untouched on a Telugu mid-call turn", () => {
    // Regression guard: the new ceiling must not start trimming calls that
    // were fine yesterday. If this fails, the limit moved, not the content.
    const context = build({
      channel: PHONE_VOICE_PROFILE,
      history: turns(30, TELUGU_TURN),
      limits: VOICE_CONTEXT_LIMITS,
    });
    expect(context.budget.trimmed.filter((t) => t.startsWith("tokens:"))).toEqual([]);
    expect(context.budget.tokens.estimatedInputTokens).toBeLessThan(VOICE_CONTEXT_LIMITS.maxInputTokens);
  });

  it("trims a Telugu message without breaking a syllable", () => {
    const context = build({
      history: [{ role: "user", content: TELUGU_TURN }],
      limits: { maxMessageChars: 20 },
    });
    const trimmedMessage = context.recentMessages[0].content;
    expect(trimmedMessage.length).toBeLessThanOrEqual(20);
    expect(TELUGU_TURN.startsWith(trimmedMessage)).toBe(true);
    expect(trimmedMessage).toBe(trimmedMessage.normalize("NFC"));
    expect(estimateTokens(trimmedMessage).estimatedTokens).toBeGreaterThan(0);
  });

  it("is deterministic under the token budget", () => {
    const params = {
      history: turns(12, TELUGU_TURN),
      limits: { maxInputTokens: 150 },
    };
    expect(build(params)).toEqual(build(params));
  });
});
