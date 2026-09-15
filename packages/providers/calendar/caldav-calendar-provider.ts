import type { BusyInterval } from "@halo/core/domain/scheduling";
import type { CalendarEventInput, CalendarProvider } from "@halo/ports/calendar-provider";
import { HttpError, isTransientHttpError, withRetry } from "@halo/platform/retry";

/**
 * CalDAV adapter (RFC 4791) — covers Apple/iCloud Calendar, Nextcloud,
 * Radicale, Fastmail and other standards-based servers with Basic auth.
 * `calendarRef` is the calendar collection URL. Busy time comes from a
 * calendar-query REPORT over the range; events are written as single-VEVENT
 * ICS objects PUT under a UID we mint, so update/delete address the same
 * resource deterministically.
 */
export class CalDavCalendarProvider implements CalendarProvider {
  readonly name = "caldav";

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    return withRetry(
      async () => {
        const response = await fetch(url, {
          ...init,
          headers: { authorization: this.authHeader, ...(init.headers ?? {}) },
        });
        if (!response.ok && response.status !== 207) {
          throw new HttpError(response.status, `CalDAV ${init.method} ${response.status}`);
        }
        return response;
      },
      { isRetryable: isTransientHttpError },
    );
  }

  async listBusy(calendarRef: string, fromISO: string, toISO: string): Promise<BusyInterval[]> {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${toIcsStamp(fromISO)}" end="${toIcsStamp(toISO)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

    const response = await this.request(calendarRef, {
      method: "REPORT",
      headers: { "content-type": "application/xml; charset=utf-8", depth: "1" },
      body,
    });
    return parseIcsBusy(await response.text());
  }

  async createEvent(calendarRef: string, event: CalendarEventInput): Promise<string> {
    const uid = `${crypto.randomUUID()}@ai-receptionist`;
    await this.putEvent(calendarRef, uid, event, true);
    return uid;
  }

  async updateEvent(calendarRef: string, eventId: string, event: CalendarEventInput): Promise<void> {
    await this.putEvent(calendarRef, eventId, event, false);
  }

  async deleteEvent(calendarRef: string, eventId: string): Promise<void> {
    await this.request(this.eventUrl(calendarRef, eventId), { method: "DELETE" });
  }

  private eventUrl(calendarRef: string, uid: string): string {
    return `${calendarRef.replace(/\/$/, "")}/${encodeURIComponent(uid)}.ics`;
  }

  private async putEvent(
    calendarRef: string,
    uid: string,
    event: CalendarEventInput,
    isNew: boolean,
  ): Promise<void> {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//AI Receptionist//Scheduling//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${toIcsStamp(new Date().toISOString())}`,
      `DTSTART:${toIcsStamp(event.startsAt)}`,
      `DTEND:${toIcsStamp(event.endsAt)}`,
      `SUMMARY:${escapeIcs(event.title)}`,
      `DESCRIPTION:${escapeIcs(event.description)}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    await this.request(this.eventUrl(calendarRef, uid), {
      method: "PUT",
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        // Create must not overwrite an existing resource; update must.
        ...(isNew ? { "if-none-match": "*" } : {}),
      },
      body: ics,
    });
  }
}

/** 2026-07-14T09:00:00.000Z → 20260714T090000Z */
export function toIcsStamp(iso: string): string {
  return `${iso.replace(/[-:]/g, "").slice(0, 15)}Z`;
}

function escapeIcs(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/**
 * Minimal ICS scan: pulls DTSTART/DTEND pairs of every VEVENT out of a
 * multistatus body. Handles UTC ("...Z") and all-day (VALUE=DATE) stamps;
 * events in other formats are skipped rather than misread.
 */
export function parseIcsBusy(body: string): BusyInterval[] {
  const busy: BusyInterval[] = [];
  const events = body.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];
  for (const event of events) {
    const start = parseIcsDate(event.match(/DTSTART[^:]*:([^\s<]+)/)?.[1]);
    const end = parseIcsDate(event.match(/DTEND[^:]*:([^\s<]+)/)?.[1]);
    if (start && end) busy.push({ start, end });
  }
  return busy;
}

function parseIcsDate(stamp: string | undefined): string | null {
  if (!stamp) return null;
  // 20260714T090000Z
  const utc = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (utc) {
    const [, y, m, d, hh, mm, ss] = utc;
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}.000Z`;
  }
  // 20260714 (all-day)
  const allDay = stamp.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (allDay) {
    const [, y, m, d] = allDay;
    return `${y}-${m}-${d}T00:00:00.000Z`;
  }
  return null;
}
