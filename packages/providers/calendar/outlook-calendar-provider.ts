import type { BusyInterval } from "@halo/core/domain/scheduling";
import type { CalendarEventInput, CalendarProvider } from "@halo/ports/calendar-provider";
import { isTransientHttpError, withRetry } from "@halo/platform/retry";
import { authedJsonFetch, type TokenSource } from "./token-source";

const API = "https://graph.microsoft.com/v1.0";

/**
 * Microsoft Outlook adapter over the Graph API. Busy time comes from
 * calendarView (expands recurring events server-side); event CRUD uses the
 * standard events resource. `calendarRef` is the Graph calendar id, or ""
 * for the connected mailbox's default calendar.
 */
export class OutlookCalendarProvider implements CalendarProvider {
  readonly name = "outlook";

  constructor(private readonly token: TokenSource) {}

  private base(calendarRef: string): string {
    return calendarRef
      ? `${API}/me/calendars/${encodeURIComponent(calendarRef)}`
      : `${API}/me/calendar`;
  }

  async listBusy(calendarRef: string, fromISO: string, toISO: string): Promise<BusyInterval[]> {
    const params = new URLSearchParams({
      startDateTime: fromISO,
      endDateTime: toISO,
      $select: "start,end,showAs",
      $top: "250",
    });
    const data = await this.call<{
      value?: Array<{
        start: { dateTime: string; timeZone: string };
        end: { dateTime: string; timeZone: string };
        showAs?: string;
      }>;
    }>(`${this.base(calendarRef)}/calendarView?${params}`, { method: "GET" });

    return (data.value ?? [])
      .filter((e) => e.showAs !== "free")
      .map((e) => ({
        // Graph returns UTC wall times for calendarView by default.
        start: new Date(`${e.start.dateTime}Z`).toISOString(),
        end: new Date(`${e.end.dateTime}Z`).toISOString(),
      }));
  }

  async createEvent(calendarRef: string, event: CalendarEventInput): Promise<string> {
    const data = await this.call<{ id: string }>(`${this.base(calendarRef)}/events`, {
      method: "POST",
      body: JSON.stringify(toGraphEvent(event)),
    });
    return data.id;
  }

  async updateEvent(calendarRef: string, eventId: string, event: CalendarEventInput): Promise<void> {
    await this.call(`${API}/me/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify(toGraphEvent(event)),
    });
  }

  async deleteEvent(_calendarRef: string, eventId: string): Promise<void> {
    await this.call(`${API}/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  }

  private call<T>(url: string, init: RequestInit): Promise<T> {
    return withRetry(async () => authedJsonFetch<T>(url, await this.token(), init), {
      isRetryable: isTransientHttpError,
    });
  }
}

function toGraphEvent(event: CalendarEventInput) {
  return {
    subject: event.title,
    body: { contentType: "text", content: event.description },
    start: { dateTime: event.startsAt.replace(/Z$/, ""), timeZone: "UTC" },
    end: { dateTime: event.endsAt.replace(/Z$/, ""), timeZone: "UTC" },
    ...(event.attendeeEmail
      ? {
          attendees: [
            {
              emailAddress: { address: event.attendeeEmail, name: event.attendeeName ?? "" },
              type: "required",
            },
          ],
        }
      : {}),
  };
}
