import { describe, expect, it } from "vitest";
import { BookingService } from "@halo/scheduling/booking-service";
import { createSchedulingFakes } from "../mocks/in-memory-scheduling";
import type { TimeSlot } from "@halo/core/domain/scheduling";
import type { MessagingProvider } from "@halo/ports/messaging-provider";

const NOW = new Date("2026-07-13T12:00:00Z");
const SLOT_9AM: TimeSlot = {
  staffId: "s1",
  staffName: "Alex",
  startsAt: "2026-07-14T13:00:00.000Z",
  endsAt: "2026-07-14T14:00:00.000Z",
};

const business = {
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

const visitor = {
  serviceName: "AC servicing",
  visitorName: "Sam",
  visitorPhone: "+1 555 0100",
  visitorEmail: "sam@example.com",
};

describe("Provider Failures", () => {
  it("creates appointment even if messaging provider fails", async () => {
    const fakes = createSchedulingFakes({ bookingEnabled: true, now: NOW });

    // Sabotage the messaging provider: the confirmation send throws.
    const failingMessaging: MessagingProvider = {
      name: "failing-fake",
      supports: () => true,
      send: async () => {
        throw new Error("Simulated messaging provider failure");
      },
    };
    const service = new BookingService(
      fakes.repository,
      failingMessaging,
      undefined,
      async () => {},
    );

    const result = await service.book({
      business,
      conversationId: "c1",
      slot: SLOT_9AM,
      ...visitor,
      now: NOW,
    });

    // The booking must still succeed even though the confirmation failed:
    // the appointment row (exclusion-constraint guarded) is the source of
    // truth and a messaging outage never loses a booking.
    expect(result.ok).toBe(true);
    expect(fakes.appointments).toHaveLength(1);
    expect(fakes.appointments[0].status).toBe("confirmed");
  });
});
