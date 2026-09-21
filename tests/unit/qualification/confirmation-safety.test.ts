import { describe, expect, it } from "vitest";
import { ENGLISH_PACK } from "@halo/language/language-pack";
import { applyUtterance, emptySnapshot, type QualificationSnapshot } from "@halo/qualification/engine";
import { parseQualificationSchema } from "@halo/qualification/schema";

/**
 * Phase 4 regressions — the read-back loop.
 *
 * Found by the Arunodhaya golden corpus: a caller who does not answer a
 * read-back had their answer to the NEXT question stored against the field
 * being confirmed, and every answer after that landed one field out. On a
 * real call that silently scrambles the entire lead, and nothing errors.
 */

const schema = (() => {
  const parsed = parseQualificationSchema({
    version: "t1",
    language: "en-IN",
    maxUnresolvedFields: 2,
    fields: [
      { id: "name", type: "name", questions: { "en-IN": "Your name?" }, maxAttempts: 2 },
      { id: "area", type: "text", questions: { "en-IN": "Which area?" }, maxAttempts: 2 },
      {
        id: "phone",
        type: "phone",
        questions: { "en-IN": "Best number?" },
        confirm: true,
        confirmPrompts: { "en-IN": "{value} — correct?" },
        maxAttempts: 2,
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.schema;
})();

const deps = { schema, pack: ENGLISH_PACK };
const step = (snapshot: QualificationSnapshot, text: string) => applyUtterance(deps, snapshot, text).snapshot;

describe("read-back safety", () => {
  it("does not fill a field the engine has not asked about yet", () => {
    // The greeting turn: nothing is pending, so nothing is captured.
    const snapshot = step(emptySnapshot(), "hello there");
    expect(snapshot.fields).toEqual({});
    expect(snapshot.pendingFieldId).toBe("name");
  });

  it("gives the next question the answer instead of overwriting the field being confirmed", () => {
    let snapshot = step(emptySnapshot(), "hello");
    snapshot = step(snapshot, "Ramesh");
    expect(snapshot.awaitingConfirmationFieldId).toBe("name");

    // The caller ploughs on and answers the next question.
    snapshot = step(snapshot, "Kukatpally");
    expect(snapshot.fields.name?.value).toBe("Ramesh");
    expect(snapshot.fields.name?.confirmed).toBe(false);
    expect(snapshot.fields.area?.value).toBe("Kukatpally");
  });

  it("never reads back a free-text answer, whose value is the caller's own words", () => {
    let snapshot = step(emptySnapshot(), "hello");
    snapshot = step(snapshot, "Ramesh");
    snapshot = step(snapshot, "Kukatpally");
    expect(snapshot.awaitingConfirmationFieldId).toBeNull();
  });

  it("still reads back an explicitly-confirmed field, and keeps the value if the caller talks past it", () => {
    let snapshot = step(emptySnapshot(), "hello");
    snapshot = step(snapshot, "Ramesh");
    snapshot = step(snapshot, "Kukatpally");
    snapshot = step(snapshot, "9876543210");
    expect(snapshot.awaitingConfirmationFieldId).toBe("phone");
    expect(snapshot.fields.phone?.value).toBe("+919876543210");

    // An unrelated reply must not destroy a captured phone number.
    snapshot = step(snapshot, "actually who is this");
    expect(snapshot.fields.phone?.value).toBe("+919876543210");
    expect(snapshot.fields.phone?.confirmed).toBe(false);
  });

  it("accepts a bare number during a read-back as a correction", () => {
    let snapshot = step(emptySnapshot(), "hello");
    snapshot = step(snapshot, "Ramesh");
    snapshot = step(snapshot, "Kukatpally");
    snapshot = step(snapshot, "9876543210");
    snapshot = step(snapshot, "9123456780");
    expect(snapshot.fields.phone?.value).toBe("+919123456780");
  });

  it("drops the value on an explicit 'no' with no correction, and asks again", () => {
    let snapshot = step(emptySnapshot(), "hello");
    snapshot = step(snapshot, "Ramesh");
    snapshot = step(snapshot, "Kukatpally");
    snapshot = step(snapshot, "9876543210");
    snapshot = step(snapshot, "no that's wrong");
    expect(snapshot.fields.phone).toBeUndefined();
    expect(snapshot.pendingFieldId).toBe("phone");
  });

  it("confirms on a plain yes", () => {
    let snapshot = step(emptySnapshot(), "hello");
    snapshot = step(snapshot, "Ramesh");
    snapshot = step(snapshot, "Kukatpally");
    snapshot = step(snapshot, "9876543210");
    snapshot = step(snapshot, "yes that's right");
    expect(snapshot.fields.phone?.confirmed).toBe(true);
    expect(snapshot.status).toBe("complete");
  });

  it("does not count an answered-but-unconfirmed field as unresolved", () => {
    let snapshot = step(emptySnapshot(), "hello");
    snapshot = step(snapshot, "Ramesh");
    snapshot = step(snapshot, "Kukatpally");
    snapshot = step(snapshot, "9876543210");
    snapshot = step(snapshot, "what is this about");
    snapshot = step(snapshot, "sorry what");
    // The number was captured; "unresolved" means never obtained, and
    // wrongly counting it drives a good call towards a human.
    expect(snapshot.unresolved).not.toContain("phone");
    expect(snapshot.humanRequested).toBe(false);
  });
});
