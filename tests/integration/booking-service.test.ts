import { describe, expect, it } from "vitest";
import { createSchedulingFakes } from "../mocks/in-memory-scheduling";
import type { TimeSlot } from "@halo/core/domain/scheduling";
import type { Business } from "@halo/core/domain/types";

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
  return createSchedulingFakes({ bookingEnabled: options.bookingEnabled, now: NOW });
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
