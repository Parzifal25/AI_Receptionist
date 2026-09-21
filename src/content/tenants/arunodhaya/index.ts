import { parseAgentConfig, type AgentConfig } from "@halo/core/domain/agents";
import { parseObjectionCatalog, type ObjectionCatalog } from "@halo/negotiation/objections";
import { parseNegotiationPolicy, type NegotiationPolicy } from "@halo/negotiation/policy";
import { parseQualificationSchema, type QualificationSchema } from "@halo/qualification/schema";
import { REQUIRED_VOICE_PROMPTS } from "@halo/voice/session-config";
import { ARUNODHAYA_AGENT_CONFIG, ARUNODHAYA_AGENT_SLUG } from "./agent";
import { ARUNODHAYA_ESCALATION } from "./escalation";
import { ARUNODHAYA_FACTS } from "./knowledge";
import { ARUNODHAYA_NEGOTIATION } from "./negotiation";
import { ARUNODHAYA_OBJECTIONS } from "./objections";
import { ARUNODHAYA_QUALIFICATION } from "./qualification";
import { factConfigurationErrors, pendingFacts, verifiedFacts, type BusinessFact } from "./supplied";

/**
 * Arunodhaya Phase 4 — the assembled, validated tenant bundle.
 *
 * Everything under this directory is CONFIGURATION for one business. None of
 * it is imported by `packages/`, and `check:neutral` enforces that the
 * reverse never happens: there is no `if (business === "arunodhaya")`
 * anywhere in HALO, and adding the next tenant means adding a sibling
 * directory, not editing a platform file.
 *
 * `loadArunodhaya()` parses every piece through the platform's own schemas
 * and REFUSES the whole bundle if any of them is wrong. A partially valid
 * sales configuration is the dangerous case: the parts that usually fail to
 * load are the constraints.
 */

export interface ArunodhayaBundle {
  slug: string;
  agentSlug: string;
  language: string;
  config: AgentConfig;
  qualification: QualificationSchema;
  objections: ObjectionCatalog;
  negotiation: NegotiationPolicy;
  facts: BusinessFact[];
  escalation: typeof ARUNODHAYA_ESCALATION;
  /** Facts the business has not supplied. The agent must defer on these. */
  pending: BusinessFact[];
  verified: BusinessFact[];
}

export type LoadResult = { ok: true; bundle: ArunodhayaBundle } | { ok: false; errors: string[] };

export const ARUNODHAYA_TENANT_SLUG = "arunodhaya";

export function loadArunodhaya(): LoadResult {
  const errors: string[] = [];

  const config = parseAgentConfig(ARUNODHAYA_AGENT_CONFIG);
  if (!config) errors.push("agent config: failed to parse");

  const qualification = parseQualificationSchema(ARUNODHAYA_QUALIFICATION);
  if (!qualification.ok) errors.push(...qualification.errors.map((e) => `qualification: ${e}`));

  const objections = parseObjectionCatalog(ARUNODHAYA_OBJECTIONS);
  if (!objections.ok) errors.push(...objections.errors.map((e) => `objections: ${e}`));

  const negotiation = parseNegotiationPolicy(ARUNODHAYA_NEGOTIATION);
  if (!negotiation.ok) errors.push(...negotiation.errors.map((e) => `negotiation: ${e}`));

  errors.push(...factConfigurationErrors(ARUNODHAYA_FACTS).map((e) => `knowledge: ${e}`));

  if (config) {
    // A phone agent without every deterministic line is not answered at all,
    // so catch it here rather than at the first real call.
    for (const key of REQUIRED_VOICE_PROMPTS) {
      if (!config.voice.prompts[key]?.trim()) errors.push(`agent config: voice prompt "${key}" is empty`);
    }
    if (config.language.primary !== ARUNODHAYA_QUALIFICATION.language) {
      errors.push(
        `agent language "${config.language.primary}" does not match the qualification language "${ARUNODHAYA_QUALIFICATION.language}"`,
      );
    }
  }
  if (negotiation.ok && negotiation.policy.language !== ARUNODHAYA_QUALIFICATION.language) {
    errors.push("negotiation policy language does not match the qualification language");
  }
  if (objections.ok) {
    // An objection may only cite evidence that actually exists, or the agent
    // is told to answer from a source that is not there.
    const factIds = new Set(ARUNODHAYA_FACTS.map((f) => f.id));
    for (const objection of objections.catalog.objections) {
      for (const id of objection.evidence) {
        if (!factIds.has(id)) errors.push(`objections: "${objection.id}" cites unknown fact "${id}"`);
      }
    }
  }

  if (errors.length > 0 || !config || !qualification.ok || !objections.ok || !negotiation.ok) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    bundle: {
      slug: ARUNODHAYA_TENANT_SLUG,
      agentSlug: ARUNODHAYA_AGENT_SLUG,
      language: config.language.primary,
      config,
      qualification: qualification.schema,
      objections: objections.catalog,
      negotiation: negotiation.policy,
      facts: ARUNODHAYA_FACTS,
      escalation: ARUNODHAYA_ESCALATION,
      pending: pendingFacts(ARUNODHAYA_FACTS),
      verified: verifiedFacts(ARUNODHAYA_FACTS),
    },
  };
}

/** Loads the bundle or throws. Used where a missing configuration is fatal. */
export function requireArunodhaya(): ArunodhayaBundle {
  const result = loadArunodhaya();
  if (!result.ok) throw new Error(`arunodhaya configuration is invalid:\n- ${result.errors.join("\n- ")}`);
  return result.bundle;
}

export { ARUNODHAYA_AGENT_CONFIG, ARUNODHAYA_ESCALATION, ARUNODHAYA_FACTS, ARUNODHAYA_NEGOTIATION, ARUNODHAYA_OBJECTIONS, ARUNODHAYA_QUALIFICATION };
export { pendingFactGuidance } from "./knowledge";
