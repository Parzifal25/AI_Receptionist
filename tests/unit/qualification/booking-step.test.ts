import { describe, expect, it, vi } from "vitest";
import { TELUGU_PACK } from "@halo/language/language-pack";
import { VisitBookingStepProvider, type VisitBookingPort, type VisitBookingResult, type VisitSlot } from "@halo/qualification/booking-step";
import { emptyConversationState } from "@halo/runtime/conversation-state";
import { BUSINESS_A, makeTrusted } from "../../mocks/runtime-fakes";

const SLOTS: VisitSlot[] = [
  { startsAt: "2026-09-18T04:30:00Z", endsAt: "2026-09-18T05:30:00Z", staffId: "tech-1", label: "Friday morning 10 o'clock" },
  { startsAt: "2026-09-18T11:30:00Z", endsAt: "2026-09-18T12:30:00Z", staffId: "tech-1", label: "Friday evening 5 o'clock" },
  { startsAt: "2026-09-19T04:30:00Z", endsAt: "2026-09-19T05:30:00Z", staffId: "tech-2", label: "Saturday morning 10 o'clock" },
];

function makePort(overrides: Partial<VisitBookingPort> = {}, bookResult?: VisitBookingResult) {
  const booked: unknown[] = [];
  const port: VisitBookingPort = {
    offerSlots: vi.fn(async () => SLOTS),
    book: vi.fn(async (params): Promise<VisitBookingResult> => {
      booked.push(params);
      return bookResult ?? { ok: true as const, appointmentId: "appt-1", startsAt: params.slot.startsAt, label: params.slot.label };
    }),
    ...overrides,
  };
  return { port, booked };
}

function makeProvider(port: VisitBookingPort, ready = true) {
  return new VisitBookingStepProvider({
    booking: port,
    pack: TELUGU_PACK,
    isReady: () => ready,
    contact: () => ({ name: "రమేష్", phone: "+919876543210", notes: "" }),
    conversationId: "conv-1",
  });
}

const input = (userMessage: string) => ({
  trusted: makeTrusted(),
  business: BUSINESS_A,
  history: [],
  userMessage,
  state: emptyConversationState(),
  now: new Date("2026-09-16T10:00:00Z"),
});

