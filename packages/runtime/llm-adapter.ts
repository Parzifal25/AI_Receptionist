import type { ChatMessage } from "@halo/core/domain/types";
import { AppError, isAppError } from "@halo/core/errors/app-error";
import {
  describeCapabilities,
  type LLMCapabilities,
  type LLMCompletionOptions,
  type LLMDelta,
  type LLMMessage,
  type LLMProvider,
  type LLMResult,
  type LLMToolCall,
  type LLMToolDescriptor,
} from "@halo/ports/llm-provider";
import { RuntimeCancelledError } from "./cancellation";
import type { ModelCallUsage } from "./contracts";

/**
 * HALO Phase 2 — the runtime-facing model adapter (Workstream 7).
 *
 * One entry point, `invokeModel`, that:
 *   - picks streaming when the provider supports it AND a delta consumer
 *     is present, completion otherwise (a provider without streaming is
 *     never asked to stream);
 *   - offers native tool descriptors only to providers that declare tool
 *     support (otherwise the caller runs the orchestrator-mediated path);
 *   - enforces a hard wall-clock deadline independent of provider honesty;
 *   - applies an explicit, side-effect-free retry policy (model calls have
 *     no side effects, so retrying one can never duplicate an action);
 *   - normalizes usage without fabricating numbers.
 */

