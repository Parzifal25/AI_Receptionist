import { describe, expect, it, vi } from "vitest";
import { BookingOrchestrator } from "@halo/scheduling/booking-orchestrator";
import type { BookingService } from "@halo/scheduling/booking-service";
import type { SchedulingRepository } from "@halo/scheduling/scheduling-repository";
import { EMPTY_DRAFT, type BookingDraft } from "@halo/scheduling/booking-draft";
import type { Appointment, SchedulingSettings, TimeSlot } from "@halo/core/domain/scheduling";
import type { LLMProvider } from "@halo/ports/llm-provider";
import type { Business } from "@halo/core/domain/types";

/**
 * The conversation → booking bridge, with the engine and LLM faked: verifies
 * scheduling context detection, that the draft accumulates across turns,
 * that only real slots reach the prompt, that the engine is invoked the
 * moment the draft is complete — and that nothing is ever narrated as booked
 * unless the engine said so.
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
  startsAt: "2026-07-14T13:00:00.000Z", // Tue 9:00 ET
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
  manageToken: "11111111-1111-4111-8111-111111111111",
  notes: "",
  createdAt: NOW.toISOString(),
};

const NO_ACTION = { action: "none", slotNumber: 0, name: "", phone: "", email: "", service: "", notes: "" };

function buildFakes(options: {
  bookingEnabled?: boolean;
  slots?: TimeSlot[];
  existing?: Appointment | null;
  actionJson?: object;
  /** Makes the extraction pass fail, as a provider outage would. */
  llmThrows?: boolean;
  bookResult?: object;
  /** Draft already carried by the conversation. */
  draft?: Partial<BookingDraft>;
}) {
  const settings: Partial<SchedulingSettings> = {
    bookingEnabled: options.bookingEnabled ?? true,
    timezone: "America/New_York",
  };

  const drafts = new Map<string, BookingDraft>();
  if (options.draft) drafts.set("c1", { ...EMPTY_DRAFT, ...options.draft });

  const repository = {
    getSettings: vi.fn(async () => settings),
    findLiveAppointmentByConversation: vi.fn(async () => options.existing ?? null),
    getBookingDraft: vi.fn(async (conversationId: string) => drafts.get(conversationId) ?? null),
    saveBookingDraft: vi.fn(async (_b: string, conversationId: string, draft: BookingDraft) => {
      drafts.set(conversationId, { ...draft });
    }),
    clearBookingDraft: vi.fn(async (conversationId: string) => {
      drafts.delete(conversationId);
    }),
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
      if (options.llmThrows) throw new Error("provider down");
      return { content: JSON.stringify(options.actionJson ?? NO_ACTION), model: "fake" };
    },
    async isHealthy() {
      return true;
    },
  };

  return {
    orchestrator: new BookingOrchestrator(repository, booking, llm),
    booking,
    repository,
    drafts,
  };
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
    const { orchestrator, booking, drafts } = buildFakes({
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
    // The draft has become an appointment; nothing is left to carry.
    expect(drafts.has("c1")).toBe(false);
  });

  // --- Draft state ------------------------------------------------------------

  it("remembers a partial booking instead of restarting each turn", async () => {
    const { orchestrator, booking, drafts } = buildFakes({
      actionJson: { ...NO_ACTION, service: "AC service" },
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "I need to book an AC service",
      now: NOW,
    });

    expect(booking.book).not.toHaveBeenCalled();
    expect(drafts.get("c1")).toMatchObject({ service: "AC service", timeCommitted: false });
    // The model is told what to ask for next, and that nothing is booked.
    expect(context?.promptSection).toContain("Still needed before this can be booked");
    expect(context?.promptSection).toContain("The appointment is NOT booked");
  });

  it("stores every detail supplied in one message", async () => {
    // The service comes from the extraction pass; the contact details are
    // read deterministically out of the visitor's own text.
    const { orchestrator, drafts } = buildFakes({
      actionJson: { ...NO_ACTION, service: "boiler service" },
    });
    await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: [
        "I'd like to book a boiler service.",
        "Name:",
        "John",
        "Phone:",
        "+1 555 0100",
        "Email:",
        "john@example.com",
      ].join("\n"),
      now: NOW,
    });

    expect(drafts.get("c1")).toMatchObject({
      service: "boiler service",
      name: "John",
      phone: "+1 555 0100",
      email: "john@example.com",
    });
  });

  it("tells the model what the visitor already gave, so it never re-asks", async () => {
    const { orchestrator } = buildFakes({
      draft: { service: "AC servicing", name: "Sam", phone: "+1 555 0100" },
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "what have you got tomorrow?",
      now: NOW,
    });

    expect(context?.promptSection).toContain("never ask for");
    expect(context?.promptSection).toContain("Name: Sam");
    expect(context?.promptSection).toContain("Phone: +1 555 0100");
    expect(context?.promptSection).toContain("Still needed before this can be booked: time");
  });

  it("books automatically once the last missing detail arrives", async () => {
    // Earlier turns agreed the time and gave the service and name; only the
    // phone number was outstanding, and it arrives with no booking keyword.
    const { orchestrator, booking } = buildFakes({
      draft: {
        service: "AC servicing",
        name: "Sam",
        date: "2026-07-14",
        time: "09:00",
        timeCommitted: true,
      },
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [{ role: "assistant", content: "What's the best number for you?" }],
      userMessage: "555 010 0100",
      now: NOW,
    });

    expect(booking.book).toHaveBeenCalledOnce();
    expect((booking.book as ReturnType<typeof vi.fn>).mock.calls[0][0].visitorPhone).toBe("555 010 0100");
    expect(context?.bookedNow).toBe(true);
  });

  it("does not book while the visitor is only asking whether a time is free", async () => {
    const { orchestrator, booking } = buildFakes({
      draft: { service: "AC servicing", name: "Sam", phone: "+1 555 0100" },
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "do you have anything tomorrow at 9am?",
      now: NOW,
    });

    expect(booking.book).not.toHaveBeenCalled();
    expect(context?.bookedNow).toBe(false);
    expect(context?.promptSection).toContain("Still needed before this can be booked: time");
  });

  it("re-opens the time for agreement when the visitor corrects it", async () => {
    const { orchestrator, booking, drafts } = buildFakes({
      slots: [SLOT, { ...SLOT, startsAt: "2026-07-14T18:00:00.000Z", endsAt: "2026-07-14T19:00:00.000Z" }],
      draft: {
        service: "AC servicing",
        name: "Sam",
        phone: "+1 555 0100",
        date: "2026-07-14",
        time: "09:00",
        timeCommitted: true,
      },
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "sorry, can we make it 2pm tomorrow?",
      now: NOW,
    });

    // "make it" is agreement to the corrected time — the new slot is booked,
    // and never the old one.
    expect(booking.book).toHaveBeenCalledOnce();
    expect((booking.book as ReturnType<typeof vi.fn>).mock.calls[0][0].slot.startsAt).toBe(
      "2026-07-14T18:00:00.000Z",
    );
    expect(context?.bookedNow).toBe(true);
    expect(drafts.has("c1")).toBe(false);
  });

  it("keeps gathering deterministically when the extraction pass fails", async () => {
    const { orchestrator, drafts } = buildFakes({ llmThrows: true });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "I want to book an appointment, I'm Sam on +1 555 0100",
      now: NOW,
    });

    expect(context).not.toBeNull();
    expect(drafts.get("c1")).toMatchObject({ name: "Sam", phone: "+1 555 0100" });
  });

  // --- Failures ---------------------------------------------------------------

  it("recovers when the slot was just taken", async () => {
    const { orchestrator, drafts } = buildFakes({
      actionJson: { action: "book", slotNumber: 1, name: "Sam", phone: "+1 555 0100", email: "", service: "AC servicing" },
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
    expect(context?.promptSection).toContain("The booking FAILED");
    expect(context?.promptSection).toContain("Tuesday, July 14 at 11:00 AM");
    // The visitor's details survive; only the dead time is dropped.
    expect(drafts.get("c1")).toMatchObject({ name: "Sam", time: "", timeCommitted: false });
  });

  it("explains a rejected booking with the engine's own reason", async () => {
    const { orchestrator } = buildFakes({
      actionJson: { action: "book", slotNumber: 1, name: "Sam", phone: "+1 555 0100", email: "", service: "AC servicing" },
      bookResult: { ok: false, reason: "invalid", message: "That time is no longer available" },
    });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "book me the 9am slot, Sam +1 555 0100",
      now: NOW,
    });

    expect(context?.bookedNow).toBe(false);
    expect(context?.promptSection).toContain("The booking FAILED and no appointment exists");
    expect(context?.promptSection).toContain("That time is no longer available");
    expect(context?.promptSection).toContain("do not invent a different explanation");
  });

  // --- Existing appointments --------------------------------------------------

  it("reschedules instead of double-booking when a live appointment exists", async () => {
    const { orchestrator, booking } = buildFakes({
      // The visitor holds Wednesday and wants to move to Tuesday's opening.
      existing: {
        ...appointment,
        startsAt: "2026-07-15T13:00:00.000Z",
        endsAt: "2026-07-15T14:00:00.000Z",
      },
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
    const { orchestrator, booking, repository } = buildFakes({ existing: appointment });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "I need to cancel my appointment please",
      now: NOW,
    });
    expect(booking.cancel).toHaveBeenCalledOnce();
    expect(context?.promptSection).toContain("JUST cancelled");
    expect(repository.clearBookingDraft).toHaveBeenCalledWith("c1");
  });

  it("never claims a cancellation it did not make", async () => {
    const { orchestrator, booking } = buildFakes({ existing: null });
    const context = await orchestrator.prepareTurn({
      business,
      conversationId: "c1",
      history: [],
      userMessage: "please cancel my appointment",
      now: NOW,
    });

    expect(booking.cancel).not.toHaveBeenCalled();
    expect(context?.promptSection).toContain("NO appointment on file");
    expect(context?.promptSection).toContain("nothing");
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
