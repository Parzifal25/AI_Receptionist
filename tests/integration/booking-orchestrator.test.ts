import { describe, expect, it, vi } from "vitest";
import { BookingOrchestrator } from "@/core/services/scheduling/booking-orchestrator";
import type { BookingService } from "@/core/services/scheduling/booking-service";
import type { SchedulingRepository } from "@/core/services/scheduling/scheduling-repository";
import type { Appointment, SchedulingSettings, TimeSlot } from "@/core/domain/scheduling";
import type { LLMProvider } from "@/core/ports/llm-provider";
import type { Business } from "@/core/domain/types";

/**
 * The conversation → booking bridge, with the engine and LLM faked: verifies
 * scheduling context detection, that real slots (and only real slots) reach
 * the prompt, and that extracted actions execute against the engine before
 * the reply is generated.
 */

const NOW = new Date("2026-07-13T12:00:00Z");

const business: Business = {
  id: "b1",
  name: "Cool Air HVAC",
  slug: "cool-air",
  description: "",
  industry: "HVAC",
  website: "",
  phone: "",
  email: "",
  address: "",
  businessHours: { tue: { open: "09:00", close: "17:00", closed: false } },
  logoUrl: "",
};

const SLOT: TimeSlot = {
  staffId: "s1",
  staffName: "Alex",
  startsAt: "2026-07-14T13:00:00.000Z",
  endsAt: "2026-07-14T14:00:00.000Z",
};

const appointment: Appointment = {
  id: "a1",
  businessId: "b1",
  staffId: "s1",
  conversationId: "c1",
  leadId: null,
  serviceName: "AC servicing",
  visitorName: "Sam",
  visitorPhone: "+1 555 0100",
  visitorEmail: "",
  startsAt: SLOT.startsAt,
  endsAt: SLOT.endsAt,
  timezone: "America/New_York",
  status: "confirmed",
  externalEventId: "",
  notes: "",
  createdAt: NOW.toISOString(),
};

function buildFakes(options: {
  bookingEnabled?: boolean;
  slots?: TimeSlot[];
  existing?: Appointment | null;
  actionJson?: object;
  bookResult?: object;
}) {
  const settings: Partial<SchedulingSettings> = {
    bookingEnabled: options.bookingEnabled ?? true,
    timezone: "America/New_York",
  };

  const repository = {
    getSettings: vi.fn(async () => settings),
    findLiveAppointmentByConversation: vi.fn(async () => options.existing ?? null),
  } as unknown as SchedulingRepository;

  const booking = {
    getAvailability: vi.fn(async () => ({ settings, staff: [], slots: options.slots ?? [SLOT] })),
    book: vi.fn(async () => options.bookResult ?? { ok: true, appointment }),
    reschedule: vi.fn(async () => ({ ok: true, appointment })),
    cancel: vi.fn(async () => ({ ok: true })),
  } as unknown as BookingService;

  const llm: LLMProvider = {
    name: "fake",
    async complete() {
      return {
        content: JSON.stringify(
          options.actionJson ?? { action: "none", slotNumber: 0, name: "", phone: "", email: "", service: "" },
        ),
        model: "fake",
      };
    },
    async isHealthy() {
      return true;
    },
  };

  return { orchestrator: new BookingOrchestrator(repository, booking, llm), booking, repository };
}

