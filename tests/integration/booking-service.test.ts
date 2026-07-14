import { describe, expect, it } from "vitest";
import { BookingService } from "@/core/services/scheduling/booking-service";
import { ConfirmationService } from "@/core/services/lifecycle/confirmation-service";
import { SlotTakenError, type SchedulingRepository } from "@/core/services/scheduling/scheduling-repository";
import type {
  Appointment,
  AppointmentDraft,
  AppointmentStatus,
  BusyInterval,
  SchedulingSettings,
  StaffMember,
  TimeSlot,
} from "@/core/domain/scheduling";
import type { MessagingProvider, OutboundMessage } from "@/core/ports/messaging-provider";
import type { Business } from "@/core/domain/types";

/**
 * Booking workflow against an in-memory repository that faithfully simulates
 * the Postgres exclusion constraint — overlapping live appointments per
 * staff member are rejected with SlotTakenError, exactly like production.
 */

const NOW = new Date("2026-07-13T12:00:00Z"); // Monday 8am ET
const SLOT_9AM: TimeSlot = {
  staffId: "s1",
  staffName: "Alex",
  startsAt: "2026-07-14T13:00:00.000Z",
  endsAt: "2026-07-14T14:00:00.000Z",
};

const business: Business = {
  id: "b1",
  name: "Cool Air HVAC",
  slug: "cool-air",
  description: "Heating and cooling",
  industry: "HVAC",
  website: "",
  phone: "+1 555 0199",
  email: "",
  address: "",
  businessHours: {
    mon: { open: "09:00", close: "17:00", closed: false },
    tue: { open: "09:00", close: "17:00", closed: false },
    wed: { open: "09:00", close: "17:00", closed: false },
  },
  logoUrl: "",
};

