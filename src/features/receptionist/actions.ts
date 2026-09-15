"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { logger } from "@halo/platform/logger";
import type { ActionState } from "@/features/business/actions";

const log = logger.child({ feature: "receptionist" });

const configSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(80),
  greeting: z.string().trim().min(1, "Greeting is required").max(500),
  tone: z.enum(["friendly", "professional", "casual", "formal"]),
  language: z.string().trim().min(2).max(10),
  customInstructions: z.string().trim().max(4000).default(""),
  isActive: z.boolean(),
  leadCaptureEnabled: z.boolean(),
  voiceEnabled: z.boolean(),
  theme: z.enum(["light", "dark", "auto"]),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a valid color"),
  position: z.enum(["bottom-right", "bottom-left"]),
  launcherLabel: z.string().trim().min(1).max(40),
});

export async function updateReceptionist(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { businessId } = await requireBusiness();

  const parsed = configSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    greeting: formData.get("greeting"),
    tone: formData.get("tone"),
    language: formData.get("language"),
    customInstructions: formData.get("customInstructions"),
    isActive: formData.get("isActive") === "on",
    leadCaptureEnabled: formData.get("leadCaptureEnabled") === "on",
    voiceEnabled: formData.get("voiceEnabled") === "on",
    theme: formData.get("theme"),
    primaryColor: formData.get("primaryColor"),
    position: formData.get("position"),
    launcherLabel: formData.get("launcherLabel"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { id, theme, primaryColor, position, launcherLabel, ...fields } = parsed.data;

  const supabase = await createSupabaseServerClient();
  // RLS restricts the update to receptionists in the user's business; the
  // explicit business_id filter is defense in depth.
  const { error } = await supabase
    .from("receptionists")
    .update({
      name: fields.name,
      greeting: fields.greeting,
      tone: fields.tone,
      language: fields.language,
      custom_instructions: fields.customInstructions,
      is_active: fields.isActive,
      lead_capture_enabled: fields.leadCaptureEnabled,
      voice_enabled: fields.voiceEnabled,
      branding: { theme, primaryColor, position, launcherLabel },
    })
    .eq("id", id)
    .eq("business_id", businessId);

  if (error) {
    log.error("receptionist update failed", { error: error.message });
    return { error: "Could not save changes. Please try again." };
  }

  revalidatePath("/dashboard/receptionist");
  return { error: null, message: "Receptionist updated." };
}
