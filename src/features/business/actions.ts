"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness, requireUser } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { logger } from "@halo/platform/logger";

const log = logger.child({ feature: "business" });

export interface ActionState {
  error: string | null;
  message?: string | null;
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const onboardingSchema = z.object({
  name: z.string().trim().min(1, "Business name is required").max(120),
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : `business-${suffix}`;
}

export async function createBusiness(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireUser();
  const parsed = onboardingSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("create_business_with_owner", {
    business_name: parsed.data.name,
    business_slug: slugify(parsed.data.name),
  });

  if (error) {
    log.error("business creation failed", { error: error.message });
    return { error: "Could not create your business. Please try again." };
  }

  redirect("/dashboard");
}

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------

const hoursEntry = z.object({
  open: z.string().regex(/^\d{2}:\d{2}$/).catch("09:00"),
  close: z.string().regex(/^\d{2}:\d{2}$/).catch("17:00"),
  closed: z.boolean(),
});

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const profileSchema = z.object({
  name: z.string().trim().min(1, "Business name is required").max(120),
  description: z.string().trim().max(2000).default(""),
  industry: z.string().trim().max(100).default(""),
  website: z.string().trim().url("Enter a valid website URL").max(500).or(z.literal("")).default(""),
  phone: z.string().trim().max(30).default(""),
  email: z.string().trim().email("Enter a valid email").max(254).or(z.literal("")).default(""),
  address: z.string().trim().max(500).default(""),
});

export async function updateBusinessProfile(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { businessId } = await requireBusiness();

  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    industry: formData.get("industry"),
    website: formData.get("website"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    address: formData.get("address"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const businessHours: Record<string, z.infer<typeof hoursEntry>> = {};
  for (const day of WEEKDAYS) {
    businessHours[day] = hoursEntry.parse({
      open: formData.get(`hours_${day}_open`) || "09:00",
      close: formData.get(`hours_${day}_close`) || "17:00",
      closed: formData.get(`hours_${day}_closed`) === "on",
    });
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("businesses")
    .update({ ...parsed.data, business_hours: businessHours })
    .eq("id", businessId);

  if (error) {
    log.error("profile update failed", { error: error.message });
    return { error: "Could not save changes. Please try again." };
  }

  revalidatePath("/dashboard/profile");
  return { error: null, message: "Profile saved." };
}
