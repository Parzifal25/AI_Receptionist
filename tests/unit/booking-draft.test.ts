import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  commitSlot,
  describeDraft,
  extractDraftFromMessage,
  extractLabeledFields,
  extractNameHint,
  hasDraftContent,
  mergeDraft,
  missingFields,
  resolveSlot,
  type BookingDraft,
} from "@halo/scheduling/booking-draft";
import type { TimeSlot } from "@halo/core/domain/scheduling";

/**
 * The draft is the conversation's memory of a booking. These tests pin the
 * two properties the receptionist's behaviour depends on: one message can
 * fill many fields, and a later message updates the draft instead of
 * restarting it.
 */

const NOW = new Date("2026-07-13T12:00:00Z"); // Monday 8am ET
const TZ = "America/New_York";

const slot9am: TimeSlot = {
  staffId: "s1",
  staffName: "Alex",
  startsAt: "2026-07-14T13:00:00.000Z", // Tue 9:00 ET
  endsAt: "2026-07-14T14:00:00.000Z",
};
const slot2pm: TimeSlot = {
  staffId: "s1",
  staffName: "Alex",
  startsAt: "2026-07-14T18:00:00.000Z", // Tue 14:00 ET
  endsAt: "2026-07-14T19:00:00.000Z",
};

function draftOf(patch: Partial<BookingDraft>): BookingDraft {
  return { ...EMPTY_DRAFT, ...patch };
}

describe("labelled field extraction", () => {
  it("reads a multi-line form paste as one update", () => {
    const patch = extractLabeledFields(
      ["Name:", "John", "", "Phone:", "+1 555 0100", "", "Email:", "john@example.com"].join("\n"),
    );
    expect(patch).toEqual({ name: "John", phone: "+1 555 0100", email: "john@example.com" });
  });

  it("reads inline labels on a single line", () => {
    expect(
      extractLabeledFields("Name: John Doe, phone: 555-010-0100, service: teeth cleaning"),
    ).toEqual({ name: "John Doe", phone: "555-010-0100", service: "teeth cleaning" });
  });

  it("ignores values that contradict their label", () => {
    // "email: soon" is not an email, and "phone: later" is not a number.
    expect(extractLabeledFields("email: soon\nphone: later")).toEqual({});
  });

  it("returns nothing when there are no labels", () => {
    expect(extractLabeledFields("do you have anything tomorrow?")).toEqual({});
  });
});

describe("name hints", () => {
  it.each([
    ["I'm John", "John"],
    ["my name is john smith", "John Smith"],
    ["this is Priya", "Priya"],
  ])("reads %s", (text, expected) => {
    expect(extractNameHint(text)).toBe(expected);
  });

  it.each(["I'm looking for a quote", "I'm not sure yet", "I'm free at 3"])(
    "does not mistake %s for a name",
    (text) => {
      expect(extractNameHint(text)).toBe("");
    },
  );
});

describe("extractDraftFromMessage", () => {
  it("pulls every detail out of one message", () => {
    const patch = extractDraftFromMessage(
      "Hi, I'm Sam — can I book AC servicing tomorrow at 9am? Phone: +1 555 0100, email sam@example.com",
      NOW,
      TZ,
    );
    expect(patch).toMatchObject({
      name: "Sam",
      phone: "+1 555 0100",
      email: "sam@example.com",
      date: "2026-07-14",
      time: "09:00",
    });
  });

  it("does not read digits inside an email as a phone number", () => {
    const patch = extractDraftFromMessage("reach me at sam1234567@example.com", NOW, TZ);
    expect(patch.email).toBe("sam1234567@example.com");
    expect(patch.phone).toBeUndefined();
  });

  it("pins a date only for a single-day window", () => {
    expect(extractDraftFromMessage("tomorrow works", NOW, TZ).date).toBe("2026-07-14");
    expect(extractDraftFromMessage("sometime next week", NOW, TZ).date).toBeUndefined();
  });

  it("extracts nothing from a message with no booking detail", () => {
    expect(extractDraftFromMessage("sounds good, thanks!", NOW, TZ)).toEqual({});
  });
});

