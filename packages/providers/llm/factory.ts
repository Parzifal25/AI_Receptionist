import type { LLMProvider } from "@halo/ports/llm-provider";
import { getServerEnv } from "@halo/platform/env";
import { AnthropicProvider } from "./anthropic-provider";
import { GeminiProvider } from "./gemini-provider";
import { OllamaProvider } from "./ollama-provider";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { FallbackLLMRouter } from "./fallback-router";

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
};

let cached: LLMProvider | null = null;

/**
 * Provider selection is pure configuration: set LLM_PROVIDER / LLM_MODEL /
 * LLM_API_KEY and the whole product switches models. No application code
 * references a concrete provider class.
 */
export function getLLMProvider(): LLMProvider {
  if (cached) return cached;
  const env = getServerEnv();

  switch (env.LLM_PROVIDER) {
    case "cloud":
      cached = new FallbackLLMRouter([
        { model: "openai/gpt-oss-120b", provider: new OpenAICompatibleProvider("groq", DEFAULT_BASE_URLS.groq, requireKey(env.GROQ_LLM_API_KEY, "groq"), "openai/gpt-oss-120b", env.LLM_TIMEOUT_MS) },
        { model: "qwen/qwen3.8-27b", provider: new OpenAICompatibleProvider("groq", DEFAULT_BASE_URLS.groq, requireKey(env.GROQ_LLM_API_KEY, "groq"), "qwen/qwen3.8-27b", env.LLM_TIMEOUT_MS) },
        { model: "anthropic/claude-sonnet-4.6", provider: new OpenAICompatibleProvider("openrouter", "https://openrouter.ai/api/v1", requireKey(env.OPENROUTER_LLM_API_KEY, "openrouter"), "anthropic/claude-sonnet-4.6", env.LLM_TIMEOUT_MS) },
        { model: "qwen/qwen3.8-27b", provider: new OpenAICompatibleProvider("openrouter", "https://openrouter.ai/api/v1", requireKey(env.OPENROUTER_LLM_API_KEY, "openrouter"), "qwen/qwen3.8-27b", env.LLM_TIMEOUT_MS) },
      ]);
      break;
    case "ollama":
      cached = new OllamaProvider(env.OLLAMA_BASE_URL, env.LLM_MODEL, env.LLM_TIMEOUT_MS);
      break;
    case "anthropic":
      cached = new AnthropicProvider(
        requireKey(env.LLM_API_KEY, "anthropic"),
        env.LLM_MODEL,
        undefined,
        env.LLM_TIMEOUT_MS,
      );
      break;
    case "gemini":
      cached = new GeminiProvider(
        requireKey(env.LLM_API_KEY, "gemini"),
        env.LLM_MODEL,
        undefined,
        env.LLM_TIMEOUT_MS,
      );
      break;
    case "openai":
    case "groq":
    case "mistral":
      cached = new OpenAICompatibleProvider(
        env.LLM_PROVIDER,
        env.LLM_BASE_URL ?? DEFAULT_BASE_URLS[env.LLM_PROVIDER],
        requireKey(env.LLM_API_KEY, env.LLM_PROVIDER),
        env.LLM_MODEL,
        env.LLM_TIMEOUT_MS,
      );
      break;
  }
  return cached;
}

function requireKey(key: string | undefined, provider: string): string {
  if (!key) throw new Error(`LLM_API_KEY is required when LLM_PROVIDER=${provider}`);
  return key;
}

/** Test helper. */
export function resetLLMProviderForTests(): void {
  cached = null;
}
