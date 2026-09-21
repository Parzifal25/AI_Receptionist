import { z } from "zod";

/**
 * HALO Phase 4 — commercial and negotiation POLICY (plan §P8; brief §8).
 *
 * The separation this file exists to enforce:
 *
 *   CONVERSATIONAL STRATEGY  — how to talk to a customer who pushes back:
 *                              acknowledge, understand, explain value, ask a
 *                              useful question. The model does this.
 *   BUSINESS AUTHORIZATION   — what may actually be offered, at what number,
 *                              under what conditions, and what may never be
 *                              promised. Only this file and
 *                              `authorization.ts` decide that.
 *
 * The model may negotiate. It may not authorize. It proposes a concession by
 * ID; application code checks it against the policy and either performs it or
 * refuses, and only a verified result may be narrated.
 *
 * NOTHING HERE HAS A DEFAULT VALUE. A concession whose `value` is null, a
 * quote whose `amount` is null and a financing option with `verified: false`
 * are all UNAUTHORIZED: the agent may not mention them. That is deliberate.
 * Until a business supplies verified numbers, the honest behaviour is to
 * explain, ask, and escalate — never to invent a discount to keep a call
 * alive. A policy that "helpfully" defaulted to 5% would be a fabricated
 * commercial commitment.
 *
 * Every customer-facing string is tenant-authored, per language. The
 * platform never writes, translates or paraphrases one.
 */

const slotKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "field ids are lower_snake, max 40 chars");
/** Per-language text: { "te-IN": "…", "en-IN": "…" }. */
const localized = z.record(z.string().min(2).max(16), z.string().min(1).max(600));

export const CONCESSION_TYPES = [
  "discount_percent",
  "discount_amount",
  "free_addon",
  "payment_terms",
  "price_hold",
] as const;
export type ConcessionType = (typeof CONCESSION_TYPES)[number];

/** A precondition on what the qualification engine has actually captured. */
export const concessionConditionSchema = z.object({
  field: slotKey,
  /** The captured value must be one of these (compared as stored strings). */
  in: z.array(z.string().max(60)).min(1).max(20),
});

export const concessionSchema = z.object({
  id: slotKey,
  label: localized,
  type: z.enum(CONCESSION_TYPES),
  /**
   * The authorized magnitude: percent for `discount_percent`, currency
   * minor-unit-free amount for `discount_amount`, days for `payment_terms`
   * and `price_hold`, unused for `free_addon`.
   *
   * `null` = the business has not supplied a verified value. The concession
   * is then UNAVAILABLE, not "up to the agent".
   */
  value: z.number().min(0).max(1_000_000).nullable(),
  /** Every condition must hold before this may be offered. */
  conditions: z.array(concessionConditionSchema).max(8).default([]),
  /**
   * True = a person must approve before it is offered at all. The agent may
   * say it will be checked; it may never say it has been granted.
   */
  requiresApproval: z.boolean().default(true),
  /** Exactly how to offer it, in the customer's language. Tenant-authored. */
  script: localized,
  /** How many times it may be offered in one conversation. */
  maxPerConversation: z.int().min(1).max(5).default(1),
});

export const quoteSchema = z.object({
  id: slotKey,
  label: localized,
  /** `null` = no verified figure exists; the agent must not state one. */
  amount: z.number().min(0).nullable(),
  /** What the amount is per ("kw", "unit", "month", "project"). */
  unit: z.string().min(1).max(24),
  note: localized.optional(),
});

export const financingOptionSchema = z.object({
  id: slotKey,
  label: localized,
  description: localized,
  /**
   * False until the business confirms the option exists on the stated terms.
   * An unverified option is never mentioned.
   */
  verified: z.boolean().default(false),
});

