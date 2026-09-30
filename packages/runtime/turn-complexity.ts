import type { AgentConfig } from "@halo/core/domain/agents";
import { DEFAULT_ROUTING_CUES } from "@halo/language/routing-cues";
import type { LLMCompletionOptions } from "@halo/ports/llm-provider";

export type TurnComplexity = NonNullable<LLMCompletionOptions["routingTier"]>;

/** Conservative, bounded routing heuristic. Unknown intent uses the middle tier.
 * It controls compute only; authorization remains entirely in the tool boundary.
 */
export interface RoutingSignals {
  pendingConfirmation?: unknown;
  workflowStep?: string | null;
  intent?: string | null;
  escalation?: { status: string };
}

export function classifyTurn(text: string, state?: RoutingSignals, policy?: AgentConfig["routing"]): TurnComplexity {
  // A short confirmation can authorize an important action. Never route it
  // cheaply merely because its text resembles a greeting.
  if (state?.pendingConfirmation || state?.workflowStep || state?.intent ||
      (state?.escalation && state.escalation.status !== "none")) return "complex";
  const value = text.trim().toLowerCase();
  if (value.length > (policy?.complexLength ?? 600) ||
      (policy?.complexPhrases ?? DEFAULT_ROUTING_CUES.complexPhrases).some(cue => value.includes(cue.toLowerCase()))) return "complex";
  const phrase = value.replace(/[.!\s]+$/u, "");
  if ((policy?.simplePhrases ?? DEFAULT_ROUTING_CUES.simplePhrases).some(cue => phrase === cue.toLowerCase())) return "simple";
  return "medium";
}
