import type { ChatMessage } from "@halo/core/domain/types";
import { AppError, isAppError } from "@halo/core/errors/app-error";
import type {
  LLMCapabilities, LLMCompletionOptions, LLMDelta, LLMMessage, LLMProvider,
  LLMResult, LLMRoute, LLMRouteEvent,
} from "@halo/ports/llm-provider";

export interface ModelCandidate { provider: LLMProvider; model: string }

const RETRYABLE = new Set(["timeout", "connection", "provider_5xx", "rate_limit", "provider_unavailable", "model_unavailable"]);

function failureCategory(error: unknown): string {
  if (isAppError(error) && error.code === "PROVIDER_ERROR") {
    const details = error.details as { category?: unknown } | undefined;
    return typeof details?.category === "string" ? details.category : "provider_unavailable";
  }
  return "non_retryable";
}

/** Ordered, per-request failover. Every candidate receives the same prompt, messages and tools. */
export class FallbackLLMRouter implements LLMProvider {
  readonly name = "cloud";
  readonly managesRetries = true;
  private readonly cooldowns = new Map<string, { until: number; error: unknown; strikes: number }>();

  constructor(readonly candidates: readonly ModelCandidate[], private readonly backoff: {
    clock?: () => number; sleep?: (ms: number) => Promise<void>; maxWaitMs?: number;
  } = {}) {
    if (candidates.length === 0) throw new Error("LLM router requires a candidate");
  }

  private now(): number { return (this.backoff.clock ?? Date.now)(); }

  private recordFailure(provider: string, error: unknown): Record<string, string | number> {
    const details = isAppError(error) ? error.details as Record<string, unknown> | undefined : undefined;
    const safe: Record<string, string | number> = {};
    for (const key of ["retryAfterMs", "limitSource", "limitReason"] as const) {
      const value = details?.[key];
      if (typeof value === "number" || typeof value === "string") safe[key] = value;
    }
    if (typeof details?.status === "number") safe.httpStatus = details.status;
    if (failureCategory(error) === "rate_limit") {
      const strikes = (this.cooldowns.get(provider)?.strikes ?? 0) + 1;
      const delay = Math.max(typeof details?.retryAfterMs === "number" ? details.retryAfterMs : 0,
        Math.min(60_000, 1_000 * 2 ** Math.min(strikes - 1, 6)));
      this.cooldowns.set(provider, { until: this.now() + delay, error, strikes });
      safe.retryAfterMs = delay;
    }
    return safe;
  }

