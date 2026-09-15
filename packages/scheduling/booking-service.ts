import "server-only";
import type { Business } from "@halo/core/domain/types";
import type {
  Appointment,
  AppointmentDraft,
  BusyInterval,
  ReminderChannel,
  SchedulingSettings,
  StaffMember,
  TimeSlot,
} from "@halo/core/domain/scheduling";
import type { MessagingProvider } from "@halo/ports/messaging-provider";
import { generateSlots } from "./availability";
import { assertTransition, isLive } from "./appointment-state";
import { formatInTz } from "./timezone";
import type { WhenWindow } from "./when-parser";
import { SchedulingRepository, SlotTakenError } from "./scheduling-repository";
import { ConfirmationService } from "@halo/lifecycle/confirmation-service";
import { createCalendarProvider } from "@halo/providers/calendar/factory";
import { getMessagingProvider } from "@halo/providers/messaging/factory";
import { emitBusinessEvent, type EmitInput } from "@halo/workflows/event-bus";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "booking" });

export interface AvailabilityResult {
  settings: SchedulingSettings;
  staff: StaffMember[];
  slots: TimeSlot[];
}

export type BookingResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: "slot_taken"; alternatives: TimeSlot[] }
  | { ok: false; reason: "invalid"; message: string };

/**
 * The booking workflow engine: availability → book → confirm → remind, plus
 * reschedule and cancel. Depends only on ports and pure functions; external
 * calendars and messaging degrade gracefully — the appointment row in our
 * database (guarded by the exclusion constraint) is always the source of
 * truth, and a calendar or messaging outage never loses a booking.
 */
export class BookingService {
  constructor(
    private readonly repository: SchedulingRepository = new SchedulingRepository(),
    private readonly messaging: MessagingProvider = getMessagingProvider(),
    private readonly calendarFactory: typeof createCalendarProvider = createCalendarProvider,
    /** Workflow/CRM automation feed; failures are logged, never propagated. */
    private readonly emitEvent: (input: EmitInput) => Promise<void> = emitBusinessEvent,
    confirmations?: ConfirmationService,
  ) {
    this.confirmationsOverride = confirmations ?? null;
  }

  private confirmationsOverride: ConfirmationService | null;

  /** Lazy so tests injecting fakes never touch env-dependent defaults. */
  private get confirmations(): ConfirmationService {
    if (!this.confirmationsOverride) {
      this.confirmationsOverride = new ConfirmationService(this.messaging);
    }
    return this.confirmationsOverride;
  }

  /** Fire-and-forget: automation must never break a booking flow. */
  private emit(input: EmitInput): void {
    void this.emitEvent(input).catch((error) =>
      log.warn("business event emit failed", { type: input.type, error }),
    );
  }

