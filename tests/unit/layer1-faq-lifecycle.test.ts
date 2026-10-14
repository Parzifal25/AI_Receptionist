import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFaq, deleteFaq, reviewFaqRevision, updateFaq, withdrawFaq } from "@/features/faqs/actions";
import { createDocument, reviewDocumentRevision, withdrawDocument } from "@/features/knowledge/actions";

/**
 * D14 — the dashboard actions. Tenant identity comes from requireBusiness()
 * (the signed-in membership), never from the form; approval-type actions are
 * refused for members before the database is asked (which refuses again).
 */
const fake = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "member",
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  deletes: [] as Array<[string, unknown]>,
  indexed: [] as Array<Record<string, unknown>>,
  indexStatus: "ready" as "ready" | "failed",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@halo/tenancy/auth", () => ({ requireBusiness: async () => ({ businessId: "tenant-a", userId: "synthetic", role: fake.role }) }));
vi.mock("@halo/providers/knowledge/factory", () => ({ getKnowledgeProvider: () => ({
  name: "fake",
  async search() { return []; },
  async indexRevision(input: Record<string, unknown>) { fake.indexed.push(input); return fake.indexStatus; },
}) }));
vi.mock("@halo/tenancy/supabase/server", () => ({ createSupabaseServerClient: async () => ({
  rpc: (name: string, args: Record<string, unknown>) => {
    fake.rpcs.push([name, args]);
    const result = { data: { document_id: "doc-1", revision_id: "rev-1" }, error: null };
    return Object.assign(Promise.resolve(result), { single: async () => result });
  },
  from: () => {
    const query = {
      delete: () => query,
      eq: (key: string, value: unknown) => { fake.deletes.push([key, value]); return query; },
      then: (resolve: (result: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    return query;
  },
}) }));

const ID = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { fake.role = "owner"; fake.rpcs.length = 0; fake.deletes.length = 0; fake.indexed.length = 0; fake.indexStatus = "ready"; });
function form(extra: Record<string, string> = {}) {
  const data = new FormData();
  data.set("question", "Synthetic question?"); data.set("answer", "Synthetic answer"); data.set("category", "Test");
  data.set("title", "Synthetic doc"); data.set("content", "Synthetic approved content");
  data.set("id", ID); data.set("is_published", "true"); data.set("business_id", "tenant-b");
  for (const [k, v] of Object.entries(extra)) data.set(k, v);
  return data;
}

describe("D14 FAQ actions", () => {
  it("creates a revision pending review for the trusted tenant; client tenant and publish flags are ignored", async () => {
    expect(await createFaq({ error: null }, form())).toMatchObject({ error: null });
    expect(fake.rpcs).toEqual([["faq_create_revision", { p_business_id: "tenant-a", p_faq_id: null, p_question: "Synthetic question?", p_answer: "Synthetic answer", p_category: "Test" }]]);
  });

  it("an edit becomes a new revision of the same FAQ", async () => {
    expect(await updateFaq({ error: null }, form())).toMatchObject({ error: null });
    expect(fake.rpcs[0]).toEqual(["faq_create_revision", expect.objectContaining({ p_business_id: "tenant-a", p_faq_id: ID })]);
  });

  it.each(["owner", "admin"] as const)("%s can approve, withdraw and delete", async (role) => {
    fake.role = role;
    await reviewFaqRevision(form({ revisionId: ID, decision: "approve" }));
    await withdrawFaq(form());
    await deleteFaq(form());
    expect(fake.rpcs).toEqual([["faq_review_revision", { p_revision_id: ID, p_approve: true }], ["faq_withdraw", { p_faq_id: ID }]]);
    expect(fake.deletes).toEqual([["id", ID], ["business_id", "tenant-a"]]);
  });

  it("a member cannot approve, withdraw or delete (refused before the database)", async () => {
    fake.role = "member";
    await reviewFaqRevision(form({ revisionId: ID, decision: "approve" }));
    await withdrawFaq(form());
    await deleteFaq(form());
    expect(fake.rpcs).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });

  it("anything but an explicit approve is a rejection", async () => {
    await reviewFaqRevision(form({ revisionId: ID, decision: "maybe" }));
    expect(fake.rpcs).toEqual([["faq_review_revision", { p_revision_id: ID, p_approve: false }]]);
  });
});

describe("D14 document actions", () => {
  it("creates a revision, indexes exactly that revision, then submits it for review", async () => {
    fake.role = "member";
    expect(await createDocument({ error: null }, form())).toMatchObject({ error: null });
    expect(fake.rpcs.map(([name]) => name)).toEqual(["knowledge_create_document_revision", "knowledge_submit_revision"]);
    expect(fake.rpcs[0][1]).toMatchObject({ p_business_id: "tenant-a", p_document_id: null });
    expect(fake.indexed).toEqual([{ businessId: "tenant-a", documentId: "doc-1", revisionId: "rev-1", chunks: ["Synthetic approved content"] }]);
  });

  it("a failed index is reported and never submitted", async () => {
    fake.indexStatus = "failed";
    const state = await createDocument({ error: null }, form());
    expect(state.error).toMatch(/indexing failed/);
    expect(fake.rpcs.map(([name]) => name)).toEqual(["knowledge_create_document_revision"]);
  });

  it("a member cannot approve or withdraw documents", async () => {
    fake.role = "member";
    await reviewDocumentRevision(form({ revisionId: ID, decision: "approve" }));
    await withdrawDocument(form());
    expect(fake.rpcs).toEqual([]);
  });

  it("an admin approval names only the revision; the database derives its tenant", async () => {
    fake.role = "admin";
    await reviewDocumentRevision(form({ revisionId: ID, decision: "approve" }));
    expect(fake.rpcs).toEqual([["knowledge_review_revision", { p_revision_id: ID, p_approve: true }]]);
  });
});
