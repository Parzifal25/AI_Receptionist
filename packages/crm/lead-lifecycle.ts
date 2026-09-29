import type { CallDisposition } from "@halo/core/domain/voice";

export const LEAD_STATES = ["NEW", "CONTACTING", "CONNECTED", "QUALIFYING", "QUALIFIED", "UNQUALIFIED",
  "APPOINTMENT_PENDING", "APPOINTMENT_BOOKED", "FOLLOW_UP_REQUIRED", "NURTURE", "CONVERTED", "LOST", "DO_NOT_CONTACT"] as const;
export type LeadState = typeof LEAD_STATES[number];
export const LEAD_TRANSITIONS: Readonly<Record<LeadState, readonly LeadState[]>> = {
  NEW: ["CONTACTING", "CONNECTED", "QUALIFYING", "QUALIFIED", "UNQUALIFIED", "APPOINTMENT_BOOKED", "FOLLOW_UP_REQUIRED", "LOST"],
  CONTACTING: ["CONNECTED", "QUALIFYING", "QUALIFIED", "UNQUALIFIED", "APPOINTMENT_BOOKED", "FOLLOW_UP_REQUIRED", "NURTURE", "LOST"],
  CONNECTED: ["QUALIFYING", "QUALIFIED", "UNQUALIFIED", "APPOINTMENT_PENDING", "APPOINTMENT_BOOKED", "FOLLOW_UP_REQUIRED", "LOST"],
  QUALIFYING: ["QUALIFIED", "UNQUALIFIED", "APPOINTMENT_PENDING", "APPOINTMENT_BOOKED", "FOLLOW_UP_REQUIRED", "LOST"],
  QUALIFIED: ["APPOINTMENT_PENDING", "APPOINTMENT_BOOKED", "FOLLOW_UP_REQUIRED", "CONVERTED", "LOST"],
  UNQUALIFIED: ["NURTURE", "LOST"],
  APPOINTMENT_PENDING: ["APPOINTMENT_BOOKED", "FOLLOW_UP_REQUIRED", "LOST"],
  APPOINTMENT_BOOKED: ["FOLLOW_UP_REQUIRED", "CONVERTED", "LOST"],
  FOLLOW_UP_REQUIRED: ["CONTACTING", "CONNECTED", "QUALIFYING", "QUALIFIED", "UNQUALIFIED", "APPOINTMENT_PENDING", "APPOINTMENT_BOOKED", "NURTURE", "CONVERTED", "LOST"],
  NURTURE: ["CONTACTING", "CONNECTED", "FOLLOW_UP_REQUIRED", "LOST"],
  CONVERTED: [], LOST: [], DO_NOT_CONTACT: [],
};
export function canTransitionLead(from: LeadState, to: LeadState): boolean {
  return from === to || to === "DO_NOT_CONTACT" || LEAD_TRANSITIONS[from].includes(to);
}
/** Only verified call outcomes enter here; model text is not an outcome. */
export function leadStateForOutcome(disposition: CallDisposition): LeadState | null {
  switch (disposition) {
    case "qualified": return "QUALIFIED";
    case "not_qualified": return "UNQUALIFIED";
    case "appointment_booked": return "APPOINTMENT_BOOKED";
    case "callback_requested": return "FOLLOW_UP_REQUIRED";
    case "not_interested": return "LOST";
    case "do_not_call": case "wrong_number": return "DO_NOT_CONTACT";
    default: return null;
  }
}
