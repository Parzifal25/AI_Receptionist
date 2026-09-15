# Appointment Intelligence

How the receptionist goes from answering questions to completing work: it
qualifies, checks real availability, offers slots, books, confirms, and
triggers reminders — inside a normal conversation.

## The booking turn

```
Visitor: "I'd like AC servicing tomorrow."
   │
   ▼
BookingOrchestrator.prepareTurn (per chat turn, draft-driven)
   1. load draft            the appointment this conversation is assembling
   2. scheduling context?   keyword OR parsed time expression OR live appointment OR draft
   3. parseWhen             "tomorrow" → UTC window in the business timezone
   4. getAvailability       real slots from the availability engine
   5. update the draft      LLM extraction, then deterministic extraction (regex wins)
   6. resolve + commit      the visitor's wall clock → one real open slot
   7. execute               the moment the draft is complete: book / reschedule / cancel
   8. inject ground truth   "## Live scheduling" or "## Booking status" prompt section
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
appointment produces a scored lead. Booking, rescheduling, and cancelling
additionally emit `appointment.*` business events into the workflow/CRM
platform (fire-and-forget — automation can never break a booking); see
[WORKFLOWS.md](WORKFLOWS.md).

## The draft appointment

A booking is rarely one message. `scheduling/booking-draft.ts` holds what the
conversation has gathered so far — `service`, `date`, `time`, `name`, `email`,
`phone`, `notes` — persisted per conversation in `booking_drafts`
(`0012_booking_drafts.sql`) and deleted the moment it becomes a real
appointment. Every turn *updates* it; no turn restarts it.

- **One message, many fields.** Deterministic extraction reads labelled values
  (`Name:` / `Phone:` / `Email:`, inline or on the following line), a bare
  email or phone, "I'm Sam", and any date/time expression — so a pasted block
  of details fills every field in one pass. The LLM pass adds `service` and
  `notes`; regex-verified contact details always win, because they cannot be
  hallucinated.
- **Latest value wins, empty never clears.** A corrected phone number or
  service replaces the old one; a turn that mentions neither leaves them alone.
- **Agreed vs. mentioned.** `date`/`time` are the visitor's wall clock, not an
  instant. `timeCommitted` records that they *agreed* to it rather than merely
  asked about it, and changing the time clears the flag — so a correction can
  never book the superseded slot. Only a committed time that still matches a
  real open slot is bookable, and the visitor's own words outrank the model's
  slot number (a re-indexed list must never turn "9am" into 10am).
- **Complete → book.** When `missingFields` comes back empty the orchestrator
  calls `BookingService` itself; the visitor never has to say "yes" twice.
- **Failure keeps the draft.** A rejected booking drops the dead time and
  keeps everything else, so recovery never re-collects details.

The draft is also what stops the generic-question loop: the prompt section
lists exactly what the visitor has already given ("never ask for any of them
again") and names the single next thing to ask for.

## What the model may claim

The reply model narrates; it never decides. Every branch of `prepareTurn`
says explicitly what did and did not happen:

- Nothing is described as booked unless `BookingService` returned `ok: true`
  **on this turn**. Mid-booking sections state "The appointment is NOT booked"
  and forbid "confirmed / held / reserved".
- A failed booking is reported as failed, with the engine's own reason and its
  real alternatives — never re-narrated as a success.
- A cancellation request with no appointment on file gets an honest "I can't
  see a booking under this chat", never a fabricated cancellation.
- A repeated confirmation of a time the visitor already holds is answered with
  "nothing has changed", not a silent reschedule into the next free slot.
- Prices, policies, staff actions and availability may only come from the
  business profile, knowledge base, or an engine-supplied section.

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
| Draft appointment | `scheduling/booking-draft.ts` | Pure. Conversation-scoped booking state: extraction, merge, slot resolution, readiness |
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
) where (status in ('pending', 'confirmed', 'checked_in', 'running_late', 'in_progress'))
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

Google Calendar connects from Settings → "Connect Google Calendar":
`/api/oauth/google-calendar/start` sends an admin to Google consent
(calendar.events + calendar.freebusy scopes, offline access) with an
HMAC-signed state bound to the business and a CSRF nonce cookie;
`/api/oauth/google-calendar/callback` verifies both plus the signed-in
user's tenancy, exchanges the code, and stores the business-level row in
`calendar_connections` (staff-level rows can be layered on later). Requires
`GOOGLE_CLIENT_ID/SECRET` and the callback URL registered in Google Cloud
Console as `<NEXT_PUBLIC_APP_URL>/api/oauth/google-calendar/callback`.
Outlook/CalDAV connect flows aren't built yet (the engine reads whatever
rows exist).

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

Those booking-engine knobs are still SQL/API. The **customer-facing** half of
the same table — reminder schedule, location address, prep instructions,
intake form, review link, and the automatic no-show sweep — is edited at
`/dashboard/settings/lifecycle` (see [LIFECYCLE.md](LIFECYCLE.md)).

Env: `MESSAGING_PROVIDER` (default `log`), `GOOGLE_CLIENT_ID/SECRET`,
`MICROSOFT_CLIENT_ID/SECRET` (only needed once a tenant connects that
provider), `CRON_SECRET` (authorizes `/api/cron/reminders`).

## Testing

- `timezone.test.ts` — DST conversions, date-line, formatting.
- `availability.test.ts` — hours, buffers, holidays, notice, horizon, busy conflicts, per-staff hours, round-robin, time-of-day filters.
- `when-parser.test.ts` — today/tomorrow/weekday/next week/explicit dates/time-of-day/exact clock times (am-pm, 24h, ambiguous-hour resolution).
- `oauth-state.test.ts` — signed OAuth state: round-trip, tamper/forgery rejection, TTL expiry.
- `appointment-state.test.ts` — legal and illegal transitions.
- `retry.test.ts`, `ics.test.ts` — retry policy, CalDAV ICS parsing.
- `booking-service.test.ts` — end-to-end workflow against an in-memory repo that simulates the exclusion constraint: book/confirm/remind, double-book race, cancel-frees-slot, reschedule, validation.
- `booking-draft.test.ts` — draft model: labelled/multi-field extraction, name hints, merge and correction semantics, commitment clearing, slot resolution and ambiguity, readiness.
- `booking-orchestrator.test.ts` — conversation bridge: context detection, slot injection, draft accumulation, auto-booking on completion, corrections, slot-taken and rejected-booking recovery, reschedule-not-double-book, cancel fast path, cancel-with-nothing-to-cancel, extraction-pass outage.
- `booking-conversation.test.ts` — end-to-end conversations through ChatService + orchestrator + engine: multi-turn booking, one-message booking, no re-asking, corrections, repeated messages, reschedule, cancellation, tool failure and recovery, no-availability honesty.
- `chat-service.test.ts` — booking context reaches the prompt; bookings force lead capture.

## Beyond the booking: the customer lifecycle

Everything around the appointment — HTML confirmations with ICS attachments,
WhatsApp/SMS, self-service reschedule/cancel links (`/appt/<manage_token>`),
directions, prep instructions, intake forms, day-of status tracking
(`checked_in`, `running_late`, `in_progress`), thank-yous, satisfaction
surveys, review/rebook journeys, and lifecycle analytics — lives in the
lifecycle layer. See [LIFECYCLE.md](LIFECYCLE.md). The state machine in
`appointment-state.ts` and migration `0010_customer_lifecycle.sql` are the
scheduling-side anchors.

## Known limits / next steps

1. No dashboard UI for staff or the booking-engine settings (timezone, slot length, buffers, notice, holidays) — the engine is API/data complete. Appointments have a day-of tracking board (`/dashboard/appointments`) and the customer-facing lifecycle settings have an editor (`/dashboard/settings/lifecycle`); staff and slot policy are still SQL/API. (Google Calendar connect IS built, on the Settings page; Outlook/CalDAV connect flows are not.)
2. ~~Exact clock times~~ solved: `parseWhen` parses "tomorrow at 10 AM", "2:30pm", "14:00", "noon" into a one-hour slot filter (`exactTime`), and the orchestrator answers a fully-booked exact time with the next three real openings instead of a dead end.
3. Reminder copy is fixed English; per-tenant templates and the visitor's language are a natural extension.
4. No per-service durations — one slot length per business today (`services` catalog is the schema-level next step).
