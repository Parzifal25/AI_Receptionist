"use server";

import { rejectSecurityAudit } from "@halo/platform/security-audit";
import { failSecurityAudit } from "@halo/platform/security-audit";
import { withAuditedAction } from "@halo/tenancy/audited-action";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { logger } from "@halo/platform/logger";
import type { ActionState } from "@/features/business/actions";

/**
 * D14 FAQ governance (migration 0033). Every create or edit adds an
 * immutable revision pending review; the receptionist answers only from
 * an FAQ revision an owner or admin approved. A client-supplied publish
 * flag is ignored. Logs carry ids only, never question or answer text.
 */

const log = logger.child({ feature: "faqs" });

const faqSchema = z.object({
  question: z.string().trim().min(1, "Question is required").max(500),
  answer: z.string().trim().min(1, "Answer is required").max(4000),
  category: z.string().trim().max(100).default(""),
});
const uuid = z.string().uuid();

const canApprove = (role: string) => role === "owner" || role === "admin";

async function saveRevision(faqId: string | null, formData: FormData): Promise<ActionState> {
  const { businessId } = await requireBusiness();
  const parsed = faqSchema.safeParse({
    question: formData.get("question"),
    answer: formData.get("answer"),
    category: formData.get("category"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("faq_create_revision", {
    p_business_id: businessId,
    p_faq_id: faqId,
    p_question: parsed.data.question,
    p_answer: parsed.data.answer,
    p_category: parsed.data.category,
  });
  if (error) {
    log.error("faq revision create failed", { faqId, error: error.message.slice(0, 200) });
    return { error: "Could not save the FAQ. Please try again." };
  }
  revalidatePath("/dashboard/faqs");
  return { error: null, message: "Saved and sent for review. The receptionist uses it once an owner or admin approves it." };
}

export async function createFaq(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return withAuditedAction(async () => {

    return saveRevision(null, formData);

  }, { action: "createFaq" });
}

export async function updateFaq(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return withAuditedAction(async () => {

    const id = uuid.safeParse(formData.get("id"));
    if (!id.success) return { error: "Invalid FAQ" };
    return saveRevision(id.data, formData);

  }, { action: "updateFaq" });
}

/** Approve (publish) or reject a pending FAQ revision. Owner/admin only. */
export async function reviewFaqRevision(formData: FormData): Promise<void> {
  return withAuditedAction(async () => {

    const { role } = await requireBusiness();
    const revisionId = uuid.safeParse(formData.get("revisionId"));
    if (!canApprove(role) || !revisionId.success) { await rejectSecurityAudit(); return; }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("faq_review_revision", {
      p_revision_id: revisionId.data,
      p_approve: formData.get("decision") === "approve",
  });
  if (error) { await failSecurityAudit(); log.error("faq review failed", { revisionId: revisionId.data, error: error.message.slice(0, 200) }); }
  revalidatePath("/dashboard/faqs");

  }, { action: "reviewFaqRevision" });
}

/** Stop serving an FAQ. Owner/admin only. */
export async function withdrawFaq(formData: FormData): Promise<void> {
  return withAuditedAction(async () => {

    const { role } = await requireBusiness();
    const id = uuid.safeParse(formData.get("id"));
    if (!canApprove(role) || !id.success) { await rejectSecurityAudit(); return; }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("faq_withdraw", { p_faq_id: id.data });
    if (error) { await failSecurityAudit(); log.error("faq withdraw failed", { faqId: id.data, error: error.message.slice(0, 200) }); }
    revalidatePath("/dashboard/faqs");

  }, { action: "withdrawFaq" });
}

/** Delete an unpublished FAQ and its history. Owner/admin only. */
export async function deleteFaq(formData: FormData): Promise<void> {
  return withAuditedAction(async () => {

    const { businessId, role } = await requireBusiness();
    const id = uuid.safeParse(formData.get("id"));
    if (!canApprove(role) || !id.success) { await rejectSecurityAudit(); return; }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.from("faqs").delete().eq("id", id.data).eq("business_id", businessId);
    if (error) { await failSecurityAudit(); log.error("faq delete failed", { faqId: id.data, error: error.message.slice(0, 200) }); }
    revalidatePath("/dashboard/faqs");

  }, { action: "deleteFaq" });
}
