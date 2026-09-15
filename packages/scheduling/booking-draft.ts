import type { TimeSlot } from "@halo/core/domain/scheduling";
import { dateStringInTz, hourInTz } from "./timezone";
import { parseWhen } from "./when-parser";

/**
 * The draft appointment a conversation is assembling.
 *
 * A booking is rarely one message. The visitor drips in a service, then a
 * day, then their name, then corrects the time — and a stateless turn would
 * start over each time and re-ask what it was already told. The draft is the
 * conversation's memory of the booking: every turn *updates* it (latest
 * value wins) instead of restarting, and the moment it is complete the
 * orchestrator invokes the booking engine itself.
 *
 * `date`/`time` are wall-clock in the business timezone (YYYY-MM-DD and
 * 24-hour HH:MM) rather than instants, because that's what the visitor
 * actually said; they're resolved against real open slots at booking time.
 */
export interface BookingDraft {
  service: string;
  /** YYYY-MM-DD in the business timezone. */
  date: string;
  /** HH:MM, 24-hour, in the business timezone. */
  time: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  /**
   * The visitor has *agreed to* `date`/`time`, not merely asked about them.
   * Asking "do you have Tuesday at 10?" fills the draft; "10 works" commits
   * it. Only a committed time may be booked, and changing the time clears
   * the commitment so a correction can never book the old slot.
   */
  timeCommitted: boolean;
}

export const EMPTY_DRAFT: BookingDraft = {
  service: "",
  date: "",
  time: "",
  name: "",
  email: "",
  phone: "",
  notes: "",
  timeCommitted: false,
};

export type BookingDraftPatch = Partial<BookingDraft>;

/** The things that must be known before the engine can be called. */
export type MissingField = "service" | "time" | "name" | "contact";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
/** Digits with common separators; 7-15 digits total (E.164 bounds). */
const PHONE_RE = /(?:\+?\d[\d\s().-]{5,18}\d)/;

/**
 * Field labels visitors (and forms pasted into chat) actually use. Matched
 * case-insensitively; longest label first so "phone number" beats "phone".
 */
const FIELD_LABELS: Array<[string, keyof BookingDraft]> = [
  ["email address", "email"],
  ["phone number", "phone"],
  ["contact number", "phone"],
  ["mobile number", "phone"],
  ["full name", "name"],
  ["first name", "name"],
  ["e-mail", "email"],
  ["email", "email"],
  ["phone", "phone"],
  ["mobile", "phone"],
  ["cell", "phone"],
  ["tel", "phone"],
  ["name", "name"],
  ["service", "service"],
  ["treatment", "service"],
  ["reason", "service"],
  ["notes", "notes"],
  ["note", "notes"],
  ["comments", "notes"],
];

const LABEL_RE = new RegExp(
  `(^|[\\n\\r,;•\\-*\\s])(${FIELD_LABELS.map(([label]) => label).join("|")})\\s*[:=]`,
  "gi",
);

/** Words that follow "I'm"/"this is" without being a name. */
const NAME_STOPWORDS = new Set([
  "a", "an", "the", "not", "just", "still", "here", "there", "free", "available", "fine",
  "good", "great", "ok", "okay", "sorry", "looking", "trying", "hoping", "wondering",
  "interested", "calling", "asking", "after", "about", "in", "on", "at", "for", "with",
  "my", "me", "we", "you", "and", "but", "so", "very", "really", "actually", "afraid",
  "sure", "happy", "glad", "new", "old", "going", "coming", "booked", "booking",
]);

