import type { LanguagePack } from "@halo/language/language-pack";
import { normalizeForMatching } from "@halo/language/normalize";
import type { BillRanges } from "@halo/language/parsers/bill";
import type { QualificationField, QualificationSchema } from "./schema";

/**
 * HALO Phase 4 — the deterministic qualification state machine (plan §P8.4-5).
 *
 * Pure and synchronous: given the schema, a language pack, the current
 * snapshot and one caller utterance, it decides what was learned and what to
 * ask next. The model never decides any of this; it only renders the next
 * question in the caller's language and phrasing.
 *
 * Invariants:
 *   - the caller's ORIGINAL words are stored beside every normalized value;
 *   - nothing uncertain is accepted silently — low confidence, ambiguous bill
 *     readings and `confirm` fields are read back and require a yes;
 *   - a filled field is never re-asked (the booking-draft invariant,
 *     generalized);
 *   - attempts per field are bounded, so a misheard answer cannot loop;
 *   - "I don't know" is a legitimate answer, recorded as unknown, not retried;
 *   - do-not-call, wrong-number, callback and human requests are honoured
 *     immediately, in the caller's language.
 */

export interface FieldValue {
  /** Normalized value: enum option, "3000" (INR), "300" (kWh), E.164, pincode, text. */
  value: string;
  /** What the caller actually said, verbatim. */
  raw: string;
  confidence: number;
  confirmed: boolean;
  /** For energy_or_money: which reading was taken. */
  unit?: "inr" | "kwh" | "kw";
  unknown?: boolean;
}

export type QualificationStatus =
  | "in_progress"
  | "complete"
  | "disqualified"
  | "do_not_call"
  | "wrong_number"
  | "callback_requested";

export interface QualificationSnapshot {
  fields: Record<string, FieldValue>;
  attempts: Record<string, number>;
  status: QualificationStatus;
  disqualifiedReason: string | null;
  /** Field whose answer the engine is waiting for. */
  pendingFieldId: string | null;
  /** Field whose parsed value is waiting for a yes/no confirmation. */
  awaitingConfirmationFieldId: string | null;
  humanRequested: boolean;
  unresolved: string[];
}

export function emptySnapshot(): QualificationSnapshot {
  return {
    fields: {},
    attempts: {},
    status: "in_progress",
    disqualifiedReason: null,
    pendingFieldId: null,
    awaitingConfirmationFieldId: null,
    humanRequested: false,
    unresolved: [],
  };
}

export type QualificationEvent =
  | { type: "captured"; field: string; value: string; confidence: number }
  | { type: "confirmation_requested"; field: string; value: string }
  | { type: "confirmed"; field: string }
  | { type: "rejected"; field: string }
  | { type: "unknown"; field: string }
  | { type: "retry"; field: string; attempt: number }
  | { type: "unresolved"; field: string }
  | { type: "disqualified"; field: string; reason: string }
  | { type: "intent"; intent: string }
  | { type: "complete" };

export interface ApplyResult {
  snapshot: QualificationSnapshot;
  events: QualificationEvent[];
}

export interface EngineDeps {
  schema: QualificationSchema;
  pack: LanguagePack;
  billRanges?: BillRanges;
}

