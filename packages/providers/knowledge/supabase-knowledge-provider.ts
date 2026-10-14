import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeSnippet } from "@halo/core/domain/types";
import type { EmbeddingProvider } from "@halo/ports/embedding-provider";
import type {
  KnowledgeIndexStatus,
  KnowledgeProvider,
  KnowledgeRevisionIndexInput,
  KnowledgeScope,
} from "@halo/ports/knowledge-provider";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres insufficient_privilege: the governed RPCs raise it for a denied
// tenant, document, revision or collection scope.
const PG_DENIED = "42501";

type GovernedKeywordRow = {
  source: "chunk" | "faq"; ref_id: string; revision_id: string; business_id: string;
  title: string; content: string; rank: number;
};
type GovernedVectorRow = {
  ref_id: string; revision_id: string; business_id: string; title: string; content: string; similarity: number;
};

/** Collection ids are validated before any database access; never widened. */
export function collectionScope(scope: KnowledgeScope | undefined): string[] {
  const ids = [...new Set(scope?.collectionIds ?? [])];
  if (ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw AppError.forbidden("Knowledge collection scope is invalid");
  }
  return ids;
}

/**
 * Governed Postgres retrieval (D14, migration 0033).
 *
 * Both paths call SECURITY DEFINER RPCs that return only approved,
 * published, fully indexed revisions of the named tenant, with the
 * collection scope applied inside the query (before ranking). A row that
 * names another tenant is dropped as a second check. The keyword path is
 * authoritative; the vector path is an enhancement fused by rank, and an
 * embedding failure falls back to keyword only.
 */
export class SupabaseKnowledgeProvider implements KnowledgeProvider {
  readonly name = "supabase";
  readonly enforcesCollectionScope = true;
  private readonly log = logger.child({ provider: this.name });

  constructor(
    private readonly db: SupabaseClient,
    private readonly embeddings: EmbeddingProvider | null,
  ) {}

  async search(businessId: string, query: string, limit = DEFAULT_LIMIT, scope?: KnowledgeScope): Promise<KnowledgeSnippet[]> {
    if (!businessId?.trim()) throw AppError.forbidden("Knowledge retrieval requires tenant context");
    const collectionIds = collectionScope(scope);
    const normalized = normalizeQuery(query);
    if (!normalized) return [];

    const [keyword, vector] = await Promise.all([
      this.keywordSearch(businessId, normalized, collectionIds, limit),
      this.vectorSearch(businessId, normalized, collectionIds, limit),
    ]);
    return vector.length ? fuseByReciprocalRank([keyword, vector], limit) : keyword;
  }

  private denied(error: { code?: string; message: string }, what: string): AppError {
    if (error.code === PG_DENIED) return AppError.forbidden(`${what} was denied`);
    this.log.error(`${what} failed`, { error: error.message.slice(0, 200) });
    return AppError.provider(`${what} failed`);
  }

  private async keywordSearch(businessId: string, query: string, collectionIds: string[], limit: number): Promise<KnowledgeSnippet[]> {
    const { data, error } = await this.db.rpc("search_governed_knowledge", {
      target_business_id: businessId,
      query,
      allowed_collection_ids: collectionIds,
      match_limit: limit,
    });
    if (error) throw this.denied(error, "Knowledge search");
    return ((data ?? []) as GovernedKeywordRow[]).flatMap((row) => {
      if (row.business_id !== businessId || !row.content?.trim()) return [];
      return [{ source: row.source, refId: row.ref_id, revisionId: row.revision_id, title: row.title, content: row.content, score: row.rank }];
    });
  }

  private async vectorSearch(businessId: string, query: string, collectionIds: string[], limit: number): Promise<KnowledgeSnippet[]> {
    if (!this.embeddings) return [];
    let embedding: number[] | undefined;
    try {
      [embedding] = await this.embeddings.embed([query]);
    } catch (error) {
      this.log.warn("query embedding failed, using keyword retrieval only", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return [];
    }
    if (!embedding?.length) return [];
    const { data, error } = await this.db.rpc("match_governed_knowledge_chunks", {
      target_business_id: businessId,
      query_embedding: embedding,
      allowed_collection_ids: collectionIds,
      match_limit: limit,
    });
    if (error) throw this.denied(error, "Knowledge vector search");
    return ((data ?? []) as GovernedVectorRow[]).flatMap((row) => {
      if (row.business_id !== businessId || !row.content?.trim()) return [];
      return [{ source: "chunk" as const, refId: row.ref_id, revisionId: row.revision_id, title: row.title, content: row.content, score: row.similarity }];
    });
  }

  /**
   * Indexes one draft revision: the database verifies tenant, document and
   * revision on both calls, clears any earlier attempt, and marks the draft
   * ready only when every chunk landed. Returns the resulting status; a
   * `failed` revision cannot be submitted or approved.
   */
  async indexRevision({ businessId, documentId, revisionId, chunks }: KnowledgeRevisionIndexInput): Promise<KnowledgeIndexStatus> {
    if (!businessId?.trim()) throw AppError.forbidden("Document indexing requires tenant context");
    if (![documentId, revisionId].every((id) => UUID.test(id ?? ""))) throw AppError.forbidden("Document indexing requires a document and revision");
    const ids = { p_business_id: businessId, p_document_id: documentId, p_revision_id: revisionId };

    const begin = await this.db.rpc("knowledge_begin_indexing", ids);
    if (begin.error) throw this.denied(begin.error, "Document indexing");

    const usable = chunks.filter((chunk) => chunk.trim());
    if (usable.length && usable.length === chunks.length) {
      let embeddings: number[][] | null = null;
      if (this.embeddings) {
        try {
          embeddings = await this.embeddings.embed(usable);
        } catch (error) {
          // Embeddings are an enhancement: the revision stays complete for keyword search.
          this.log.warn("embedding failed, indexing without vectors", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        }
      }
      const { error } = await this.db.from("knowledge_chunks").insert(usable.map((content, i) => ({
        document_id: documentId,
        business_id: businessId,
        revision_id: revisionId,
        content,
        chunk_index: i,
        embedding: embeddings?.[i] ?? null,
      })));
      if (error) this.log.error("chunk insert failed", { documentId, revisionId, error: error.message.slice(0, 200) });
    }

    const finish = await this.db.rpc("knowledge_finish_indexing", { ...ids, p_expected_chunks: chunks.length });
    if (finish.error) throw this.denied(finish.error, "Document indexing");
    return finish.data === "ready" ? "ready" : "failed";
  }
}
