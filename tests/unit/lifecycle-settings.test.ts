import { describe, expect, it } from "vitest";
import {
  lifecycleSettingsSchema,
  parseIntakeFields,
  parseReminderLeadMinutes,
} from "@/core/services/lifecycle/lifecycle-settings";

/**
 * The tenant-editable lifecycle content. These values are messaged to real
 * customers and drive the reminder queue, so the parsing rules are pinned
 * here rather than trusted to the form.
 */

const valid = {
  locationAddress: "12 Bridge St, Boston MA",
  prepInstructions: "Please clear access to the outdoor unit.",
  reviewUrl: "https://g.page/r/cool-air/review",
  intakeForm: [{ id: "unit_age", label: "How old is your unit?", type: "text", required: true }],
  remindersEnabled: true,
  reminderLeadMinutes: [60, 1440],
  autoNoShowEnabled: true,
  noShowGraceMinutes: 45,
};

describe("lifecycleSettingsSchema", () => {
  it("accepts a fully populated configuration", () => {
    const parsed = lifecycleSettingsSchema.parse(valid);
    expect(parsed.locationAddress).toBe("12 Bridge St, Boston MA");
    expect(parsed.autoNoShowEnabled).toBe(true);
    expect(parsed.noShowGraceMinutes).toBe(45);
  });

  it("orders reminders the way they fire — furthest out first — and dedupes", () => {
    const parsed = lifecycleSettingsSchema.parse({
      ...valid,
      reminderLeadMinutes: [60, 1440, 60, 15],
    });
    expect(parsed.reminderLeadMinutes).toEqual([1440, 60, 15]);
  });

  it("rejects reminder lead times outside the supported window", () => {
    expect(() =>
      lifecycleSettingsSchema.parse({ ...valid, reminderLeadMinutes: [1] }),
    ).toThrow();
    expect(() =>
      lifecycleSettingsSchema.parse({ ...valid, reminderLeadMinutes: [43_201] }),
    ).toThrow();
  });

  it("caps the number of reminders per appointment", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => (i + 1) * 10);
    expect(() =>
      lifecycleSettingsSchema.parse({ ...valid, reminderLeadMinutes: eleven }),
    ).toThrow(/at most 10/);
  });

  it("requires review links to be https, since customers are sent them", () => {
    expect(() =>
      lifecycleSettingsSchema.parse({ ...valid, reviewUrl: "http://g.page/r/x/review" }),
    ).toThrow(/https/);
    expect(() =>
      lifecycleSettingsSchema.parse({ ...valid, reviewUrl: "javascript:alert(1)" }),
    ).toThrow(/https/);
  });

  it("treats an empty review link as 'not configured'", () => {
    expect(lifecycleSettingsSchema.parse({ ...valid, reviewUrl: "" }).reviewUrl).toBe("");
  });

  it("rejects duplicate intake field ids, which would collide in answers", () => {
    expect(() =>
      lifecycleSettingsSchema.parse({
        ...valid,
        intakeForm: [
          { id: "note", label: "Note", type: "text", required: false },
          { id: "note", label: "Another note", type: "text", required: false },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects intake field ids that are not safe answer keys", () => {
    expect(() =>
      lifecycleSettingsSchema.parse({
        ...valid,
        intakeForm: [{ id: "my field!", label: "Bad", type: "text", required: false }],
      }),
    ).toThrow();
  });

  it("applies safe defaults for an unconfigured business", () => {
    const parsed = lifecycleSettingsSchema.parse({});
    expect(parsed).toMatchObject({
      locationAddress: "",
      prepInstructions: "",
      reviewUrl: "",
      intakeForm: [],
      remindersEnabled: true,
      reminderLeadMinutes: [1440, 60],
      autoNoShowEnabled: false,
      noShowGraceMinutes: 30,
    });
  });

  it("bounds the no-show grace period to a day", () => {
    expect(() =>
      lifecycleSettingsSchema.parse({ ...valid, noShowGraceMinutes: 1441 }),
    ).toThrow();
    expect(() =>
      lifecycleSettingsSchema.parse({ ...valid, noShowGraceMinutes: -1 }),
    ).toThrow();
  });
});

describe("parseIntakeFields", () => {
  it("derives stable ids from labels", () => {
    expect(parseIntakeFields([{ label: "How old is your unit?", type: "text" }])).toEqual([
      { id: "how-old-is-your-unit", label: "How old is your unit?", type: "text", required: false },
    ]);
  });

  it("drops blank rows so the empty 'add a field' row is not saved", () => {
    expect(parseIntakeFields([{ label: "  " }, { label: "" }, { label: "Real", type: "text" }])).toHaveLength(1);
  });

  it("suffixes colliding ids instead of overwriting answers", () => {
    const fields = parseIntakeFields([
      { label: "Notes", type: "text" },
      { label: "Notes", type: "textarea" },
      { label: "Notes!", type: "text" },
    ]);
    expect(fields.map((f) => f.id)).toEqual(["notes", "notes-2", "notes-3"]);
  });

  it("falls back to a text field for unknown types", () => {
    expect(parseIntakeFields([{ label: "X", type: "date" }])[0].type).toBe("text");
    expect(parseIntakeFields([{ label: "X", type: "checkbox" }])[0].type).toBe("checkbox");
  });

  it("honours an explicitly supplied id", () => {
    expect(parseIntakeFields([{ id: "unit_age", label: "How old?" }])[0].id).toBe("unit_age");
  });
});

describe("parseReminderLeadMinutes", () => {
  it("reads bare minutes", () => {
    expect(parseReminderLeadMinutes("1440, 60")).toEqual([1440, 60]);
  });

  it("reads human units", () => {
    expect(parseReminderLeadMinutes("2d, 24h, 90m")).toEqual([2880, 1440, 90]);
    expect(parseReminderLeadMinutes("1 day\n3 hours")).toEqual([1440, 180]);
  });

  it("drops nonsense and out-of-range entries rather than failing the save", () => {
    expect(parseReminderLeadMinutes("24h, soon, 1m, 90d")).toEqual([1440]);
  });

  it("dedupes across notations and sorts furthest-out first", () => {
    expect(parseReminderLeadMinutes("60, 1h, 24h")).toEqual([1440, 60]);
  });

  it("returns nothing for empty input", () => {
    expect(parseReminderLeadMinutes("  ")).toEqual([]);
  });
});