/** Applies one caller utterance. `utterance` empty = the call just started. */
export function applyUtterance(deps: EngineDeps, previous: QualificationSnapshot, utterance: string): ApplyResult {
  const snapshot: QualificationSnapshot = {
    ...previous,
    fields: { ...previous.fields },
    attempts: { ...previous.attempts },
    unresolved: [...previous.unresolved],
  };
  const events: QualificationEvent[] = [];
  const text = utterance.trim();

  if (isTerminal(snapshot.status)) return { snapshot, events };

  if (text) {
    // 1. Caller-level intents always win over the current question.
    const intents = deps.pack.intents(text).map((m) => m.intent);
    if (intents.includes("do_not_call")) {
      return { snapshot: close(snapshot, "do_not_call"), events: [...events, { type: "intent", intent: "do_not_call" }] };
    }
    if (intents.includes("wrong_number")) {
      return { snapshot: close(snapshot, "wrong_number"), events: [...events, { type: "intent", intent: "wrong_number" }] };
    }
    if (intents.includes("human")) {
      snapshot.humanRequested = true;
      events.push({ type: "intent", intent: "human" });
    }
    if (intents.includes("call_back_later")) {
      return { snapshot: close(snapshot, "callback_requested"), events: [...events, { type: "intent", intent: "call_back_later" }] };
    }

    // 2. A pending confirmation is answered before anything else.
    // Whether this utterance was spent on a pending confirmation. When a
    // confirmation is released without being answered, the utterance is
    // still unspent and belongs to the next question.
    let consumed = snapshot.awaitingConfirmationFieldId !== null;
    const hadConfirmation = consumed;
    if (snapshot.awaitingConfirmationFieldId) {
      const fieldId = snapshot.awaitingConfirmationFieldId;
      const field = fieldById(deps.schema, fieldId);
      const affirmed = intents.includes("affirm");
      const denied = intents.includes("deny");
      // An ambiguous amount/units reading is not resolved by "yes": the
      // caller has to say WHICH it is, so a unit word in the answer wins.
      const clarified = field && field.type === "energy_or_money" ? extractValue(deps, field, text) : null;
      if (clarified?.unit && !snapshot.fields[fieldId]?.unit) {
        snapshot.fields[fieldId] = { ...clarified, confirmed: true, confidence: Math.max(clarified.confidence, 0.9) };
        snapshot.awaitingConfirmationFieldId = null;
        events.push({ type: "confirmed", field: fieldId });
        applyDisqualifier(snapshot, events, field);
      } else if (affirmed && !denied && (field?.type !== "energy_or_money" || snapshot.fields[fieldId]?.unit !== undefined)) {
        const current = snapshot.fields[fieldId];
        if (current) snapshot.fields[fieldId] = { ...current, confirmed: true, confidence: Math.max(current.confidence, 0.95) };
        snapshot.awaitingConfirmationFieldId = null;
        events.push({ type: "confirmed", field: fieldId });
        applyDisqualifier(snapshot, events, field);
        if (isTerminal(snapshot.status)) return { snapshot, events };
      } else if (field?.type === "energy_or_money" && affirmed && !denied && snapshot.fields[fieldId] && !snapshot.fields[fieldId].unit) {
        // "Yes" does not say whether the number is money or units. Keep the
        // value, ask once more, and after the field's attempt budget accept it
        // as unit-unknown rather than looping on the caller.
        bumpAttempt(snapshot, events, field);
        if ((snapshot.attempts[fieldId] ?? 0) >= field.maxAttempts) {
          snapshot.awaitingConfirmationFieldId = null;
          snapshot.unresolved = snapshot.unresolved.filter((id) => id !== fieldId);
        } else {
          events.push({ type: "confirmation_requested", field: fieldId, value: snapshot.fields[fieldId].value });
        }
      } else if (field) {
        /*
         * Neither a clean yes nor the energy special case. Three different
         * things arrive here and they must NOT be treated alike — the
         * earlier version deleted the captured value first and re-extracted
         * from whatever was said, which meant a caller who simply answered
         * the NEXT question ("Anantapur") had it stored as their name, and
         * every answer after that landed one field out. On a real call that
         * silently scrambles the whole lead.
         */
        // A "correction" must be signalled. For a number the value itself
        // signals it — a bare amount or phone number during a read-back is a
        // correction and nothing else. For a name, a place or a free-text
        // answer, almost any utterance parses as a value, so without an
        // explicit "no" the caller is answering the NEXT question, not
        // correcting this one.
        const corrected = denied || RESTATABLE_FIELD_TYPES.has(field.type) ? extractValue(deps, field, text) : null;
        if (corrected) {
          // A correction, or the value said again ("no, three thousand").
          events.push({ type: "rejected", field: fieldId });
          snapshot.fields[fieldId] = corrected;
          events.push({ type: "captured", field: fieldId, value: corrected.value, confidence: corrected.confidence });
          if (field.confirm || corrected.confidence < CONFIRMATION_THRESHOLD) {
            bumpAttempt(snapshot, events, field);
            if ((snapshot.attempts[fieldId] ?? 0) >= field.maxAttempts) {
              // Asked enough. Keep what we heard, marked unconfirmed.
              snapshot.awaitingConfirmationFieldId = null;
            } else {
              events.push({ type: "confirmation_requested", field: fieldId, value: corrected.value });
            }
          } else {
            snapshot.awaitingConfirmationFieldId = null;
            applyDisqualifier(snapshot, events, field);
            if (isTerminal(snapshot.status)) return { snapshot, events };
          }
        } else if (denied) {
          // "No, that's wrong", with no correction offered. Drop it and ask
          // again — this is the one case where deleting is right.
          delete snapshot.fields[fieldId];
          snapshot.awaitingConfirmationFieldId = null;
          events.push({ type: "rejected", field: fieldId });
          bumpAttempt(snapshot, events, field);
        } else if (!field.confirm) {
          // The caller has moved on and this read-back was only a
          // low-confidence nicety. Keep what we heard, unconfirmed, and let
          // the utterance answer whatever comes next instead of losing it.
          snapshot.awaitingConfirmationFieldId = null;
          applyDisqualifier(snapshot, events, field);
          if (isTerminal(snapshot.status)) return { snapshot, events };
          consumed = false;
        } else {
          // An explicit read-back is a business requirement (a phone number,
          // an amount): ask again, bounded, without destroying the value.
          bumpAttempt(snapshot, events, field);
          if ((snapshot.attempts[fieldId] ?? 0) >= field.maxAttempts) {
            snapshot.awaitingConfirmationFieldId = null;
          } else {
            events.push({ type: "confirmation_requested", field: fieldId, value: snapshot.fields[fieldId]?.value ?? "" });
          }
        }
      }
    }

    // A released confirmation leaves the utterance unspent: the caller was
    // answering the next question, so let the next field have it. Only in
    // that case — outside it, a field the engine has not asked about yet
    // must not be filled from whatever the caller happened to say.
    if (hadConfirmation && !consumed && !snapshot.awaitingConfirmationFieldId) {
      const next = nextField(deps.schema, snapshot);
      snapshot.pendingFieldId = next?.id ?? null;
    }

    if (!snapshot.awaitingConfirmationFieldId && !consumed && snapshot.pendingFieldId) {
      const field = fieldById(deps.schema, snapshot.pendingFieldId);
      if (field) {
        if (intents.includes("dont_know")) {
          snapshot.fields[field.id] = { value: "", raw: text, confidence: 0, confirmed: false, unknown: true };
          events.push({ type: "unknown", field: field.id });
          if (field.required && !snapshot.unresolved.includes(field.id)) snapshot.unresolved.push(field.id);
        } else {
          const captured = captureField(deps, snapshot, events, field, text);
          if (isTerminal(snapshot.status)) return { snapshot, events };
          if (!captured) bumpAttempt(snapshot, events, field);
        }
      }
    }
  }

  // 3. Too many unresolved required fields: a person should take over.
  if (snapshot.unresolved.length >= deps.schema.maxUnresolvedFields) snapshot.humanRequested = true;

  // 4. Choose the next question.
  if (!snapshot.awaitingConfirmationFieldId) {
    const next = nextField(deps.schema, snapshot);
    snapshot.pendingFieldId = next?.id ?? null;
    if (!next && snapshot.status === "in_progress") {
      snapshot.status = "complete";
      events.push({ type: "complete" });
    }
  }
  return { snapshot, events };
}