describe("BookingOrchestrator.prepareTurn", () => {
  it("stays out of non-scheduling conversations", async () => {
    const { orchestrator } = buildFakes({});
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "what are your prices for a tune-up?",
      now: NOW,
    });
    expect(context).toBeNull();
  });

  it("returns null when booking is disabled", async () => {
    const { orchestrator } = buildFakes({ bookingEnabled: false });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "I'd like to book AC servicing tomorrow",
      now: NOW,
    });
    expect(context).toBeNull();
  });

  it("injects real slots when the visitor asks to book", async () => {
    const { orchestrator, booking } = buildFakes({});
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "I'd like AC servicing tomorrow",
      now: NOW,
    });

    expect(context?.bookedNow).toBe(false);
    expect(context?.promptSection).toContain("Tuesday, July 14 at 9:00 AM");
    expect(context?.promptSection).toContain("ONLY offer times from this list");
    // The parsed "tomorrow" window reached the availability engine.
    const call = (booking.getAvailability as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.window?.label).toBe("tomorrow");
  });

  it("tells the model to be honest when nothing is open", async () => {
    const { orchestrator } = buildFakes({ slots: [] });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "can I get an appointment tomorrow?",
      now: NOW,
    });
    expect(context?.promptSection).toContain("NO open slots");
  });

  it("offers the next real openings when the exact requested time is booked", async () => {
    const { orchestrator, booking } = buildFakes({});
    // The 10 AM search comes back empty; the widened re-search finds slots.
    (booking.getAvailability as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      settings: { bookingEnabled: true, timezone: "America/New_York" },
      staff: [],
      slots: [],
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "I want an appointment tomorrow at 10 AM",
      now: NOW,
    });

    const calls = (booking.getAvailability as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].window?.label).toBe("tomorrow at 10 am");
    expect(calls[0][0].window?.localHourRange).toEqual({ startHour: 10, endHour: 11 });
    expect(calls[1][0].window?.localHourRange).toBeUndefined();
    expect(calls[1][0].limit).toBe(3);

    expect(context?.promptSection).toContain("is NOT available");
    expect(context?.promptSection).toContain("Tuesday, July 14 at 9:00 AM");
    expect(context?.promptSection).toContain("ONLY offer times from this list");
  });

  it("books when the visitor confirms a slot, before the reply is written", async () => {
    const { orchestrator, booking } = buildFakes({
      actionJson: {
        action: "book",
        slotNumber: 1,
        name: "Sam",
        phone: "+1 555 0100",
        email: "",
        service: "AC servicing",
      },
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [
        { role: "user", content: "I'd like AC servicing tomorrow" },
        { role: "assistant", content: "I have 9am or 10am open tomorrow." },
      ],
      userMessage: "9am works — I'm Sam, +1 555 0100",
      now: NOW,
    });

    expect(booking.book).toHaveBeenCalledOnce();
    const call = (booking.book as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.slot.startsAt).toBe(SLOT.startsAt);
    expect(call.visitorPhone).toBe("+1 555 0100");
    expect(context?.bookedNow).toBe(true);
    expect(context?.promptSection).toContain("JUST successfully booked");
    expect(context?.promptSection).toContain("Do NOT ask for any more details");
  });

  it("recovers when the slot was just taken", async () => {
    const { orchestrator } = buildFakes({
      actionJson: { action: "book", slotNumber: 1, name: "Sam", phone: "+1 555 0100", email: "", service: "" },
      bookResult: {
        ok: false,
        reason: "slot_taken",
        alternatives: [{ ...SLOT, startsAt: "2026-07-14T15:00:00.000Z", endsAt: "2026-07-14T16:00:00.000Z" }],
      },
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "book me the 9am slot, Sam +1 555 0100",
      now: NOW,
    });
    expect(context?.bookedNow).toBe(false);
    expect(context?.promptSection).toContain("JUST taken");
    expect(context?.promptSection).toContain("Tuesday, July 14 at 11:00 AM");
  });

  it("reschedules instead of double-booking when a live appointment exists", async () => {
    const { orchestrator, booking } = buildFakes({
      existing: appointment,
      actionJson: { action: "book", slotNumber: 1, name: "Sam", phone: "+1 555 0100", email: "", service: "" },
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "can we move my appointment to tomorrow 9am?",
      now: NOW,
    });
    expect(booking.reschedule).toHaveBeenCalledOnce();
    expect(booking.book).not.toHaveBeenCalled();
    expect(context?.promptSection).toContain("JUST successfully moved");
  });

  it("cancels via the deterministic fast path, without an LLM call", async () => {
    const { orchestrator, booking } = buildFakes({ existing: appointment });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "I need to cancel my appointment please",
      now: NOW,
    });
    expect(booking.cancel).toHaveBeenCalledOnce();
    expect(context?.promptSection).toContain("JUST cancelled");
  });

  it("surfaces the existing appointment so the model can reference it", async () => {
    const { orchestrator } = buildFakes({ existing: appointment });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "when is my appointment again?",
      now: NOW,
    });
    expect(context?.promptSection).toContain("already has an appointment");
    expect(context?.promptSection).toContain("Tuesday, July 14 at 9:00 AM");
  });
});
