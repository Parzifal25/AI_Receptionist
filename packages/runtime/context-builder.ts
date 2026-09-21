import type { ChatMessage } from "@halo/core/domain/types";
import type {
  ActionRecord,
  ChannelProfile,
  ContextLimits,
  ConversationContext,
  CustomerContext,
  KnowledgeContext,
  ResolvedAgentRuntimeContext,
  ToolDescriptor,
  TrustedRequestContext,
} from "./contracts";
import type { ConversationState } from "./conversation-state";

/**
 * HALO Phase 2 — bounded context builder (Workstream 3).
 *
 * Assembles everything a turn needs, once, deterministically, with explicit
 * limits on every component. Nothing here calls a model or a database: the
 * caller loads history/state/knowledge through their ports and hands the
 * raw material in; the builder only selects, trims and accounts.
 *
 * What is deliberately NOT included: other tenants' anything, secrets,
 * authorization internals, every tool definition (only the offered ones),
 * unlimited history, unrelated knowledge, raw client metadata.
 */

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = Object.freeze({
  maxRecentMessages: 16,
  maxHistoryFetch: 40,
  maxMessageChars: 2000,
  maxSummaryChars: 1200,
  maxKnowledgeSnippets: 6,
  maxKnowledgeChars: 7200,
  maxToolDescriptors: 8,
  maxCustomerFacts: 8,
  maxTotalChars: 32_000,
});

/**
 * Voice context budget (Phase 3, docs/VOICE_TOKEN_BUDGET.md).
 *
 * A phone turn is not a chat turn. The caller is waiting in silence, so
 * time-to-first-token is the dominant cost, and prompt size is the part of it
 * we control. The same layering as `DEFAULT_CONTEXT_LIMITS` is kept — this is
 * a re-budgeting of the existing builder, not a second code path — with each
 * layer sized for what can actually be said aloud in one turn:
 *
 *   - knowledge is cut hardest (6 snippets/7200 chars → 3/2400): an agent can
 *     speak one or two facts per turn, so the rest is paid for and discarded;
 *   - messages are short because replies are capped at 450 spoken chars, so
 *     the per-message cap drops with them;
 *   - `maxToolDescriptors` is deliberately UNCHANGED: trimming knowledge
 *     costs detail, but dropping a tool descriptor silently removes a
 *     capability the agent was configured to have.
 */
export const VOICE_CONTEXT_LIMITS: ContextLimits = Object.freeze({
  maxRecentMessages: 10,
  maxHistoryFetch: 24,
  maxMessageChars: 600,
  maxSummaryChars: 800,
  maxKnowledgeSnippets: 3,
  maxKnowledgeChars: 2400,
  maxToolDescriptors: DEFAULT_CONTEXT_LIMITS.maxToolDescriptors,
  maxCustomerFacts: 6,
  maxTotalChars: 9_000,
});

export interface BuildContextParams {
  trusted: TrustedRequestContext;
  agent: ResolvedAgentRuntimeContext;
  channel: ChannelProfile;
  state: ConversationState;
  /** Chronological transcript rows (user/assistant only), possibly longer than the window. */
  history: ChatMessage[];
  knowledge: KnowledgeContext;
  tools: ToolDescriptor[];
  systemSections: string[];
  verifiedActions: ActionRecord[];
  customer?: CustomerContext | null;
  limits?: Partial<ContextLimits>;
}

function trimText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Only visitor/assistant rows reach the model as history. */
export function conversationalHistory(history: ChatMessage[]): ChatMessage[] {
  return history.filter((m) => m.role === "user" || m.role === "assistant");
}

