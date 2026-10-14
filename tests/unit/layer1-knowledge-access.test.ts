import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectionScope, SupabaseKnowledgeProvider } from "@halo/providers/knowledge/supabase-knowledge-provider";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { emptyKnowledgeProvider } from "../mocks/runtime-fakes";

/**
 * D14 — the governed knowledge provider at its database boundary. The SQL
 * itself (approval, publication, tenant and collection scope) is proven as
 * real roles by scripts/check-rls.mjs; these tests pin what the provider
 * sends and how it treats what comes back.
 */
type Rpc = { data: unknown; error: { code?: string; message: string } | null };
const COL = "11111111-2222-4333-8444-555555555555";
const DOC = "aaaaaaaa-0000-4000-8000-000000000001";
const REV = "aaaaaaaa-0000-4000-8000-000000000002";

function database(responses: Record<string, Rpc | ((args: Record<string, unknown>) => Rpc)> = {}, insertError: string | null = null) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const inserted: Array<Record<string, unknown>[]> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    const response = responses[name];
    return typeof response === "function" ? response(args) : response ?? { data: [], error: null };
  });
  const from = vi.fn(() => ({
    insert: async (rows: Record<string, unknown>[]) => { inserted.push(rows); return { error: insertError ? { message: insertError } : null }; },
  }));
  return { db: { rpc, from } as unknown as SupabaseClient, rpc, calls, inserted };
}

const keywordRow = (ref: string, business = "tenant-a", content = "Approved text") =>
  ({ source: "chunk", ref_id: ref, revision_id: `rev-${ref}`, business_id: business, title: "Doc", content, rank: 0.5 });