  private appointmentPayload(appointment: Appointment): Record<string, unknown> {
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

  /** Open slots for a business, optionally narrowed to a parsed time window. */
  async getAvailability(params: {
    business: Business;
    window?: WhenWindow | null;
    limit?: number;
    now?: Date;
  }): Promise<AvailabilityResult> {
    const { business, window, limit = 24, now = new Date() } = params;
    const settings = await this.repository.getSettings(business.id);
    const empty: AvailabilityResult = { settings, staff: [], slots: [] };
    if (!settings.bookingEnabled) return empty;

    const staff = await this.repository.listActiveStaff(business.id);
    if (staff.length === 0) return empty;

    const horizonEnd = new Date(now.getTime() + settings.maxAdvanceDays * 86_400_000);
    const fromISO = window?.fromISO ?? now.toISOString();
    const toISO = window?.toISO ?? horizonEnd.toISOString();

    const busyByStaff = await this.collectBusy(business.id, staff, fromISO, toISO);

    const slots = generateSlots({
      settings,
      businessHours: business.businessHours,
      staff,
      busyByStaff,
      fromISO,
      toISO,
      now,
      localHourRange: window?.localHourRange,
      limit,
    });
    return { settings, staff, slots };
  }

  /**
   * Books a slot. The DB exclusion constraint arbitrates concurrent
   * confirmations — on loss, fresh alternatives come back so the AI can
   * recover the conversation instead of dead-ending.
   */
  async book(params: {
    business: Business;
    conversationId: string | null;
    slot: TimeSlot;
    serviceName: string;
    visitorName: string;
    visitorPhone: string;
    visitorEmail: string;
    notes?: string;
    now?: Date;
  }): Promise<BookingResult> {
    const { business, slot, now = new Date() } = params;
    const settings = await this.repository.getSettings(business.id);

    if (!settings.bookingEnabled) {
      return { ok: false, reason: "invalid", message: "Booking is not enabled" };
    }
    if (Date.parse(slot.startsAt) < now.getTime() + settings.minNoticeMinutes * 60_000) {
      return { ok: false, reason: "invalid", message: "That time is no longer available" };
    }
    if (!params.visitorPhone && !params.visitorEmail) {
      return { ok: false, reason: "invalid", message: "A phone number or email is required" };
    }

    const draft: AppointmentDraft = {
      businessId: business.id,
      staffId: slot.staffId,
      conversationId: params.conversationId,
      serviceName: params.serviceName,
      visitorName: params.visitorName,
      visitorPhone: params.visitorPhone,
      visitorEmail: params.visitorEmail,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      timezone: settings.timezone,
      notes: params.notes,
    };

    let appointment: Appointment;
    try {
      appointment = await this.repository.insertAppointment(draft, "confirmed");
    } catch (error) {
      if (error instanceof SlotTakenError) {
        const { slots } = await this.getAvailability({
          business,
          window: {
            fromISO: slot.startsAt,
            toISO: new Date(Date.parse(slot.startsAt) + 7 * 86_400_000).toISOString(),
            label: "alternatives",
          },
          limit: 3,
          now,
        });
        return { ok: false, reason: "slot_taken", alternatives: slots };
      }
      throw error;
    }

    // Everything after the insert is best-effort: the booking exists.
    await this.pushToExternalCalendar(business, appointment).catch((error) =>
      log.warn("external calendar create failed", { appointmentId: appointment.id, error }),
    );
    if (settings.remindersEnabled) {
      await this.scheduleReminders(appointment, settings, now).catch((error) =>
        log.warn("reminder scheduling failed", { appointmentId: appointment.id, error }),
      );
    }
    await this.confirmations
      .sendBookingConfirmation(business, appointment, settings, "created")
      .catch((error) =>
        log.warn("confirmation send failed", { appointmentId: appointment.id, error }),
      );
    await this.repository.trackEvent(business.id, "appointment_booked", {
      appointmentId: appointment.id,
      startsAt: appointment.startsAt,
    });
    this.emit({
      businessId: business.id,
      type: "appointment.created",
      correlationId: appointment.conversationId ?? appointment.id,
      payload: this.appointmentPayload(appointment),
    });

    return { ok: true, appointment };
  }

  /** Moves a live appointment to a new slot. */
  async reschedule(params: {
    business: Business;
    appointment: Appointment;
    slot: TimeSlot;
    now?: Date;
  }): Promise<BookingResult> {
    const { business, appointment, slot, now = new Date() } = params;
    if (!isLive(appointment.status)) {
      return { ok: false, reason: "invalid", message: "This appointment can no longer be changed" };
    }
    const settings = await this.repository.getSettings(business.id);
    if (Date.parse(slot.startsAt) < now.getTime() + settings.minNoticeMinutes * 60_000) {
      return { ok: false, reason: "invalid", message: "That time is no longer available" };
    }

    const previous = formatInTz(appointment.startsAt, appointment.timezone);
    try {
      await this.repository.updateAppointmentTimes(
        appointment.id,
        slot.startsAt,
        slot.endsAt,
        slot.staffId,
        `Rescheduled from ${previous}.`,
      );
    } catch (error) {
      if (error instanceof SlotTakenError) {
        const { slots } = await this.getAvailability({ business, limit: 3, now });
        return { ok: false, reason: "slot_taken", alternatives: slots };
      }
      throw error;
    }

    const updated: Appointment = {
      ...appointment,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      staffId: slot.staffId,
    };

    await this.syncExternalCalendar(business, updated).catch((error) =>
      log.warn("external calendar update failed", { appointmentId: appointment.id, error }),
    );
    await this.repository.cancelReminders(appointment.id);
    if (settings.remindersEnabled) {
      await this.scheduleReminders(updated, settings, now).catch(() => {});
    }
    await this.confirmations
      .sendBookingConfirmation(business, updated, settings, "rescheduled")
      .catch(() => {});
    await this.repository.trackEvent(business.id, "appointment_rescheduled", {
      appointmentId: appointment.id,
    });
    this.emit({
      businessId: business.id,
      type: "appointment.rescheduled",
      correlationId: updated.conversationId ?? updated.id,
      payload: this.appointmentPayload(updated),
    });

    return { ok: true, appointment: updated };
  }

  /** Cancels a live appointment and releases its slot. */
  async cancel(params: {
    business: Business;
    appointment: Appointment;
    reason?: string;
  }): Promise<{ ok: boolean }> {
    const { business, appointment } = params;
    assertTransition(appointment.status, "cancelled");
    const settings = await this.repository.getSettings(business.id);

    await this.repository.updateAppointmentStatus(
      appointment.id,
      "cancelled",
      params.reason ? `Cancelled: ${params.reason}` : "Cancelled by visitor.",
    );
    await this.removeFromExternalCalendar(business, appointment).catch((error) =>
      log.warn("external calendar delete failed", { appointmentId: appointment.id, error }),
    );
    await this.repository.cancelReminders(appointment.id);
    await this.confirmations.sendCancellation(business, appointment, settings).catch(() => {});
    await this.repository.trackEvent(business.id, "appointment_cancelled", {
      appointmentId: appointment.id,
    });
    this.emit({
      businessId: business.id,
      type: "appointment.cancelled",
      correlationId: appointment.conversationId ?? appointment.id,
      payload: this.appointmentPayload(appointment),
    });
    return { ok: true };
  }

  // --- Internals -------------------------------------------------------------

  private async collectBusy(
    businessId: string,
    staff: StaffMember[],
    fromISO: string,
    toISO: string,
  ): Promise<Map<string, BusyInterval[]>> {
    const busy = await this.repository.listInternalBusy(businessId, fromISO, toISO);

    // External calendars add busy time on top of our own appointments. A
    // provider outage degrades to internal-only rather than blocking booking.
    await Promise.all(
      staff
        .filter((s) => s.calendarProvider !== "internal")
        .map(async (member) => {
          try {
            const connection = await this.repository.getCalendarConnection(businessId, member.id);
            if (!connection) return;
            const provider = this.calendarFactory(connection);
            const external = await provider.listBusy(
              member.calendarRef || connection.calendarRef,
              fromISO,
              toISO,
            );
            busy.set(member.id, [...(busy.get(member.id) ?? []), ...external]);
          } catch (error) {
            log.warn("external busy fetch failed, using internal only", {
              staffId: member.id,
              error,
            });
          }
        }),
    );
    return busy;
  }

  private async calendarFor(
    business: Business,
    appointment: Appointment,
  ): Promise<{ provider: ReturnType<typeof createCalendarProvider>; calendarRef: string } | null> {
    const connection = await this.repository.getCalendarConnection(
      business.id,
      appointment.staffId,
    );
    if (!connection) return null;
    return { provider: this.calendarFactory(connection), calendarRef: connection.calendarRef };
  }

  private eventInput(business: Business, appointment: Appointment) {
    return {
      title: `${appointment.serviceName || "Appointment"} — ${appointment.visitorName || "visitor"}`,
      description: [
        `Booked by the ${business.name} AI receptionist.`,
        appointment.visitorName && `Name: ${appointment.visitorName}`,
        appointment.visitorPhone && `Phone: ${appointment.visitorPhone}`,
        appointment.visitorEmail && `Email: ${appointment.visitorEmail}`,
        appointment.notes && `Notes: ${appointment.notes}`,
      ]
        .filter(Boolean)
        .join("\n"),
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      timezone: appointment.timezone,
      attendeeName: appointment.visitorName || undefined,
      attendeeEmail: appointment.visitorEmail || undefined,
    };
  }

  private async pushToExternalCalendar(business: Business, appointment: Appointment): Promise<void> {
    const calendar = await this.calendarFor(business, appointment);
    if (!calendar) return;
    const externalId = await calendar.provider.createEvent(
      calendar.calendarRef,
      this.eventInput(business, appointment),
    );
    if (externalId) await this.repository.setExternalEventId(appointment.id, externalId);
  }

  private async syncExternalCalendar(business: Business, appointment: Appointment): Promise<void> {
    if (!appointment.externalEventId) {
      return this.pushToExternalCalendar(business, appointment);
    }
    const calendar = await this.calendarFor(business, appointment);
    if (!calendar) return;
    await calendar.provider.updateEvent(
      calendar.calendarRef,
      appointment.externalEventId,
      this.eventInput(business, appointment),
    );
  }

  private async removeFromExternalCalendar(
    business: Business,
    appointment: Appointment,
  ): Promise<void> {
    if (!appointment.externalEventId) return;
    const calendar = await this.calendarFor(business, appointment);
    if (!calendar) return;
    await calendar.provider.deleteEvent(calendar.calendarRef, appointment.externalEventId);
  }

  private async scheduleReminders(
    appointment: Appointment,
    settings: SchedulingSettings,
    now: Date,
  ): Promise<void> {
    const channel: ReminderChannel = appointment.visitorPhone ? "sms" : "email";
    const to = appointment.visitorPhone || appointment.visitorEmail;
    if (!to) return;

    const rows = settings.reminderLeadMinutes
      .map((lead) => new Date(Date.parse(appointment.startsAt) - lead * 60_000))
      .filter((sendAt) => sendAt.getTime() > now.getTime())
      .map((sendAt) => ({
        appointmentId: appointment.id,
        businessId: appointment.businessId,
        channel,
        sendAt: sendAt.toISOString(),
      }));
    await this.repository.scheduleReminders(rows);
  }

}
