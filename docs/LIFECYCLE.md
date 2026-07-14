# Customer Lifecycle

Everything that happens **before**, **during**, and **after** an appointment.
The AI books the visit ([SCHEDULING.md](SCHEDULING.md)); this layer turns that
one row into a complete customer journey — confirmations, reminders,
self-service, day-of tracking, surveys, reviews, rebooking, a searchable
customer timeline, and the analytics over all of it.

```
BEFORE                       DURING                    AFTER
──────                       ──────                    ─────
HTML email + ICS invite      checked_in                thank-you message
WhatsApp / SMS confirmation  running_late              satisfaction survey
reminder engine (custom      in_progress               review request (workflow)
  schedules, retries)        completed / no_show       follow-up & rebook offers
reschedule / cancel links       │                        (30-day timer)
directions (Google Maps)        └── every transition   no-show recovery
prep instructions                   emits a business   CRM stage → customer
intake forms                        event              revenue attribution
```

## Before the appointment

**Confirmations** (`src/core/services/lifecycle/confirmation-service.ts`).
On booking (and again on reschedule) the visitor gets, best-effort on every
reachable channel:

- **HTML email** with the appointment facts, *Manage booking* and *Get
  directions* buttons, prep instructions, an intake-form nudge — plus an
  **ICS calendar attachment** (`src/lib/ics.ts`, RFC 5545: escaping, 75-octet
  folding, `METHOD:REQUEST`; cancellations send `METHOD:CANCEL` so calendars
  clean themselves up).
- **WhatsApp** when the messaging gateway supports it, **SMS** otherwise —
  same facts, plain text.

All wording lives in pure builders
(`confirmation-content.ts`) so tests pin the copy and channels never drift.

**Self-service links.** Every appointment carries an unguessable
`manage_token` (uuid, unique index). `https://<app>/appt/<token>` is the
visitor's page: reschedule (server-re-derived slots only), cancel, check in,
"running late", directions, prep instructions, intake form, and — after the
visit — the satisfaction survey. The token is the entire credential; the API
(`/api/v1/appointments/:token[...]`) never accepts ids, rate-limits by IP,
and 404s malformed tokens identically to unknown ones.

**Reminder engine.** Unchanged mechanics (SKIP LOCKED claiming, pessimistic
delivery, retries with backoff — see SCHEDULING.md) with lifecycle content:
manage link, prep instructions, directions. Custom schedules per business via
`reminder_lead_minutes`. Deliveries/failures land in `usage_events`
(`reminder_sent` / `reminder_failed`) so reminder success is measurable.

**Business content** (`scheduling_settings`): `location_address` (drives the
Google Maps deep link), `prep_instructions`, `intake_form` (JSON array of
`{id, label, type: text|textarea|checkbox, required}` fields; responses in
`intake_responses`, one per appointment, resubmission revises), `review_url`.

## During the appointment

The state machine (`appointment-state.ts`) covers the day of:

```
pending ──► confirmed ──► running_late ──► checked_in ──► in_progress ──► completed
                │  │            │______________│_______________│
                │  └─► no_show  └─────────► cancelled ◄────────┘
```

- Non-terminal statuses **hold the slot** (the exclusion constraint was
  rebuilt over the expanded set).
- Visitors can reschedule/cancel while `pending/confirmed/running_late`
  (`isLive`); once checked in, changes are staff-side.
- Staff drive transitions from **`/dashboard/appointments`** (today /
  upcoming / past board, one-click Check in / Late / Start / Complete /
  No-show, only legal moves offered); visitors can self-check-in or flag
  lateness from the manage page.
- `AppointmentLifecycleService.transition()` validates the move, writes the
  status + note, cancels pending reminders on terminal outcomes, records the
  analytics event, sends the thank-you on completion, and emits
  `appointment.checked_in` / `appointment.completed` / `appointment.no_show`
  for workflows.

## After the appointment

- **Thank-you message** (email + WhatsApp/SMS) with a one-tap survey link is
  sent on completion — built in, no workflow required.
