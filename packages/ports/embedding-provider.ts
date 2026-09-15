/**
 * Port for text-embedding models. Optional in Phase 1 — when no embedding
 * provider is configured, knowledge retrieval falls back to Postgres
 * full-text search and product behavior is unchanged.
 */
export interface EmbeddingProvider {
  readonly name: string;
  /** Dimensionality of vectors this provider produces. */
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
