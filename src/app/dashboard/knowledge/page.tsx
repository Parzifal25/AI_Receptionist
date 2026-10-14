import type { Metadata } from "next";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DocumentEditor } from "@/features/knowledge/document-editor";
import { deleteDocument, reviewDocumentRevision, withdrawDocument } from "@/features/knowledge/actions";

export const metadata: Metadata = { title: "Knowledge base — AI Receptionist" };

const STATUS_TONE = { ready: "green", processing: "amber", error: "red" } as const;

interface OpenRevision {
  id: string;
  document_id: string;
  revision: number;
  state: "draft" | "pending_review" | "approved";
  index_status: string;
}

export default async function KnowledgePage() {
  const { businessId, role } = await requireBusiness();
  const canApprove = role === "owner" || role === "admin";
  const supabase = await createSupabaseServerClient();

  const [{ data: documents }, { data: revisions }] = await Promise.all([
    supabase
      .from("knowledge_documents")
      .select("id, title, content, status, created_at, published_revision_id")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false }),
    supabase
      .from("knowledge_document_revisions")
      .select("id, document_id, revision, state, index_status")
      .eq("business_id", businessId)
      .in("state", ["draft", "pending_review", "approved"]),
  ]);
  const open = (revisions ?? []) as OpenRevision[];
  const published = (docId: string) => open.find((r) => r.document_id === docId && r.state === "approved");
  const pending = (docId: string) => open.find((r) => r.document_id === docId && r.state === "pending_review");

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Knowledge base</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Paste your services, policies, pricing pages — anything the receptionist should know.
          It only answers from content an owner or admin has approved, your approved FAQs and your profile.
          Every change is kept as a revision and must be approved again.
        </p>
      </div>

      <DocumentEditor mode="create" />

      <div className="space-y-4">
        {(documents ?? []).length === 0 ? (
          <Card>
            <EmptyState
              title="No documents yet"
              description="Add your first document above — service descriptions, policies and pricing work great."
            />
          </Card>
        ) : (
          documents!.map((doc) => {
            const live = published(doc.id);
            const review = pending(doc.id);
            return (
              <Card key={doc.id}>
                <CardHeader
                  title={doc.title}
                  description={`${doc.content.length.toLocaleString()} characters · added ${new Date(doc.created_at).toLocaleDateString()}`}
                  action={
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={live ? "green" : "slate"}>
                        {live ? `Published · r${live.revision}` : "Not published"}
                      </Badge>
                      {review && <Badge tone="amber">{`Awaiting approval · r${review.revision}`}</Badge>}
                      <Badge tone={STATUS_TONE[doc.status as keyof typeof STATUS_TONE] ?? "slate"}>
                        {doc.status}
                      </Badge>
                      {canApprove && review && (
                        <>
                          <form action={reviewDocumentRevision}>
                            <input type="hidden" name="revisionId" value={review.id} />
                            <input type="hidden" name="decision" value="approve" />
                            <Button type="submit" variant="ghost" size="sm">Approve</Button>
                          </form>
                          <form action={reviewDocumentRevision}>
                            <input type="hidden" name="revisionId" value={review.id} />
                            <input type="hidden" name="decision" value="reject" />
                            <Button type="submit" variant="ghost" size="sm">Reject</Button>
                          </form>
                        </>
                      )}
                      {canApprove && doc.published_revision_id && (
                        <form action={withdrawDocument}>
                          <input type="hidden" name="id" value={doc.id} />
                          <Button type="submit" variant="ghost" size="sm">Withdraw</Button>
                        </form>
                      )}
                      {canApprove && !doc.published_revision_id && (
                        <form action={deleteDocument}>
                          <input type="hidden" name="id" value={doc.id} />
                          <Button type="submit" variant="ghost" size="sm">Delete</Button>
                        </form>
                      )}
                    </div>
                  }
                />
                <DocumentEditor
                  mode="edit"
                  document={{ id: doc.id, title: doc.title, content: doc.content }}
                />
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