describe("D14 governed knowledge provider", () => {
  it("searches only through the governed RPC with the trusted tenant and an explicit empty scope", async () => {
    const fake = database({ search_governed_knowledge: { data: [keywordRow("c1")], error: null } });
    const result = await new SupabaseKnowledgeProvider(fake.db, null).search("tenant-a", "  warranty  ");
    expect(fake.calls).toEqual([["search_governed_knowledge", { target_business_id: "tenant-a", query: "warranty", allowed_collection_ids: [], match_limit: 6 }]]);
    expect(result).toEqual([{ source: "chunk", refId: "c1", revisionId: "rev-c1", title: "Doc", content: "Approved text", score: 0.5 }]);
  });

  it("passes a collection scope to both keyword and vector RPCs", async () => {
    const embed = vi.fn(async () => [[0.1, 0.2]]);
    const fake = database({
      search_governed_knowledge: { data: [keywordRow("c1")], error: null },
      match_governed_knowledge_chunks: { data: [{ ref_id: "c2", revision_id: "r2", business_id: "tenant-a", title: "Doc", content: "Vector text", similarity: 0.9 }], error: null },
    });
    const result = await new SupabaseKnowledgeProvider(fake.db, { name: "synthetic", embed } as never).search("tenant-a", "warranty", 4, { collectionIds: [COL, COL] });
    expect(fake.calls.map(([name, args]) => [name, args.allowed_collection_ids])).toEqual([
      ["search_governed_knowledge", [COL]],
      ["match_governed_knowledge_chunks", [COL]],
    ]);
    expect(result.map((s) => s.refId).sort()).toEqual(["c1", "c2"]);
  });

  it("drops a row that names another tenant even if the RPC returned it", async () => {
    const fake = database({ search_governed_knowledge: { data: [keywordRow("mine"), keywordRow("theirs", "tenant-b"), keywordRow("blank", "tenant-a", "  ")], error: null } });
    const result = await new SupabaseKnowledgeProvider(fake.db, null).search("tenant-a", "warranty");
    expect(result.map((s) => s.refId)).toEqual(["mine"]);
  });

  it.each([[["not-a-uuid"]], [[COL, "x"]], [[""]]])("refuses a malformed collection scope before any database access (%j)", async (collectionIds) => {
    const fake = database();
    await expect(new SupabaseKnowledgeProvider(fake.db, null).search("tenant-a", "warranty", 6, { collectionIds })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(() => collectionScope({ collectionIds })).toThrow();
  });

  it("maps a database scope denial to FORBIDDEN and other failures to a provider error", async () => {
    const denied = database({ search_governed_knowledge: { data: null, error: { code: "42501", message: "knowledge collection scope names an unknown collection" } } });
    await expect(new SupabaseKnowledgeProvider(denied.db, null).search("tenant-a", "warranty", 6, { collectionIds: [COL] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const down = database({ search_governed_knowledge: { data: null, error: { message: "connection reset" } } });
    await expect(new SupabaseKnowledgeProvider(down.db, null).search("tenant-a", "warranty")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("falls back to keyword results when the query embedding fails", async () => {
    const embed = vi.fn(async () => { throw new Error("embedding quota"); });
    const fake = database({ search_governed_knowledge: { data: [keywordRow("c1")], error: null } });
    const result = await new SupabaseKnowledgeProvider(fake.db, { name: "synthetic", embed } as never).search("tenant-a", "warranty");
    expect(result.map((s) => s.refId)).toEqual(["c1"]);
    expect(fake.calls.map(([name]) => name)).toEqual(["search_governed_knowledge"]);
  });

  it("rejects missing tenant before accessing the database", async () => {
    const fake = database();
    await expect(new SupabaseKnowledgeProvider(fake.db, null).search(" ", "hours")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.rpc).not.toHaveBeenCalled();
  });
});

describe("D14 revision indexing", () => {
  const input = { businessId: "tenant-a", documentId: DOC, revisionId: REV, chunks: ["one", "two"] };

  it("verifies the revision, writes revision-bound chunks, and lets the database decide readiness", async () => {
    const fake = database({ knowledge_finish_indexing: { data: "ready", error: null } });
    expect(await new SupabaseKnowledgeProvider(fake.db, null).indexRevision(input)).toBe("ready");
    const ids = { p_business_id: "tenant-a", p_document_id: DOC, p_revision_id: REV };
    expect(fake.calls).toEqual([["knowledge_begin_indexing", ids], ["knowledge_finish_indexing", { ...ids, p_expected_chunks: 2 }]]);
    expect(fake.inserted[0]).toEqual([
      { document_id: DOC, business_id: "tenant-a", revision_id: REV, content: "one", chunk_index: 0, embedding: null },
      { document_id: DOC, business_id: "tenant-a", revision_id: REV, content: "two", chunk_index: 1, embedding: null },
    ]);
  });

  it("refuses a revision the database does not own before writing or embedding", async () => {
    const embed = vi.fn();
    const fake = database({ knowledge_begin_indexing: { data: null, error: { code: "42501", message: "knowledge revision not found for this business and document" } } });
    await expect(new SupabaseKnowledgeProvider(fake.db, { name: "synthetic", embed } as never).indexRevision(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.inserted).toHaveLength(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it("reports failed when the chunk write fails, never ready", async () => {
    const fake = database({ knowledge_finish_indexing: ({ p_expected_chunks }) => ({ data: p_expected_chunks === 2 ? "failed" : "ready", error: null }) }, "insert failed");
    expect(await new SupabaseKnowledgeProvider(fake.db, null).indexRevision(input)).toBe("failed");
  });

  it.each([[[]], [["text", "  "]]])("does not write an empty or partially blank chunk set (%j)", async (chunks) => {
    const fake = database({ knowledge_finish_indexing: { data: "failed", error: null } });
    expect(await new SupabaseKnowledgeProvider(fake.db, null).indexRevision({ ...input, chunks })).toBe("failed");
    expect(fake.inserted).toHaveLength(0);
  });

  it("keeps indexing complete for keyword search when embeddings fail", async () => {
    const embed = vi.fn(async () => { throw new Error("embedding quota"); });
    const fake = database({ knowledge_finish_indexing: { data: "ready", error: null } });
    expect(await new SupabaseKnowledgeProvider(fake.db, { name: "synthetic", embed } as never).indexRevision(input)).toBe("ready");
    expect(fake.inserted[0].every((row) => row.embedding === null)).toBe(true);
  });

  it.each([{ businessId: "", documentId: DOC, revisionId: REV }, { businessId: "tenant-a", documentId: "doc", revisionId: REV }])("refuses missing tenant or malformed ids before database access", async (ids) => {
    const fake = database();
    await expect(new SupabaseKnowledgeProvider(fake.db, null).indexRevision({ ...ids, chunks: ["x"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.rpc).not.toHaveBeenCalled();
  });
});

describe("D14 runtime resolver scope", () => {
  it("passes a nonempty binding to a provider that enforces collection scope", async () => {
    const provider = { ...emptyKnowledgeProvider(), enforcesCollectionScope: true };
    const search = vi.spyOn(provider, "search");
    await new ProviderKnowledgeResolver(provider).resolve({ businessId: "tenant-a", collectionIds: [COL], history: [], userMessage: "hours?", limits: { maxSnippets: 6, maxChars: 1000 } });
    expect(search).toHaveBeenCalledWith("tenant-a", expect.any(String), 6, { collectionIds: [COL] });
  });

  it.each([{ businessId: "", collectionIds: [] }, { businessId: "tenant-a", collectionIds: [COL] }])("refuses absent tenant, or a binding the provider cannot enforce, before provider access", async (scope) => {
    const provider = emptyKnowledgeProvider();
    const search = vi.spyOn(provider, "search");
    await expect(new ProviderKnowledgeResolver(provider).resolve({ ...scope, history: [], userMessage: "hours", limits: { maxSnippets: 6, maxChars: 1000 } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(search).not.toHaveBeenCalled();
  });
});
