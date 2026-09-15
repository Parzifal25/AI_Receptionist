import { describe, expect, it } from "vitest";
import { actionsForOutcome, BookingSystemActionProvider } from "@halo/scheduling/booking-runtime-adapter";
import type { BookingTurnContext } from "@halo/scheduling/booking-orchestrator";
import { BUSINESS_A, makeTrusted } from "../mocks/runtime-fakes";
import { emptyConversationState } from "@halo/runtime/conversation-state";

function turn(outcome: BookingTurnContext["outcome"], bookedNow = false): BookingTurnContext {
  return { promptSection: "## Booking status\n...", bookedNow, outcome };
}

describe("booking runtime adapter — engine outcomes → permitted claims", () => {
  it("permits a booking claim only after the engine booked", () => {
    expect(actionsForOutcome(turn({ kind: "booked", hasExistingAppointment: false }))).toMatchObject([
      { name: "book_appointment", status: "succeeded", claimsPermitted: ["appointment.book"] },
    ]);
    expect(actionsForOutcome(turn({ kind: "guidance", hasExistingAppointment: false }))).toEqual([]);
    expect(actionsForOutcome(turn({ kind: "nothing_to_cancel", hasExistingAppointment: false }))).toEqual([]);
  });

  it("maps reschedule, cancel and existing-appointment outcomes", () => {
    expect(actionsForOutcome(turn({ kind: "rescheduled", hasExistingAppointment: true }))[0].claimsPermitted).toContain("appointment.reschedule");
    expect(actionsForOutcome(turn({ kind: "cancelled", hasExistingAppointment: false }))[0].claimsPermitted).toEqual(["appointment.cancel"]);
    expect(actionsForOutcome(turn({ kind: "unchanged", hasExistingAppointment: true }))[0]).toMatchObject({ name: "appointment_on_file", claimsPermitted: ["appointment.book"] });
    expect(actionsForOutcome(turn({ kind: "guidance", hasExistingAppointment: true }))[0].name).toBe("appointment_on_file");
  });

  it("a failed booking permits nothing; only unrecoverable failures ask for a human", () => {
    const taken = actionsForOutcome(turn({ kind: "failed", reason: "slot_taken", wasReschedule: false, hasExistingAppointment: false }))[0];
    expect(taken).toMatchObject({ status: "failed", claimsPermitted: [], needsHuman: false });
    const invalid = actionsForOutcome(turn({ kind: "failed", reason: "invalid", wasReschedule: true, hasExistingAppointment: true }))[0];
    expect(invalid).toMatchObject({ name: "reschedule_appointment", status: "failed", needsHuman: true });
  });

  it("derives the outcome from bookedNow for hand-built legacy contexts", () => {
    expect(actionsForOutcome({ promptSection: "x", bookedNow: true })[0].name).toBe("book_appointment");
    expect(actionsForOutcome({ promptSection: "x", bookedNow: false })).toEqual([]);
  });

  it("passes the trusted conversation id to the engine and returns nothing when scheduling is off", async () => {
    const seen: string[] = [];
    const provider = new BookingSystemActionProvider({
      async prepareTurn(params) {
        seen.push(params.conversationId);
        return null;
      },
    });
    const outcome = await provider.prepare({ trusted: makeTrusted({ conversationId: "conv-9" }), business: BUSINESS_A, history: [], userMessage: "book", state: emptyConversationState(), now: new Date() });
    expect(seen).toEqual(["conv-9"]);
    expect(outcome).toBeNull();
  });
});
