import type { Metadata } from "next";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FaqEditor } from "@/features/faqs/faq-editor";
import { deleteFaq, reviewFaqRevision, withdrawFaq } from "@/features/faqs/actions";

export const metadata: Metadata = { title: "FAQs — AI Receptionist" };

interface OpenRevision {
  id: string;
  faq_id: string;
  revision: number;
  state: "pending_review" | "approved";
}

export default async function FaqsPage() {
  const { businessId, role } = await requireBusiness();
  const canApprove = role === "owner" || role === "admin";
  const supabase = await createSupabaseServerClient();

  const [{ data: faqs }, { data: revisions }] = await Promise.all([
    supabase
      .from("faqs")
      .select("id, question, answer, category, published_revision_id")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false }),
    supabase
      .from("faq_revisions")
      .select("id, faq_id, revision, state")
      .eq("business_id", businessId)
      .in("state", ["pending_review", "approved"]),
  ]);
  const open = (revisions ?? []) as OpenRevision[];

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">FAQs</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          The receptionist answers these word-perfect, but only once an owner or admin has approved
          them. Every edit is kept as a revision and must be approved again.
        </p>
      </div>

      <FaqEditor mode="create" />

      <div className="space-y-4">
        {(faqs ?? []).length === 0 ? (
          <Card>
            <EmptyState
              title="No FAQs yet"
              description="Start with the questions your visitors ask most — opening hours, pricing, location."
            />
          </Card>
        ) : (
          faqs!.map((faq) => {
            const live = open.find((r) => r.faq_id === faq.id && r.state === "approved");
            const review = open.find((r) => r.faq_id === faq.id && r.state === "pending_review");
            return (
              <Card key={faq.id}>
                <CardHeader
                  title={faq.question}
                  description={faq.category || undefined}
                  action={
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={live ? "green" : "slate"}>
                        {live ? `Published · r${live.revision}` : "Not published"}
                      </Badge>
                      {review && <Badge tone="amber">{`Awaiting approval · r${review.revision}`}</Badge>}
                      {canApprove && review && (
                        <>
                          <form action={reviewFaqRevision}>
                            <input type="hidden" name="revisionId" value={review.id} />
                            <input type="hidden" name="decision" value="approve" />
                            <Button type="submit" variant="ghost" size="sm">Approve</Button>
                          </form>
                          <form action={reviewFaqRevision}>
                            <input type="hidden" name="revisionId" value={review.id} />
                            <input type="hidden" name="decision" value="reject" />
                            <Button type="submit" variant="ghost" size="sm">Reject</Button>
                          </form>
                        </>
                      )}
                      {canApprove && faq.published_revision_id && (
                        <form action={withdrawFaq}>
                          <input type="hidden" name="id" value={faq.id} />
                          <Button type="submit" variant="ghost" size="sm">Withdraw</Button>
                        </form>
                      )}
                      {canApprove && !faq.published_revision_id && (
                        <form action={deleteFaq}>
                          <input type="hidden" name="id" value={faq.id} />
                          <Button type="submit" variant="ghost" size="sm">Delete</Button>
                        </form>
                      )}
                    </div>
                  }
                />
                <FaqEditor
                  mode="edit"
                  faq={{
                    id: faq.id,
                    question: faq.question,
                    answer: faq.answer,
                    category: faq.category,
                  }}
                />
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
