/**
 * HALO Phase 4.5 Sprint 2 — prompt and token measurement.
 *
 * Reports the rendered system prompt for one realistic mid-call turn in three
 * languages, split into stable content, dynamic content and tool descriptors,
 * in characters, UTF-8 bytes and ESTIMATED tokens.
 *
 * Every character and byte figure is MEASURED (`.length` and a UTF-8 count on
 * the string that would actually be sent). Every token figure is an ESTIMATE
 * from `packages/language/tokens.ts`: no tokenizer ships here and no provider
 * has reported `input_tokens` for this product. The columns are labelled so
 * the two can never be confused in a report.
 *
 *   npm run sprint2:tokens
 */
import type { Business, ChatMessage } from "../packages/core/domain/types";
import { estimateTokens } from "../packages/language/tokens";
import { selectLanguagePack } from "../packages/language/language-pack";
import { PHONE_VOICE_PROFILE } from "../packages/runtime/channel-profile";
import { buildConversationContext, VOICE_CONTEXT_LIMITS } from "../packages/runtime/context-builder";
import { emptyConversationState } from "../packages/runtime/conversation-state";
import { composePrompt, genericDoctrine, type PromptSectionId } from "../packages/runtime/prompt-composer";
import { BUILTIN_TOOLS, ToolRegistry } from "../packages/runtime/tools/registry";
import { NegotiationSystemActionProvider } from "../packages/negotiation/system-action";
import { QualificationSystemActionProvider } from "../packages/qualification/system-action";
import { resolvedContextForCall } from "../packages/voice/phone-channel-adapter";
import { requireArunodhaya, pendingFactGuidance } from "../src/content/tenants/arunodhaya";

const BUSINESS: Business = {
  id: "biz-arunodhaya",
  name: "Arunodhaya Solar",
  slug: "arunodhaya",
  description: "Rooftop solar installation",
  industry: "solar",
  website: "",
  phone: "+914000000001",
  email: "",
  address: "Hyderabad",
  businessHours: { mon: { open: "09:00", close: "18:00", closed: false } },
  logoUrl: "",
};

/**
 * Sections whose text changes only when an agent version is published, a
 * tenant profile is edited, or this code changes. Everything else is per-turn.
 * This is an accounting split for the report — NOT a cache prefix, which is
 * Sprint 3 and needs the section order changed.
 */
const STABLE: ReadonlySet<PromptSectionId> = new Set<PromptSectionId>([
  "identity",
  "business_facts",
  "channel",
  "situations",
  "extra",
  "capabilities",
  "rules",
  "custom_instructions",
]);

interface Conversation {
  label: string;
  user: string;
  assistant: string;
  /** What the caller says on the turn being measured. */
  utterance: string;
}

/**
 * Three representative mid-call conversations, matched so the comparison is
 * like for like: each caller raises the SAME objection ("too_expensive") in a
 * different language, using a cue phrase the tenant already authored, so the
 * same system-action sections are produced and the only thing that varies is
 * the script the conversation is written in. Every non-English line is drawn
 * from text already in this repository or is neutral; none invents a business
 * fact (see tests/unit/voice/smoke-utterances.test.ts for the rule).
 */
const CONVERSATIONS: Conversation[] = [
  {
    label: "English",
    user: "I want to know about solar, my monthly bill keeps going up.",
    assistant: "Understood. Which area are you living in?",
    utterance: "this is too expensive",
  },
  {
    label: "Telugu",
    user: "నాకు సోలార్ గురించి తెలుసుకోవాలి, నెల బిల్లు ఎక్కువ వస్తోంది.",
    assistant: "అర్థమైంది. మీరు ఏ ఏరియాలో ఉంటున్నారు?",
    utterance: "ఇది చాలా ఖరీదు",
  },
  {
    label: "Tenglish",
    user: "naaku solar gurinchi telusukovali, nela bill ekkuva vastondi",
    assistant: "artham aindi. meeru ea area lo untunnaru?",
    utterance: "idi chala expensive andi",
  },
];

function history(c: Conversation): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < 15; i++) {
    out.push({ role: "user", content: c.user });
    out.push({ role: "assistant", content: c.assistant });
  }
  return out;
}

async function systemSections(utterance: string): Promise<string[]> {
  const bundle = requireArunodhaya();
  const pack = selectLanguagePack(bundle.language).pack;
  const qualification = new QualificationSystemActionProvider({
    schema: bundle.qualification,
    pack,
    ...(bundle.qualification.billRanges ? { billRanges: bundle.qualification.billRanges } : {}),
  });
  const negotiation = new NegotiationSystemActionProvider({
    policy: bundle.negotiation,
    catalog: bundle.objections,
    language: bundle.language,
  });
  const input = {
    trusted: { businessId: BUSINESS.id, conversationId: "c", agentId: "a", agentVersionId: "v", turnId: "t" },
    business: BUSINESS,
    history: [],
    userMessage: utterance,
    state: emptyConversationState(),
    now: new Date("2026-09-21T10:00:00Z"),
  };
  const out: string[] = [];
  for (const provider of [qualification, negotiation]) {
    const outcome = await provider.prepare(input);
    if (outcome) out.push(...outcome.sections);
  }
  const guidance = pendingFactGuidance(bundle.facts, bundle.language);
  if (guidance) out.push(guidance);
  return out;
}

