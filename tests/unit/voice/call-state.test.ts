import { describe, expect, it } from "vitest";
import { CALL_STATES, TERMINAL_CALL_STATES } from "@halo/core/domain/voice";
import {
  assertCallTransition,
  callTransitionTable,
  canTransitionCall,
  initialCallState,
  isTerminalCallState,
  pathToCallState,
} from "@halo/voice/call-state";

describe("call state machine", () => {
  it("inbound calls start ringing, outbound calls start created", () => {
    expect(initialCallState("inbound")).toBe("ringing");
    expect(initialCallState("outbound")).toBe("created");
  });

  it("walks the happy inbound path", () => {
    const path = ["ringing", "connected", "in_conversation", "completing", "completed"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransitionCall(path[i - 1], path[i])).toBe(true);
  });

  it("walks the happy outbound path including dial states", () => {
    const path = ["created", "queued", "dialing", "ringing", "connected", "in_conversation", "completing", "completed"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransitionCall(path[i - 1], path[i])).toBe(true);
  });

  it("protects every terminal state", () => {
    for (const terminal of TERMINAL_CALL_STATES) {
      expect(isTerminalCallState(terminal)).toBe(true);
      for (const to of CALL_STATES) expect(canTransitionCall(terminal, to)).toBe(false);
    }
  });

  it("allows an interrupted call to recover once or finalize", () => {
    expect(canTransitionCall("in_conversation", "interrupted")).toBe(true);
    expect(canTransitionCall("interrupted", "in_conversation")).toBe(true);
    expect(canTransitionCall("interrupted", "completing")).toBe(true);
    expect(canTransitionCall("interrupted", "transferred")).toBe(false);
  });

  it("rejects illegal transitions with a typed conflict", () => {
    expect(() => assertCallTransition("ringing", "completed")).toThrowError(/Cannot move call/);
    expect(() => assertCallTransition("completed", "in_conversation")).toThrowError(/Cannot move call/);
    try {
      assertCallTransition("busy", "connected");
    } catch (error) {
      expect((error as { code: string }).code).toBe("CONFLICT");
    }
  });

  it("every non-terminal state can fail", () => {
    for (const state of CALL_STATES) {
      if (isTerminalCallState(state)) continue;
      expect(canTransitionCall(state, "failed")).toBe(true);
    }
  });

  it("finds legal intermediate paths for skipped provider statuses", () => {
    expect(pathToCallState("in_conversation", "completed")).toEqual(["completing", "completed"]);
    expect(pathToCallState("ringing", "in_conversation")).toEqual(["connected", "in_conversation"]);
    expect(pathToCallState("completed", "failed")).toBeNull();
    expect(pathToCallState("connected", "connected")).toEqual([]);
  });

  it("the table covers every state exactly once", () => {
    expect(Object.keys(callTransitionTable()).sort()).toEqual([...CALL_STATES].sort());
  });
});
