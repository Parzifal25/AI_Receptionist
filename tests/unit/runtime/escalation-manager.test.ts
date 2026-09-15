import { describe, expect, it } from "vitest";
import { emptyConversationState } from "@halo/runtime/conversation-state";
import { decideEscalation, type EscalationInput } from "@halo/runtime/escalation-manager";

function input(overrides: Partial<EscalationInput> = {}): EscalationInput {
  return {
    userMessage: "what are your hours?",
    state: emptyConversationState(),
    actions: [],
    toolResults: [],
    guardrailTriggers: [],
    unansweredStreak: 0,
    validationFallbackUsed: false,
    ...overrides,
  };
}

describe("escalation manager (Phase 2, WS12)", () => {
  it("does not escalate an ordinary turn", () => {
    expect(decideEscalation(input())).toMatchObject({ escalate: false, recommendedAction: "none" });
  });

  it("escalates an explicit request for a person", () => {
    for (const message of ["Can I talk to a real person?", "let me speak with someone", "transfer me to a manager", "I want a human please"]) {
      expect(decideEscalation(input({ userMessage: message }))).toMatchObject({ escalate: true, reason: "explicit_human_request", recommendedAction: "offer_callback" });
    }
    expect(decideEscalation(input({ userMessage: "how many people work there?" })).escalate).toBe(false);
  });

  it("escalates tenant-configured sensitive triggers with high priority", () => {
    const decision = decideEscalation(input({ userMessage: "I think there is a GAS LEAK in the kitchen", guardrailTriggers: ["gas leak", "lawsuit"] }));
    expect(decision).toMatchObject({ escalate: true, reason: "sensitive_situation", priority: "high" });
  });

  it("escalates a failed action that needs a human, but not a recoverable one", () => {
    const recoverable = decideEscalation(input({ actions: [{ source: "system", name: "book_appointment", status: "failed", claimsPermitted: [], summary: "slot taken", needsHuman: false }] }));
    expect(recoverable.escalate).toBe(false);
    const needsHuman = decideEscalation(input({ actions: [{ source: "system", name: "book_appointment", status: "failed", claimsPermitted: [], summary: "invalid", needsHuman: true }] }));
    expect(needsHuman).toMatchObject({ escalate: true, reason: "action_failed" });
  });

  it("escalates when the validated reply fell back (low confidence)", () => {
    expect(decideEscalation(input({ validationFallbackUsed: true }))).toMatchObject({ escalate: true, reason: "low_confidence" });
  });

  it("escalates unsupported requests (the model wanted a tool the agent lacks)", () => {
    const decision = decideEscalation(input({ toolResults: [{ intentId: "x", name: "refund", status: "rejected", summary: "", claimsPermitted: [], rejection: "unknown_tool" }] }));
    expect(decision).toMatchObject({ escalate: true, reason: "unsupported_request", priority: "low" });
  });

  it("escalates repeated misunderstanding after three unanswered questions", () => {
    expect(decideEscalation(input({ unansweredStreak: 2 })).escalate).toBe(false);
    expect(decideEscalation(input({ unansweredStreak: 3 }))).toMatchObject({ escalate: true, reason: "repeated_misunderstanding" });
  });

  it("honours a tool executor's escalation request first", () => {
    const decision = decideEscalation(
      input({
        userMessage: "gas leak",
        guardrailTriggers: ["gas leak"],
        toolResults: [{ intentId: "x", name: "request_human_handoff", status: "succeeded", summary: "", claimsPermitted: [], escalation: { reason: "explicit_human_request", priority: "normal" } }],
      }),
    );
    expect(decision.reason).toBe("explicit_human_request");
    expect(decision.summary).not.toMatch(/gas leak/);
  });
});
