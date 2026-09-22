import type { ChatMessage } from "@halo/core/domain/types";
import { truncateChars } from "@halo/language/truncate";
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
import {
  buildTokenBudgetReport,
  measureComponent,
  type ComponentUsage,
  type ReducibleComponent,
  type TokenBudgetPolicy,
} from "./token-budget";

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
  // 32,000 characters is ~8,000 tokens of English and ~32,000 of Telugu. The
  // token ceiling is what actually binds a multilingual turn, and it is set
  // from what a chat turn has been measured to cost, with headroom — not
  // from the character ceiling divided by four.
  maxInputTokens: 12_000,
  reservedOutputTokens: 1_024,
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
  /*
   * A phone turn's estimated token cost is dominated by the Telugu system-
   * action sections, which are verified ground truth and are never trimmed.
   * The measured Phase 4 voice prompt estimates at roughly 4.4K tokens
   * (`npm run sprint2:tokens`), so 6,000 leaves the current configuration
   * untouched while still bounding the case this ceiling exists for: a
   * tenant who authors the template, the knowledge base or the history in
   * Telugu, where the character budget stops meaning anything.
   */
  maxInputTokens: 6_000,
  reservedOutputTokens: 512,
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

/**
 * Character trimming that never splits a codepoint or a Telugu syllable.
 * `slice` would: it counts UTF-16 code units, so it can orphan a vowel sign
 * or a surrogate half and change what the caller actually said.
 */
function trimText(text: string, max: number): string {
  return text.length > max ? truncateChars(text, max) : text;
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

  /*
   * The same degradation again, in the unit that binds a multilingual turn.
   *
   * Characters bound what this code hands around; ESTIMATED tokens bound what
   * the provider will accept, and on Telugu the two differ by about 4x. A
   * context that passed the loop above can still be far over the token
   * ceiling, so it is enforced separately, in the same order, with the same
   * floor of two messages — and never against the fixed components, because
   * dropping a verified system action or a tool descriptor removes a fact or
   * a capability rather than some detail.
   *
   * `npm run sprint2:tokens` prints what this costs per language.
   */
  const tokenPolicy: TokenBudgetPolicy = {
    maxInputTokens: limits.maxInputTokens,
    reservedOutputTokens: limits.reservedOutputTokens,
  };
  const measure = (): ComponentUsage[] => [
    measureComponent("prompt_template", agent.promptTemplate),
    measureComponent(
      "custom_instructions",
      agent.config.instructions.customInstructions || agent.receptionist.customInstructions,
    ),
    measureComponent("system_actions", params.systemSections.join("\n")),
    measureComponent("tools", tools.map((t) => `${t.name}${t.description}`).join("\n")),
    measureComponent("customer", customer ? customer.facts.join("\n") : ""),
    measureComponent("knowledge", knowledgeSnippets.map((s) => s.content).join("\n")),
    measureComponent("summary", summary),
    measureComponent("history", recentMessages.map((m) => m.content).join("\n")),
  ];
  const present = (): Set<ReducibleComponent> => {
    const set = new Set<ReducibleComponent>();
    if (knowledgeSnippets.length > 0) set.add("knowledge");
    if (summary.length > 0) set.add("summary");
    if (recentMessages.length > 2) set.add("history");
    return set;
  };
  let tokenReport = buildTokenBudgetReport({ components: measure(), policy: tokenPolicy, present: present() });
  // Bounded by construction: each pass removes one unit of the named
  // component, and the component is dropped from `present` once empty.
  while (tokenReport.nextToReduce !== null) {
    const target = tokenReport.nextToReduce;
    if (target === "knowledge") knowledgeSnippets = knowledgeSnippets.slice(0, -1);
    else if (target === "summary") summary = "";
    else recentMessages = recentMessages.slice(1);
    trimmed.push(`tokens:${target}`);
    tokenReport = buildTokenBudgetReport({ components: measure(), policy: tokenPolicy, present: present() });
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
        truncated:
        params.knowledge.truncated ||
        dedupedTrimmed.some((t) => t.startsWith("knowledge") || t === "budget:knowledge" || t === "tokens:knowledge"),
    },
    tools,
    systemSections: params.systemSections,
    verifiedActions: params.verifiedActions,
    customer,
    budget: { limits, totalChars: total(), trimmed: dedupedTrimmed, tokens: tokenReport },
  };
}