export const negotiationPolicySchema = z.object({
  version: z.string().min(1).max(40),
  /** Primary language tag; must key every localized field. */
  language: z.string().min(2).max(16),
  currency: z.string().length(3).default("INR"),
  /**
   * How much the agent may say about price at all:
   *   none  — no figures; explain value and route to a person or a visit;
   *   range — only the configured quote range;
   *   exact — the configured quote figures.
   */
  priceDisclosure: z.enum(["none", "range", "exact"]).default("none"),
  quotes: z.array(quoteSchema).max(24).default([]),
  concessions: z.array(concessionSchema).max(24).default([]),
  floors: z
    .object({
      /** Never quote or discount below this. `null` = no floor configured. */
      minAmount: z.number().min(0).nullable().default(null),
      maxDiscountPercent: z.number().min(0).max(100).nullable().default(null),
    })
    .default({ minAmount: null, maxDiscountPercent: null }),
  financing: z.array(financingOptionSchema).max(12).default([]),
  escalation: z
    .object({
      /** Concession pushes tolerated before a person is offered. */
      requestsBeforeHuman: z.int().min(1).max(6).default(2),
      /** A request for something not in `concessions` goes to a person. */
      escalateOnUnlistedRequest: z.boolean().default(true),
      /** A discount above this always needs a person, even if authorized. */
      humanApprovalAbovePercent: z.number().min(0).max(100).nullable().default(null),
    })
    .default({ requestsBeforeHuman: 2, escalateOnUnlistedRequest: true, humanApprovalAbovePercent: null }),
  /**
   * Things the agent must NEVER say, in the customer's language. These are
   * rendered into the prompt verbatim as hard prohibitions.
   */
  prohibitedPromises: z.array(z.string().min(2).max(300)).max(40).default([]),
});

export type Concession = z.infer<typeof concessionSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type FinancingOption = z.infer<typeof financingOptionSchema>;
export type NegotiationPolicy = z.infer<typeof negotiationPolicySchema>;

export type PolicyParseResult =
  | { ok: true; policy: NegotiationPolicy }
  | { ok: false; errors: string[] };

/**
 * Parses and cross-checks a policy. A malformed policy is REFUSED, not
 * partially applied: half a commercial policy is worse than none, because
 * the missing half is exactly the part that says "no".
 */
export function parseNegotiationPolicy(raw: unknown): PolicyParseResult {
  const parsed = negotiationPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`) };
  }
  const policy = parsed.data;
  const errors: string[] = [];
  const lang = policy.language;

  const ids = new Set<string>();
  for (const concession of policy.concessions) {
    if (ids.has(concession.id)) errors.push(`duplicate concession id "${concession.id}"`);
    ids.add(concession.id);
    if (!concession.script[lang]) errors.push(`concession "${concession.id}" has no script in "${lang}"`);
    if (!concession.label[lang]) errors.push(`concession "${concession.id}" has no label in "${lang}"`);
    if (concession.type === "discount_percent" && concession.value !== null && concession.value > 100) {
      errors.push(`concession "${concession.id}" is a discount above 100%`);
    }
    if (
      concession.type === "discount_percent" &&
      concession.value !== null &&
      policy.floors.maxDiscountPercent !== null &&
      concession.value > policy.floors.maxDiscountPercent
    ) {
      errors.push(`concession "${concession.id}" (${concession.value}%) exceeds the configured floor of ${policy.floors.maxDiscountPercent}%`);
    }
  }
  for (const quote of policy.quotes) {
    if (!quote.label[lang]) errors.push(`quote "${quote.id}" has no label in "${lang}"`);
  }
  for (const option of policy.financing) {
    if (!option.description[lang]) errors.push(`financing option "${option.id}" has no description in "${lang}"`);
  }
  if (policy.priceDisclosure !== "none" && policy.quotes.every((q) => q.amount === null)) {
    errors.push(`priceDisclosure is "${policy.priceDisclosure}" but no quote has a verified amount`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, policy };
}

/** A policy that authorizes nothing: the safe state before a business supplies figures. */
export function emptyNegotiationPolicy(language: string): NegotiationPolicy {
  return negotiationPolicySchema.parse({ version: "empty", language });
}
