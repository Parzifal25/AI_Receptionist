import { estimateTokens, TOKEN_ESTIMATOR_ID, type TokenEstimate } from "@halo/language/tokens";

/**
 * HALO Phase 4.5 Sprint 2 — the token budget.
 *
 * The context builder has always had a CHARACTER ceiling. On a Latin prompt
 * that is a usable proxy for tokens; on a Telugu one it is not, and the gap
 * is not small — the same character can cost four times as many tokens. So a
 * turn could sit inside `maxTotalChars` and be far outside the model's real
 * context window, with nothing anywhere reporting a problem.
 *
 * This module adds the second ceiling, in the unit that actually binds. It
 * does not replace the character budget: characters bound what this code
 * hands around (strings, database columns, log lines), tokens bound what the
 * provider will accept. A component is reduced when EITHER ceiling is hit.
 *
 * Every token figure is an ESTIMATE produced by `@halo/language/tokens`. No
 * tokenizer and no provider count is involved. The estimator rounds against
 * us on non-Latin script on purpose: over-estimating drops a knowledge
 * snippet, under-estimating overruns a real context window mid-call.
 *
 * The reduction order is the same one the character budget already uses, and
 * for the same reason: knowledge is the least specific to this caller, the
 * recap is a lossy record of what was said, and recent turns are what the
 * conversation is actually about. History is never cut below the last two
 * messages, and tenant content, verified system actions and tool descriptors
 * are never cut at all — dropping one of those removes a capability or a
 * fact, which is a defect, not a saving.
 */

/** Context components the budget may reduce, in no particular order. */
export type ReducibleComponent = "knowledge" | "summary" | "history";

/** The fixed components. Listed so it is explicit that they are never cut. */
export const FIXED_COMPONENTS = ["prompt_template", "custom_instructions", "system_actions", "tools", "customer"] as const;
export type FixedComponent = (typeof FIXED_COMPONENTS)[number];
export type BudgetComponent = ReducibleComponent | FixedComponent;

/**
 * Deterministic reduction order. Not configurable per call: a budget that
 * degrades differently from one turn to the next is not reviewable.
 */
export const REDUCTION_ORDER: readonly ReducibleComponent[] = Object.freeze(["knowledge", "summary", "history"]);

export interface TokenBudgetPolicy {
  /** Ceiling on the ESTIMATED input tokens the builder's components may cost. */
  maxInputTokens: number;
  /** Tokens held back for the model's reply; never spent on context. */
  reservedOutputTokens: number;
}

export interface ComponentUsage {
  component: BudgetComponent;
  chars: number;
  bytes: number;
  estimatedTokens: number;
  reducible: boolean;
}

export interface TokenBudgetReport {
  /** ESTIMATED input tokens across every component. Not a provider count. */
  estimatedInputTokens: number;
  /** Tokens reserved for the reply. */
  outputAllowanceTokens: number;
  /** maxInputTokens − estimatedInputTokens. Negative when over. */
  remainingTokens: number;
  /** True when the estimate exceeds the ceiling and content must be reduced. */
  needsReduction: boolean;
  /** The component the next reduction would take from, or null when inside budget. */
  nextToReduce: ReducibleComponent | null;
  /** Per-component usage, largest estimate first. */
  components: ComponentUsage[];
  policy: TokenBudgetPolicy;
  /** Which estimation rules produced these numbers. */
  estimator: string;
}

/** One component's contribution, measured once. */
export function measureComponent(component: BudgetComponent, text: string): ComponentUsage {
  const estimate: TokenEstimate = estimateTokens(text);
  return {
    component,
    chars: estimate.chars,
    bytes: estimate.bytes,
    estimatedTokens: estimate.estimatedTokens,
    reducible: (REDUCTION_ORDER as readonly string[]).includes(component),
  };
}

/**
 * Builds the report for a set of already-measured components. Pure: it
 * decides nothing and mutates nothing, so the same inputs always produce the
 * same verdict and a caller can log it before acting on it.
 *
 * `present` names the reducible components that still have content — a
 * component that is already empty cannot be reduced again, so the next
 * reduction skips it.
 */
export function buildTokenBudgetReport(params: {
  components: ComponentUsage[];
  policy: TokenBudgetPolicy;
  present: ReadonlySet<ReducibleComponent>;
}): TokenBudgetReport {
  const estimatedInputTokens = params.components.reduce((n, c) => n + c.estimatedTokens, 0);
  const needsReduction = estimatedInputTokens > params.policy.maxInputTokens;
  const nextToReduce = needsReduction
    ? (REDUCTION_ORDER.find((component) => params.present.has(component)) ?? null)
    : null;
  return {
    estimatedInputTokens,
    outputAllowanceTokens: params.policy.reservedOutputTokens,
    remainingTokens: params.policy.maxInputTokens - estimatedInputTokens,
    needsReduction,
    nextToReduce,
    components: [...params.components].sort((a, b) => b.estimatedTokens - a.estimatedTokens || (a.component < b.component ? -1 : 1)),
    policy: params.policy,
    estimator: TOKEN_ESTIMATOR_ID,
  };
}