describe("mergeDraft", () => {
  it("updates rather than restarts, and lets the latest correction win", () => {
    let draft = mergeDraft(EMPTY_DRAFT, { service: "AC servicing", name: "Sam" });
    draft = mergeDraft(draft, { phone: "+1 555 0100" });
    expect(draft).toMatchObject({ service: "AC servicing", name: "Sam", phone: "+1 555 0100" });

    draft = mergeDraft(draft, { phone: "+1 555 0199" });
    expect(draft.phone).toBe("+1 555 0199");
  });

  it("never clears a known value with an empty one", () => {
    const draft = mergeDraft(draftOf({ name: "Sam" }), { name: "", service: "  " });
    expect(draft.name).toBe("Sam");
    expect(draft.service).toBe("");
  });

  it("drops the time commitment when the visitor changes the time", () => {
    const committed = draftOf({ date: "2026-07-14", time: "09:00", timeCommitted: true });
    expect(mergeDraft(committed, { time: "14:00" }).timeCommitted).toBe(false);
    // An unrelated detail leaves the agreed time standing.
    expect(mergeDraft(committed, { phone: "+1 555 0100" }).timeCommitted).toBe(true);
  });
});

describe("resolveSlot", () => {
  it("matches the visitor's wall clock against real slots", () => {
    const draft = draftOf({ date: "2026-07-14", time: "09:00" });
    expect(resolveSlot(draft, [slot9am, slot2pm], TZ)).toBe(slot9am);
  });

  it("returns null when the requested time is not open", () => {
    expect(resolveSlot(draftOf({ date: "2026-07-14", time: "11:00" }), [slot9am], TZ)).toBeNull();
  });

  it("refuses to guess when a bare hour exists on several days", () => {
    const nextDay: TimeSlot = {
      ...slot9am,
      startsAt: "2026-07-15T13:00:00.000Z",
      endsAt: "2026-07-15T14:00:00.000Z",
    };
    expect(resolveSlot(draftOf({ time: "09:00" }), [slot9am, nextDay], TZ)).toBeNull();
    expect(resolveSlot(draftOf({ time: "09:00" }), [slot9am], TZ)).toBe(slot9am);
  });

  it("needs a time — a day alone is not a slot", () => {
    expect(resolveSlot(draftOf({ date: "2026-07-14" }), [slot9am], TZ)).toBeNull();
  });
});

describe("readiness", () => {
  it("commits a slot onto the draft in business-local wall clock", () => {
    const draft = commitSlot(EMPTY_DRAFT, slot2pm, TZ);
    expect(draft).toMatchObject({ date: "2026-07-14", time: "14:00", timeCommitted: true });
  });

  it("reports what is still missing, in asking order", () => {
    expect(missingFields(EMPTY_DRAFT, false)).toEqual(["service", "time", "name", "contact"]);
    expect(
      missingFields(draftOf({ service: "AC servicing", name: "Sam", email: "s@example.com" }), true),
    ).toEqual([]);
    // Either contact channel satisfies the requirement.
    expect(
      missingFields(draftOf({ service: "x", name: "Sam", phone: "+1 555 0100" }), true),
    ).toEqual([]);
  });

  it("knows whether a conversation has started a booking", () => {
    expect(hasDraftContent(null)).toBe(false);
    expect(hasDraftContent(EMPTY_DRAFT)).toBe(false);
    expect(hasDraftContent(draftOf({ service: "AC servicing" }))).toBe(true);
  });

  it("describes the draft for the prompt, flagging whether the time is agreed", () => {
    const text = describeDraft(
      draftOf({ service: "AC servicing", date: "2026-07-14", time: "09:00", name: "Sam" }),
      TZ,
    );
    expect(text).toContain("Service: AC servicing");
    expect(text).toContain("Name: Sam");
    expect(text).toContain("not yet agreed");
  });
});
