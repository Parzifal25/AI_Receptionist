import type { ChatMessage } from "@halo/core/domain/types";

/**
 * Port for chat-completion models. Implementations exist for Ollama and any
 * OpenAI-compatible API (OpenAI, Groq, Mistral, ...); Anthropic and Gemini
 * get dedicated adapters. Application code depends only on this interface.
 *
 * Phase 2 (HALO Agent Runtime) extends the port with OPTIONAL, capability-
 * declared surfaces: streaming, native tool/function descriptors, finish
 * reasons and normalized usage. A provider declares exactly what it
 * supports via `capabilities()`; callers (the runtime's LLM adapter) fall
 * back honestly — streaming → completion, native tools → no tools offered —
 * instead of every adapter pretending to implement everything.
 */

export type LLMRole = "user" | "assistant" | "tool";

/** A model-proposed tool call. `arguments` is a string only when the provider returned unparsable JSON. */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

/**
 * Transcript entry as sent to a model. `ChatMessage` (user/assistant text)
 * is assignable to it; tool-call turns add `toolCalls` (assistant) or
 * `toolCallId` (tool result).
 */
export interface LLMMessage {
  role: LLMRole;
  content: string;
  toolCalls?: LLMToolCall[];
  toolCallId?: string;
}

/** What the model is told about a controlled tool. JSON Schema parameters. */
export interface LLMToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /** When true, ask the model for a strict-JSON response if it supports it. */
  jsonMode?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Native tool descriptors. Providers whose `capabilities().tools` is false
   * ignore this field; callers must check capabilities first.
   */
  tools?: LLMToolDescriptor[];
  /** Per-call ceiling; the adapter uses the smaller of this and its default. */
  timeoutMs?: number;
  /** Provider/model attempt telemetry; contains no prompt or credentials. */
  onRouteEvent?: (event: LLMRouteEvent) => void;
  /**
   * Phase 4.5 Sprint 3 — opt-in live pass-through for multi-candidate
   * routers. Default OFF: routers buffer each candidate so a failed partial
   * stream can never leak into the delivered answer. When ON, a streaming
   * router yields the FIRST candidate's deltas as they arrive, and a
   * candidate that fails after its first text delta fails the request
   * outright (a second candidate's text must never follow a partial first,
   * and already-emitted deltas may have been consumed downstream).
   */
  liveStream?: boolean;
}

export interface LLMRouteEvent {
  type: "requested" | "started" | "first_token" | "completed" | "failed" | "fallback" | "exhausted" | "skipped";
  provider: string;
  model: string;
  attempt: number;
  fallback: boolean;
  latencyMs?: number;
  failureCategory?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  httpStatus?: number;
  retryAfterMs?: number;
  limitSource?: string;
  limitReason?: string;
}

export interface LLMRoute {
  provider: string;
  model: string;
  attempt: number;
  fallbackCount: number;
  timeToFirstTokenMs?: number;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
}

export type LLMFinishReason = "stop" | "tool_calls" | "length" | "other";

export interface LLMResult {
  content: string;
  model: string;
  /** Token accounting when the provider reports it; undefined otherwise. */
  usage?: LLMUsage;
  /** Present only when the model proposed native tool calls. */
  toolCalls?: LLMToolCall[];
  finishReason?: LLMFinishReason;
  route?: LLMRoute;
  httpStatus?: number;
}

export type LLMDelta =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: LLMToolCall }
  | { type: "usage"; usage: LLMUsage }
  | { type: "route"; route: LLMRoute }
  | { type: "done"; finishReason: LLMFinishReason; httpStatus?: number };

export interface LLMCapabilities {
  streaming: boolean;
  tools: boolean;
  jsonMode: boolean;
  /** The provider reports token usage on completions. */
  usage: boolean;
}

export interface LLMProvider {
  readonly name: string;
  /** Avoid multiplying a router's bounded attempts with an outer retry loop. */
  readonly managesRetries?: boolean;
  complete(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options?: LLMCompletionOptions,
  ): Promise<LLMResult>;
  /** Cheap connectivity probe used by health checks. */
  isHealthy(): Promise<boolean>;
  /** Honest capability declaration. Absent = the conservative defaults below. */
  capabilities?(): LLMCapabilities;
  /** Streaming completion. Only callable when `capabilities().streaming` is true. */
  stream?(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options?: LLMCompletionOptions,
  ): AsyncIterable<LLMDelta>;
}

/** Conservative defaults for adapters that predate capability declaration. */
export const NO_CAPABILITIES: LLMCapabilities = Object.freeze({
  streaming: false,
  tools: false,
  jsonMode: false,
  usage: false,
});

export function describeCapabilities(provider: LLMProvider): LLMCapabilities {
  if (typeof provider.capabilities !== "function") return NO_CAPABILITIES;
  const declared = provider.capabilities();
  return {
    streaming: declared.streaming && typeof provider.stream === "function",
    tools: declared.tools,
    jsonMode: declared.jsonMode,
    usage: declared.usage,
  };
}
