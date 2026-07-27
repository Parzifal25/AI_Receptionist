import { z } from "zod";
import type { IntakeField, SchedulingSettings } from "@/core/domain/scheduling";

/**
 * The tenant-editable half of the scheduling settings: everything the
 * lifecycle layer says to a customer (where to go, how to prepare, what to
 * fill in, where to review) and when it says it (reminder schedule, no-show
 * grace). Booking-engine mechanics — timezone, slot length, buffers, notice
 * — stay out of this patch; they belong to the scheduling engine.
 *
 * Pure module: parsing and normalisation only, so the rules are pinned by
 * unit tests and shared by the server action and any future API surface.
 */

/** Field ids are used as JSON keys in intake answers — keep them boring. */
const FIELD_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const intakeFieldSchema = z.object({
  id: z
    .string()
    .trim()
    .toLowerCase()
    .regex(FIELD_ID, "field id must be lowercase letters, numbers, - or _ (max 40)"),
  label: z.string().trim().min(1, "every intake field needs a label").max(200),
  type: z.enum(["text", "textarea", "checkbox"]),
  required: z.boolean().default(false),
});

/**
 * Review destinations are messaged to customers, so they must be https —
 * the same rule the webhook action applies to tenant-supplied URLs. Empty
 * means "no review link configured" and disables the review ask.
 */
const reviewUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => value === "" || /^https:\/\/\S+$/i.test(value),
    "review link must be an https:// URL",
  );

/**
 * Reminder lead times, in minutes before the appointment. Deduped and
 * sorted furthest-out first so "24h then 1h" reads the way it fires, and
 * capped at 30 days / 10 entries so one tenant cannot flood the queue.
 */
const reminderLeadMinutesSchema = z
  .array(z.number().int().min(5).max(43_200))
  .max(10, "at most 10 reminders per appointment")
  .transform((values) => [...new Set(values)].sort((a, b) => b - a));

export const lifecycleSettingsSchema = z.object({
  locationAddress: z.string().trim().max(500).default(""),
  prepInstructions: z.string().trim().max(4_000).default(""),
  reviewUrl: reviewUrlSchema.default(""),
  intakeForm: z
    .array(intakeFieldSchema)
    .max(25, "at most 25 intake fields")
    .default([])
    .superRefine((fields, ctx) => {
      const seen = new Set<string>();
      for (const field of fields) {
        if (seen.has(field.id)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate intake field id "${field.id}"`,
          });
        }
        seen.add(field.id);
      }
    }),
  remindersEnabled: z.boolean().default(true),
  reminderLeadMinutes: reminderLeadMinutesSchema.default([1_440, 60]),
  autoNoShowEnabled: z.boolean().default(false),
  noShowGraceMinutes: z.number().int().min(0).max(1_440).default(30),
});

export type LifecycleSettingsPatch = z.infer<typeof lifecycleSettingsSchema>;

/** Narrows full settings down to the editable patch (form hydration). */
export function toLifecyclePatch(settings: SchedulingSettings): LifecycleSettingsPatch {
  return {
    locationAddress: settings.locationAddress,
    prepInstructions: settings.prepInstructions,
    reviewUrl: settings.reviewUrl,
    intakeForm: settings.intakeForm,
    remindersEnabled: settings.remindersEnabled,
    reminderLeadMinutes: settings.reminderLeadMinutes,
    autoNoShowEnabled: settings.autoNoShowEnabled,
    noShowGraceMinutes: settings.noShowGraceMinutes,
  };
}

/**
 * Parses the intake-form builder's wire format. The UI submits parallel
 * arrays of field rows; blank rows are dropped so an empty "add a field"
 * row never becomes a required question. Ids are derived from the label
 * when the operator does not supply one.
 */
export function parseIntakeFields(
  rows: Array<{ id?: string; label?: string; type?: string; required?: boolean }>,
): IntakeField[] {
  const used = new Set<string>();
  const fields: IntakeField[] = [];

  for (const row of rows) {
    const label = (row.label ?? "").trim();
    if (!label) continue;
    const base = slugifyFieldId(row.id?.trim() || label);
    if (!base) continue;

    // Collision-proof without surprising the operator: first one keeps the
    // clean id, later ones get a numeric suffix.
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);

    fields.push({
      id,
      label: label.slice(0, 200),
      type: row.type === "textarea" || row.type === "checkbox" ? row.type : "text",
      required: row.required === true,
    });
  }
  return fields;
}

/**
 * Underscores survive: an id the operator already saved (`unit_age`) must
 * round-trip unchanged, or re-saving the form would rewrite the id and
 * orphan every intake answer stored under the old key.
 */
function slugifyFieldId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** "1440,60" / "24h, 1h" → [1440, 60]. Invalid entries are dropped. */
export function parseReminderLeadMinutes(raw: string): number[] {
  const minutes: number[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const match = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)?$/.exec(token);
    if (!match) continue;
    const value = Number(match[1]);
    const unit = match[2] ?? "m";
    const factor = unit.startsWith("d") ? 1_440 : unit.startsWith("h") ? 60 : 1;
    const total = Math.round(value * factor);
    if (total >= 5 && total <= 43_200) minutes.push(total);
  }
  return [...new Set(minutes)].sort((a, b) => b - a);
}
