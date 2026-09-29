import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canTransitionLead, LEAD_STATES, LEAD_TRANSITIONS, leadStateForOutcome } from "@halo/crm/lead-lifecycle";

describe("generic lead lifecycle", () => {
  it("keeps DNC terminal and permits suppression from every state", () => {
    for (const state of LEAD_STATES) {
      expect(canTransitionLead(state, "DO_NOT_CONTACT")).toBe(true);
      expect(canTransitionLead("DO_NOT_CONTACT", state)).toBe(state === "DO_NOT_CONTACT");
    }
  });
  it("does not let routine activity resurrect closed leads", () => {
    expect(canTransitionLead("CONVERTED", "CONTACTING")).toBe(false);
    expect(canTransitionLead("LOST", "QUALIFIED")).toBe(false);
    expect(canTransitionLead("FOLLOW_UP_REQUIRED", "CONTACTING")).toBe(true);
  });
  it("maps only meaningful verified outcomes", () => {
    expect(leadStateForOutcome("no_outcome")).toBeNull();
    expect(leadStateForOutcome("appointment_booked")).toBe("APPOINTMENT_BOOKED");
    expect(leadStateForOutcome("wrong_number")).toBe("DO_NOT_CONTACT");
  });
  it("keeps the SQL transition graph identical to application policy", () => {
    const sql = readFileSync("supabase/migrations/0024_lead_lifecycle.sql", "utf8");
    for (const [state, targets] of Object.entries(LEAD_TRANSITIONS)) {
      expect(sql).toContain(`when '${state}' then new_state = any(array[${targets.map(s => `'${s}'`).join(",")}]::text[])`);
    }
  });
});
