"use server";

import { rejectSecurityAudit } from "@halo/platform/security-audit";
import { failSecurityAudit } from "@halo/platform/security-audit";
import { withAuditedAction } from "@halo/tenancy/audited-action";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { logger } from "@halo/platform/logger";
import type { ActionState } from "@/features/business/actions";

const log = logger.child({ feature: "settings" });

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const settingsSchema = z.object({
  allowedDomains: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(/[\n,]/)
        .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .filter(Boolean),
    )
    .refine((domains) => domains.every((d) => DOMAIN_RE.test(d)), {
      message: "One or more domains are invalid — use the form example.com",
    })
    .refine((domains) => domains.length <= 20, { message: "Maximum 20 domains" }),
  notifyOnLead: z.boolean(),
  notificationEmail: z
    .string()
    .trim()
    .email("Enter a valid email")
    .max(254)
    .or(z.literal(""))
    .default(""),
});

export async function updateSettings(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withAuditedAction(async () => {

    const { businessId, role } = await requireBusiness();
    if (role === "member") { await rejectSecurityAudit(); return { error: "Only admins can change settings" }; }

    const parsed = settingsSchema.safeParse({
      allowedDomains: formData.get("allowedDomains"),
      notifyOnLead: formData.get("notifyOnLead") === "on",
      notificationEmail: formData.get("notificationEmail"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("business_settings")
    .update({
      allowed_domains: parsed.data.allowedDomains,
      notify_on_lead: parsed.data.notifyOnLead,
      notification_email: parsed.data.notificationEmail,
    })
    .eq("business_id", businessId);

  if (error) {
    log.error("settings update failed", { error: error.message });
    return { error: "Could not save settings. Please try again." };
  }

  revalidatePath("/dashboard/settings");
  return { error: null, message: "Settings saved." };

  }, { action: "updateSettings" });
}

/**
 * Removes the business-level Google Calendar connection. Goes through the
 * service role because calendar_connections holds OAuth tokens and has no
 * RLS policies by design — tenant scoping happens here.
 */
export async function disconnectGoogleCalendar(): Promise<void> {
  return withAuditedAction(async () => {

    const { businessId, role } = await requireBusiness();
    if (role === "member") { await rejectSecurityAudit(); return; }

    const { error } = await getAdminClient()
      .from("calendar_connections")
      .delete()
      .eq("business_id", businessId)
      .eq("provider", "google")
      .is("staff_id", null);
    if (error) {
      await failSecurityAudit();
      log.error("calendar disconnect failed", { error: error.message });
    }
    revalidatePath("/dashboard/settings");

  }, { action: "disconnectGoogleCalendar" });
}
