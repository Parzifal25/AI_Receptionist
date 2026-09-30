import { parseAgentConfig } from "@halo/core/domain/agents";

/** Data-only fixtures: each runs through the same runtime, registry and policies. */
export const GENERIC_TENANTS = [
  { id: "education", name: "Cedar Learning", objective: "Explain enrollment options and collect requested contact details",
    knowledge: "The evening course meets on Tuesdays.", question: "When does the evening course meet?",
    answer: "The evening course meets on Tuesdays.", tools: ["save_contact_details"],
    workflows: ["lead.created"], language: "en", voice: "advisor", policy: { discountsAllowed: false } },
  { id: "professional", name: "Maple Advisory", objective: "Help visitors request a consultation",
    knowledge: "Introductory consultations last thirty minutes.", question: "How long is an introductory consultation?",
    answer: "An introductory consultation lasts thirty minutes.", tools: ["request_human_handoff"],
    workflows: ["appointment.created"], language: "en-IN", voice: "consultant", policy: { confirmationsRequired: true } },
  { id: "support", name: "Birch Equipment", objective: "Explain support procedures without promising refunds",
    knowledge: "Repairs require inspection by the service team.", question: "What is the repair process?",
    answer: "Repairs require inspection by the service team.", tools: [],
    workflows: ["conversation.escalated"], language: "en-US", voice: "support", policy: { refundsAllowed: false } },
].map(tenant => ({ ...tenant, config: parseAgentConfig({
  identity: { name: `${tenant.name} Assistant` }, objective: tenant.objective,
  instructions: { customInstructions: tenant.objective },
  knowledge: { collectionIds: [`${tenant.id}-knowledge`] },
  language: { primary: tenant.language }, voice: { ttsVoice: tenant.voice, speakingRate: tenant.id === "support" ? 0.9 : 1.1 },
  tools: { grantedToolIds: tenant.tools, policy: tenant.policy }, workflows: { allowedTriggers: tenant.workflows },
})! }));
