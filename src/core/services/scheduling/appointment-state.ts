import type { AppointmentStatus } from "@/core/domain/scheduling";
import { AppError } from "@/core/errors/app-error";

/**
 * Appointment state machine.
 *
 *   pending ──► confirmed ──► completed
 *      │            │─────► no_show
 *      └────────────┴─────► cancelled
 *
 * `cancelled`, `completed` and `no_show` are terminal. Rescheduling is a
 * time change on a live (pending/confirmed) appointment, not a state — the
 * record keeps its status and history lands in `notes`.
 */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled", "no_show"],
  cancelled: [],
  completed: [],
  no_show: [],
};

/** Statuses that hold their time slot (drive conflict detection). */
export const ACTIVE_STATUSES: AppointmentStatus[] = ["pending", "confirmed"];

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (!canTransition(from, to)) {
    throw AppError.conflict(`Cannot move appointment from ${from} to ${to}`);
  }
}

/** Whether an appointment can still be rescheduled or cancelled. */
export function isLive(status: AppointmentStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}
