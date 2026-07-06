"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const log = logger.child({ feature: "leads" });

export async function updateLeadStatus(formData: FormData): Promise<void> {
  const { businessId } = await requireBusiness();
  const id = z.string().uuid().parse(formData.get("id"));
  const status = z
    .enum(["new", "contacted", "qualified", "closed"])
    .parse(formData.get("status"));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("leads")
    .update({ status })
    .eq("id", id)
    .eq("business_id", businessId);
  if (error) log.error("lead status update failed", { error: error.message });

  revalidatePath("/dashboard/leads");
}

export async function deleteLead(formData: FormData): Promise<void> {
  const { businessId } = await requireBusiness();
  const id = z.string().uuid().parse(formData.get("id"));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("leads")
    .delete()
    .eq("id", id)
    .eq("business_id", businessId);
  if (error) log.error("lead delete failed", { error: error.message });

  revalidatePath("/dashboard/leads");
}
