import type { ActionRecord } from "@halo/runtime/contracts";
import type { SystemActionInput, SystemActionOutcome, SystemActionProvider } from "@halo/runtime/system-actions";
import type { BookingOrchestrator, BookingTurnContext, BookingTurnOutcome } from "./booking-orchestrator";

/**
 * HALO Phase 2 — the scheduling engine as a runtime SystemActionProvider.
 *
 * The BookingOrchestrator already implements act-then-narrate: it books,
 * reschedules or cancels deterministically BEFORE the model is called and
 * hands back a ground-truth prompt section. This adapter is the only change
 * needed to run it inside the Agent Runtime: it turns the orchestrator's
 * typed outcome into verified ActionRecords so the ResponseValidator can
 * enforce that the reply never claims more than the engine actually did.
 *
 * Nothing about booking state changes: booking_drafts, appointments and the
 * engine's invariants are untouched.
 */
export class BookingSystemActionProvider implements SystemActionProvider {
  readonly name = "scheduling";

  constructor(private readonly orchestrator: Pick<BookingOrchestrator, "prepareTurn">) {}

  async prepare(input: SystemActionInput): Promise<SystemActionOutcome | null> {
    const turn = await this.orchestrator.prepareTurn({
      business: input.business,
      conversationId: input.trusted.conversationId,
      history: input.history,
      userMessage: input.userMessage,
      now: input.now,
    });
    if (!turn) return null;
    return {
      sections: [turn.promptSection],
      actions: actionsForOutcome(turn),
      statePatch: { intent: "appointment" },
    };
  }
}

/** Maps the engine's outcome onto what the reply is allowed to claim. */
export function actionsForOutcome(turn: BookingTurnContext): ActionRecord[] {
  const outcome: BookingTurnOutcome = turn.outcome ?? {
    kind: turn.bookedNow ? "booked" : "guidance",
    hasExistingAppointment: false,
  };
  switch (outcome.kind) {
    case "booked":
      return [
        {
          source: "system",
          name: "book_appointment",
          status: "succeeded",
          claimsPermitted: ["appointment.book"],
          summary: "The scheduling engine booked the appointment this turn.",
        },
      ];
    case "rescheduled":
      return [
        {
          source: "system",
          name: "reschedule_appointment",
          status: "succeeded",
          claimsPermitted: ["appointment.reschedule", "appointment.book"],
          summary: "The scheduling engine moved the appointment this turn.",
        },
      ];
    case "cancelled":
      return [
        {
          source: "system",
          name: "cancel_appointment",
          status: "succeeded",
          claimsPermitted: ["appointment.cancel"],
          summary: "The scheduling engine cancelled the appointment this turn.",
        },
      ];
    case "failed":
      return [
        {
          source: "system",
          name: outcome.wasReschedule ? "reschedule_appointment" : "book_appointment",
          status: "failed",
          claimsPermitted: [],
          summary:
            outcome.reason === "slot_taken"
              ? "The chosen time was taken; alternatives were offered."
              : "The scheduling engine rejected the booking.",
          needsHuman: outcome.reason !== "slot_taken",
        },
      ];
    case "unchanged":
      return [existingAppointmentRecord()];
    case "guidance":
      return outcome.hasExistingAppointment ? [existingAppointmentRecord()] : [];
    case "nothing_to_cancel":
      return [];
  }
}

function existingAppointmentRecord(): ActionRecord {
  return {
    source: "system",
    name: "appointment_on_file",
    status: "succeeded",
    claimsPermitted: ["appointment.book"],
    summary: "The visitor already holds a confirmed appointment (verified by the engine).",
  };
}