/** Ends the qualification: nothing more is asked once the caller said this. */
function close(snapshot: QualificationSnapshot, status: QualificationStatus): QualificationSnapshot {
  return { ...snapshot, status, pendingFieldId: null, awaitingConfirmationFieldId: null };
}

/** Extracts a value for `field`; returns false when nothing usable was said. */
function captureField(
  deps: EngineDeps,
  snapshot: QualificationSnapshot,
  events: QualificationEvent[],
  field: QualificationField,
  text: string,
): boolean {
  const extracted = extractValue(deps, field, text);
  if (!extracted) return false;

  snapshot.fields[field.id] = extracted;
  snapshot.unresolved = snapshot.unresolved.filter((id) => id !== field.id);
  events.push({ type: "captured", field: field.id, value: extracted.value, confidence: extracted.confidence });

  const needsConfirmation = (field.confirm || extracted.confidence < CONFIRMATION_THRESHOLD) && !isVerbatimField(field);
  if (needsConfirmation && !extracted.unknown) {
    snapshot.awaitingConfirmationFieldId = field.id;
    events.push({ type: "confirmation_requested", field: field.id, value: extracted.value });
    return true;
  }
  applyDisqualifier(snapshot, events, field);
  return true;
}

export const CONFIRMATION_THRESHOLD = 0.8;

