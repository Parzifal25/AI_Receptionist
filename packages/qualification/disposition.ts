import type { CallDisposition } from "@halo/core/domain/voice";
import { isTerminal, type QualificationSnapshot } from "./engine";

/**
 * HALO Phase 4 — deterministic call disposition (plan §P5.4).
 *
 * The business outcome is computed from what actually happened — the
 * qualification snapshot, a verified booking, an escalation, how far the call
 * got — never asserted by the model. It is kept separate from the call's
 * technical state: a `completed` call can be `not_interested`, and a call that
 * never reached a conversation has no outcome at all.
 */

export interface DispositionInput {
  snapshot: QualificationSnapshot;
  /** An appointment the booking engine actually created this call. */
  appointmentId?: string | null;
  /** The call was handed to a human (transfer accepted). */
  transferred?: boolean;
  /** A handoff was requested, whether or not it succeeded. */
  escalationRequested?: boolean;
  /** Caller turns that actually happened. */
  turns: number;
}

export interface DispositionResult {
  disposition: CallDisposition;
  reason: string | null;
  escalated: boolean;
  doNotCall: boolean;
  appointmentId: string | null;
}

export function computeDisposition(input: DispositionInput): DispositionResult {
  const { snapshot } = input;
  const escalated = Boolean(input.transferred || input.escalationRequested || snapshot.humanRequested);
  const base = { escalated, doNotCall: snapshot.status === "do_not_call", appointmentId: input.appointmentId ?? null };

  if (snapshot.status === "do_not_call") {
    return { ...base, disposition: "do_not_call", reason: "the caller asked not to be contacted again" };
  }
  if (snapshot.status === "wrong_number") {
    return { ...base, disposition: "wrong_number", reason: "the number does not belong to the expected contact" };
  }
  if (input.appointmentId) {
    return { ...base, disposition: "appointment_booked", reason: null };
  }
  if (input.transferred) {
    return { ...base, disposition: "escalated_to_human", reason: "handed to a person during the call" };
  }
  if (snapshot.status === "callback_requested") {
    return { ...base, disposition: "callback_requested", reason: "the caller asked to be called back later" };
  }
  if (snapshot.status === "disqualified") {
    return { ...base, disposition: "not_qualified", reason: snapshot.disqualifiedReason };
  }
  if (escalated) {
    return { ...base, disposition: "escalated_to_human", reason: "a person was requested" };
  }
  if (input.turns === 0) {
    // The call never became a conversation: no outcome is the honest answer.
    return { ...base, disposition: "no_outcome", reason: "the call ended before any exchange" };
  }
  if (snapshot.status === "complete") {
    return { ...base, disposition: "qualified", reason: null };
  }
  if (Object.keys(snapshot.fields).length === 0) {
    return { ...base, disposition: "no_outcome", reason: "nothing was collected before the call ended" };
  }
  return {
    ...base,
    disposition: "not_qualified",
    reason: `qualification incomplete (${snapshot.unresolved.length > 0 ? `unresolved: ${snapshot.unresolved.join(", ")}` : "call ended early"})`,
  };
}

export { isTerminal };
