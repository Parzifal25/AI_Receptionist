import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeSnippet } from "@/core/domain/types";
import type { EmbeddingProvider } from "@/core/ports/embedding-provider";
import type { KnowledgeProvider } from "@/core/ports/knowledge-provider";
import { AppError } from "@/core/errors/app-error";
import { logger } from "@/lib/logger";

const DEFAULT_LIMIT = 6;

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
    const trimmed = query.trim();
    if (!trimmed) return [];

    if (this.embeddings) {
      const snippets = await this.vectorSearch(businessId, trimmed, limit);
      // Vector search can miss exact-keyword matches in FAQs; blend both.
      if (snippets.length > 0) return snippets;
    }
    return this.keywordSearch(businessId, trimmed, limit);
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
      (row: { source: string; ref_id: string; content: string; rank: number }) => ({
        source: row.source as "chunk" | "faq",
        refId: row.ref_id,
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
      (row: { ref_id: string; content: string; similarity: number }) => ({
        source: "chunk" as const,
        refId: row.ref_id,
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