export interface ModelRetryPolicy {
  /** Total attempts (1 = no retry). Only transient provider errors are retried, never timeouts. */
  attempts: number;
  /** Fixed delay between attempts; tests inject `sleep`. */
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = Object.freeze({ attempts: 1, delayMs: 250 });

export interface InvokeModelParams {
  provider: LLMProvider;
  systemPrompt: string;
  messages: Array<ChatMessage | LLMMessage>;
  options: Pick<LLMCompletionOptions, "temperature" | "maxTokens" | "jsonMode">;
  /** Offered only when the provider declares native tool support. */
  tools?: LLMToolDescriptor[];
  /** Absolute deadline (epoch ms). The call is abandoned when it passes. */
  deadlineAt: number;
  purpose: ModelCallUsage["purpose"];
  retry?: ModelRetryPolicy;
  /** Present → streaming is preferred when available. */
  onDelta?: (delta: LLMDelta) => void;
  clock?: () => number;
  /** Aborts the call (barge-in). Rejects with RuntimeCancelledError; never retried. */
  signal?: AbortSignal;
}

export interface InvokeModelResult {
  result: LLMResult;
  usage: ModelCallUsage;
  capabilities: LLMCapabilities;
  /** Tools were requested but the provider cannot take them natively. */
  toolsDowngraded: boolean;
}

export class ModelDeadlineError extends Error {
  constructor(readonly deadlineAt: number) {
    super("model call exceeded the turn deadline");
    this.name = "ModelDeadlineError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withDeadline<T>(promise: Promise<T>, remainingMs: number, deadlineAt: number, signal?: AbortSignal): Promise<T> {
  if (remainingMs <= 0) return Promise.reject(new ModelDeadlineError(deadlineAt));
  if (signal?.aborted) return Promise.reject(new RuntimeCancelledError("model"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ModelDeadlineError(deadlineAt)), remainingMs);
    if (signal) {
      onAbort = () => reject(new RuntimeCancelledError("model"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  // An abandoned call must not surface as an unhandled rejection later.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/** Transient = the provider was reachable-ish but failed; timeouts and deadlines are never retried. */
function isRetryable(error: unknown): boolean {
  if (error instanceof ModelDeadlineError || error instanceof RuntimeCancelledError) return false;
  if (isAppError(error)) return error.code === "PROVIDER_ERROR" && !/too long/i.test(error.message);
  return false;
}

async function consumeStream(
  iterable: AsyncIterable<LLMDelta>,
  model: string,
  onDelta?: (delta: LLMDelta) => void,
): Promise<LLMResult> {
  let content = "";
  const toolCalls: LLMToolCall[] = [];
  let usage: LLMResult["usage"];
  let finishReason: LLMResult["finishReason"];
  for await (const delta of iterable) {
    onDelta?.(delta);
    if (delta.type === "text") content += delta.text;
    else if (delta.type === "tool_call") toolCalls.push(delta.call);
    else if (delta.type === "usage") usage = delta.usage;
    else if (delta.type === "done") finishReason = delta.finishReason;
  }
  if (!content.trim() && toolCalls.length === 0) {
    throw AppError.provider("AI service returned an empty response");
  }
  return {
    content: content.trim(),
    model,
    usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

export async function invokeModel(params: InvokeModelParams): Promise<InvokeModelResult> {
  const clock = params.clock ?? Date.now;
  const capabilities = describeCapabilities(params.provider);
  const retry = params.retry ?? DEFAULT_MODEL_RETRY_POLICY;
  const sleep = retry.sleep ?? defaultSleep;

  const wantsTools = (params.tools?.length ?? 0) > 0;
  const toolsDowngraded = wantsTools && !capabilities.tools;
  const tools = wantsTools && capabilities.tools ? params.tools : undefined;
  const useStreaming = capabilities.streaming && typeof params.onDelta === "function";

  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, retry.attempts); attempt++) {
    const startedAt = clock();
    const remainingMs = params.deadlineAt - startedAt;
    if (remainingMs <= 0) throw new ModelDeadlineError(params.deadlineAt);
    const options: LLMCompletionOptions = {
      ...params.options,
      ...(tools ? { tools } : {}),
      timeoutMs: Math.max(1, remainingMs),
      // Adapters use abortSignal INSTEAD of their own timeout, so a caller
      // signal is combined with the remaining deadline, never substituted.
      ...(params.signal ? { abortSignal: AbortSignal.any([params.signal, AbortSignal.timeout(Math.max(1, remainingMs))]) } : {}),
    };
    try {
      const call = useStreaming
        ? consumeStream(
            params.provider.stream!(params.systemPrompt, params.messages, options),
            "",
            params.onDelta,
          ).then((r) => ({ ...r, model: r.model || providerModel(params.provider) }))
        : params.provider.complete(params.systemPrompt, params.messages, options);
      const result = await withDeadline(call, remainingMs, params.deadlineAt, params.signal);
      const latencyMs = clock() - startedAt;
      return {
        result,
        capabilities,
        toolsDowngraded,
        usage: normalizeUsage(params.provider.name, result, latencyMs, params.purpose, useStreaming),
      };
    } catch (error) {
      lastError = params.signal?.aborted ? new RuntimeCancelledError("model") : error;
      if (attempt >= retry.attempts || !isRetryable(lastError)) break;
      await sleep(retry.delayMs);
    }
  }
  throw lastError;
}

function providerModel(provider: LLMProvider): string {
  const maybe = (provider as { model?: unknown }).model;
  return typeof maybe === "string" ? maybe : "";
}

/** Usage is reported only when the provider supplied both counts. Never estimated. */
export function normalizeUsage(
  provider: string,
  result: LLMResult,
  latencyMs: number,
  purpose: ModelCallUsage["purpose"],
  streamed: boolean,
): ModelCallUsage {
  const usage = result.usage;
  const hasUsage =
    usage !== undefined &&
    Number.isFinite(usage.promptTokens) &&
    Number.isFinite(usage.completionTokens);
  return {
    provider,
    model: result.model,
    purpose,
    latencyMs,
    streamed,
    ...(hasUsage
      ? {
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          totalTokens: usage.promptTokens + usage.completionTokens,
        }
      : {}),
  };
}

/** Parsed tool-call arguments, or null when the provider handed back unparsable JSON. */
export function toolCallArguments(call: LLMToolCall): Record<string, unknown> | null {
  if (typeof call.arguments !== "string") return call.arguments;
  try {
    const parsed = JSON.parse(call.arguments) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
