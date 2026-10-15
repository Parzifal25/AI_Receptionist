"use server";

import { failSecurityAudit } from "@halo/platform/security-audit";
import { withAuditedAction } from "@halo/tenancy/audited-action";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { logger } from "@halo/platform/logger";

const log = logger.child({ feature: "leads" });

export async function updateLeadStatus(formData: FormData): Promise<void> {
  return withAuditedAction(async () => {

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
    if (error) { await failSecurityAudit(); log.error("lead status update failed", { error: error.message }); }

    revalidatePath("/dashboard/leads");

  }, { action: "updateLeadStatus" });
}

export async function deleteLead(formData: FormData): Promise<void> {
  return withAuditedAction(async () => {

    const { businessId } = await requireBusiness();
    const id = z.string().uuid().parse(formData.get("id"));

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase
      .from("leads")
      .delete()
      .eq("id", id)
      .eq("business_id", businessId);
    if (error) { await failSecurityAudit(); log.error("lead delete failed", { error: error.message }); }

    revalidatePath("/dashboard/leads");

  }, { action: "deleteLead" });
}
