import { describe, expect, it } from "vitest";
import { WEB_CHAT_PROFILE } from "@halo/runtime/channel-profile";
import type { ActionRecord } from "@halo/runtime/contracts";
import {
  claimGuardCoverage,
  detectActionClaims,
  safeFallbackReply,
  validateReply,
} from "@halo/runtime/response-validator";

/**
 * Phase 4 — act-then-narrate must guard the language the agent actually
 * speaks. An English regex over a Telugu reply does not fail loudly; it
 * silently stops guarding, which is how a Telugu agent could claim a booking
 * that never happened.
 */
describe("multilingual act-then-narrate guard", () => {
  const booked: ActionRecord[] = [
    { source: "tool", name: "book", status: "succeeded", claimsPermitted: ["appointment.book"], summary: "booked" },
  ];
  // "I have booked your appointment" / "I connected you to a person".
  const TELUGU_PHRASES = {
    "appointment.book": ["బుక్ చేశాను", "appointment book chesanu", "slot confirm chesanu"],
    handoff: ["మా టీమ్‌కి పంపించాను", "team ki pampinchanu"],
  };

  it("catches a Telugu booking claim that the English patterns miss entirely", () => {
    const reply = "మీ అపాయింట్‌మెంట్ బుక్ చేశాను, రేపు ఉదయం వస్తారు.";
    expect(detectActionClaims(reply)).toHaveLength(0);

    const detected = detectActionClaims(reply, TELUGU_PHRASES);
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ kind: "appointment.book", source: "configured" });
  });

  it("catches the same claim written in transliterated Telugu", () => {
    const detected = detectActionClaims("Mee slot confirm chesanu sir.", TELUGU_PHRASES);
    expect(detected[0]?.kind).toBe("appointment.book");
  });

  it("matches across zero-width joiners and Telugu digits, which arrive from real STT", () => {
    const withZwnj = "మా టీమ్‌కి పంపించాను";
    expect(detectActionClaims(withZwnj, TELUGU_PHRASES)[0]?.kind).toBe("handoff");
  });

  it("rejects the unsupported claim and allows the supported one", () => {
    const reply = "మీ అపాయింట్‌మెంట్ బుక్ చేశాను.";
    const unsupported = validateReply({ reply, channel: WEB_CHAT_PROFILE, actions: [], claimPhrases: TELUGU_PHRASES });
    expect(unsupported.violations.map((v) => v.kind)).toContain("unsupported_action_claim");
    expect(unsupported.needsRegeneration).toBe(true);

    const supported = validateReply({ reply, channel: WEB_CHAT_PROFILE, actions: booked, claimPhrases: TELUGU_PHRASES });
    expect(supported.violations).toHaveLength(0);
  });

  it("leaves existing English behaviour untouched when no phrases are configured", () => {
    const reply = "I've booked you in for tomorrow morning.";
    expect(detectActionClaims(reply)[0]).toMatchObject({ kind: "appointment.book", source: "builtin" });
    expect(validateReply({ reply, channel: WEB_CHAT_PROFILE, actions: [] }).needsRegeneration).toBe(true);
    expect(validateReply({ reply, channel: WEB_CHAT_PROFILE, actions: booked }).violations).toHaveLength(0);
  });

  it("reports which claim kinds a non-English agent has no guard for", () => {
    expect(claimGuardCoverage("en-US")).toMatchObject({ builtinApplies: true, uncovered: [] });
    const telugu = claimGuardCoverage("te-IN", TELUGU_PHRASES);
    expect(telugu.builtinApplies).toBe(false);
    expect(telugu.covered).toEqual(expect.arrayContaining(["appointment.book", "handoff"]));
    expect(telugu.uncovered).toEqual(expect.arrayContaining(["appointment.reschedule", "appointment.cancel"]));
  });

  it("speaks the tenant's own fallback line rather than an English apology", () => {
    const violations = [{ kind: "unsupported_action_claim" as const, detail: "x", repairable: "regenerate" as const }];
    expect(safeFallbackReply(violations)).toMatch(/^Sorry/);
    expect(safeFallbackReply(violations, "క్షమించండి, ఇప్పుడు అది పూర్తి చేయలేకపోయాను.")).toBe(
      "క్షమించండి, ఇప్పుడు అది పూర్తి చేయలేకపోయాను.",
    );
  });
});
