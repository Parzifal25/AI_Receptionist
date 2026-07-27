"use server";

import { revalidatePath } from "next/cache";
import { requireBusiness } from "@/lib/auth";
import {
  lifecycleSettingsSchema,
  parseIntakeFields,
  parseReminderLeadMinutes,
} from "@/core/services/lifecycle/lifecycle-settings";
import { SchedulingRepository } from "@/core/services/scheduling/scheduling-repository";
import { logger } from "@/lib/logger";
import type { ActionState } from "@/features/business/actions";

const log = logger.child({ feature: "lifecycle-settings" });

/** Cap on submitted intake rows — the form itself renders far fewer. */
const MAX_INTAKE_ROWS = 25;

/**
 * Saves the lifecycle content every customer message is built from:
 * directions, prep instructions, the intake form, the review destination,
 * the reminder schedule, and the automatic no-show sweep.
 *
 * The form posts parallel `intakeLabel[]` / `intakeType[]` / `intakeId[]`
 * arrays plus `intakeRequired-<index>` checkboxes (unchecked boxes are
 * simply absent from FormData, so required state is read by index).
 */
export async function updateLifecycleSettings(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { businessId, role } = await requireBusiness();
  if (role === "member") return { error: "Only admins can change settings" };

  const labels = formData.getAll("intakeLabel").slice(0, MAX_INTAKE_ROWS);
  const ids = formData.getAll("intakeId");
  const types = formData.getAll("intakeType");

  const intakeForm = parseIntakeFields(
    labels.map((label, index) => ({
      id: String(ids[index] ?? ""),
      label: String(label ?? ""),
      type: String(types[index] ?? "text"),
      required: formData.get(`intakeRequired-${index}`) === "on",
    })),
  );

  const parsed = lifecycleSettingsSchema.safeParse({
    locationAddress: formData.get("locationAddress") ?? "",
    prepInstructions: formData.get("prepInstructions") ?? "",
    reviewUrl: formData.get("reviewUrl") ?? "",
    intakeForm,
    remindersEnabled: formData.get("remindersEnabled") === "on",
    reminderLeadMinutes: parseReminderLeadMinutes(String(formData.get("reminderLeadMinutes") ?? "")),
    autoNoShowEnabled: formData.get("autoNoShowEnabled") === "on",
    noShowGraceMinutes: Number(formData.get("noShowGraceMinutes") ?? 30),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  // Reminders on with no lead times would silently send nothing — say so
  // rather than saving a schedule that never fires.
  if (parsed.data.remindersEnabled && parsed.data.reminderLeadMinutes.length === 0) {
    return { error: "Add at least one reminder time, or turn reminders off." };
  }

  try {
    await new SchedulingRepository().updateLifecycleSettings(businessId, parsed.data);
  } catch (error) {
    log.error("lifecycle settings save failed", { businessId, error });
    return { error: "Could not save lifecycle settings. Please try again." };
  }

  revalidatePath("/dashboard/settings/lifecycle");
  return { error: null, message: "Customer lifecycle settings saved." };
}
