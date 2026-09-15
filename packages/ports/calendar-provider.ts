import type { BusyInterval } from "@halo/core/domain/scheduling";

export interface CalendarEventInput {
  title: string;
  description: string;
  /** UTC ISO instants. */
  startsAt: string;
  endsAt: string;
  /** IANA zone for providers that render events in local time. */
  timezone: string;
  attendeeName?: string;
  attendeeEmail?: string;
}

/**
 * Port for external calendar backends. The booking engine talks only to this
 * interface — Google, Outlook, CalDAV and the internal calendar are
 * interchangeable adapters, so business logic never changes when a tenant
 * connects a different calendar.
 *
 * `calendarRef` is the provider-specific calendar identifier (a Google
 * calendar id, an Outlook calendar id, a CalDAV collection URL, ...).
 */
export interface CalendarProvider {
  readonly name: string;
  /** Busy intervals within [fromISO, toISO). */
  listBusy(calendarRef: string, fromISO: string, toISO: string): Promise<BusyInterval[]>;
  /** Creates an event; returns the provider's event id. */
  createEvent(calendarRef: string, event: CalendarEventInput): Promise<string>;
  updateEvent(calendarRef: string, eventId: string, event: CalendarEventInput): Promise<void>;
  deleteEvent(calendarRef: string, eventId: string): Promise<void>;
}
