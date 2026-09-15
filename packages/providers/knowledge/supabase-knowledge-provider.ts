import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeSnippet } from "@halo/core/domain/types";
import type { EmbeddingProvider } from "@halo/ports/embedding-provider";
import type { KnowledgeProvider } from "@halo/ports/knowledge-provider";
import { AppError } from "@halo/core/errors/app-error";
import { logger } from "@halo/platform/logger";

const DEFAULT_LIMIT = 6;
// Standard RRF damping constant; larger values flatten the influence of top
// ranks. 60 is the widely-used default from the original RRF paper.
const RRF_K = 60;
// Retrieval queries are visitor messages; cap length so a pathological wall of
// text can't blow up tsquery parsing or the embedding request.
const MAX_QUERY_LENGTH = 400;

/**
 * Normalizes a raw visitor message into a retrieval query: collapses
 * whitespace, strips control characters, and caps length. Pure function.
 */
export function normalizeQuery(raw: string): string {
  return raw
    // Strip control characters; normal whitespace is collapsed on the next line.
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/**
 * Reciprocal Rank Fusion: merges several ranked result lists into one using
 * only each item's rank, so lists with incomparable score scales (BM25/ts_rank
 * vs cosine similarity) combine fairly. Items appearing in multiple lists are
 * reinforced. De-duplicates by refId, preserving the highest-scoring content.
 */
export function fuseByReciprocalRank(
  lists: KnowledgeSnippet[][],
  limit: number,
): KnowledgeSnippet[] {
  const fused = new Map<string, { snippet: KnowledgeSnippet; score: number }>();

  for (const list of lists) {
    list.forEach((snippet, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(snippet.refId);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(snippet.refId, { snippet: { ...snippet, score: contribution }, score: contribution });
      }
    });
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ ...entry.snippet, score: entry.score }));
}

/**
 * Knowledge retrieval backed by Postgres. Uses vector similarity when an
 * EmbeddingProvider is supplied, full-text search otherwise. Both paths are
 * tenant-scoped inside SECURITY DEFINER SQL functions.
 */
export class SupabaseKnowledgeProvider implements KnowledgeProvider {
  readonly name = "supabase";
  private readonly log = logger.child({ provider: this.name });

  constructor(
    private readonly db: SupabaseClient,
    private readonly embeddings: EmbeddingProvider | null,
  ) {}

  async search(businessId: string, query: string, limit = DEFAULT_LIMIT): Promise<KnowledgeSnippet[]> {
    const normalized = normalizeQuery(query);
    if (!normalized) return [];

    // Keyword search covers both chunks and FAQs; vector search covers chunks
    // semantically. Without embeddings, keyword alone is the whole story.
    if (!this.embeddings) {
      return this.keywordSearch(businessId, normalized, limit);
    }

    // Hybrid: run both and fuse. Vector-only would drop FAQs entirely (they
    // aren't embedded), and keyword-only misses paraphrases — fusion keeps
    // exact FAQ hits and semantic chunk hits in one ranked list. Vector
    // failures degrade to keyword-only rather than failing the turn.
    const [keyword, vector] = await Promise.all([
      this.keywordSearch(businessId, normalized, limit),
      this.vectorSearch(businessId, normalized, limit).catch((error) => {
        this.log.warn("vector search failed, using keyword only", { error });
        return [] as KnowledgeSnippet[];
      }),
    ]);

    return fuseByReciprocalRank([keyword, vector], limit);
  }

  private async keywordSearch(businessId: string, query: string, limit: number): Promise<KnowledgeSnippet[]> {
    const { data, error } = await this.db.rpc("search_knowledge", {
      target_business_id: businessId,
      query,
      match_limit: limit,
    });
    if (error) {
      this.log.error("keyword search failed", { error: error.message });
      throw AppError.provider("Knowledge search failed");
    }
    return (data ?? []).map(
      (row: { source: string; ref_id: string; title: string; content: string; rank: number }) => ({
        source: row.source as "chunk" | "faq",
        refId: row.ref_id,
        title: row.title,
        content: row.content,
        score: row.rank,
      }),
    );
  }

  private async vectorSearch(businessId: string, query: string, limit: number): Promise<KnowledgeSnippet[]> {
    const [embedding] = await this.embeddings!.embed([query]);
    const { data, error } = await this.db.rpc("match_knowledge_chunks", {
      target_business_id: businessId,
      query_embedding: embedding,
      match_limit: limit,
    });
    if (error) {
      this.log.error("vector search failed", { error: error.message });
      throw AppError.provider("Knowledge search failed");
    }
    return (data ?? []).map(
      (row: { ref_id: string; title: string; content: string; similarity: number }) => ({
        source: "chunk" as const,
        refId: row.ref_id,
        title: row.title,
        content: row.content,
        score: row.similarity,
      }),
    );
  }

  async indexDocument(businessId: string, documentId: string, chunks: string[]): Promise<void> {
    // Re-index is idempotent: clear old chunks first.
    await this.removeDocument(businessId, documentId);
    if (chunks.length === 0) return;

    let embeddings: number[][] | null = null;
    if (this.embeddings) {
      try {
        embeddings = await this.embeddings.embed(chunks);
      } catch (error) {
        // Embeddings are an enhancement — fall back to keyword-only indexing.
        this.log.warn("embedding failed, indexing without vectors", { error });
      }
    }

    const rows = chunks.map((content, i) => ({
      document_id: documentId,
      business_id: businessId,
      content,
      chunk_index: i,
      embedding: embeddings?.[i] ?? null,
    }));

    const { error } = await this.db.from("knowledge_chunks").insert(rows);
    if (error) {
      this.log.error("chunk insert failed", { error: error.message });
      throw AppError.provider("Failed to index document");
    }
  }

  async removeDocument(businessId: string, documentId: string): Promise<void> {
    const { error } = await this.db
      .from("knowledge_chunks")
      .delete()
      .eq("business_id", businessId)
      .eq("document_id", documentId);
    if (error) {
      this.log.error("chunk delete failed", { error: error.message });
      throw AppError.provider("Failed to remove document from index");
    }
  }
}
