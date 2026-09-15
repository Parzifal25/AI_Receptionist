import { BookingService } from "@halo/scheduling/booking-service";
import { ConfirmationService } from "@halo/lifecycle/confirmation-service";
import {
  SlotTakenError,
  type SchedulingRepository,
} from "@halo/scheduling/scheduling-repository";
import { ACTIVE_STATUSES } from "@halo/scheduling/appointment-state";
import type { BookingDraft } from "@halo/scheduling/booking-draft";
import type {
  Appointment,
  AppointmentDraft,
  AppointmentStatus,
  BusyInterval,
  SchedulingSettings,
  StaffMember,
} from "@halo/core/domain/scheduling";
import type { MessagingProvider, OutboundMessage } from "@halo/ports/messaging-provider";

/**
 * The scheduling engine, in memory. Faithfully simulates the two things
 * production leans on: the Postgres exclusion constraint (overlapping live
 * appointments per staff member raise SlotTakenError) and the booking-draft
 * store. Everything else — calendars, messaging — is a recorder.
 *
 * Shared by the booking-service tests and the end-to-end conversation
 * tests, so both exercise the same behaviour.
 */

export const DEFAULT_NOW = new Date("2026-07-13T12:00:00Z"); // Monday 8am ET

export interface SchedulingFakeOptions {
  bookingEnabled?: boolean;
  settings?: Partial<SchedulingSettings>;
  staff?: StaffMember[];
  now?: Date;
}

export function createSchedulingFakes(options: SchedulingFakeOptions = {}) {
  const now = options.now ?? DEFAULT_NOW;
  const settings: SchedulingSettings = {
    businessId: "b1",
    bookingEnabled: options.bookingEnabled ?? true,
    timezone: "America/New_York",
    slotDurationMinutes: 60,
    bufferMinutes: 0,
    minNoticeMinutes: 120,
    maxAdvanceDays: 14,
    holidays: [],
    remindersEnabled: true,
    reminderLeadMinutes: [24 * 60, 60],
    locationAddress: "12 Main St, Springfield",
    prepInstructions: "Please clear access to the unit.",
    intakeForm: [],
    reviewUrl: "",
    autoNoShowEnabled: false,
    noShowGraceMinutes: 30,
    ...options.settings,
  };

  const staff: StaffMember[] = options.staff ?? [
    {
      id: "s1",
      businessId: "b1",
      name: "Alex",
      role: "",
      workingHours: null,
      isActive: true,
      calendarProvider: "internal",
      calendarRef: "",
    },
  ];

  const appointments: Appointment[] = [];
  const reminders: Array<{ appointmentId: string; sendAt: string; status: string }> = [];
  const events: string[] = [];
  const drafts = new Map<string, BookingDraft>();
  let idCounter = 0;

  const isActive = (status: AppointmentStatus) => ACTIVE_STATUSES.includes(status);

  const overlapsLive = (staffId: string, startsAt: string, endsAt: string, exceptId?: string) =>
    appointments.some(
      (a) =>
        a.staffId === staffId &&
        a.id !== exceptId &&
        isActive(a.status) &&
        Date.parse(a.startsAt) < Date.parse(endsAt) &&
        Date.parse(a.endsAt) > Date.parse(startsAt),
    );

  const repository = {
    async getSettings() {
      return settings;
    },
    async listActiveStaff() {
      return staff;
    },
    async listInternalBusy(_b: string, fromISO: string, toISO: string) {
      const map = new Map<string, BusyInterval[]>();
      for (const a of appointments) {
        if (!isActive(a.status)) continue;
        if (Date.parse(a.startsAt) >= Date.parse(toISO)) continue;
        if (Date.parse(a.endsAt) <= Date.parse(fromISO)) continue;
        map.set(a.staffId, [...(map.get(a.staffId) ?? []), { start: a.startsAt, end: a.endsAt }]);
      }
      return map;
    },
    async insertAppointment(draft: AppointmentDraft, status: AppointmentStatus) {
      if (overlapsLive(draft.staffId, draft.startsAt, draft.endsAt)) throw new SlotTakenError();
      idCounter += 1;
      const appointment: Appointment = {
        id: `a${idCounter}`,
        leadId: null,
        externalEventId: "",
        manageToken: `00000000-0000-4000-8000-00000000000${idCounter}`,
        notes: draft.notes ?? "",
        createdAt: now.toISOString(),
        status,
        businessId: draft.businessId,
        staffId: draft.staffId,
        conversationId: draft.conversationId,
        serviceName: draft.serviceName,
        visitorName: draft.visitorName,
        visitorPhone: draft.visitorPhone,
        visitorEmail: draft.visitorEmail,
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
        timezone: draft.timezone,
      };
      appointments.push(appointment);
      return appointment;
    },
    async getAppointment(id: string) {
      return appointments.find((a) => a.id === id) ?? null;
    },
    async getAppointmentByToken(manageToken: string) {
      return appointments.find((a) => a.manageToken === manageToken) ?? null;
    },
    async findLiveAppointmentByConversation(conversationId: string) {
      return (
        appointments.find((a) => a.conversationId === conversationId && isActive(a.status)) ?? null
      );
    },
    async updateAppointmentStatus(id: string, status: AppointmentStatus) {
      const a = appointments.find((x) => x.id === id);
      if (a) a.status = status;
    },
    async updateAppointmentTimes(
      id: string,
      startsAt: string,
      endsAt: string,
      staffId: string,
      noteSuffix = "",
    ) {
      if (overlapsLive(staffId, startsAt, endsAt, id)) throw new SlotTakenError();
      const a = appointments.find((x) => x.id === id);
      if (a) Object.assign(a, { startsAt, endsAt, staffId, notes: `${a.notes}\n${noteSuffix}`.trim() });
    },
    async setExternalEventId() {},
    async scheduleReminders(rows: Array<{ appointmentId: string; sendAt: string }>) {
      reminders.push(...rows.map((r) => ({ ...r, status: "scheduled" })));
    },
    async cancelReminders(appointmentId: string) {
      for (const r of reminders) {
        if (r.appointmentId === appointmentId && r.status === "scheduled") r.status = "cancelled";
      }
    },
    async getCalendarConnection() {
      return null;
    },
    async getBookingDraft(conversationId: string) {
      return drafts.get(conversationId) ?? null;
    },
    async saveBookingDraft(_businessId: string, conversationId: string, draft: BookingDraft) {
      drafts.set(conversationId, { ...draft });
    },
    async clearBookingDraft(conversationId: string) {
      drafts.delete(conversationId);
    },
    async trackEvent(_b: string, event: string) {
      events.push(event);
    },
  } as unknown as SchedulingRepository;

  const sent: OutboundMessage[] = [];
  const messaging: MessagingProvider = {
    name: "fake",
    supports: () => true,
    async send(message) {
      sent.push(message);
    },
  };

  // Recorded business events — bookings feed the workflow/CRM platform.
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const service = new BookingService(
    repository,
    messaging,
    undefined,
    async (input) => {
      emitted.push({ type: input.type, payload: input.payload });
    },
    new ConfirmationService(messaging, "http://app.test"),
  );

  return { repository, service, settings, staff, appointments, reminders, drafts, sent, events, emitted };
}
