# Changelog

## 2026-07-27 — Lifecycle automation & operability

Closes the gaps the V1 lifecycle platform left open: the parts of the
journey that still needed a human, a SQL client, or a log tail.

### Before the appointment
- **Lifecycle settings editor** (`/dashboard/settings/lifecycle`): location
  address, prep instructions, intake-form builder, review link, reminder
  schedule (`2d, 24h, 90m` shorthand), and the no-show sweep — previously
  SQL-only. Parsing rules live in a pure module
  (`core/services/lifecycle/lifecycle-settings.ts`): https-only review links,
  unique and safe intake ids, deduped/sorted reminder times, and id
  round-tripping so re-saving a form never orphans stored intake answers.

### During the appointment
- **Automatic no-show sweep** — `/api/cron/no-shows` (every 15 min) flips
  appointments nobody arrived for to `no_show`, opt-in per business, with a
  grace period measured from the appointment's end. Never touches
  `checked_in`/`in_progress`. Goes through the normal transition, so
  reminders are cancelled, analytics recorded, and `appointment.no_show`
  emitted — which drives the recovery journey with no staff input.
  Migration `0011_lifecycle_automation.sql` adds the settings and a partial
  index over exactly the sweep's predicate.

### After the appointment
- **Related-service upsell** journey template (completed → 7 days → offer +
  timeline entry) and **Periodic rebooking** (completed → the tenant's own
  `cadenceDays` → "you're due" invite).
- `schedule_followup` accepts `delayDays` for cadence-shaped journeys,
  capped at one year.

### Timeline & automation
- **Ops records reach the customer timeline** — tickets, jobs, quotes,
  invoices, reservations, and payments created via `ops_create` now appear
  on the customer's timeline, and a `payment` with a positive amount is
  attributed as revenue. Best-effort by design: throwing after the
  downstream record exists would make the engine retry and double-create it.
- **Run-history browser** in Automations plus `GET /api/workflows/runs` and
  `GET /api/workflows/runs/:runId` — recent runs by status, expandable into
  per-step logs. Journeys are no longer only observable through log drains.

### Tests
320 passing (up from 283): the sweep rule's every branch, lifecycle-settings
parsing, day-cadence timers, and `ops_create` timeline/revenue/failure paths.

## 2026-07-14 — Customer lifecycle platform

Appointments became a complete customer journey — everything before, during,
and after the visit. See [LIFECYCLE.md](LIFECYCLE.md).

### Before the appointment
- **Rich confirmations**: HTML email with manage/directions buttons and an
  **ICS calendar attachment** (`src/lib/ics.ts` — RFC 5545 escaping/folding,
  REQUEST/CANCEL methods); **WhatsApp** when the gateway supports it, SMS
  otherwise. Messaging port gained `html` + `attachments`.
- **Self-service manage page** (`/appt/<manage_token>`): reschedule
  (server-derived slots only), cancel, check in, running-late, Google Maps
  directions, prep instructions, **intake forms**, post-visit survey. Public
  token-authenticated API under `/api/v1/appointments/:token`, rate-limited,
  uuid tokens with unique index.
- **Reminders** now carry the manage link, prep, and directions, and record
  `reminder_sent`/`reminder_failed` for analytics.
- Per-business lifecycle content on `scheduling_settings`:
  `location_address`, `prep_instructions`, `intake_form`, `review_url`.

### During the appointment
- State machine expanded: `checked_in`, `running_late`, `in_progress` (slot
  still held; exclusion constraint rebuilt). `AppointmentLifecycleService`
  validates transitions, cancels reminders on terminal outcomes, and emits
  `appointment.checked_in` / `appointment.completed` / `appointment.no_show`.
- **`/dashboard/appointments`**: today/upcoming/past board with one-click
  legal transitions.

### After the appointment
- Built-in **thank-you message** with survey link on completion.
- **Satisfaction surveys** (`appointment_feedback`: 1–5 stars, optional NPS,
  comment; one per appointment, resubmission revises) emitting
  `feedback.received`; CRM stage advances to `customer` on completion.
- **Journey templates** (booking journey, review-ask after 1 day + rebook
  offer after 30, no-show recovery, unhappy-customer alert) installable from
  the new **visual workflow builder** (`/dashboard/automations`), backed by
  full workflow CRUD (`/api/workflows` + `/api/workflows/templates`).
- New workflow actions: `request_review` (tracks `review_requested`),
  `ops_create` — the **OpsCorp-ready `OpsProvider` port**
  (`fsm_ticket`, `technician_job`, `quote`, `invoice`,
  `inventory_reservation`, `payment`; `OPS_PROVIDER` factory, `log` adapter
  shipped).
- New triggers: `appointment.checked_in/completed/no_show`,
  `feedback.received` — with always-on CRM timeline sync for each.

