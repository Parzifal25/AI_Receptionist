import type { KnowledgeSnippet } from "@/core/domain/types";

/**
 * Port for tenant-scoped knowledge retrieval. The default implementation is
 * Postgres full-text search over knowledge chunks + FAQs; a vector-search
 * implementation activates automatically when an EmbeddingProvider is
 * configured. Future implementations (external vector DBs, hosted RAG)
 * plug in behind this same interface.
 */
export interface KnowledgeProvider {
  readonly name: string;
  search(businessId: string, query: string, limit?: number): Promise<KnowledgeSnippet[]>;
  /** Index a document's chunks so they become retrievable. */
  indexDocument(businessId: string, documentId: string, chunks: string[]): Promise<void>;
  removeDocument(businessId: string, documentId: string): Promise<void>;
}