describe("site-visit booking step", () => {
  it("does nothing until qualification says it is ready", async () => {
    const { port } = makePort();
    expect(await makeProvider(port, false).prepare(input("రేపు"))).toBeNull();
    expect(port.offerSlots).not.toHaveBeenCalled();
  });

  it("offers only slots the scheduling engine returned", async () => {
    const { port } = makePort();
    const outcome = (await makeProvider(port).prepare(input("సైట్ విజిట్ కావాలి")))!;
    expect(outcome.sections[0]).toContain("Friday morning 10 o'clock");
    expect(outcome.sections[0]).toContain("never offer any other time");
    expect(outcome.actions).toHaveLength(0);
  });

  it("reads the selected date and time back, then books only after explicit confirmation", async () => {
    const { port, booked } = makePort();
    const provider = makeProvider(port);
    await provider.prepare(input("సైట్ విజిట్ కావాలి"));
    const selection = (await provider.prepare(input("రెండోది")))!;
    expect(selection.sections[0]).toContain(SLOTS[1].label);
    expect(selection.sections[0]).toContain("NOTHING is booked yet");
    expect(booked).toHaveLength(0);
    const outcome = (await provider.prepare(input("అవును")))!;
    expect(booked).toHaveLength(1);
    expect((booked[0] as { slot: VisitSlot }).slot.startsAt).toBe(SLOTS[1].startsAt);
    expect(outcome.actions[0]).toMatchObject({ name: "appointment.book", status: "succeeded", claimsPermitted: ["appointment.book"] });
    expect(outcome.sections[0]).toContain("IS booked");
    expect(provider.current()).toMatchObject({ phase: "booked", appointmentId: "appt-1" });
  });

  it("matches digits and restated times as well as ordinals", async () => {
    for (const [utterance, index] of [["one", 0], ["3", 2], ["శుక్రవారం సాయంత్రం", 1]] as const) {
      const { port, booked } = makePort();
      const provider = makeProvider(port);
      await provider.prepare(input("times cheppandi"));
      await provider.prepare(input(utterance));
      expect(booked, `${utterance} must not book before confirmation`).toHaveLength(0);
      await provider.prepare(input("yes"));
      expect((booked[0] as { slot: VisitSlot }).slot.startsAt, utterance).toBe(SLOTS[index].startsAt);
    }
  });

  it("does not book on rejection or an ambiguous answer", async () => {
    const { port, booked } = makePort();
    const provider = makeProvider(port);
    await provider.prepare(input("visit"));
    const readback = (await provider.prepare(input("first")))!;
    expect(readback.sections[0]).toContain("Do not book until the caller clearly confirms");
    await provider.prepare(input("maybe"));
    expect(booked).toHaveLength(0);
    const rejected = (await provider.prepare(input("no")))!;
    expect(rejected.sections[0]).toContain("NOTHING is booked");
    expect(booked).toHaveLength(0);
  });

  it("uses one idempotency key per conversation and slot", async () => {
    const { port, booked } = makePort();
    const provider = makeProvider(port);
    await provider.prepare(input("times"));
    await provider.prepare(input("first"));
    await provider.prepare(input("yes, that's right"));
    // A repeated yes after booking never books again.
    const after = (await provider.prepare(input("అవును అవును")))!;
    expect(booked).toHaveLength(1);
    expect((booked[0] as { idempotencyKey: string }).idempotencyKey).toBe(`conv-1:${SLOTS[0].startsAt}`);
    expect(after.actions).toHaveLength(0);
    expect(after.sections[0]).toContain("is booked");
  });

  it("never claims a booking when the slot was taken, and offers the alternatives", async () => {
    const alternatives = [SLOTS[2]];
    const { port, booked } = makePort({}, { ok: false, reason: "slot_taken", alternatives });
    const provider = makeProvider(port);
    await provider.prepare(input("times"));
    const outcome = (await provider.prepare(input("first")))!;
    expect(booked).toHaveLength(0);
    const bookedOutcome = (await provider.prepare(input("yes")))!;
    expect(outcome.actions).toHaveLength(0);
    expect(bookedOutcome.actions[0]).toMatchObject({ status: "failed", claimsPermitted: [] });
    expect(bookedOutcome.sections[0]).toContain("NOTHING is booked");
    expect(bookedOutcome.sections[0]).toContain("Saturday morning 10 o'clock");
    expect(provider.current().phase).toBe("offered");
  });

  it("escalates honestly when booking fails outright", async () => {
    const { port } = makePort({}, { ok: false, reason: "invalid", message: "booking is disabled" });
    const provider = makeProvider(port);
    await provider.prepare(input("times"));
    await provider.prepare(input("first"));
    const outcome = (await provider.prepare(input("yes")))!;
    expect(outcome.actions[0]).toMatchObject({ status: "failed", needsHuman: true });
    expect(outcome.sections[0]).toContain("do not say it is");
  });

  it("says so when the calendar has nothing to offer", async () => {
    const { port } = makePort({ offerSlots: vi.fn(async () => []) });
    const outcome = (await makeProvider(port).prepare(input("visit")))!;
    expect(outcome.sections[0]).toContain("no free visit times");
    expect(outcome.sections[0]).toContain("Do not invent a time");
  });

  it("re-offers a bounded number of times when the caller does not choose", async () => {
    const { port } = makePort();
    const provider = makeProvider(port);
    await provider.prepare(input("visit"));
    for (let i = 0; i < 3; i++) await provider.prepare(input("ఏమో"));
    expect(await provider.prepare(input("ఏమో"))).toBeNull();
  });
});
