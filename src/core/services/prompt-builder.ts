import type { Business, KnowledgeSnippet, Receptionist } from "@halo/core/domain/types";
import type { Playbook } from "@halo/knowledge/playbooks";
import { matchIndustryPlaybook } from "@/content/industry-playbooks";
import { WEB_CHAT_PROFILE, WEB_VOICE_PROFILE } from "@halo/runtime/channel-profile";
import { emptyConversationState } from "@halo/runtime/conversation-state";
import {
  buildSafetyRules,
  composePrompt,
  genericDoctrine,
  LEAD_CAPTURE_DOCTRINE,
  PROMPT_COMPOSER_VERSION,
  type PromptDoctrine,
} from "@halo/runtime/prompt-composer";

/**
 * Version of the prompt assembler — the CODE that composes the system
 * prompt (section order, safety rules, grounding format). Distinct from the
 * business's published prompt CONTENT, which lives in
 * `agent_versions.prompt_template` and whose version is
 * `agent_versions.version`.
 *
 * Since Phase 2 the assembler is the HALO runtime's PromptComposer
 * (`packages/runtime/prompt-composer.ts`); this constant mirrors its version
 * so conversation logs and A/B analyses keep a single attribution key.
 */
export const PROMPT_ASSEMBLER_VERSION = PROMPT_COMPOSER_VERSION;

/**
 * @deprecated Compatibility alias. The assembler version is code-level;
 * conversation content versioning lives in `agent_versions.version`. New
 * code should import PROMPT_ASSEMBLER_VERSION.
 */
export const PROMPT_VERSION = PROMPT_ASSEMBLER_VERSION;

export { buildSafetyRules };

const TONE_DESCRIPTIONS: Record<string, string> = {
  friendly: "Warm, approachable and upbeat. Use natural conversational language.",
  professional: "Polished and courteous. Clear, precise, businesslike language.",
  casual: "Relaxed and informal, like chatting with a helpful colleague.",
  formal: "Respectful and traditional. Complete sentences, no slang.",
};

export interface PromptTemplateContext {
  business: Business;
  receptionist: Receptionist;
  knowledge: KnowledgeSnippet[];
  channel?: "chat" | "voice";
  /**
   * Playbook content is APPLICATION/TENANT data (plan §2.4 rule 1) — the
   * assembler only renders the section it is given. Defaults to the app's
   * seed catalog for backward compatibility; agent configuration can pass
   * its own (or none).
   */
  playbook?: Playbook | null;
}

/**
 * The receptionist doctrine: the pre-HALO receptionist persona (identity +
 * tone), the richer receptionist situation playbook, the matched industry
 * playbook and lead-capture behaviour — all APPLICATION content. Used by
 * the runtime for agents without a published template (the compatibility
 * path) so existing receptionists keep their behaviour.
 */
export function receptionistDoctrine(params: {
  business: Business;
  receptionist: Receptionist;
  playbook?: Playbook | null;
}): PromptDoctrine {
  const { business, receptionist } = params;
  const playbook =
    params.playbook !== undefined
      ? params.playbook
      : matchIndustryPlaybook(business.industry, business.description);

  const doctrine = genericDoctrine();
  doctrine.identityFallback =
    `You are ${receptionist.name}, the receptionist for ${business.name}. You are a real member of the team in every way that matters: you know the business, you care about its customers, and your job is to help every visitor quickly, make them feel heard, and connect them with the team when that's the right next step. You are talking with a website visitor right now.\n\n` +
    `## Tone\n${TONE_DESCRIPTIONS[receptionist.tone] ?? TONE_DESCRIPTIONS.friendly}`;

  // The receptionist situation list is the generic one with the richer
  // acknowledge-before-ask phrasing kept from the original receptionist prompt.
  doctrine.situations = doctrine.situations.map((s) =>
    s.startsWith("Booking or appointment request:")
      ? `Booking or appointment request: enthusiastically collect what the team needs — the service, their name, their phone or email, and preferred times — one detail at a time, and never ask again for something they've already told you. If a "Live scheduling" section appears below, follow it exactly: offer only those verified times, treat the details it lists as already collected, and ask only for what it says is still missing. Never announce a booking as confirmed, held or reserved unless a "Booking status" section says the system actually made it — if that section says the booking failed, say so plainly and offer the alternatives it gives you. Without such a section you cannot confirm a slot yourself — say the team will confirm shortly.`
      : s,
  );
  if (playbook?.emergency) doctrine.situations.unshift(`Emergency: ${playbook.emergency}`);

  if (playbook) {
    const playbookLines = [
      ...playbook.notes.map((n) => `- ${n}`),
      `- Useful details to gather naturally over the conversation (one at a time, never as a checklist): ${playbook.qualifyingDetails.join("; ")}.`,
    ];
    if (playbook.compliance) playbookLines.push(`- Hard rule: ${playbook.compliance}`);
    doctrine.extras.push({ title: "Industry playbook", body: playbookLines.join("\n") });
  }

  if (receptionist.leadCaptureEnabled) {
    doctrine.extras.push({
      title: LEAD_CAPTURE_DOCTRINE.title,
      body:
        `Part of your job is making sure interested visitors don't slip away. When a visitor shows interest (asks about services, pricing, availability) or you can't answer their question, naturally work toward collecting their name, phone number or email, and what they need — conversationally, one detail at a time, never as a form. Phone number is the most valuable detail. Time your ask to a moment you're providing value ("I can have the team call you with an exact quote — what's the best number?"). If they decline, drop it gracefully and keep helping; ask at most twice per conversation.`,
    });
  }
  return doctrine;
}