- **Satisfaction survey / feedback** — 1–5 stars, optional 0–10 NPS, comment
  (`appointment_feedback`, one row per appointment, resubmission revises).
  Valid once the visit happened (completed, or start time passed and not
  cancelled). Every submission emits `feedback.received` and lands on the
  customer timeline as a review entry.
- **Review requests, follow-ups, rebooking, no-show recovery** — tenant
  workflows on `appointment.completed` / `appointment.no_show` /
  `feedback.received`, with ready-made journey templates (review ask after
  1 day, rebook offer after 30, unhappy-customer alert under 4 stars). See
  [WORKFLOWS.md](WORKFLOWS.md#journey-templates--the-visual-builder).

## Customer timeline

The built-in CRM records every interaction against one deduped customer:
appointments (booked, rescheduled, cancelled, checked in, completed,
no-show), leads, reviews/feedback, revenue, merges, and anything workflows
append (`crm_record_timeline` — reminder/email/whatsapp entries come from
journey steps). **`/dashboard/customers`** searches people by name / email /
phone; the detail page searches the timeline by text and filters by kind.

## OpsCorp / back-office provider

Workflows create FSM tickets, technician jobs, quotes, invoices, inventory
reservations, and payments through the `OpsProvider` port via the
`ops_create` action — business logic never touches a back-office API, so
connecting OpsCorp is one new factory case. Details in
[WORKFLOWS.md](WORKFLOWS.md#actions).

## Analytics

`GET /api/analytics/lifecycle?days=7|30|90` and **`/dashboard/analytics`**
compute, per business (formulas pinned in
`tests/unit/lifecycle-analytics.test.ts`):

| Metric | Definition |
|---|---|
| Booking conversion | bookings / conversations started |
| Reminder success | `reminder_sent` / (`reminder_sent` + `reminder_failed`) |
| No-show rate | no-shows / (completed + no-shows) |
| Review rate | feedback received / completed (requests shown alongside) |
| Customer lifetime value | attributed revenue / customers |
| Repeat customers | customers with ≥2 appointments / customers with ≥1 |
| Revenue | Σ `customers.revenue_total` (attributed via `crm_record_revenue`) |
| Appointment utilization | booked minutes / (staff × days × 8 h) — directional |
| Peak booking hours | start-hour histogram in each booking's local time |
| AI success rate | 1 − unanswered questions / messages |

Rates use the selected period; revenue/CLV cover all time. Empty
denominators render as "—", never fake zeros.

## Data & security

- Migration `0010_customer_lifecycle.sql`: expanded status set + rebuilt
  exclusion constraint, `manage_token`, `appointment_feedback`,
  `intake_responses`, lifecycle columns on `scheduling_settings`, new
  `usage_events` types, member-read RLS on the new tables (writes go through
  the service role, token- or tenant-scoped in code).
- Public endpoints are rate-limited (`appointmentManageLimiter`) and
  validate the token shape before touching the database.
- Everything after a status write is best-effort: a messaging or analytics
  outage never loses the state change (same rule as booking).

## Tests

- `ics-builder.test.ts` — stamps, escaping, folding, REQUEST/CANCEL.
- `confirmation-content.test.ts` — links, HTML escaping, copy on every channel.
- `appointment-state.test.ts` — full day-of state machine.
- `lifecycle-service.test.ts` (integration) — transitions, reminder cleanup,
  thank-you delivery, emitted events, feedback validity windows.
- `lifecycle-analytics.test.ts` — every metric formula + zero-safety.
- `workflow-templates.test.ts` — templates validate, `{{var}}` substitution,
  the canonical booked → review → rebook journey shape.
- `workflow-actions.test.ts` — `request_review`, `ops_create` (+ existing).

## Known limits / next steps

- Timezone note: the appointments board's "today" uses the server clock, not
  the business timezone; fine for same-region deployments.
- No automatic no-show sweep (staff mark it); a cron that flags overdue
  confirmed appointments is a natural V2 item.
- `intake_form` has no dashboard editor yet — set via SQL/API for now.
- Reminder channel is chosen once (phone → sms, else email); per-lead-time
  channel mixes are schema-ready (`appointment_reminders.channel`) but not
  exposed.
