import type { BusyInterval } from "@halo/core/domain/scheduling";
import type { CalendarEventInput, CalendarProvider } from "@halo/ports/calendar-provider";

/**
 * The internal calendar: appointments live only in our database, which the
 * booking engine always consults (it is the source of truth and the race
 * arbiter for every staff member, external calendar or not). This adapter
 * therefore has no extra busy time to contribute and no external events to
 * write — it exists so "no connected calendar" is just another provider
 * rather than a special case in business logic.
 */
export class InternalCalendarProvider implements CalendarProvider {
  readonly name = "internal";

  async listBusy(): Promise<BusyInterval[]> {
    return [];
  }

  async createEvent(_calendarRef: string, _event: CalendarEventInput): Promise<string> {
    return ""; // no external system → no external event id
  }

  async updateEvent(): Promise<void> {}

  async deleteEvent(): Promise<void> {}
}
