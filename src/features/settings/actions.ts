"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
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
  const { businessId, role } = await requireBusiness();
  if (role === "member") return { error: "Only admins can change settings" };

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
}
