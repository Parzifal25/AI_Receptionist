import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseKnowledgeProvider } from "@halo/providers/knowledge/supabase-knowledge-provider";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { emptyKnowledgeProvider } from "../mocks/runtime-fakes";

type Row = Record<string, unknown>;
function database(options: { rows?: Row[]; error?: boolean; document?: Row | null } = {}) {
  const filters: Array<[string, unknown]> = [];
  const insert = vi.fn();
  const remove = vi.fn();
  const rpc = vi.fn(async () => ({ data: [
    { source: "chunk", ref_id: "pending-doc", title: "Ready but unapproved", content: "UNAPPROVED", rank: 1 },
    ...["approved", "pending", "foreign"].map(id => ({ source: "faq", ref_id: id, content: "RPC TEXT MUST NOT BE TRUSTED", rank: 1 })),
  ], error: null }));
  const from = vi.fn((table: string) => {
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      in: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      maybeSingle: async () => ({ data: options.document ?? null, error: options.error ? { message: "unavailable" } : null }),
      insert,
      delete: remove,
      // Deliberately return unfiltered rows: provider must defensively check
      // tenant and publication, in addition to sending the correct filters.
      then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: table === "faqs" ? options.rows ?? [] : [], error: options.error ? { message: "unavailable" } : null }).then(resolve),
    };
    return query;
  });
  return { db: { rpc, from } as unknown as SupabaseClient, rpc, from, filters, insert, remove };
}

const faq = (id: string, business_id = "tenant-a", is_published = true) => ({ id, business_id, is_published, question: "Synthetic hours?", answer: "Synthetic approved answer", category: "Hours" });

describe("Layer 1 trusted knowledge access", () => {
  it("serves published own-tenant FAQs, refuses documents, pending and foreign FAQs", async () => {
    const fake = database({ rows: [faq("approved"), faq("pending", "tenant-a", false), faq("foreign", "tenant-b")] });
    const embed = vi.fn();
    const provider = new SupabaseKnowledgeProvider(fake.db, { name: "synthetic", dimensions: 768, embed } as never);
    const result = await provider.search("tenant-a", "hours");
    expect(result.map(row => row.refId)).toEqual(["approved"]);
    expect(result[0].content).toContain("Synthetic approved answer");
    expect(fake.rpc).toHaveBeenCalledWith("search_knowledge", { target_business_id: "tenant-a", query: "hours", match_limit: 6 });
    expect(fake.filters).toContainEqual(["business_id", "tenant-a"]);
    expect(fake.filters).toContainEqual(["is_published", true]);
    expect(embed).not.toHaveBeenCalled();
    expect(fake.rpc).toHaveBeenCalledTimes(1); // No vector-document bypass.
  });

  it("fails closed on approval read failure", async () => {
    const fake = database({ rows: [faq("approved")], error: true });
    await expect(new SupabaseKnowledgeProvider(fake.db, null).search("tenant-a", "hours")).rejects.toThrow("publication could not be verified");
  });

  it("rejects missing tenant before accessing the database", async () => {
    const fake = database();
    await expect(new SupabaseKnowledgeProvider(fake.db, null).search(" ", "hours")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it.each([null, { id: "doc-b", business_id: "tenant-b" }])("refuses indexing a missing/foreign parent before deletes, inserts or embedding", async (document) => {
    const fake = database({ document });
    const embed = vi.fn();
    await expect(new SupabaseKnowledgeProvider(fake.db, { name: "synthetic", embed } as never).indexDocument("tenant-a", "doc-b", ["text"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.remove).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it.each([{ businessId: "", collectionIds: [] }, { businessId: "tenant-a", collectionIds: ["tenant-b-collection"] }])("refuses absent tenant or unsupported collection before provider access", async (scope) => {
    const provider = emptyKnowledgeProvider();
    const search = vi.spyOn(provider, "search");
    await expect(new ProviderKnowledgeResolver(provider).resolve({ ...scope, history: [], userMessage: "hours", limits: { maxSnippets: 6, maxChars: 1000 } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(search).not.toHaveBeenCalled();
  });
});
