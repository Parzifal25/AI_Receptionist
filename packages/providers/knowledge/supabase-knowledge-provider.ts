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
 * Postgres retrieval. Published FAQs are checked again against tenant rows.
 * Document retrieval is withheld until approval storage exists (D14).
 */
export class SupabaseKnowledgeProvider implements KnowledgeProvider {
  readonly name = "supabase";
  private readonly log = logger.child({ provider: this.name });

  constructor(
    private readonly db: SupabaseClient,
    private readonly embeddings: EmbeddingProvider | null,
  ) {}

  async search(businessId: string, query: string, limit = DEFAULT_LIMIT): Promise<KnowledgeSnippet[]> {
    if (!businessId?.trim()) throw AppError.forbidden("Knowledge retrieval requires tenant context");
    const normalized = normalizeQuery(query);
    if (!normalized) return [];

    // Documents have no approval lifecycle in the current schema. Do not
    // infer approval from indexing readiness. Only published FAQs can be
    // authorized until the owner approves the additive D14 migration.
    return this.keywordSearch(businessId, normalized, limit);
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
    const candidates = (data ?? []).filter((row: { source: string }) => row.source === "faq") as Array<{ ref_id: string; rank: number }>;
    if (!candidates.length) return [];
    const { data: faqs, error: approvalError } = await this.db.from("faqs")
      .select("id, business_id, is_published, question, answer, category")
      .eq("business_id", businessId).eq("is_published", true)
      .in("id", candidates.map((row) => row.ref_id));
    if (approvalError) throw AppError.provider("Knowledge publication could not be verified");
    const approved = new Map((faqs ?? []).filter((faq) => faq.business_id === businessId && faq.is_published === true).map((faq) => [faq.id, faq]));
    return candidates.flatMap((row) => {
      const faq = approved.get(row.ref_id);
      if (!faq || !faq.question?.trim() || !faq.answer?.trim()) return [];
      return [{ source: "faq" as const, refId: faq.id, title: faq.category || "FAQ", content: `Q: ${faq.question}\nA: ${faq.answer}`, score: row.rank }];
    });
  }

  async indexDocument(businessId: string, documentId: string, chunks: string[]): Promise<void> {
    if (!businessId?.trim()) throw AppError.forbidden("Document indexing requires tenant context");
    const { data: document, error: ownershipError } = await this.db.from("knowledge_documents")
      .select("id, business_id").eq("id", documentId).eq("business_id", businessId).maybeSingle();
    if (ownershipError) throw AppError.provider("Document ownership could not be verified");
    if (!document || document.id !== documentId || document.business_id !== businessId) throw AppError.forbidden("Document does not belong to this tenant");
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
