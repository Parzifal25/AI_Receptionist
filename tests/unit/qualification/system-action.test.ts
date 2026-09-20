import { describe, expect, it } from "vitest";
import { TELUGU_PACK } from "@halo/language/language-pack";
import { QualificationSystemActionProvider } from "@halo/qualification/system-action";
import { emptyConversationState } from "@halo/runtime/conversation-state";
import { BUSINESS_A, makeTrusted } from "../../mocks/runtime-fakes";
import { testSchema } from "../../mocks/qualification-fixture";

const schema = testSchema();

function provider(signals?: () => { sttConfidence: number | null }) {
  return new QualificationSystemActionProvider({ schema, pack: TELUGU_PACK, ...(signals ? { signals } : {}) });
}

const input = (userMessage: string) => ({
  trusted: makeTrusted(),
  business: BUSINESS_A,
  history: [],
  userMessage,
  state: emptyConversationState(),
  now: new Date("2026-09-16T10:00:00Z"),
});

describe("qualification system action (ground truth for the model)", () => {
  it("hands the model the tenant's own next question, verbatim", async () => {
    const p = provider();
    const outcome = (await p.prepare(input("హలో")))!;
    expect(outcome.sections[0]).toContain("ఇల్లు మీ సొంతమా లేక అద్దెకా?");
    expect(outcome.sections[0]).toContain("ASK EXACTLY THIS NEXT");
    expect(outcome.statePatch?.workflowStep).toBe("qualifying");
    expect(outcome.actions).toHaveLength(0);
  });

  it("reports collected values and asks for a confirmation when one is pending", async () => {
    const p = provider();
    await p.prepare(input("హలో"));
    await p.prepare(input("సొంతం"));
    await p.prepare(input("ఇండిపెండెంట్ హౌస్"));
    const outcome = (await p.prepare(input("500081")))!;
    expect(outcome.sections[0]).toContain("ownership = owner");
    expect(outcome.sections[0]).toContain("CONFIRM THIS AND NOTHING ELSE");
    expect(outcome.sections[0]).toContain("500081");
  });

  it("forces a read-back when the caller was heard poorly, whatever the parser thought", async () => {
    const p = provider(() => ({ sttConfidence: 0.3 }));
    await p.prepare(input("హలో"));
    const outcome = (await p.prepare(input("సొంతం")))!;
    expect(outcome.sections[0]).toContain("CONFIRM THIS AND NOTHING ELSE");
    expect(p.current().awaitingConfirmationFieldId).toBe("ownership");
  });

  it("closes the conversation on a disqualifier, with no pitch and no visit", async () => {
    const p = provider();
    await p.prepare(input("హలో"));
    const outcome = (await p.prepare(input("అద్దె ఇల్లు")))!;
    expect(outcome.sections[0]).toContain("does not qualify");
    expect(outcome.sections[0]).toContain("do not offer a visit");
    expect(outcome.statePatch?.workflowStep).toBe("closed");
  });

  it("honours do-not-call immediately and records it in state", async () => {
    const p = provider();
    await p.prepare(input("హలో"));
    const outcome = (await p.prepare(input("మళ్ళీ కాల్ చేయకండి")))!;
    expect(outcome.sections[0]).toContain("asked not to be contacted again");
    expect(outcome.statePatch?.workflowStep).toBe("closed");
    expect(p.current().status).toBe("do_not_call");
  });

  it("writes only bounded, string-valued slots into conversation state", async () => {
    const p = provider();
    await p.prepare(input("హలో"));
    await p.prepare(input("సొంతం"));
    const outcome = (await p.prepare(input("ఇండిపెండెంట్ హౌస్")))!;
    expect(outcome.statePatch?.qualification).toEqual({ ownership: "owner", property_type: "independent_house" });
    for (const value of Object.values(outcome.statePatch!.qualification!)) {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeLessThanOrEqual(240);
    }
  });
});
