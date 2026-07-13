import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isLive,
} from "@/core/services/scheduling/appointment-state";

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
});