### Customers & analytics
- **`/dashboard/customers`**: searchable customer list (name/email/phone) +
  per-customer **searchable timeline** (text + kind filters).
- **Lifecycle analytics** (`/dashboard/analytics`,
  `GET /api/analytics/lifecycle`): booking conversion, reminder success,
  no-show rate, review rate, CLV, repeat customers, revenue attribution,
  appointment utilization, peak booking hours, AI success rate — pure
  formulas pinned by unit tests.
- Migration `0010_customer_lifecycle.sql`; tests: 33 files / 283 passing.

## 2026-07-14 — Business automation platform

### Workflow engine (new)
- Event bus: every booking, lead, and conversation start emits a
  `BusinessEvent` (fire-and-forget; never breaks the emitting flow), recorded
  in `workflow_events` as an audit trail.
- Engine: tenant-defined workflows per trigger with AND-ed conditions,
  ordered steps, `{{event.…}}` variable interpolation, per-step timeouts and
  retries, run-level retries with exponential backoff, dead-letter queue,
  per-attempt execution logs, correlation IDs, and database-enforced
  idempotency (one run per workflow+event).
- Triggers: appointment created/rescheduled/cancelled, lead
  created/updated, conversation started, follow-up timers, inbound webhooks
  (`POST /api/hooks/:businessId`, per-tenant secret), manual runs
  (`POST /api/workflows/:id/run`, admin).
- Actions: send email/SMS/WhatsApp (messaging port), HTTPS webhooks with
  Slack/Discord/JSON formats (covers Zapier, n8n, Make, HubSpot, Salesforce,
  OpsCorp FSM, custom), CRM upsert/timeline/revenue, follow-up scheduling,
  analytics tracking.
- `/api/cron/workflows` (every 5 min): fires due timers, retries due runs.
- Migration `0009_workflows.sql`: workflows, workflow_events, workflow_runs,
  workflow_run_logs, workflow_timers + SKIP LOCKED claim functions.

### Built-in CRM (new)
- `customers` + `customer_timeline`: every lead and appointment
  automatically creates/updates a customer — deduped by normalized email and
  phone, duplicates merged with history consolidation, forward-only pipeline
  stage (lead → engaged → booked → customer), appointment counters, revenue
  attribution, append-only timeline. Zero configuration.

### Google Calendar connect fixes
- `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (and Microsoft, messaging vars)
  documented in `.env.example` — previously undocumented, so deployments
  showed "not configured" with no path forward.
- The Settings card now renders a four-step setup wizard (with the exact
  redirect URI to register, copyable) when credentials are missing, instead
  of a dead-end error. Connect/disconnect/reconnect flows verified.

### Voice reliability fixes
- Root cause of "Voice isn't working right now": instant retries burned the
  whole error budget in <1 s when Chrome's cloud recognition failed fast
  (`network`). Retries are now spaced (default 750 ms) and survive Chrome's
  onerror→onend double-fire.
- Explicit microphone pre-flight (`getUserMedia`) on mic tap: "blocked" vs
  "no device" known before recognition starts; permission prompt at a
  predictable moment.
- Insecure (http) embeds now hide the mic button instead of showing one
  that can never work; `network` failures get their own actionable message;
  every fallback message now says how to retry.
- Chrome paused-synthesis quirk worked around (`speechSynthesis.resume()`).

### Tests
- 46 new tests (229 total, all green): engine execution/conditions/
  interpolation/idempotency/retries/resume/dead-letter/timeout/timers,
  action registry (webhook formats, channel guards, https-only), CRM
  dedupe/merge/pipeline/revenue, voice backoff/pre-flight/network-fallback,
  booking event emission.

### Docs
- New: WORKFLOWS.md, OPERATIONS.md, TROUBLESHOOTING.md, this changelog.
- Updated: README, INSTALLATION, DEPLOYMENT, ARCHITECTURE, SECURITY, API,
  SCHEDULING, AI, ROADMAP, TESTING.

## 2026-07-14 (earlier) — Exact times + Google Calendar OAuth
- `parseWhen` understands exact clock times ("tomorrow at 10 AM", "2:30pm",
  "14:00", "noon") with sensible ambiguous-hour resolution; fully-booked
  exact times get the next three real openings instead of a dead end.
- Google Calendar OAuth connect flow: signed state + CSRF nonce, offline
  refresh tokens, Settings connect/disconnect card.

## 2026-07-13 — Appointment intelligence
- Availability engine, deterministic when-parser, booking service +
  orchestrator (LLM never decides facts), calendar adapters
  (internal/Google/Outlook/CalDAV), reminders cron, exclusion-constraint
  double-booking protection. See SCHEDULING.md.

## Earlier
- Phase 1 multi-tenant SaaS platform: dashboard, knowledge base, embeddable
  chat+voice widget, grounded AI conversation, lead capture, analytics,
  RLS security model.
