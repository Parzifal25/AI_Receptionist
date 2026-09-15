import type { Metadata } from "next";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FaqEditor } from "@/features/faqs/faq-editor";
import { deleteFaq, toggleFaqPublished } from "@/features/faqs/actions";

export const metadata: Metadata = { title: "FAQs — AI Receptionist" };

export default async function FaqsPage() {
  const { businessId } = await requireBusiness();
  const supabase = await createSupabaseServerClient();

  const { data: faqs } = await supabase
    .from("faqs")
    .select("id, question, answer, category, is_published")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">FAQs</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          The receptionist answers these word-perfect. Unpublished FAQs are ignored.
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
          faqs!.map((faq) => (
            <Card key={faq.id}>
              <CardHeader
                title={faq.question}
                description={faq.category || undefined}
                action={
                  <div className="flex items-center gap-2">
                    <Badge tone={faq.is_published ? "green" : "slate"}>
                      {faq.is_published ? "Published" : "Draft"}
                    </Badge>
                    <form action={toggleFaqPublished}>
                      <input type="hidden" name="id" value={faq.id} />
                      <input type="hidden" name="publish" value={String(!faq.is_published)} />
                      <Button type="submit" variant="ghost" size="sm">
                        {faq.is_published ? "Unpublish" : "Publish"}
                      </Button>
                    </form>
                    <form action={deleteFaq}>
                      <input type="hidden" name="id" value={faq.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
                    </form>
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
          ))
        )}
      </div>
    </div>
  );
}
