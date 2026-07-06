import type { ChatMessage } from "@/core/domain/types";

export interface LLMCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /** When true, ask the model for a strict-JSON response if it supports it. */
  jsonMode?: boolean;
  abortSignal?: AbortSignal;
}

export interface LLMResult {
  content: string;
  model: string;
  /** Token accounting when the provider reports it; undefined otherwise. */
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * Port for chat-completion models. Implementations exist for Ollama and any
 * OpenAI-compatible API (OpenAI, Groq, Mistral, ...); Anthropic and Gemini
 * get dedicated adapters. Application code depends only on this interface.
 */
export interface LLMProvider {
  readonly name: string;
  complete(
    systemPrompt: string,
    messages: ChatMessage[],
    options?: LLMCompletionOptions,
  ): Promise<LLMResult>;
  /** Cheap connectivity probe used by health checks. */
  isHealthy(): Promise<boolean>;
}
