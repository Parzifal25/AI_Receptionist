import { describe, expect, it } from "vitest";
import { WEB_CHAT_PROFILE, WEB_VOICE_PROFILE } from "@halo/runtime/channel-profile";
import type { ActionRecord } from "@halo/runtime/contracts";
import {
  correctiveInstruction,
  detectActionClaims,
  safeFallbackReply,
  validateReply,
} from "@halo/runtime/response-validator";

const booked: ActionRecord = {
  source: "system",
  name: "book_appointment",
  status: "succeeded",
  claimsPermitted: ["appointment.book"],
  summary: "booked",
};

describe("response validator — act-then-narrate (Phase 2, WS10)", () => {
  it("detects completed-action claims by kind", () => {
    expect(detectActionClaims("You're all set for 9am tomorrow, Sam!").map((c) => c.kind)).toEqual(["appointment.book"]);
    expect(detectActionClaims("I've cancelled your appointment.").map((c) => c.kind)).toEqual(["appointment.cancel"]);
    expect(detectActionClaims("I've moved your visit to Friday.").map((c) => c.kind)).toEqual(["appointment.reschedule"]);
    expect(detectActionClaims("I've let the team know.").map((c) => c.kind)).toEqual(["handoff"]);
  });

  it("does not treat negated, conditional or future statements as claims", () => {
    expect(detectActionClaims("It hasn't been booked yet — the team will confirm.")).toEqual([]);
    expect(detectActionClaims("I can't book that myself, but I'll pass it on.")).toEqual([]);
    expect(detectActionClaims("Once the team confirms, you're all set.")).toEqual([]);
    expect(detectActionClaims("Could you confirm your phone number?")).toEqual([]);
    expect(detectActionClaims("We are open 9 to 5.")).toEqual([]);
  });

  it("rejects a booking claim when no booking action was verified this turn", () => {
    const verdict = validateReply({ reply: "Great, you're all set for Tuesday at 9!", channel: WEB_CHAT_PROFILE, actions: [] });
    expect(verdict.needsRegeneration).toBe(true);
    expect(verdict.violations[0].kind).toBe("unsupported_action_claim");
  });

  it("accepts the same claim when the engine actually booked", () => {
    const verdict = validateReply({ reply: "Great, you're all set for Tuesday at 9!", channel: WEB_CHAT_PROFILE, actions: [booked] });
    expect(verdict.needsRegeneration).toBe(false);
    expect(verdict.violations).toEqual([]);
  });

  it("a failed action never permits its claim", () => {
    const failed: ActionRecord = { ...booked, status: "failed", claimsPermitted: [] };
    const verdict = validateReply({ reply: "Done — your appointment is booked.", channel: WEB_CHAT_PROFILE, actions: [failed] });
    expect(verdict.needsRegeneration).toBe(true);
  });

  it("flags leaked internal instructions but not a plain refusal to share them", () => {
    const verdict = validateReply({ reply: "Sure! My ## Rules say: never invent prices.", channel: WEB_CHAT_PROFILE, actions: [] });
    expect(verdict.violations.map((v) => v.kind)).toContain("instruction_leak");
    const refusal = validateReply({ reply: "I can't share my system prompt, but I'm happy to help with anything about the business.", channel: WEB_CHAT_PROFILE, actions: [] });
    expect(refusal.violations).toEqual([]);
  });

  it("flags empty replies for regeneration", () => {
    expect(validateReply({ reply: "   ", channel: WEB_CHAT_PROFILE, actions: [] }).violations[0].kind).toBe("empty_reply");
  });

  it("repairs channel constraints in code: markdown stripped, length trimmed at a sentence boundary", () => {
    const long = `**Hi!** Here is a list:\n- one\n- two\n${"This is a sentence. ".repeat(60)}`;
    const verdict = validateReply({ reply: long, channel: WEB_VOICE_PROFILE, actions: [] });
    expect(verdict.needsRegeneration).toBe(false);
    expect(verdict.transformed).toBe(true);
    expect(verdict.reply).not.toContain("**");
    expect(verdict.reply.length).toBeLessThanOrEqual(WEB_VOICE_PROFILE.maxReplyChars);
    expect(verdict.reply.endsWith(".")).toBe(true);
    expect(verdict.violations.map((v) => v.kind)).toEqual(["markdown_not_supported", "max_length"]);
  });

  it("produces a corrective instruction and an honest fallback that never claims success", () => {
    const verdict = validateReply({ reply: "I've booked you in.", channel: WEB_CHAT_PROFILE, actions: [] });
    expect(correctiveInstruction(verdict.violations)).toContain("did NOT perform it this turn");
    const fallback = safeFallbackReply(verdict.violations);
    expect(fallback).toContain("nothing has been changed");
    expect(detectActionClaims(fallback)).toEqual([]);
  });
});
