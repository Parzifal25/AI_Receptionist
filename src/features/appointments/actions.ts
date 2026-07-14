"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@/lib/auth";
import { AppointmentLifecycleService } from "@/core/services/lifecycle/lifecycle-service";
import { loadBusinessById } from "@/core/services/lifecycle/manage-service";
import { SchedulingRepository } from "@/core/services/scheduling/scheduling-repository";
import { logger } from "@/lib/logger";

const log = logger.child({ feature: "appointments" });

const statusSchema = z.enum([
  "checked_in",
  "running_late",
  "in_progress",
  "completed",
  "no_show",
  "cancelled",
]);

/**
 * Staff-side day-of tracking: move an appointment through the lifecycle
 * state machine from the dashboard board.
 */
export async function updateAppointmentLifecycle(formData: FormData): Promise<void> {
  const { businessId } = await requireBusiness();
  const id = z.string().uuid().parse(formData.get("id"));
  const status = statusSchema.parse(formData.get("status"));

  const repository = new SchedulingRepository();
  const appointment = await repository.getAppointment(id);
  if (!appointment || appointment.businessId !== businessId) {
    log.warn("appointment not found or foreign", { id });
    return;
  }
  const business = await loadBusinessById(businessId);
  if (!business) return;

  try {
    await new AppointmentLifecycleService(repository).transition(business, appointment, status);
  } catch (error) {
    // Illegal transition (stale board) — nothing to do but log.
    log.warn("lifecycle transition rejected", { id, status, error });
  }

  revalidatePath("/dashboard/appointments");
}
