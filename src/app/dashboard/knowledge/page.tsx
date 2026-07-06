import type { Metadata } from "next";
import { requireBusiness } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DocumentEditor } from "@/features/knowledge/document-editor";
import { deleteDocument } from "@/features/knowledge/actions";

export const metadata: Metadata = { title: "Knowledge base — AI Receptionist" };

const STATUS_TONE = { ready: "green", processing: "amber", error: "red" } as const;

export default async function KnowledgePage() {
  const { businessId } = await requireBusiness();
  const supabase = await createSupabaseServerClient();

  const { data: documents } = await supabase
    .from("knowledge_documents")
    .select("id, title, content, status, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Knowledge base</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Paste your services, policies, pricing pages — anything the receptionist should know.
          It only answers from what you add here, your FAQs and your profile.
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
          documents!.map((doc) => (
            <Card key={doc.id}>
              <CardHeader
                title={doc.title}
                description={`${doc.content.length.toLocaleString()} characters · added ${new Date(doc.created_at).toLocaleDateString()}`}
                action={
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS_TONE[doc.status as keyof typeof STATUS_TONE] ?? "slate"}>
                      {doc.status}
                    </Badge>
                    <form action={deleteDocument}>
                      <input type="hidden" name="id" value={doc.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
                    </form>
                  </div>
                }
              />
              <DocumentEditor
                mode="edit"
                document={{ id: doc.id, title: doc.title, content: doc.content }}
              />
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
