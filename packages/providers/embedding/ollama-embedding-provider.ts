import type { EmbeddingProvider } from "@halo/ports/embedding-provider";
import { AppError } from "@halo/core/errors/app-error";

/** Embeddings via a local Ollama model (default: nomic-embed-text, 768-dim). */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly dimensions = 768;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw AppError.provider("Embedding service is unreachable");
    });

    if (!response.ok) throw AppError.provider("Embedding service returned an error");
    const data = (await response.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw AppError.provider("Embedding service returned an invalid response");
    }
    return data.embeddings;
  }
}
