import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  assertTransition,
  canTransition,
  isInFlight,
  isLive,
} from "@halo/scheduling/appointment-state";

describe("appointment state machine", () => {
  it("allows the legal lifecycle paths", () => {
    expect(canTransition("pending", "confirmed")).toBe(true);
    expect(canTransition("pending", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "completed")).toBe(true);
    expect(canTransition("confirmed", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "no_show")).toBe(true);
  });

  it("blocks resurrection from terminal states", () => {
    expect(canTransition("cancelled", "confirmed")).toBe(false);
    expect(canTransition("completed", "cancelled")).toBe(false);
    expect(canTransition("no_show", "confirmed")).toBe(false);
    expect(canTransition("pending", "completed")).toBe(false); // must confirm first
  });

  it("assertTransition throws a conflict on illegal moves", () => {
    expect(() => assertTransition("cancelled", "confirmed")).toThrowError(/cannot move/i);
    expect(() => assertTransition("pending", "confirmed")).not.toThrow();
  });

  it("only live appointments hold their slot", () => {
    expect(isLive("pending")).toBe(true);
    expect(isLive("confirmed")).toBe(true);
    expect(isLive("cancelled")).toBe(false);
    expect(isLive("completed")).toBe(false);
  });

  it("supports the day-of flow: confirmed → checked_in → in_progress → completed", () => {
    expect(canTransition("confirmed", "checked_in")).toBe(true);
    expect(canTransition("confirmed", "running_late")).toBe(true);
    expect(canTransition("running_late", "checked_in")).toBe(true);
    expect(canTransition("checked_in", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "completed")).toBe(true);
    // Walk-straight-out shortcuts are legal too.
    expect(canTransition("confirmed", "in_progress")).toBe(true);
    expect(canTransition("checked_in", "completed")).toBe(true);
  });

  it("blocks nonsense day-of moves", () => {
    expect(canTransition("pending", "checked_in")).toBe(false); // must confirm first
    expect(canTransition("checked_in", "no_show")).toBe(false); // they're here
    expect(canTransition("in_progress", "no_show")).toBe(false);
    expect(canTransition("completed", "in_progress")).toBe(false);
  });

  it("in-flight statuses hold the slot but are no longer visitor-changeable", () => {
    for (const status of ["checked_in", "running_late", "in_progress"] as const) {
      expect(ACTIVE_STATUSES).toContain(status);
      expect(isInFlight(status)).toBe(true);
    }
    expect(isLive("running_late")).toBe(true); // late visitors can still reschedule
    expect(isLive("checked_in")).toBe(false);
    expect(isLive("in_progress")).toBe(false);
  });
});