  private async waitForProvider(index: number, deadline: number, options: LLMCompletionOptions): Promise<unknown | null> {
    if (options.abortSignal?.aborted) throw options.abortSignal.reason;
    const cooldown = this.cooldowns.get(this.candidates[index].provider.name);
    const waitMs = cooldown ? Math.max(0, cooldown.until - this.now()) : 0;
    if (!cooldown || waitMs === 0) return null;
    if (waitMs > (this.backoff.maxWaitMs ?? 2_000) || this.now() + waitMs >= deadline) {
      this.emit(options, { type: "skipped", ...this.base(index), failureCategory: "rate_limit", retryAfterMs: waitMs });
      return cooldown.error;
    }
    await (this.backoff.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(waitMs);
    if (options.abortSignal?.aborted) throw options.abortSignal.reason;
    return null;
  }

  capabilities(): LLMCapabilities {
    const caps = this.candidates.map((c) => c.provider.capabilities?.());
    return {
      streaming: caps.every((c) => c?.streaming),
      tools: caps.every((c) => c?.tools),
      jsonMode: caps.every((c) => c?.jsonMode),
      usage: caps.every((c) => c?.usage),
    };
  }

  async isHealthy(): Promise<boolean> {
    for (const candidate of this.candidates) if (await candidate.provider.isHealthy()) return true;
    return false;
  }

  private emit(options: LLMCompletionOptions, event: LLMRouteEvent): void {
    try { options.onRouteEvent?.(event); } catch { /* telemetry cannot break inference */ }
  }

  private base(index: number): Pick<LLMRouteEvent, "provider" | "model" | "attempt" | "fallback"> {
    const candidate = this.candidates[index];
    return { provider: candidate.provider.name, model: candidate.model, attempt: index + 1, fallback: index > 0 };
  }

  private candidateOptions(options: LLMCompletionOptions, deadline: number, index: number): LLMCompletionOptions {
    const remaining = Math.max(1, deadline - this.now());
    return { ...options, timeoutMs: Math.max(1, Math.floor(remaining / (this.candidates.length - index))) };
  }

  async complete(systemPrompt: string, messages: Array<ChatMessage | LLMMessage>, options: LLMCompletionOptions = {}): Promise<LLMResult> {
    this.emit(options, { type: "requested", ...this.base(0) });
    const deadline = this.now() + (options.timeoutMs ?? 60_000);
    let lastError: unknown;
    for (let index = 0; index < this.candidates.length; index++) {
      const candidate = this.candidates[index];
      const base = this.base(index);
      const unavailable = await this.waitForProvider(index, deadline, options);
      if (unavailable) { lastError = unavailable; continue; }
      const started = Date.now();
      this.emit(options, { type: "started", ...base });
      try {
        const result = await candidate.provider.complete(systemPrompt, messages, this.candidateOptions(options, deadline, index));
        const route: LLMRoute = { provider: base.provider, model: base.model, attempt: base.attempt, fallbackCount: index };
        this.emit(options, { type: "completed", ...base, latencyMs: Math.max(0, Date.now() - started),
          httpStatus: result.httpStatus,
          inputTokens: result.usage?.promptTokens, outputTokens: result.usage?.completionTokens,
          totalTokens: result.usage ? result.usage.promptTokens + result.usage.completionTokens : undefined });
        return { ...result, route };
      } catch (error) {
        lastError = error;
        const category = failureCategory(error);
        this.emit(options, { type: "failed", ...base, latencyMs: Math.max(0, Date.now() - started), failureCategory: category,
          ...this.recordFailure(base.provider, error) });
        if (!RETRYABLE.has(category) || options.abortSignal?.aborted) throw error;
        if (index + 1 < this.candidates.length) this.emit(options, { type: "fallback", ...this.base(index + 1), failureCategory: category });
      }
    }
    this.emit(options, { type: "exhausted", ...this.base(this.candidates.length - 1), failureCategory: failureCategory(lastError) });
    throw lastError;
  }

  async *stream(systemPrompt: string, messages: Array<ChatMessage | LLMMessage>, options: LLMCompletionOptions = {}): AsyncIterable<LLMDelta> {
    this.emit(options, { type: "requested", ...this.base(0) });
    const deadline = this.now() + (options.timeoutMs ?? 60_000);
    let lastError: unknown;
    for (let index = 0; index < this.candidates.length; index++) {
      const candidate = this.candidates[index];
      const base = this.base(index);
      const unavailable = await this.waitForProvider(index, deadline, options);
      if (unavailable) { lastError = unavailable; continue; }
      const started = Date.now();
      let firstTokenMs: number | undefined;
      // Live pass-through yields the first candidate as it streams; the
      // default buffers one candidate so a failed partial stream cannot
      // leak into a later answer.
      const live = options.liveStream === true;
      const deltas: LLMDelta[] = [];
      let anyDeltaEmitted = false;
      this.emit(options, { type: "started", ...base });
      try {
        for await (const delta of candidate.provider.stream!(systemPrompt, messages, this.candidateOptions(options, deadline, index))) {
          if (delta.type === "text" && firstTokenMs === undefined) {
            firstTokenMs = Math.max(0, Date.now() - started);
            this.emit(options, { type: "first_token", ...base, latencyMs: firstTokenMs });
          }
          deltas.push(delta);
          if (live && !anyDeltaEmitted && (delta.type === "text" || delta.type === "tool_call")) {
            // From here the first candidate is committed to the consumer;
            // a later failure must not be papered over with another model.
            anyDeltaEmitted = true;
          }
          if (live) yield delta;
        }
        if (!deltas.some((d) => d.type === "done") ||
            !deltas.some((d) => d.type === "text" || d.type === "tool_call")) {
          throw AppError.provider("AI service returned an incomplete stream", { category: "provider_unavailable" });
        }
        const usage = deltas.find((d) => d.type === "usage");
        const counts = usage?.type === "usage" ? usage.usage : undefined;
        const done = deltas.find((d) => d.type === "done");
        const route: LLMRoute = { provider: base.provider, model: base.model, attempt: base.attempt,
          fallbackCount: index, timeToFirstTokenMs: firstTokenMs };
        this.emit(options, { type: "completed", ...base, latencyMs: Math.max(0, Date.now() - started),
          httpStatus: done?.type === "done" ? done.httpStatus : undefined,
          inputTokens: counts?.promptTokens, outputTokens: counts?.completionTokens,
          totalTokens: counts ? counts.promptTokens + counts.completionTokens : undefined });
        if (live) {
          // Deltas already went out live; the consumer still needs the
          // completed route (provider/model/TTFT) for usage reporting.
          yield { type: "route", route };
          return;
        }
        yield { type: "route", route };
        yield* deltas;
        return;
      } catch (error) {
        lastError = error;
        const category = failureCategory(error);
        this.emit(options, { type: "failed", ...base, latencyMs: Math.max(0, Date.now() - started), failureCategory: category,
          ...this.recordFailure(base.provider, error) });
        if (anyDeltaEmitted || !RETRYABLE.has(category) || options.abortSignal?.aborted) throw error;
        if (index + 1 < this.candidates.length) this.emit(options, { type: "fallback", ...this.base(index + 1), failureCategory: category });
      }
    }
    this.emit(options, { type: "exhausted", ...this.base(this.candidates.length - 1), failureCategory: failureCategory(lastError) });
    throw lastError;
  }
}
