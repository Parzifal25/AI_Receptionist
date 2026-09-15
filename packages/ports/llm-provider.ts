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
}

export type LLMDelta =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: LLMToolCall }
  | { type: "usage"; usage: LLMUsage }
  | { type: "done"; finishReason: LLMFinishReason };

export interface LLMCapabilities {
  streaming: boolean;
  tools: boolean;
  jsonMode: boolean;
  /** The provider reports token usage on completions. */
  usage: boolean;
}

export interface LLMProvider {
  readonly name: string;
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