/**
 * Types whose value IS the caller's own words, so there is nothing to verify
 * by reading it back. Confidence-gated read-back exists to catch a MISHEARD
 * structured value — a digit, an amount, a name — where being wrong is
 * materially harmful and being right is checkable. Applying it to free text
 * produces an agent that repeats every answer back ("you said Kukatpally,
 * is that right?"), which is the mechanical interrogation this design is
 * supposed to avoid — and worse, it makes the caller's answer to the NEXT
 * question arrive while a confirmation is pending, where it is taken as a
 * correction and stored under the wrong field.
 *
 * An explicit `confirm: true` on such a field is still honoured.
 */
const VERBATIM_FIELD_TYPES = new Set<QualificationField["type"]>(["text", "time"]);

/**
 * Types whose value, said again on its own, unambiguously means "no, THIS
 * one" during a read-back. Everything else needs an explicit denial.
 */
const RESTATABLE_FIELD_TYPES = new Set<QualificationField["type"]>([
  "money",
  "energy_or_money",
  "capacity_kw",
  "phone",
  "pincode",
]);

function isVerbatimField(field: QualificationField): boolean {
  return VERBATIM_FIELD_TYPES.has(field.type) && !field.confirm;
}

function extractValue(deps: EngineDeps, field: QualificationField, text: string): FieldValue | null {
  const pack = deps.pack;
  switch (field.type) {
    case "enum": {
      const normalized = normalizeForMatching(text);
      for (const option of field.options ?? []) {
        for (const keywords of Object.values(option.keywords)) {
          const hit = [...keywords].sort((a, b) => b.length - a.length).find((k) => normalized.includes(normalizeForMatching(k)));
          if (hit) {
            // A keyword hit is a discrete choice, not a measurement. (Length
            // is a bad proxy for certainty across scripts: Telugu words are
            // short in code units.) Very short keywords ("own", "flat") are
            // slightly more collision-prone, so they score a little lower.
            return { value: option.value, raw: text, confidence: hit.length >= 4 ? 0.9 : 0.8, confirmed: false };
          }
        }
      }
      return null;
    }
    case "boolean": {
      const intents = pack.intents(text).map((m) => m.intent);
      if (intents.includes("affirm") && !intents.includes("deny")) return { value: "yes", raw: text, confidence: 0.9, confirmed: false };
      if (intents.includes("deny")) return { value: "no", raw: text, confidence: 0.9, confirmed: false };
      return null;
    }
    case "money": {
      const bill = pack.bill(text, deps.billRanges);
      if (bill.amountInr === undefined) return null;
      return { value: String(bill.amountInr), raw: text, confidence: bill.confidence, confirmed: false, unit: "inr" };
    }
    case "energy_or_money": {
      const bill = pack.bill(text, deps.billRanges);
      if (bill.kind === "amount" && bill.amountInr !== undefined) {
        return { value: String(bill.amountInr), raw: text, confidence: bill.confidence, confirmed: false, unit: "inr" };
      }
      if (bill.kind === "units" && bill.unitsKwh !== undefined) {
        return { value: String(bill.unitsKwh), raw: text, confidence: bill.confidence, confirmed: false, unit: "kwh" };
      }
      if (bill.kind === "ambiguous" && bill.value !== undefined) {
        // Deliberately below the confirmation threshold: the agent must ask
        // whether the number is rupees or units before it means anything.
        return { value: String(bill.value), raw: text, confidence: Math.min(bill.confidence, 0.5), confirmed: false };
      }
      return null;
    }
    case "capacity_kw": {
      const capacity = pack.capacity(text);
      if (!capacity || capacity.ambiguousUnit) return null;
      return { value: String(capacity.kw), raw: text, confidence: capacity.confidence, confirmed: false, unit: "kw" };
    }
    case "phone": {
      const phone = pack.phone(text);
      return phone ? { value: phone.e164, raw: phone.raw, confidence: phone.confidence, confirmed: false } : null;
    }
    case "pincode": {
      const pincode = pack.pincode(text);
      return pincode ? { value: pincode.pincode, raw: pincode.raw, confidence: pincode.confidence, confirmed: false } : null;
    }
    case "name": {
      const name = pack.name(text);
      return name ? { value: name.raw, raw: text, confidence: name.confidence, confirmed: false } : null;
    }
    case "time": {
      if (!pack.hasTime(text)) return null;
      return { value: pack.timeGloss(text), raw: text, confidence: 0.7, confirmed: false };
    }
    case "text": {
      const trimmed = text.slice(0, 200);
      return trimmed ? { value: trimmed, raw: text, confidence: 0.6, confirmed: false } : null;
    }
  }
}

