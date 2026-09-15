import type { EmbeddingProvider } from "@halo/ports/embedding-provider";
import { getServerEnv } from "@halo/platform/env";
import { OllamaEmbeddingProvider } from "./ollama-embedding-provider";

let cached: EmbeddingProvider | null | undefined;

/**
 * Returns the configured embedding provider, or null when embeddings are
 * disabled (EMBEDDING_PROVIDER=none). Callers treat null as "use full-text
 * search" — the product works either way.
 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (cached !== undefined) return cached;
  const env = getServerEnv();

  switch (env.EMBEDDING_PROVIDER) {
    case "ollama":
      cached = new OllamaEmbeddingProvider(env.OLLAMA_BASE_URL, env.EMBEDDING_MODEL);
      break;
    case "openai":
      // OpenAI embeddings use 1536+ dims; the pgvector column is 768. A
      // dedicated migration accompanies enabling this — guard until then.
      throw new Error(
        "EMBEDDING_PROVIDER=openai requires a vector-dimension migration; see docs/ARCHITECTURE.md",
      );
    case "none":
    default:
      cached = null;
  }
  return cached;
}

export function resetEmbeddingProviderForTests(): void {
  cached = undefined;
}
