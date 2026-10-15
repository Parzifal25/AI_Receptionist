"use server";

import { rejectSecurityAudit } from "@halo/platform/security-audit";
import { failSecurityAudit } from "@halo/platform/security-audit";
import { withAuditedAction } from "@halo/tenancy/audited-action";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { chunkText } from "@halo/knowledge/chunker";
import { getKnowledgeProvider } from "@halo/providers/knowledge/factory";
import { logger } from "@halo/platform/logger";
import type { ActionState } from "@/features/business/actions";

/**
 * D14 knowledge governance (migration 0033). Every save creates an
 * immutable draft revision, indexes it and submits it for review; nothing
 * is served until an owner or admin approves it. Authority is checked here
 * from the trusted membership role and again in the database from the
 * caller's JWT. Logs carry ids and bounded error text, never content.
 */

const log = logger.child({ feature: "knowledge" });

const documentSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  content: z.string().trim().min(1, "Content is required").max(100_000),
});
const uuid = z.string().uuid();

const canApprove = (role: string) => role === "owner" || role === "admin";

async function saveRevision(documentId: string | null, formData: FormData): Promise<ActionState> {
  const { businessId } = await requireBusiness();
  const parsed = documentSchema.safeParse({
    title: formData.get("title"),
    content: formData.get("content"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc("knowledge_create_document_revision", {
      p_business_id: businessId,
      p_document_id: documentId,
      p_title: parsed.data.title,
      p_content: parsed.data.content,
    })
    .single<{ document_id: string; revision_id: string }>();
  if (error || !data) {
    log.error("knowledge revision create failed", { documentId, error: error?.message?.slice(0, 200) });
    return { error: "Could not save the document. Please try again." };
  }

  let status: "ready" | "failed" = "failed";
  try {
    status = await getKnowledgeProvider().indexRevision({
      businessId,
      documentId: data.document_id,
      revisionId: data.revision_id,
      chunks: chunkText(parsed.data.content),
    });
  } catch (indexError) {
    log.error("knowledge indexing failed", {
      documentId: data.document_id,
      revisionId: data.revision_id,
      error: indexError instanceof Error ? indexError.message.slice(0, 200) : "unknown",
    });
  }
  revalidatePath("/dashboard/knowledge");
  if (status !== "ready") {
    return { error: "Saved, but indexing failed. The receptionist will not use this version; please save again." };
  }

  const { error: submitError } = await supabase.rpc("knowledge_submit_revision", { p_revision_id: data.revision_id });
  if (submitError) {
    log.error("knowledge revision submit failed", { revisionId: data.revision_id, error: submitError.message.slice(0, 200) });
    return { error: "Saved, but it could not be sent for review. Please try again." };
  }
  return { error: null, message: "Saved and sent for review. The receptionist uses it once an owner or admin approves it." };
}

export async function createDocument(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return withAuditedAction(async () => {

    return saveRevision(null, formData);

  }, { action: "createDocument" });
}

export async function updateDocument(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return withAuditedAction(async () => {

    const id = uuid.safeParse(formData.get("id"));
    if (!id.success) return { error: "Invalid document" };
    return saveRevision(id.data, formData);

  }, { action: "updateDocument" });
}

/** Approve (publish) or reject a pending revision. Owner/admin only. */
export async function reviewDocumentRevision(formData: FormData): Promise<void> {
  return withAuditedAction(async () => {

    const { role } = await requireBusiness();
    const revisionId = uuid.safeParse(formData.get("revisionId"));
    if (!canApprove(role) || !revisionId.success) { await rejectSecurityAudit(); return; }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("knowledge_review_revision", {
      p_revision_id: revisionId.data,
      p_approve: formData.get("decision") === "approve",
  });
  if (error) { await failSecurityAudit(); log.error("knowledge review failed", { revisionId: revisionId.data, error: error.message.slice(0, 200) }); }
  revalidatePath("/dashboard/knowledge");

  }, { action: "reviewDocumentRevision" });
}

/** Stop serving a document's published revision. Owner/admin only. */
export async function withdrawDocument(formData: FormData): Promise<void> {
  return withAuditedAction(async () => {

    const { role } = await requireBusiness();
    const id = uuid.safeParse(formData.get("id"));
    if (!canApprove(role) || !id.success) { await rejectSecurityAudit(); return; }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("knowledge_withdraw_document", { p_document_id: id.data });
    if (error) { await failSecurityAudit(); log.error("knowledge withdraw failed", { documentId: id.data, error: error.message.slice(0, 200) }); }
    revalidatePath("/dashboard/knowledge");

  }, { action: "withdrawDocument" });
}

/**
 * Delete an unpublished document and its revision history. Owner/admin
 * only; the database refuses published documents (withdraw first).
 */
export async function deleteDocument(formData: FormData): Promise<void> {
  return withAuditedAction(async () => {

    const { businessId, role } = await requireBusiness();
    const id = uuid.safeParse(formData.get("id"));
    if (!canApprove(role) || !id.success) { await rejectSecurityAudit(); return; }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase
      .from("knowledge_documents")
      .delete()
      .eq("id", id.data)
      .eq("business_id", businessId);
    if (error) { await failSecurityAudit(); log.error("document delete failed", { documentId: id.data, error: error.message.slice(0, 200) }); }
    revalidatePath("/dashboard/knowledge");

  }, { action: "deleteDocument" });
}
