import "server-only";
import type { Business } from "@halo/core/domain/types";
import type { Appointment, AppointmentStatus } from "@halo/core/domain/scheduling";
import {
  assertTransition,
  TERMINAL_STATUSES,
} from "@halo/scheduling/appointment-state";
import { SchedulingRepository } from "@halo/scheduling/scheduling-repository";
import { ConfirmationService } from "./confirmation-service";
import { emitBusinessEvent, type EmitInput } from "@halo/workflows/event-bus";
import type { BusinessEventType } from "@halo/core/domain/workflow";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "lifecycle" });

/** Day-of statuses staff/visitors can move an appointment into, with copy. */
const STATUS_NOTES: Partial<Record<AppointmentStatus, string>> = {
  checked_in: "Visitor checked in.",
  running_late: "Visitor is running late.",
  in_progress: "Appointment in progress.",
  completed: "Appointment completed.",
  no_show: "Visitor did not show up.",
};

/** Status → business event the automation platform reacts to. */
const STATUS_EVENTS: Partial<Record<AppointmentStatus, BusinessEventType>> = {
  checked_in: "appointment.checked_in",
  completed: "appointment.completed",
  no_show: "appointment.no_show",
};

/** Status → usage_events row feeding lifecycle analytics. */
const STATUS_ANALYTICS: Partial<
  Record<AppointmentStatus, "appointment_checked_in" | "appointment_completed" | "appointment_no_show">
> = {
  checked_in: "appointment_checked_in",
  completed: "appointment_completed",
  no_show: "appointment_no_show",
};

export function appointmentEventPayload(appointment: Appointment): Record<string, unknown> {
  return {
    appointmentId: appointment.id,
    serviceName: appointment.serviceName,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    timezone: appointment.timezone,
    staffId: appointment.staffId,
    visitorName: appointment.visitorName,
    visitorPhone: appointment.visitorPhone,
    visitorEmail: appointment.visitorEmail,
    conversationId: appointment.conversationId,
  };
}

/**
 * During-appointment tracking and the post-appointment kickoff. Moves an
 * appointment through the day-of state machine (checked in, running late,
 * in progress, completed, no show), cancels pending reminders when the
 * outcome is settled, sends the thank-you on completion, and emits the
 * business events the workflow platform's review/follow-up/rebook journeys
 * trigger on. Everything after the status write is best-effort.
 */
export class AppointmentLifecycleService {
  constructor(
    private readonly repository: SchedulingRepository = new SchedulingRepository(),
    confirmations?: ConfirmationService,
    private readonly emitEvent: (input: EmitInput) => Promise<void> = emitBusinessEvent,
  ) {
    this.confirmationsOverride = confirmations ?? null;
  }

  private confirmationsOverride: ConfirmationService | null;

  private get confirmations(): ConfirmationService {
    if (!this.confirmationsOverride) this.confirmationsOverride = new ConfirmationService();
    return this.confirmationsOverride;
  }

  /**
   * Moves an appointment to a new day-of status. Throws AppError.conflict
   * when the transition is not legal from the current status.
   */
  async transition(
    business: Business,
    appointment: Appointment,
    to: AppointmentStatus,
  ): Promise<Appointment> {
    assertTransition(appointment.status, to);
    await this.repository.updateAppointmentStatus(appointment.id, to, STATUS_NOTES[to] ?? "");
    const updated: Appointment = { ...appointment, status: to };

    if (TERMINAL_STATUSES.includes(to)) {
      await this.repository.cancelReminders(appointment.id);
    }

    const analytics = STATUS_ANALYTICS[to];
    if (analytics) {
      await this.repository
        .trackEvent(business.id, analytics, { appointmentId: appointment.id })
        .catch((error) => log.warn("lifecycle analytics failed", { error }));
    }

    if (to === "completed") {
      const settings = await this.repository.getSettings(business.id);
      await this.confirmations
        .sendThankYou(business, updated, settings)
        .catch((error) => log.warn("thank-you send failed", { appointmentId: appointment.id, error }));
    }

    const eventType = STATUS_EVENTS[to];
    if (eventType) {
      void this.emitEvent({
        businessId: business.id,
        type: eventType,
        correlationId: updated.conversationId ?? updated.id,
        payload: appointmentEventPayload(updated),
      }).catch((error) => log.warn("lifecycle event emit failed", { type: eventType, error }));
    }

    return updated;
  }
}
