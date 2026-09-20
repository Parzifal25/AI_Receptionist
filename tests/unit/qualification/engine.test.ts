import { describe, expect, it } from "vitest";
import { TELUGU_PACK } from "@halo/language/language-pack";
import { applyUtterance, emptySnapshot, qualificationPayload, type QualificationSnapshot } from "@halo/qualification/engine";
import { parseQualificationSchema } from "@halo/qualification/schema";
import { computeDisposition } from "@halo/qualification/disposition";
import { testSchema, TEST_SCHEMA_RAW } from "../../mocks/qualification-fixture";

const schema = testSchema();
const deps = { schema, pack: TELUGU_PACK };

/** Mirrors a real call: the greeting turn asks nothing, then answers arrive. */
function run(utterances: string[], from?: QualificationSnapshot) {
  let snapshot = from ?? applyUtterance(deps, emptySnapshot(), "").snapshot;
  const events = [];
  for (const utterance of utterances) {
    const result = applyUtterance(deps, snapshot, utterance);
    snapshot = result.snapshot;
    events.push(...result.events);
  }
  return { snapshot, events };
}

describe("qualification schema validation", () => {
  it("accepts a well-formed schema", () => {
    expect(parseQualificationSchema(TEST_SCHEMA_RAW).ok).toBe(true);
  });

  it.each([
    ["missing question in the schema language", { fields: [{ id: "a", type: "text", questions: { "en-IN": "x" } }] }],
    ["enum without options", { fields: [{ id: "a", type: "enum", questions: { "te-IN": "x" } }] }],
    ["confirm without a prompt", { fields: [{ id: "a", type: "text", confirm: true, questions: { "te-IN": "x" } }] }],
    ["disqualifier on a non-enum field", { fields: [{ id: "a", type: "text", questions: { "te-IN": "x" }, disqualifyWhen: { equals: ["y"], reason: "no" } }] }],
    ["skipWhen pointing at an unknown field", { fields: [{ id: "a", type: "text", questions: { "te-IN": "x" }, skipWhen: { field: "ghost", equals: ["y"] } }] }],
    ["duplicate ids", { fields: [{ id: "a", type: "text", questions: { "te-IN": "x" } }, { id: "a", type: "text", questions: { "te-IN": "y" } }] }],
  ])("rejects %s", (_label, override) => {
    const result = parseQualificationSchema({ version: "v", language: "te-IN", ...override });
    expect(result.ok).toBe(false);
  });
});