async function measure(conversation: Conversation) {
  const bundle = requireArunodhaya();
  const version = {
    id: "av-1",
    agentId: "agent-1",
    businessId: BUSINESS.id,
    version: 1,
    config: bundle.config,
    promptTemplate: bundle.config.instructions.promptTemplate,
    promptVersion: "2026-09-21.1",
    model: {},
    publishedAt: "2026-09-21T00:00:00Z",
    createdBy: null,
    createdAt: "2026-09-21T00:00:00Z",
  };
  const agent = resolvedContextForCall({ business: BUSINESS, agentId: "agent-1", version });
  const registry = new ToolRegistry(BUILTIN_TOOLS, {
    offer_concession: async () => ({ ok: true, summary: "" }),
    request_human_handoff: async () => ({ ok: true, summary: "" }),
  });
  const tools = registry.boundNames().map((n) => registry.descriptor(n)!).filter(Boolean);
  const sections = await systemSections(conversation.utterance);

  const context = buildConversationContext({
    trusted: { businessId: BUSINESS.id, conversationId: "c", agentId: "agent-1", agentVersionId: "av-1", turnId: "t" },
    agent,
    channel: PHONE_VOICE_PROFILE,
    state: emptyConversationState(),
    history: history(conversation),
    knowledge: { snippets: [], sources: [], charsUsed: 0, truncated: false, query: "" },
    tools,
    systemSections: sections,
    verifiedActions: [],
    customer: null,
    limits: VOICE_CONTEXT_LIMITS,
  });

  const prompt = composePrompt({
    business: BUSINESS,
    agentName: context.agent.name,
    promptTemplate: context.agent.promptTemplate,
    customInstructions: context.agent.customInstructions,
    language: context.agent.language,
    channel: PHONE_VOICE_PROFILE,
    state: context.state,
    summary: context.summary,
    knowledge: context.knowledge.snippets,
    tools: context.tools,
    systemSections: context.systemSections,
    customer: context.customer,
    doctrine: genericDoctrine(PHONE_VOICE_PROFILE),
    toolsNativelyOffered: true,
  });

  const stableText = prompt.sections.filter((s) => STABLE.has(s.id)).map((s) => s.text).join("\n\n");
  const dynamicText = prompt.sections.filter((s) => !STABLE.has(s.id)).map((s) => s.text).join("\n\n");
  // Tool descriptors travel in the request body, not the prompt. They are a
  // real per-turn input cost and are reported separately for that reason.
  const toolSchemaText = context.tools
    .map((t) => `${t.name}${t.description}${JSON.stringify(t.parameters)}`)
    .join("");
  const historyText = context.recentMessages.map((m) => m.content).join("\n");

  return {
    label: conversation.label,
    rendered: estimateTokens(prompt.text),
    stable: estimateTokens(stableText),
    dynamic: estimateTokens(dynamicText),
    toolSchemas: estimateTokens(toolSchemaText),
    history: estimateTokens(historyText),
    budget: context.budget,
  };
}

function row(label: string, e: ReturnType<typeof estimateTokens>): string {
  return [
    label.padEnd(30),
    String(e.chars).padStart(8),
    String(e.bytes).padStart(8),
    String(e.estimatedTokens).padStart(10),
    e.charsPerToken.toFixed(2).padStart(9),
  ].join("  ");
}

async function main() {
  console.log("\n=== Sprint 2 — prompt and token report (phone-voice, Phase 4 sections) ===");
  console.log("chars and bytes are MEASURED. tokens are ESTIMATED — no tokenizer, no provider count.\n");

  for (const conversation of CONVERSATIONS) {
    const m = await measure(conversation);
    console.log(`--- ${m.label} conversation ---`);
    console.log(["component".padEnd(30), "chars", "bytes", "est.tokens", "chars/tok"].map((h, i) =>
      i === 0 ? h : h.padStart([0, 8, 8, 10, 9][i])).join("  "));
    console.log(row("rendered system prompt", m.rendered));
    console.log(row("  of which stable", m.stable));
    console.log(row("  of which dynamic", m.dynamic));
    console.log(row("native tool schemas (body)", m.toolSchemas));
    console.log(row("recent history (messages)", m.history));
    const turn = m.rendered.estimatedTokens + m.toolSchemas.estimatedTokens + m.history.estimatedTokens;
    console.log(`  typical turn input, ESTIMATED   ${turn} tokens ` +
      `(prompt ${m.rendered.estimatedTokens} + tools ${m.toolSchemas.estimatedTokens} + history ${m.history.estimatedTokens})`);
    console.log(`  builder budget: ${m.budget.tokens.estimatedInputTokens} est. tokens of ` +
      `${m.budget.limits.maxInputTokens}, ${m.budget.totalChars} chars of ${m.budget.limits.maxTotalChars}`);
    console.log(`  trimmed: ${m.budget.trimmed.join(", ") || "(nothing)"}\n`);
  }

  console.log("Reading this table:");
  console.log("  chars/tok near 4 is Latin text; near 1 is Telugu. The whole point of the");
  console.log("  estimator is that those two numbers are not interchangeable, and the old");
  console.log("  character-only budget treated them as if they were.");
  console.log("  The stable/dynamic split is ACCOUNTING, not a cache prefix: the stable");
  console.log("  sections are not contiguous from the start of the prompt, and reordering");
  console.log("  them is Sprint 3.\n");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