function applyDisqualifier(
  snapshot: QualificationSnapshot,
  events: QualificationEvent[],
  field: QualificationField | null,
): void {
  if (!field?.disqualifyWhen) return;
  const value = snapshot.fields[field.id];
  if (!value || value.unknown) return;
  if (field.disqualifyWhen.equals.includes(value.value)) {
    snapshot.status = "disqualified";
    snapshot.disqualifiedReason = field.disqualifyWhen.reason;
    snapshot.pendingFieldId = null;
    snapshot.awaitingConfirmationFieldId = null;
    events.push({ type: "disqualified", field: field.id, reason: field.disqualifyWhen.reason });
  }
}

function bumpAttempt(
  snapshot: QualificationSnapshot,
  events: QualificationEvent[],
  field: QualificationField,
): void {
  const attempt = (snapshot.attempts[field.id] ?? 0) + 1;
  snapshot.attempts[field.id] = attempt;
  if (attempt >= field.maxAttempts) {
    // "Unresolved" means we never got the answer. A field that HAS a value —
    // captured but never confirmed — is answered, just not verified, and
    // counting it as unresolved wrongly drives the call towards a human.
    const answered = snapshot.fields[field.id] !== undefined && !snapshot.fields[field.id].unknown;
    if (field.required && !answered && !snapshot.unresolved.includes(field.id)) snapshot.unresolved.push(field.id);
    if (!answered) events.push({ type: "unresolved", field: field.id });
    return;
  }
  events.push({ type: "retry", field: field.id, attempt });
}

/** The next question: first required-and-unanswered field the schema allows. */
export function nextField(schema: QualificationSchema, snapshot: QualificationSnapshot): QualificationField | null {
  for (const field of schema.fields) {
    if (snapshot.fields[field.id]) continue;
    if (snapshot.unresolved.includes(field.id)) continue;
    if ((snapshot.attempts[field.id] ?? 0) >= field.maxAttempts) continue;
    if (field.skipWhen) {
      const gate = snapshot.fields[field.skipWhen.field];
      if (gate && field.skipWhen.equals.includes(gate.value)) continue;
    }
    return field;
  }
  return null;
}

export function fieldById(schema: QualificationSchema, id: string): QualificationField | null {
  return schema.fields.find((f) => f.id === id) ?? null;
}

export function isTerminal(status: QualificationStatus): boolean {
  return status === "disqualified" || status === "do_not_call" || status === "wrong_number" || status === "callback_requested";
}

/** Values suitable for `conversation_outcomes.qualification` (jsonb). */
export function qualificationPayload(snapshot: QualificationSnapshot): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(snapshot.fields)) {
    fields[id] = {
      value: value.value,
      // The caller's own words are kept beside every normalized value.
      raw: value.raw,
      confidence: value.confidence,
      confirmed: value.confirmed,
      ...(value.unit ? { unit: value.unit } : {}),
      ...(value.unknown ? { unknown: true } : {}),
    };
  }
  return {
    status: snapshot.status,
    ...(snapshot.disqualifiedReason ? { disqualifiedReason: snapshot.disqualifiedReason } : {}),
    unresolved: snapshot.unresolved,
    humanRequested: snapshot.humanRequested,
    fields,
  };
}
