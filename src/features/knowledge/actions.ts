"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { chunkText } from "@/core/services/chunker";
import { getKnowledgeProvider } from "@/providers/knowledge/factory";
import { logger } from "@/lib/logger";
import type { ActionState } from "@/features/business/actions";

const log = logger.child({ feature: "knowledge" });

const documentSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  content: z.string().trim().min(1, "Content is required").max(100_000),
});

export async function createDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { businessId } = await requireBusiness();
  const parsed = documentSchema.safeParse({
    title: formData.get("title"),
    content: formData.get("content"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { data: document, error } = await supabase
    .from("knowledge_documents")
    .insert({
      business_id: businessId,
      title: parsed.data.title,
      content: parsed.data.content,
      status: "processing",
    })
    .select("id")
    .single();

  if (error || !document) {
    log.error("document insert failed", { error: error?.message });
    return { error: "Could not save the document. Please try again." };
  }

  await indexDocument(businessId, document.id, parsed.data.content);
  revalidatePath("/dashboard/knowledge");
  return { error: null, message: "Document added to your knowledge base." };
}

export async function updateDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { businessId } = await requireBusiness();
  const idResult = z.string().uuid().safeParse(formData.get("id"));
  const parsed = documentSchema.safeParse({
    title: formData.get("title"),
    content: formData.get("content"),
  });
  if (!idResult.success) return { error: "Invalid document" };
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("knowledge_documents")
    .update({ title: parsed.data.title, content: parsed.data.content, status: "processing" })
    .eq("id", idResult.data)
    .eq("business_id", businessId);

  if (error) {
    log.error("document update failed", { error: error.message });
    return { error: "Could not save changes. Please try again." };
  }

  await indexDocument(businessId, idResult.data, parsed.data.content);
  revalidatePath("/dashboard/knowledge");
  return { error: null, message: "Document updated and re-indexed." };
}

export async function deleteDocument(formData: FormData): Promise<void> {
  const { businessId } = await requireBusiness();
  const id = z.string().uuid().parse(formData.get("id"));

  await getKnowledgeProvider().removeDocument(businessId, id);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("knowledge_documents")
    .delete()
    .eq("id", id)
    .eq("business_id", businessId);
  if (error) log.error("document delete failed", { error: error.message });

  revalidatePath("/dashboard/knowledge");
}

/** Chunk + index; document status reflects the outcome. */
async function indexDocument(businessId: string, documentId: string, content: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  try {
    const chunks = chunkText(content);
    await getKnowledgeProvider().indexDocument(businessId, documentId, chunks);
    await supabase
      .from("knowledge_documents")
      .update({ status: "ready" })
      .eq("id", documentId)
      .eq("business_id", businessId);
  } catch (error) {
    log.error("document indexing failed", { documentId, error });
    await supabase
      .from("knowledge_documents")
      .update({ status: "error" })
      .eq("id", documentId)
      .eq("business_id", businessId);
  }
}
