import type { BusyInterval } from "@/core/domain/scheduling";
import type { CalendarEventInput, CalendarProvider } from "@/core/ports/calendar-provider";
import { isTransientHttpError, withRetry } from "@/lib/retry";
import { authedJsonFetch, type TokenSource } from "./token-source";

const API = "https://www.googleapis.com/calendar/v3";

/**
 * Google Calendar adapter. Free/busy via the freeBusy endpoint (respects
 * every event on the calendar, not just ours) and standard event CRUD.
 * `calendarRef` is the Google calendar id ("primary" or an email-style id).
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google";

  constructor(private readonly token: TokenSource) {}

  async listBusy(calendarRef: string, fromISO: string, toISO: string): Promise<BusyInterval[]> {
    const data = await this.call<{
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    }>(`${API}/freeBusy`, {
      method: "POST",
      body: JSON.stringify({ timeMin: fromISO, timeMax: toISO, items: [{ id: calendarRef }] }),
    });
    const busy = data.calendars?.[calendarRef]?.busy ?? [];
    return busy.map((b) => ({ start: b.start, end: b.end }));
  }

  async createEvent(calendarRef: string, event: CalendarEventInput): Promise<string> {
    const data = await this.call<{ id: string }>(
      `${API}/calendars/${encodeURIComponent(calendarRef)}/events`,
      { method: "POST", body: JSON.stringify(toGoogleEvent(event)) },
    );
    return data.id;
  }

  async updateEvent(calendarRef: string, eventId: string, event: CalendarEventInput): Promise<void> {
    await this.call(
      `${API}/calendars/${encodeURIComponent(calendarRef)}/events/${encodeURIComponent(eventId)}`,
      { method: "PATCH", body: JSON.stringify(toGoogleEvent(event)) },
    );
  }

  async deleteEvent(calendarRef: string, eventId: string): Promise<void> {
    await this.call(
      `${API}/calendars/${encodeURIComponent(calendarRef)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );
  }

  private call<T>(url: string, init: RequestInit): Promise<T> {
    return withRetry(async () => authedJsonFetch<T>(url, await this.token(), init), {
      isRetryable: isTransientHttpError,
    });
  }
}

function toGoogleEvent(event: CalendarEventInput) {
  return {
    summary: event.title,
    description: event.description,
    start: { dateTime: event.startsAt, timeZone: event.timezone },
    end: { dateTime: event.endsAt, timeZone: event.timezone },
    ...(event.attendeeEmail
      ? { attendees: [{ email: event.attendeeEmail, displayName: event.attendeeName ?? "" }] }
      : {}),
  };
}
