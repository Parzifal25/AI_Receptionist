import { z } from "zod";

/**
 * HALO Phase 4 — configurable qualification schema (plan §P8.4).
 *
 * A tenant describes WHAT to collect and in WHICH ORDER; the engine decides
 * what to ask next, extracts answers deterministically, confirms anything
 * uncertain and applies disqualifiers. Nothing here is industry-specific:
 * field types are generic (money, energy-or-money, capacity, phone, pincode,
 * name, enum, boolean, free text, time) and every question, keyword and
 * disqualification reason is tenant content.
 *
 * Questions are per language tag and authored in that language — the platform
 * never translates them.
 */

export const FIELD_TYPES = [
  "enum",
  "boolean",
  "money",
  /** Amount OR consumption units, disambiguated and confirmed (plan §P3.6). */
  "energy_or_money",
  "capacity_kw",
  "phone",
  "pincode",
  "name",
  "text",
  "time",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const slotKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "field ids are lower_snake, max 40 chars");
/** Per-language text: { "te-IN": "…", "en-IN": "…" }. */
const localized = z.record(z.string().min(2).max(16), z.string().min(1).max(400));

export const qualificationOptionSchema = z.object({
  value: z.string().min(1).max(40),
  /** Per-language keyword lists matched against the normalized utterance. */
  keywords: z.record(z.string().min(2).max(16), z.array(z.string().min(1).max(60)).max(40)),
});

export const qualificationFieldSchema = z.object({
  id: slotKey,
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(true),
  questions: localized,
  options: z.array(qualificationOptionSchema).max(12).optional(),
  /** Always read the value back before relying on it (numbers, names). */
  confirm: z.boolean().default(false),
  confirmPrompts: localized.optional(),
  /** Values that end the conversation as not qualified, with a stated reason. */
  disqualifyWhen: z
    .object({ equals: z.array(z.string().max(40)).max(12), reason: z.string().min(3).max(200) })
    .optional(),
  /** Skip when an earlier answer makes this field irrelevant. */
  skipWhen: z.object({ field: slotKey, equals: z.array(z.string().max(40)).max(12) }).optional(),
  /** Attempts before the engine moves on (and counts the field unresolved). */
  maxAttempts: z.int().min(1).max(5).default(2),
});

export const qualificationSchemaSchema = z.object({
  version: z.string().min(1).max(40),
  /** Primary language tag for questions; must key every `questions` map. */
  language: z.string().min(2).max(16),
  fields: z.array(qualificationFieldSchema).min(1).max(24),
  /** Unresolved required fields tolerated before asking for a human. */
  maxUnresolvedFields: z.int().min(1).max(10).default(2),
  /** Plausible ranges for energy_or_money fields (tenant configuration). */
  billRanges: z
    .object({
      amountInr: z.object({ min: z.number(), max: z.number() }),
      unitsKwh: z.object({ min: z.number(), max: z.number() }),
    })
    .optional(),
});

export type QualificationField = z.infer<typeof qualificationFieldSchema>;
export type QualificationSchema = z.infer<typeof qualificationSchemaSchema>;

export type ParseResult =
  | { ok: true; schema: QualificationSchema }
  | { ok: false; errors: string[] };

/** Parses and cross-checks a schema; a malformed schema is refused loudly. */
export function parseQualificationSchema(raw: unknown): ParseResult {
  const parsed = qualificationSchemaSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "schema"}: ${i.message}`) };
  }
  const schema = parsed.data;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const field of schema.fields) {
    if (ids.has(field.id)) errors.push(`duplicate field id "${field.id}"`);
    ids.add(field.id);
    if (!field.questions[schema.language]) {
      errors.push(`field "${field.id}" has no question in the schema language "${schema.language}"`);
    }
    if (field.type === "enum" && (!field.options || field.options.length === 0)) {
      errors.push(`enum field "${field.id}" needs options`);
    }
    if (field.type !== "enum" && field.options) errors.push(`field "${field.id}" is not an enum but has options`);
    if (field.confirm && !field.confirmPrompts?.[schema.language]) {
      errors.push(`field "${field.id}" needs a confirmation prompt in "${schema.language}"`);
    }
    if (field.disqualifyWhen && field.type !== "enum" && field.type !== "boolean") {
      errors.push(`field "${field.id}" can only disqualify on enum or boolean values`);
    }
  }
  for (const field of schema.fields) {
    if (field.skipWhen && !ids.has(field.skipWhen.field)) {
      errors.push(`field "${field.id}" skips on unknown field "${field.skipWhen.field}"`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, schema };
}