/**
 * The compatibility path: assembles the full system prompt for a
 * receptionist without a published agent template (identity → tone → facts
 * → knowledge → conversation → situations → playbook → lead capture → rules
 * → custom instructions). Since Phase 2 it is the runtime PromptComposer
 * fed with the receptionist doctrine, so the same code policy applies.
 */
export function buildSystemPrompt(params: PromptTemplateContext): string {
  const { business, receptionist, knowledge, channel = "chat" } = params;
  return composePrompt({
    business,
    agentName: receptionist.name,
    promptTemplate: "",
    customInstructions: receptionist.customInstructions,
    language: "en",
    channel: channel === "voice" ? WEB_VOICE_PROFILE : WEB_CHAT_PROFILE,
    state: emptyConversationState(),
    summary: "",
    knowledge,
    tools: [],
    systemSections: [],
    customer: null,
    doctrine: receptionistDoctrine({ business, receptionist, playbook: params.playbook }),
  }).text;
}

/**
 * The agent-version path: composes the system prompt from the published
 * `agent_versions.prompt_template` (business configuration) around the same
 * grounded facts and the same invariant safety rules. The template can
 * define identity/tone/behaviour — it can never weaken the Rules section,
 * which is code policy appended after it and declared to take precedence.
 *
 * Deterministic: same inputs, same prompt. No timestamps, no randomness.
 */
export function buildSystemPromptFromAgentVersion(params: {
  business: Business;
  agentName: string;
  promptTemplate: string;
  knowledge: KnowledgeSnippet[];
  /** Appended after the template, subject to the Rules. */
  customInstructions?: string;
  /** Language default announced in the Rules when not English. */
  language?: string;
  channel?: "chat" | "voice";
  /** Whether the runtime captures leads on this conversation. */
  leadCaptureEnabled?: boolean;
}): string {
  const doctrine = genericDoctrine();
  if (params.leadCaptureEnabled) doctrine.extras.push(LEAD_CAPTURE_DOCTRINE);
  return composePrompt({
    business: params.business,
    agentName: params.agentName,
    promptTemplate: params.promptTemplate,
    customInstructions: params.customInstructions ?? "",
    language: params.language ?? "en",
    channel: params.channel === "voice" ? WEB_VOICE_PROFILE : WEB_CHAT_PROFILE,
    state: emptyConversationState(),
    summary: "",
    knowledge: params.knowledge,
    tools: [],
    systemSections: [],
    customer: null,
    doctrine,
  }).text;
}

/**
 * Prompt for the structured lead-extraction pass. Runs in JSON mode against
 * the conversation transcript.
 */
export function buildLeadExtractionPrompt(): string {
  return `You extract contact details from a receptionist chat transcript.

Return a JSON object with exactly these string fields (empty string when the visitor did not provide the detail):
{"name": "", "email": "", "phone": "", "intent": ""}

Rules:
- Only extract details the VISITOR stated about themselves. Never infer or fabricate. Never extract the business's own phone, email or staff names, even if they appear in the transcript.
- If the visitor corrected a detail, use the latest version.
- "name" is the visitor's own name only — not a pet's, a company's, or the person they're asking about, unless they're clearly the contact.
- "intent" is a short phrase (max 12 words) describing what the visitor wants; include the specific service and any timeline they mentioned (e.g. "book teeth cleaning next week", "quote for roof leak repair, urgent").
- Respond with the JSON object only.`;
}
