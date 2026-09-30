import type { LLMCompletionOptions, LLMMessage, LLMProvider } from "@halo/ports/llm-provider";
import { FallbackLLMRouter, type ModelCandidate } from "./fallback-router";

export type ModelTier = NonNullable<LLMCompletionOptions["routingTier"]>;

/** Each configured tier has its own ordered failover chain. No model names or
 * business-specific classifiers belong here. Instances live across turns.
 */
export class ComplexityLLMRouter implements LLMProvider {
  readonly name = "routed";
  readonly managesRetries = true;
  private readonly routes: Record<ModelTier, FallbackLLMRouter>;

  constructor(candidates: Record<ModelTier, readonly ModelCandidate[]>) {
    const cooldowns = new Map();
    this.routes = Object.fromEntries(Object.entries(candidates).map(([tier, chain]) =>
      [tier, new FallbackLLMRouter(chain, { cooldowns, maxWaitMs: 0 })])) as Record<ModelTier, FallbackLLMRouter>;
  }

  capabilities() {
    const caps = Object.values(this.routes).map((route) => route.capabilities());
    return { streaming: caps.every((c) => c.streaming), tools: caps.every((c) => c.tools),
      jsonMode: caps.every((c) => c.jsonMode), usage: caps.every((c) => c.usage) };
  }
  async isHealthy() {
    const health = await Promise.all(Object.values(this.routes).map(async (route) => {
      try { return await route.isHealthy(); } catch { return false; }
    }));
    return health.every(Boolean);
  }
  complete(prompt: string, messages: LLMMessage[], options: LLMCompletionOptions = {}) {
    return this.routes[options.routingTier ?? "medium"].complete(prompt, messages, options);
  }
  stream(prompt: string, messages: LLMMessage[], options: LLMCompletionOptions = {}) {
    return this.routes[options.routingTier ?? "medium"].stream(prompt, messages, options);
  }
}