const NAME_HINT_RE =
  /\b(?:my name(?:'s| is)?|i'?m|i am|this is|it'?s)\s+([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*)?)/iu;

function countDigits(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

function looksLikePhone(value: string): boolean {
  const digits = countDigits(value);
  return digits >= 7 && digits <= 15;
}

/** Trims the punctuation that surrounds a value pulled out of free text. */
function cleanValue(value: string): string {
  return value
    .replace(/[\s\r\n]+/g, " ")
    .replace(/^[\s,;:.\-–—]+/, "")
    .replace(/[\s,;.\-–—]+$/, "")
    .trim()
    .slice(0, 200);
}

/**
 * Pulls out every `Label: value` pair in a message — inline
 * ("Name: John, Phone: 555…") or block-style, where the value sits on the
 * line *after* the label. A value runs until the next label or the end of
 * the message, which is what makes the multi-field paste work in one pass.
 */
export function extractLabeledFields(text: string): BookingDraftPatch {
  const matches = [...text.matchAll(LABEL_RE)];
  if (matches.length === 0) return {};

  const patch: BookingDraftPatch = {};
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const field = FIELD_LABELS.find(
      ([label]) => label === match[2].toLowerCase(),
    )?.[1];
    if (!field || field === "timeCommitted") continue;

    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const value = cleanValue(text.slice(start, end));
    if (!value) continue;

    // A mislabelled value is worse than a missing one: validate the two
    // fields that have a machine-checkable shape before trusting the label.
    if (field === "email") {
      const email = value.match(EMAIL_RE)?.[0];
      if (email) patch.email = email;
      continue;
    }
    if (field === "phone") {
      const phone = value.match(PHONE_RE)?.[0]?.trim();
      if (phone && looksLikePhone(phone)) patch.phone = phone;
      continue;
    }
    patch[field] = value;
  }
  return patch;
}

/** A plausible personal name from "I'm John" / "my name is John Smith". */
export function extractNameHint(text: string): string {
  const captured = text.match(NAME_HINT_RE)?.[1];
  if (!captured) return "";

  const tokens = captured
    .split(/\s+/)
    .filter((token) => !/\d/.test(token) && token.length > 1);
  while (tokens.length > 0 && NAME_STOPWORDS.has(tokens[0].toLowerCase())) tokens.shift();
  while (tokens.length > 0 && NAME_STOPWORDS.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  if (tokens.length === 0) return "";
  return tokens
    .slice(0, 2)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

/**
 * Everything one visitor message contributes to the draft, without an LLM:
 * labelled fields, a bare email/phone, a name hint, and any date/time
 * expression. Deterministic, so a message carrying four details updates four
 * fields — and so contact details can never be hallucinated.
 */
export function extractDraftFromMessage(
  text: string,
  now: Date,
  timezone: string,
): BookingDraftPatch {
  const patch: BookingDraftPatch = { ...extractLabeledFields(text) };

  if (!patch.email) {
    const email = text.match(EMAIL_RE)?.[0];
    if (email) patch.email = email;
  }
  if (!patch.phone) {
    // Strip any email first: its local part can carry enough digits to look
    // like a phone number.
    const phone = text.replace(EMAIL_RE, " ").match(PHONE_RE)?.[0]?.trim();
    if (phone && looksLikePhone(phone)) patch.phone = phone;
  }
  if (!patch.name) {
    const name = extractNameHint(text);
    if (name) patch.name = name;
  }

  const window = parseWhen(text, now, timezone);
  if (window) {
    // Only a single-day window pins a date; "next week" stays a search hint.
    const spanMs = Date.parse(window.toISO) - Date.parse(window.fromISO);
    if (spanMs <= 26 * 3_600_000) {
      patch.date = dateStringInTz(new Date(window.fromISO), timezone);
    }
    if (window.exactTime && window.localHourRange) {
      patch.time = `${String(window.localHourRange.startHour).padStart(2, "0")}:00`;
    }
  }

  return patch;
}

/**
 * Applies a patch to a draft: a non-empty value always wins (so the latest
 * correction sticks), an empty one never clears what's known.
 *
 * Changing the day or time silently drops the commitment — a visitor who
 * moves from "10am" to "2pm" has un-agreed to 10am, and the engine must not
 * book either time until they agree again.
 */
export function mergeDraft(draft: BookingDraft, patch: BookingDraftPatch): BookingDraft {
  const next: BookingDraft = { ...draft };
  for (const key of ["service", "date", "time", "name", "email", "phone", "notes"] as const) {
    const value = patch[key]?.trim();
    if (value) next[key] = value;
  }

  const timeChanged = next.date !== draft.date || next.time !== draft.time;
  next.timeCommitted = patch.timeCommitted ?? (timeChanged ? false : draft.timeCommitted);
  return next;
}

/** Whether the conversation has started assembling a booking at all. */
export function hasDraftContent(draft: BookingDraft | null): boolean {
  if (!draft) return false;
  return Boolean(
    draft.service || draft.date || draft.time || draft.name || draft.email || draft.phone,
  );
}

function localHourMinute(iso: string, timezone: string): { hour: number; minute: number } {
  const decimal = hourInTz(new Date(iso), timezone);
  const hour = Math.floor(decimal);
  return { hour, minute: Math.round((decimal - hour) * 60) };
}

/**
 * Finds the open slot the draft's day/time refers to, or null when the draft
 * doesn't name one time unambiguously. Matching is on the wall clock the
 * visitor used, never on a slot index — so a stale list can't book the
 * wrong time.
 */
export function resolveSlot(
  draft: BookingDraft,
  slots: TimeSlot[],
  timezone: string,
): TimeSlot | null {
  if (!draft.time) return null;
  const [wantHour, wantMinute] = draft.time.split(":").map(Number);
  if (!Number.isFinite(wantHour)) return null;

  const candidates = slots.filter((slot) => {
    if (draft.date && dateStringInTz(new Date(slot.startsAt), timezone) !== draft.date) {
      return false;
    }
    const { hour, minute } = localHourMinute(slot.startsAt, timezone);
    // A bare hour ("10am") matches any slot inside it; the parser only ever
    // resolves to hour precision.
    return hour === wantHour && (wantMinute === 0 || minute === wantMinute);
  });

  // Without a day, an hour that exists on several days is still ambiguous.
  if (!draft.date) {
    const days = new Set(candidates.map((s) => dateStringInTz(new Date(s.startsAt), timezone)));
    if (days.size > 1) return null;
  }
  return candidates[0] ?? null;
}

/** Records the slot the visitor just agreed to on the draft. */
export function commitSlot(
  draft: BookingDraft,
  slot: TimeSlot,
  timezone: string,
): BookingDraft {
  const { hour, minute } = localHourMinute(slot.startsAt, timezone);
  return {
    ...draft,
    date: dateStringInTz(new Date(slot.startsAt), timezone),
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    timeCommitted: true,
  };
}

/**
 * What still stands between the draft and a booking, in the order a
 * receptionist would naturally ask for it. Empty means "call the engine".
 */
export function missingFields(draft: BookingDraft, hasCommittedSlot: boolean): MissingField[] {
  const missing: MissingField[] = [];
  if (!draft.service) missing.push("service");
  if (!hasCommittedSlot) missing.push("time");
  if (!draft.name) missing.push("name");
  if (!draft.phone && !draft.email) missing.push("contact");
  return missing;
}

const FIELD_QUESTIONS: Record<MissingField, string> = {
  service: "what they need booked in",
  time: "which of the open times above suits them",
  name: "their name",
  contact: "a phone number or email so the confirmation can reach them",
};

/** How to ask for one missing field, for the prompt's "next step" line. */
export function describeMissingField(field: MissingField): string {
  return FIELD_QUESTIONS[field];
}

/**
 * The draft as prompt text, so the model can see exactly what the visitor
 * has already told it — the cure for re-asking questions already answered.
 */
export function describeDraft(draft: BookingDraft, timezone: string): string {
  const lines: string[] = [];
  if (draft.service) lines.push(`- Service: ${draft.service}`);
  if (draft.date || draft.time) {
    const when = [draft.date, draft.time].filter(Boolean).join(" ");
    lines.push(
      `- Preferred time: ${when} (${timezone})${draft.timeCommitted ? " — agreed" : " — not yet agreed"}`,
    );
  }
  if (draft.name) lines.push(`- Name: ${draft.name}`);
  if (draft.phone) lines.push(`- Phone: ${draft.phone}`);
  if (draft.email) lines.push(`- Email: ${draft.email}`);
  if (draft.notes) lines.push(`- Notes: ${draft.notes}`);
  return lines.join("\n");
}
