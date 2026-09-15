"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBusiness } from "@halo/tenancy/auth";
import { AppointmentLifecycleService } from "@halo/lifecycle/lifecycle-service";
import { loadBusinessById } from "@halo/lifecycle/manage-service";
import { SchedulingRepository } from "@halo/scheduling/scheduling-repository";
import { logger } from "@halo/platform/logger";

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