function buildFakes(options: { bookingEnabled?: boolean } = {}) {
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
  };
  const staff: StaffMember[] = [
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
  let idCounter = 0;

  const overlapsLive = (staffId: string, startsAt: string, endsAt: string, exceptId?: string) =>
    appointments.some(
      (a) =>
        a.staffId === staffId &&
        a.id !== exceptId &&
        ["pending", "confirmed"].includes(a.status) &&
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
        if (!["pending", "confirmed"].includes(a.status)) continue;
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
        createdAt: NOW.toISOString(),
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
    async findLiveAppointmentByConversation(conversationId: string) {
      return (
        appointments.find(
          (a) => a.conversationId === conversationId && ["pending", "confirmed"].includes(a.status),
        ) ?? null
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
  return { service, appointments, reminders, sent, events, emitted, repository };
}

const visitor = {
  serviceName: "AC servicing",
  visitorName: "Sam",
  visitorPhone: "+1 555 0100",
  visitorEmail: "",
};

describe("BookingService", () => {
  it("returns real open slots and none when booking is disabled", async () => {
    const enabled = await buildFakes().service.getAvailability({ business, now: NOW });
    expect(enabled.slots.length).toBeGreaterThan(0);

    const disabled = await buildFakes({ bookingEnabled: false }).service.getAvailability({
      business,
      now: NOW,
    });
    expect(disabled.slots).toHaveLength(0);
  });

  it("books a slot, schedules reminders, sends confirmation, tracks the event", async () => {
    const { service, appointments, reminders, sent, events, emitted } = buildFakes();

    const result = await service.book({
      business,
      conversationId: "c1",
      slot: SLOT_9AM,
      ...visitor,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(appointments).toHaveLength(1);
    expect(appointments[0].status).toBe("confirmed");
    // 24h reminder + 1h reminder, both still in the future.
    expect(reminders.filter((r) => r.status === "scheduled")).toHaveLength(2);
    // Fake gateway supports WhatsApp, so the phone confirmation rides it.
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("whatsapp");
    expect(sent[0].body).toContain("Tuesday, July 14 at 9:00 AM");
    // Self-service manage link and prep instructions ride along.
    expect(sent[0].body).toContain("http://app.test/appt/");
    expect(sent[0].body).toContain("clear access");
    expect(events).toContain("appointment_booked");
    // The workflow/CRM platform hears about the booking.
    expect(emitted.map((e) => e.type)).toEqual(["appointment.created"]);
    expect(emitted[0].payload.visitorPhone).toBe("+1 555 0100");
  });

  it("loses the race gracefully: slot_taken with fresh alternatives", async () => {
    const { service } = buildFakes();

    const first = await service.book({ business, conversationId: "c1", slot: SLOT_9AM, ...visitor, now: NOW });
    expect(first.ok).toBe(true);

    const second = await service.book({ business, conversationId: "c2", slot: SLOT_9AM, ...visitor, now: NOW });
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === "slot_taken") {
      expect(second.alternatives.length).toBeGreaterThan(0);
      expect(second.alternatives.map((s) => s.startsAt)).not.toContain(SLOT_9AM.startsAt);
    } else {
      throw new Error("expected slot_taken");
    }
  });

  it("books the freed slot after a cancellation", async () => {
    const { service, appointments, reminders } = buildFakes();

    const first = await service.book({ business, conversationId: "c1", slot: SLOT_9AM, ...visitor, now: NOW });
    if (!first.ok) throw new Error("setup failed");

    await service.cancel({ business, appointment: first.appointment });
    expect(appointments[0].status).toBe("cancelled");
    expect(reminders.every((r) => r.status === "cancelled")).toBe(true);

    const again = await service.book({ business, conversationId: "c2", slot: SLOT_9AM, ...visitor, now: NOW });
    expect(again.ok).toBe(true);
  });

  it("reschedules a live appointment and refreshes reminders", async () => {
    const { service, appointments, reminders, sent } = buildFakes();
    const first = await service.book({ business, conversationId: "c1", slot: SLOT_9AM, ...visitor, now: NOW });
    if (!first.ok) throw new Error("setup failed");

    const newSlot: TimeSlot = {
      ...SLOT_9AM,
      startsAt: "2026-07-15T13:00:00.000Z",
      endsAt: "2026-07-15T14:00:00.000Z",
    };
    const moved = await service.reschedule({ business, appointment: first.appointment, slot: newSlot, now: NOW });

    expect(moved.ok).toBe(true);
    expect(appointments[0].startsAt).toBe(newSlot.startsAt);
    expect(appointments[0].notes).toContain("Rescheduled from");
    // Old reminders cancelled, new ones scheduled.
    expect(reminders.some((r) => r.status === "cancelled")).toBe(true);
    expect(reminders.filter((r) => r.status === "scheduled")).toHaveLength(2);
    // The reschedule confirmation carries the new time.
    expect(sent.some((m) => m.body.includes("Wednesday, July 15 at 9:00 AM"))).toBe(true);
  });

  it("rejects bookings violating validation rules", async () => {
    const { service } = buildFakes();

    const noContact = await service.book({
      business,
      conversationId: "c1",
      slot: SLOT_9AM,
      serviceName: "x",
      visitorName: "Sam",
      visitorPhone: "",
      visitorEmail: "",
      now: NOW,
    });
    expect(noContact.ok).toBe(false);

    const tooSoon = await service.book({
      business,
      conversationId: "c1",
      slot: { ...SLOT_9AM, startsAt: "2026-07-13T12:30:00.000Z", endsAt: "2026-07-13T13:30:00.000Z" },
      ...visitor,
      now: NOW,
    });
    expect(tooSoon.ok).toBe(false);
  });

  it("refuses to cancel a terminal appointment", async () => {
    const { service, appointments } = buildFakes();
    const first = await service.book({ business, conversationId: "c1", slot: SLOT_9AM, ...visitor, now: NOW });
    if (!first.ok) throw new Error("setup failed");
    appointments[0].status = "completed";

    await expect(
      service.cancel({ business, appointment: appointments[0] }),
    ).rejects.toThrow(/cannot move/i);
  });
});
