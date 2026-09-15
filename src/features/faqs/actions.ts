"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { logger } from "@halo/platform/logger";
import type { ActionState } from "@/features/business/actions";

const log = logger.child({ feature: "faqs" });

const faqSchema = z.object({
  question: z.string().trim().min(1, "Question is required").max(500),
  answer: z.string().trim().min(1, "Answer is required").max(4000),
  category: z.string().trim().max(100).default(""),
});

export async function createFaq(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { businessId } = await requireBusiness();
  const parsed = faqSchema.safeParse({
    question: formData.get("question"),
    answer: formData.get("answer"),
    category: formData.get("category"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("faqs")
    .insert({ business_id: businessId, ...parsed.data });

  if (error) {
    log.error("faq insert failed", { error: error.message });
    return { error: "Could not add the FAQ. Please try again." };
  }

  revalidatePath("/dashboard/faqs");
  return { error: null, message: "FAQ added." };
}

export async function updateFaq(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { businessId } = await requireBusiness();
  const idResult = z.string().uuid().safeParse(formData.get("id"));
  const parsed = faqSchema.safeParse({
    question: formData.get("question"),
    answer: formData.get("answer"),
    category: formData.get("category"),
  });
  if (!idResult.success) return { error: "Invalid FAQ" };
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("faqs")
    .update(parsed.data)
    .eq("id", idResult.data)
    .eq("business_id", businessId);

  if (error) {
    log.error("faq update failed", { error: error.message });
    return { error: "Could not save changes. Please try again." };
  }

  revalidatePath("/dashboard/faqs");
  return { error: null, message: "FAQ updated." };
}

export async function toggleFaqPublished(formData: FormData): Promise<void> {
  const { businessId } = await requireBusiness();
  const id = z.string().uuid().parse(formData.get("id"));
  const publish = formData.get("publish") === "true";

  const supabase = await createSupabaseServerClient();
  await supabase
    .from("faqs")
    .update({ is_published: publish })
    .eq("id", id)
    .eq("business_id", businessId);

  revalidatePath("/dashboard/faqs");
}

export async function deleteFaq(formData: FormData): Promise<void> {
  const { businessId } = await requireBusiness();
  const id = z.string().uuid().parse(formData.get("id"));

  const supabase = await createSupabaseServerClient();
  await supabase.from("faqs").delete().eq("id", id).eq("business_id", businessId);

  revalidatePath("/dashboard/faqs");
}
