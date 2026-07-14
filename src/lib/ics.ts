/**
 * Minimal RFC 5545 iCalendar builder for appointment confirmations. Emits a
 * single-VEVENT VCALENDAR the visitor's mail client renders as an "add to
 * calendar" attachment. Pure string work — safe in any runtime.
 */

export interface IcsEventInput {
  /** Globally unique, stable per appointment (drives client-side updates). */
  uid: string;
  title: string;
  description?: string;
  location?: string;
  /** UTC ISO instants. */
  startsAt: string;
  endsAt: string;
  /** Link back to the self-service manage page. */
  url?: string;
  organizerName?: string;
  attendeeName?: string;
  attendeeEmail?: string;
  /** REQUEST for new/updated bookings, CANCEL when the appointment dies. */
  method?: "REQUEST" | "CANCEL";
  /** Bumps on updates so calendar clients replace the earlier event. */
  sequence?: number;
}

/** "2026-07-14T09:00:00.000Z" → "20260714T090000Z". */
export function toIcsUtcStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ISO instant: ${iso}`);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Escapes text per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline). */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Folds a content line at 75 octets with a leading space, per RFC 5545 §3.1. */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    // First segment gets 75 octets, continuations 74 (their leading space
    // counts). Back up if the cut would split a multi-byte character.
    let take = Math.min(start === 0 ? 75 : 74, bytes.length - start);
    while (take > 1 && (bytes[start + take] & 0xc0) === 0x80) take -= 1;
    parts.push(bytes.subarray(start, start + take).toString("utf8"));
    start += take;
  }
  return parts.join("\r\n ");
}

export function buildIcsEvent(input: IcsEventInput): string {
  const method = input.method ?? "REQUEST";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AI Receptionist//Booking//EN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(input.uid)}`,
    `DTSTAMP:${toIcsUtcStamp(new Date().toISOString())}`,
    `DTSTART:${toIcsUtcStamp(input.startsAt)}`,
    `DTEND:${toIcsUtcStamp(input.endsAt)}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
    `SEQUENCE:${input.sequence ?? 0}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
  ];
  if (input.description) lines.push(`DESCRIPTION:${escapeIcsText(input.description)}`);
  if (input.location) lines.push(`LOCATION:${escapeIcsText(input.location)}`);
  if (input.url) lines.push(`URL:${escapeIcsText(input.url)}`);
  if (input.organizerName) {
    lines.push(`ORGANIZER;CN=${escapeIcsText(input.organizerName)}:MAILTO:noreply@invalid`);
  }
  if (input.attendeeEmail) {
    const cn = escapeIcsText(input.attendeeName || input.attendeeEmail);
    lines.push(`ATTENDEE;CN=${cn};ROLE=REQ-PARTICIPANT:MAILTO:${input.attendeeEmail}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
