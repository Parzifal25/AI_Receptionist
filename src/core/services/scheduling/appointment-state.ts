import type { AppointmentStatus } from "@/core/domain/scheduling";
import { AppError } from "@/core/errors/app-error";

/**
 * Appointment state machine, covering the full day-of lifecycle.
 *
 *   pending ──► confirmed ──► running_late ─┐
 *      │            │──────► checked_in ◄───┤
 *      │            │             │         │
 *      │            │             ▼         │
 *      │            │──────► in_progress ◄──┘
 *      │            │             │
 *      │            ├────────────►├──► completed
 *      │            ├──► no_show  │
 *      └────────────┴─────────────┴──► cancelled
 *
 * `cancelled`, `completed` and `no_show` are terminal. Rescheduling is a
 * time change on a live (pending/confirmed/running_late) appointment, not a
 * state — the record keeps its status and history lands in `notes`.
 */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["checked_in", "running_late", "in_progress", "completed", "cancelled", "no_show"],
  running_late: ["checked_in", "in_progress", "completed", "cancelled", "no_show"],
  checked_in: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  cancelled: [],
  completed: [],
  no_show: [],
};

/** Statuses that hold their time slot (drive conflict detection). */
export const ACTIVE_STATUSES: AppointmentStatus[] = [
  "pending",
  "confirmed",
  "checked_in",
  "running_late",
  "in_progress",
];

/** Terminal statuses — nothing further can happen to the appointment. */
export const TERMINAL_STATUSES: AppointmentStatus[] = ["cancelled", "completed", "no_show"];

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (!canTransition(from, to)) {
    throw AppError.conflict(`Cannot move appointment from ${from} to ${to}`);
  }
}

/**
 * Whether an appointment can still be rescheduled or cancelled by the
 * visitor. Once someone is checked in or being seen, changes are staff-side.
 */
export function isLive(status: AppointmentStatus): boolean {
  return status === "pending" || status === "confirmed" || status === "running_late";
}

/** Whether the visit is underway (day-of tracking states). */
export function isInFlight(status: AppointmentStatus): boolean {
  return status === "checked_in" || status === "running_late" || status === "in_progress";
}
