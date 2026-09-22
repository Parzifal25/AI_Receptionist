/**
 * HALO Phase 4 — context budget measurement (brief §14).
 *
 * Measures the RENDERED system prompt for one realistic mid-call turn, split
 * into its parts, under three configurations. No estimates: every number
 * below is `.length` on the string that would actually be sent.
 *
 *   npx tsx scripts/phase4-context-budget.ts
 */
import type { Business, ChatMessage } from "../packages/core/domain/types";
import { PHONE_VOICE_PROFILE, WEB_CHAT_PROFILE } from "../packages/runtime/channel-profile";
import { buildConversationContext, DEFAULT_CONTEXT_LIMITS, VOICE_CONTEXT_LIMITS } from "../packages/runtime/context-builder";
import { emptyConversationState } from "../packages/runtime/conversation-state";
import { composePrompt, genericDoctrine } from "../packages/runtime/prompt-composer";
import { BUILTIN_TOOLS, ToolRegistry } from "../packages/runtime/tools/registry";
import { NegotiationSystemActionProvider } from "../packages/negotiation/system-action";
import { QualificationSystemActionProvider } from "../packages/qualification/system-action";
import { selectLanguagePack } from "../packages/language/language-pack";
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

/** 30 prior turns — a realistic mid-call transcript, not a fresh call. */
function history(): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < 15; i++) {
    out.push({ role: "user", content: "నాకు సోలార్ గురించి తెలుసుకోవాలి, నెల బిల్లు ఎక్కువ వస్తోంది." });
    out.push({ role: "assistant", content: "అర్థమైంది. మీరు ఏ ఏరియాలో ఉంటున్నారు?" });
  }
  return out;
}

async function sections(withPhase4: boolean): Promise<string[]> {
  if (!withPhase4) return [];
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
    userMessage: "idi chala expensive andi",
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

async function measure(label: string, opts: { phase4: boolean; voice: boolean }) {
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
  const systemSections = await sections(opts.phase4);
  const channel = opts.voice ? PHONE_VOICE_PROFILE : WEB_CHAT_PROFILE;

  const context = buildConversationContext({
    trusted: { businessId: BUSINESS.id, conversationId: "c", agentId: "agent-1", agentVersionId: "av-1", turnId: "t" },
    agent,
    channel,
    state: emptyConversationState(),
    history: history(),
    knowledge: { snippets: [], sources: [], charsUsed: 0, truncated: false, query: "" },
    tools,
    systemSections,
    verifiedActions: [],
    customer: null,
    limits: opts.voice ? VOICE_CONTEXT_LIMITS : DEFAULT_CONTEXT_LIMITS,
  });

  const prompt = composePrompt({
    business: BUSINESS,
    agentName: context.agent.name,
    promptTemplate: context.agent.promptTemplate,
    customInstructions: context.agent.customInstructions,
    language: context.agent.language,
    channel,
    state: context.state,
    summary: context.summary,
    knowledge: context.knowledge.snippets,
    tools: context.tools,
    systemSections: context.systemSections,
    customer: context.customer,
    doctrine: genericDoctrine(channel),
    // Production wiring: every provider that declares `tools: true` receives
    // these same descriptors natively, so the composer does not repeat them.
    toolsNativelyOffered: true,
  });

  const bySection = new Map(prompt.sections.map((s) => [s.id, s.text.length]));
  const systemSectionChars = systemSections.reduce((n, sec) => n + sec.length, 0);
  const historyChars = context.recentMessages.reduce((n, m) => n + m.content.length, 0);
  return {
    label,
    rendered: prompt.text.length,
    budgetTotal: context.budget.totalChars,
    limit: context.budget.limits.maxTotalChars,
    template: bySection.get("identity") ?? 0,
    capabilities: bySection.get("capabilities") ?? 0,
    rules: bySection.get("rules") ?? 0,
    systemActions: bySection.get("system_actions") ?? 0,
    systemSectionChars,
    historyChars,
    trimmed: context.budget.trimmed,
  };
}

async function main() {
  const rows = [
    await measure("web-chat budget, no Phase 4 sections", { phase4: false, voice: false }),
    await measure("voice budget, no Phase 4 sections (Phase 3 behaviour)", { phase4: false, voice: true }),
    await measure("voice budget, with Phase 4 sections", { phase4: true, voice: true }),
  ];

  console.log("\n=== Phase 4 context budget (characters; measured, not estimated) ===\n");
  console.log(
    ["configuration".padEnd(52), "rendered", "budgeted", "limit", "history"].join("  "),
  );
  for (const row of rows) {
    console.log(
      [
        row.label.padEnd(52),
        String(row.rendered).padStart(8),
        String(row.budgetTotal).padStart(8),
        String(row.limit).padStart(5),
        String(row.historyChars).padStart(7),
      ].join("  "),
    );
  }

  console.log("\n--- where the Phase 4 voice prompt goes ---");
  const p4 = rows[2];
  console.log(`  agent prompt template (stable per version)   ${p4.template}`);
  console.log(`  tool descriptors incl. JSON schema          ${p4.capabilities}`);
  console.log(`  platform rules (stable)                    ${p4.rules}`);
  console.log(`  verified system actions (per turn)         ${p4.systemSectionChars} supplied, ` +
    `${p4.rendered - rows[1].rendered} added to the rendered prompt`);
  console.log(`  recent history kept                        ${p4.historyChars}`);
  console.log(`  trimmed by the budget                      ${p4.trimmed.join(", ") || "(nothing)"}`);

  const stable = p4.template + p4.rules;
  console.log(`\n  stable prefix (template + rules)           ${stable} of ${p4.rendered} rendered ` +
    `(${Math.round((stable / p4.rendered) * 100)}%)`);
  console.log("  → that prefix is identical on every turn of every call for this agent version,");
  console.log("    which is what makes prompt caching the next real win. It is NOT implemented.");

  console.log("\n--- honest note on the budget ---");
  console.log("  `budgeted` counts the INPUTS the builder controls (template, sections, history,");
  console.log("  knowledge, tool names). `rendered` is the string actually sent, which also carries");
  console.log("  the composer's own headings, the rules section and tool JSON schemas. The gap is");
  console.log(`  ${p4.rendered - p4.budgetTotal} characters and is not currently bounded by maxTotalChars.\n`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