describe("qualification engine", () => {
  it("asks the schema's questions in order and never re-asks a filled field", () => {
    const first = applyUtterance(deps, emptySnapshot(), "");
    expect(first.snapshot.pendingFieldId).toBe("ownership");

    const second = applyUtterance(deps, first.snapshot, "ఇల్లు నాదే సొంతం");
    expect(second.snapshot.fields.ownership.value).toBe("owner");
    expect(second.snapshot.pendingFieldId).toBe("property_type");

    const third = applyUtterance(deps, second.snapshot, "ఇండిపెండెంట్ హౌస్");
    expect(third.snapshot.fields.property_type.value).toBe("independent_house");
    expect(third.snapshot.pendingFieldId).toBe("pincode");
    expect(third.snapshot.fields.ownership.value).toBe("owner");
  });

  it("keeps the caller's own words beside every normalized value", () => {
    const { snapshot } = run(["సొంత ఇల్లు"]);
    expect(snapshot.fields.ownership).toMatchObject({ value: "owner", raw: "సొంత ఇల్లు" });
    expect(qualificationPayload(snapshot).fields).toMatchObject({ ownership: { raw: "సొంత ఇల్లు", value: "owner" } });
  });

  it("fires a tenant-configured disqualifier and stops asking", () => {
    const { snapshot, events } = run(["అద్దె ఇల్లు"]);
    expect(snapshot.status).toBe("disqualified");
    expect(snapshot.disqualifiedReason).toBe("a tenant cannot authorise work on the roof");
    expect(snapshot.pendingFieldId).toBeNull();
    expect(events.some((e) => e.type === "disqualified")).toBe(true);
    // Nothing further is collected after a disqualification.
    const after = applyUtterance(deps, snapshot, "500081");
    expect(after.snapshot.fields.pincode).toBeUndefined();
  });

  it("confirms values it was told to confirm, and accepts a correction", () => {
    let { snapshot } = run(["సొంతం", "ఇండిపెండెంట్ హౌస్", "500081"]);
    expect(snapshot.awaitingConfirmationFieldId).toBe("pincode");
    expect(snapshot.fields.pincode.confirmed).toBe(false);

    // Caller corrects the number instead of confirming it.
    snapshot = applyUtterance(deps, snapshot, "కాదు, 500034").snapshot;
    expect(snapshot.fields.pincode.value).toBe("500034");
    snapshot = applyUtterance(deps, snapshot, "అవును").snapshot;
    expect(snapshot.fields.pincode).toMatchObject({ value: "500034", confirmed: true });
    expect(snapshot.pendingFieldId).toBe("monthly_bill");
  });

  it("does not accept an ambiguous bill on a bare yes — the unit must be stated", () => {
    let { snapshot } = run(["సొంతం", "ఇండిపెండెంట్ హౌస్", "500081", "అవును"]);
    snapshot = applyUtterance(deps, snapshot, "మూడు వేలు").snapshot;
    expect(snapshot.awaitingConfirmationFieldId).toBe("monthly_bill");
    expect(snapshot.fields.monthly_bill.unit).toBeUndefined();

    // A bare "yes" leaves it unresolved...
    const bareYes = applyUtterance(deps, snapshot, "అవును").snapshot;
    expect(bareYes.fields.monthly_bill.confirmed).toBe(false);
    expect(bareYes.awaitingConfirmationFieldId).toBe("monthly_bill");

    // ...but stating the unit resolves and confirms it.
    const clarified = applyUtterance(deps, snapshot, "మూడు వేల రూపాయలు").snapshot;
    expect(clarified.fields.monthly_bill).toMatchObject({ value: "3000", unit: "inr", confirmed: true });
    expect(clarified.awaitingConfirmationFieldId).toBeNull();
  });

  it("takes a clearly-stated bill in units without a confirmation round", () => {
    const { snapshot } = run(["సొంతం", "ఇండిపెండెంట్ హౌస్", "500081", "అవును", "మూడు వందల యూనిట్లు"]);
    expect(snapshot.fields.monthly_bill).toMatchObject({ value: "300", unit: "kwh" });
  });

  it("records 'I don't know' as unknown and moves on without re-asking", () => {
    const { snapshot, events } = run(["సొంతం", "ఇండిపెండెంట్ హౌస్", "నాకు తెలియదు"]);
    expect(snapshot.fields.pincode).toMatchObject({ unknown: true });
    expect(events.some((e) => e.type === "unknown")).toBe(true);
    expect(snapshot.pendingFieldId).toBe("monthly_bill");
  });

  it("bounds retries, marks the field unresolved and asks for a human when too many fail", () => {
    const { snapshot, events } = run([
      "సొంతం",
      "ఇండిపెండెంట్ హౌస్",
      "ఏమో అర్థం కాలేదు",
      "హలో హలో",
      "ఏంటి ఇది",
      "మళ్ళీ ఏంటో",
    ]);
    expect(events.some((e) => e.type === "unresolved")).toBe(true);
    expect(snapshot.unresolved.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.pendingFieldId).not.toBe("pincode");
    const many = { ...snapshot, unresolved: ["pincode", "monthly_bill"] };
    expect(applyUtterance(deps, many, "").snapshot.humanRequested).toBe(true);
  });

  it("skips fields their gate makes irrelevant", () => {
    const { snapshot } = run(["సొంతం", "అపార్ట్మెంట్", "500081", "అవును", "మూడు వేల రూపాయలు", "నా పేరు రమేష్", "అవును"]);
    expect(snapshot.fields.property_type.value).toBe("apartment");
    expect(snapshot.pendingFieldId).toBeNull();
    expect(snapshot.status).toBe("complete");
    expect(snapshot.fields.existing_system_kw).toBeUndefined();
  });

  it.each([
    ["మళ్ళీ కాల్ చేయకండి", "do_not_call"],
    ["రాంగ్ నంబర్", "wrong_number"],
    ["ippudu kudaradu, tarvatha cheyandi", "callback_requested"],
  ])("honours %s immediately", (utterance, status) => {
    const { snapshot } = run(["సొంతం", utterance]);
    expect(snapshot.status).toBe(status);
    expect(snapshot.pendingFieldId).toBeNull();
  });

  it("flags an explicit request for a person without ending the call", () => {
    const { snapshot } = run(["సొంతం", "నాకు మనిషితో మాట్లాడాలి"]);
    expect(snapshot.humanRequested).toBe(true);
    expect(snapshot.status).toBe("in_progress");
  });
});

describe("disposition", () => {
  const base = emptySnapshot();
  it.each([
    [{ snapshot: { ...base, status: "do_not_call" as const }, turns: 2 }, "do_not_call", true],
    [{ snapshot: { ...base, status: "wrong_number" as const }, turns: 1 }, "wrong_number", false],
    [{ snapshot: { ...base, status: "disqualified" as const, disqualifiedReason: "tenant" }, turns: 3 }, "not_qualified", false],
    [{ snapshot: { ...base, status: "callback_requested" as const }, turns: 2 }, "callback_requested", false],
    [{ snapshot: { ...base, status: "complete" as const }, turns: 6 }, "qualified", false],
    [{ snapshot: base, turns: 0 }, "no_outcome", false],
  ])("computes %o", (input, expected, doNotCall) => {
    const result = computeDisposition(input);
    expect(result.disposition).toBe(expected);
    expect(result.doNotCall).toBe(doNotCall);
  });

  it("prefers a real booking over everything else", () => {
    expect(computeDisposition({ snapshot: { ...base, status: "complete" }, appointmentId: "appt-1", turns: 8 }).disposition).toBe("appointment_booked");
  });

  it("records a transfer as escalated, and a partial call as not qualified", () => {
    expect(computeDisposition({ snapshot: base, transferred: true, turns: 3 }).disposition).toBe("escalated_to_human");
    const partial = computeDisposition({
      snapshot: { ...base, fields: { ownership: { value: "owner", raw: "సొంతం", confidence: 0.9, confirmed: true } }, unresolved: ["pincode"] },
      turns: 4,
    });
    expect(partial.disposition).toBe("not_qualified");
    expect(partial.reason).toContain("pincode");
  });
});
