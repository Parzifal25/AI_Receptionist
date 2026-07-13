# Appointment Intelligence

How the receptionist goes from answering questions to completing work: it
qualifies, checks real availability, offers slots, books, confirms, and
triggers reminders — inside a normal conversation.

## The booking turn

```
Visitor: "I'd like AC servicing tomorrow."
   │
   ▼
BookingOrchestrator.prepareTurn (per chat turn, stateless)
   1. scheduling context?   keyword OR parsed time expression OR live appointment
   2. parseWhen             "tomorrow" → UTC window in the business timezone
   3. getAvailability       real slots from the availability engine
   4. extractAction         JSON pass: did the visitor just commit to a slot / cancel?
   5. execute               book / reschedule / cancel via BookingService
   6. inject ground truth   "## Live scheduling" or "## Booking status" prompt section
   │
   ▼
Reply model narrates what the engine actually did. It can only offer
system-verified times and can only claim a booking the engine confirmed.
```

Design rule: **the LLM never decides facts.** Slots come from the engine;
bookings happen before the reply is generated; the model is handed the result.
Failures anywhere degrade to a normal, booking-free turn (`chat-service.ts`
catches everything from the orchestrator).

A completed booking also force-runs lead extraction on that turn, so every
appointment produces a scored lead.

## Architecture

| Layer | Module | Notes |
|---|---|---|
| Domain | `src/core/domain/scheduling.ts` | Appointment, StaffMember, SchedulingSettings, TimeSlot, reminders |
| State machine | `scheduling/appointment-state.ts` | pending → confirmed → completed / cancelled / no_show; terminal states can't resurrect |
| Timezone math | `scheduling/timezone.ts` | Intl-based, no date library; DST-safe wall-clock → UTC |
| Availability | `scheduling/availability.ts` | Pure. Working hours (per-staff or business), slot duration, buffers, holidays, min notice, max advance, busy-interval conflicts, multi-staff round-robin merge |
| Date parsing | `scheduling/when-parser.ts` | Deterministic "tomorrow / next tuesday / july 15 / morning" → UTC window |
| Booking engine | `scheduling/booking-service.ts` | availability → book → confirm → remind; reschedule; cancel |
| Persistence | `scheduling/scheduling-repository.ts` | Service-role Supabase; SlotTakenError on constraint violation |
| Conversation bridge | `scheduling/booking-orchestrator.ts` | Turn pipeline described above |
| Reminders | `scheduling/reminder-service.ts` + `/api/cron/reminders` | Vercel Cron every 5 min |
| Calendar port | `src/core/ports/calendar-provider.ts` | listBusy / create / update / delete |
| Calendar adapters | `src/providers/calendar/*` | internal, Google, Outlook (Graph), CalDAV |
| Messaging port | `src/core/ports/messaging-provider.ts` | sms / whatsapp / email |
| Messaging adapters | `src/providers/messaging/*` | `log` today; Twilio/WhatsApp slot into the factory |

## Race conditions and conflict detection

The database is the arbiter, not application code. Migration
`0008_appointments.sql` adds:

```sql
constraint appointments_no_overlap exclude using gist (
  staff_id with =, tstzrange(starts_at, ends_at) with &&
) where (status in ('pending', 'confirmed'))
```

Two visitors confirming the same slot concurrently resolve to exactly one
appointment. The loser's insert raises `23P01`, the repository converts it to
`SlotTakenError`, the booking service returns `slot_taken` **with fresh
alternatives**, and the orchestrator tells the model to apologise and offer
them — the conversation recovers instead of dead-ending. Cancelling releases
the slot (the constraint only covers live statuses).

## Calendars

`calendarFor(staff)` resolves a `calendar_connections` row (staff-level
first, business-level fallback) into an adapter via the factory. External
calendars contribute **extra busy time** during availability and receive
event create/update/delete after bookings. Two invariants:

- Our appointments table is always consulted and always wins — an external
  outage degrades availability to internal-only and never blocks or loses a
  booking (external sync failures are logged, the row keeps
  `external_event_id = ''`).
- OAuth tokens auto-refresh (single-flight) and rotated tokens are persisted
  back through `onTokenRotate`. Google uses freeBusy + events; Outlook uses
  Graph calendarView + events; CalDAV uses calendar-query REPORT + ICS PUT
  with minted UIDs. All calls go through `withRetry` (backoff on 429/5xx,
  fail-fast on other 4xx).

What's not built yet: the dashboard OAuth connect flow that populates
`calendar_connections` (the engine reads whatever is there).

## Reminders

Booking enqueues `appointment_reminders` rows at each configured lead time
(default 24h and 1h before; per-tenant `reminder_lead_minutes`). The cron
worker claims due rows through `claim_due_reminders()` (`FOR UPDATE SKIP
LOCKED` — overlapping runs are safe). Claiming is pessimistic: a claimed row
is marked failed-with-attempt first, so a crash mid-delivery can never
double-send. Success flips it to `sent`; a delivery error requeues with a
10-minute backoff up to 3 attempts. Reminders for cancelled/started
appointments are skipped; rescheduling cancels and re-enqueues.

Channel selection: phone → sms, else email. With `MESSAGING_PROVIDER=log`
(the default) deliveries land in the application log; wiring Twilio/WhatsApp
is a new factory case, no engine changes.

## Configuration

Booking is off until a tenant has a `scheduling_settings` row with
`booking_enabled = true` **and** at least one active `staff_members` row.
Policy knobs: timezone (IANA), `slot_duration_minutes`, `buffer_minutes`,
`min_notice_minutes`, `max_advance_days`, `holidays` (YYYY-MM-DD array),
`reminders_enabled`, `reminder_lead_minutes`.

Env: `MESSAGING_PROVIDER` (default `log`), `GOOGLE_CLIENT_ID/SECRET`,
`MICROSOFT_CLIENT_ID/SECRET` (only needed once a tenant connects that
provider), `CRON_SECRET` (authorizes `/api/cron/reminders`).

## Testing

- `timezone.test.ts` — DST conversions, date-line, formatting.
- `availability.test.ts` — hours, buffers, holidays, notice, horizon, busy conflicts, per-staff hours, round-robin, time-of-day filters.
- `when-parser.test.ts` — today/tomorrow/weekday/next week/explicit dates/time-of-day.
- `appointment-state.test.ts` — legal and illegal transitions.
- `retry.test.ts`, `ics.test.ts` — retry policy, CalDAV ICS parsing.
- `booking-service.test.ts` — end-to-end workflow against an in-memory repo that simulates the exclusion constraint: book/confirm/remind, double-book race, cancel-frees-slot, reschedule, validation.
- `booking-orchestrator.test.ts` — conversation bridge: context detection, slot injection, confirmed booking before reply, slot-taken recovery, reschedule-not-double-book, cancel fast path.
- `chat-service.test.ts` — booking context reaches the prompt; bookings force lead capture.

## Known limits / next steps

1. No dashboard UI for staff, settings, appointments, or calendar OAuth connect — the engine is API/data complete, the management surface isn't.
2. `parseWhen` handles dates and day-parts, not exact clock times ("at 2:30pm"); the slot list makes that mostly moot, but exact-time matching would sharpen the extractor.
3. Reminder copy is fixed English; per-tenant templates and the visitor's language are a natural extension.
4. No per-service durations — one slot length per business today (`services` catalog is the schema-level next step).