export function buildConversationContext(params: BuildContextParams): ConversationContext {
  const limits: ContextLimits = { ...DEFAULT_CONTEXT_LIMITS, ...(params.limits ?? {}) };
  const trimmed: string[] = [];
  const { agent } = params;

  const conversational = conversationalHistory(params.history);
  let recentMessages = conversational
    .slice(-limits.maxRecentMessages)
    .map((m) => ({ role: m.role, content: trimText(m.content, limits.maxMessageChars) }));
  if (conversational.length > limits.maxRecentMessages) trimmed.push("history:window");

  let summary = trimText(params.state.summary.text, limits.maxSummaryChars);
  if (summary.length < params.state.summary.text.length) trimmed.push("summary:chars");

  // Defensive re-bounding: the resolver already budgets, but the builder is
  // the single place the limits are guaranteed.
  let knowledgeSnippets = params.knowledge.snippets.slice(0, limits.maxKnowledgeSnippets);
  if (knowledgeSnippets.length < params.knowledge.snippets.length) trimmed.push("knowledge:count");
  let knowledgeChars = 0;
  knowledgeSnippets = knowledgeSnippets.flatMap((s) => {
    const remaining = limits.maxKnowledgeChars - knowledgeChars;
    if (remaining <= 0) {
      trimmed.push("knowledge:chars");
      return [];
    }
    const content = trimText(s.content, remaining);
    knowledgeChars += content.length;
    if (content.length < s.content.length) trimmed.push("knowledge:chars");
    return [{ ...s, content }];
  });

  const tools = params.tools.slice(0, limits.maxToolDescriptors);
  if (tools.length < params.tools.length) trimmed.push("tools:count");

  const customer: CustomerContext | null = params.customer
    ? {
        ...(params.customer.name ? { name: trimText(params.customer.name, 120) } : {}),
        facts: params.customer.facts.slice(0, limits.maxCustomerFacts).map((f) => trimText(f, 240)),
      }
    : null;

  const fixedChars =
    agent.promptTemplate.length +
    (agent.config.instructions.customInstructions || agent.receptionist.customInstructions).length +
    params.systemSections.reduce((n, s) => n + s.length, 0) +
    tools.reduce((n, t) => n + t.name.length + t.description.length, 0) +
    (customer ? customer.facts.reduce((n, f) => n + f.length, 0) : 0);

  const total = () =>
    fixedChars +
    summary.length +
    knowledgeSnippets.reduce((n, s) => n + s.content.length, 0) +
    recentMessages.reduce((n, m) => n + m.content.length, 0);

  // Deterministic degradation order when the whole context is too large:
  // knowledge (least specific to this visitor) → summary → oldest history,
  // never below the last two messages.
  while (total() > limits.maxTotalChars && knowledgeSnippets.length > 0) {
    knowledgeSnippets = knowledgeSnippets.slice(0, -1);
    trimmed.push("budget:knowledge");
  }
  if (total() > limits.maxTotalChars && summary.length > 0) {
    summary = "";
    trimmed.push("budget:summary");
  }
  while (total() > limits.maxTotalChars && recentMessages.length > 2) {
    recentMessages = recentMessages.slice(1);
    trimmed.push("budget:history");
  }

  const dedupedTrimmed = [...new Set(trimmed)];

  return {
    trusted: params.trusted,
    business: agent.business,
    agent: {
      id: params.trusted.agentId,
      versionId: params.trusted.agentVersionId,
      version: agent.agentVersion,
      name: agent.config.identity.name || agent.receptionist.name,
      objective: agent.config.objective,
      language: agent.config.language.primary || agent.receptionist.language || "en",
      promptTemplate: agent.promptTemplate,
      customInstructions:
        agent.config.instructions.customInstructions || agent.receptionist.customInstructions,
      model: agent.model ?? {},
      leadCaptureEnabled: agent.receptionist.leadCaptureEnabled,
    },
    channel: params.channel,
    state: params.state,
    recentMessages,
    summary,
    knowledge: {
      ...params.knowledge,
      snippets: knowledgeSnippets,
      sources: knowledgeSnippets.map((s) => s.title),
      charsUsed: knowledgeSnippets.reduce((n, s) => n + s.content.length, 0),
      truncated: params.knowledge.truncated || dedupedTrimmed.some((t) => t.startsWith("knowledge") || t === "budget:knowledge"),
    },
    tools,
    systemSections: params.systemSections,
    verifiedActions: params.verifiedActions,
    customer,
    budget: { limits, totalChars: total(), trimmed: dedupedTrimmed },
  };
}
