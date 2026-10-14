import type { KnowledgeSnippet } from "@halo/core/domain/types";

/** Which approved knowledge a lookup may use. Empty = all of the tenant's. */
export interface KnowledgeScope {
  collectionIds: readonly string[];
}

/** Outcome of indexing one draft revision; `failed` never becomes searchable. */
export type KnowledgeIndexStatus = "ready" | "failed";

export interface KnowledgeRevisionIndexInput {
  businessId: string;
  documentId: string;
  revisionId: string;
  chunks: string[];
}

/**
 * Port for tenant-scoped knowledge retrieval and indexing (D14).
 *
 * search() returns approved, published content of one tenant only. A
 * provider that sets `enforcesCollectionScope` applies `scope.collectionIds`
 * itself and denies unknown or foreign collections; the runtime refuses a
 * nonempty scope for any provider that does not.
 *
 * indexRevision() indexes one draft revision. It never publishes: approval
 * is a separate, human, tenant-scoped action.
 */
export interface KnowledgeProvider {
  readonly name: string;
  readonly enforcesCollectionScope?: boolean;
  search(businessId: string, query: string, limit?: number, scope?: KnowledgeScope): Promise<KnowledgeSnippet[]>;
  indexRevision(input: KnowledgeRevisionIndexInput): Promise<KnowledgeIndexStatus>;
}
