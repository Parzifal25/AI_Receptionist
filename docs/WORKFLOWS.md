# Workflow Automation Platform

How the receptionist becomes a business automation platform: every business
event (a booking, a lead, a conversation) can trigger tenant-defined
workflows — and always feeds the built-in CRM, with zero configuration.

## The shape of it

```
Booking / lead / conversation code
   │  emitBusinessEvent()            fire-and-forget; never breaks the flow
   ▼
Event bus (src/core/services/workflows/event-bus.ts)
   1. record the event               workflow_events (audit trail / outbox)
   2. built-in CRM sync              customers + customer_timeline, always on
   3. dispatch tenant workflows      WorkflowEngine
   ▼
WorkflowEngine (engine.ts)
   • one run per (workflow, event)   unique constraint = idempotency
   • conditions                      AND-ed checks on the event payload
   • steps, in order                 params interpolated from {{event.…}}
   • per-step timeout + retries      then run-level retries with backoff
   • dead letter                     after max_attempts, parked for humans
   • execution log                   workflow_run_logs, every attempt
```

Design rules, mirroring the rest of the codebase:

- **No business logic touches an API.** Actions go through ports (messaging),
  the CRM service, or a tenant-supplied webhook URL. New integrations are new
  action executors or webhook targets — the engine never changes.
- **Automation never breaks the flow that triggered it.** `emitBusinessEvent`
  is called after the primary write succeeded and swallows every failure
  (logged, retried by the engine — the visitor's booking is already safe).
- **The database is the arbiter.** `unique (workflow_id, event_id)` makes
  duplicate event delivery a no-op; `FOR UPDATE SKIP LOCKED` claiming makes
  overlapping cron runs safe (same pattern as appointment reminders).

## Triggers (business events)

| Event | Fired when |
|---|---|
| `appointment.created` | The booking engine confirms an appointment |
| `appointment.rescheduled` | A live appointment moves |
| `appointment.cancelled` | A live appointment is cancelled |
| `appointment.checked_in` | The visitor checks in (self-service link or staff board) |
| `appointment.completed` | Staff marks the visit completed — starts the after-visit journey |
| `appointment.no_show` | Staff marks a no-show |
| `feedback.received` | The visitor submits the satisfaction survey (payload carries `rating`, `nps`, `comment`) |
| `lead.created` / `lead.updated` | Lead extraction captures/updates a lead |
| `conversation.started` | A visitor opens a conversation (chat or voice) |
| `conversation.archived` | Reserved — fires when archival lands in the dashboard |
| `customer.created` / `customer.updated` | Reserved for CRM-originated recipes |
| `followup.due` | A timer scheduled by `schedule_followup` fires |
| `webhook.received` | `POST /api/hooks/:businessId` (see below) |
| `manual` | `POST /api/workflows/:id/run` (admin, dashboard/API) |

Appointment/lead payloads carry the visitor identity
(`visitorName/visitorPhone/visitorEmail` or `name/phone/email`), the service,
and times — everything templates need. The `correlationId` (conversation or
appointment id) threads one visitor journey across events, runs, and logs.

## Workflow definitions

Stored in the `workflows` table (JSONB `conditions` + `steps`, validated by
`workflowDefinitionSchema` in `src/core/domain/workflow.ts`; a malformed
definition is skipped loudly, never crashes the engine). `version` increments
on change and each run records the version it executed.

```jsonc
{
  "name": "Booking follow-through",
  "trigger": "appointment.created",
  "conditions": [
    { "path": "payload.visitorEmail", "op": "exists" }
  ],
  "steps": [
    { "id": "confirm-email", "action": "send_email",
      "params": { "to": "{{event.payload.visitorEmail}}",
                  "subject": "You're booked!",
                  "body": "Thanks {{event.payload.visitorName}} — see you at {{event.payload.startsAt}}." } },
    { "id": "notify-team", "action": "call_webhook",
      "params": { "url": "https://hooks.slack.com/services/…", "format": "slack",
                  "text": "New booking: {{event.payload.serviceName}} for {{event.payload.visitorName}}" },
      "retry": { "maxAttempts": 3, "backoffMs": 2000 }, "timeoutMs": 10000 },
    { "id": "review-nudge", "action": "schedule_followup",
      "params": { "delayMinutes": 2880, "reason": "review request" } }
  ]
}
```

Conditions: `eq`, `neq`, `contains`, `exists`, `not_exists`, `gt`, `lt`
against a dot-path into the event (AND semantics). Params: any string value
may embed `{{event.…}}` placeholders; a value that is exactly one
placeholder keeps its raw type.

## Actions

| Action | What it does | Key params |
|---|---|---|
| `send_email` / `send_sms` / `send_whatsapp` | Deliver via the messaging port (`MESSAGING_PROVIDER`) | `to`, `body`, `subject` |
| `call_webhook` | HTTPS POST with `x-event-id` / `x-correlation-id` headers | `url`, `format` (`json`\|`slack`\|`discord`), `text` |
| `crm_upsert_customer` | Create/update a CRM customer | `name`, `email`, `phone`, `stage`, `source` |
| `crm_record_timeline` | Append a timeline entry (upserts the customer first) | `title`, `kind`, `email`/`phone` |
| `crm_record_revenue` | Attribute revenue to a customer | `amount`, `email`/`phone` |
| `schedule_followup` | Fire a `followup.due` event later (timer) | `delayMinutes` **or** `delayDays` (cadence journeys; days win, max 1 year), `reason` |
| `track_analytics` | Record a `workflow_custom` usage event | `name` |
| `request_review` | Message a public-review link and record `review_requested` for analytics | `to`, `reviewUrl`, `channel`, `body?` |
| `ops_create` | Create one back-office record through the `OpsProvider` port | `kind`, `data`, `name`/`email`/`phone` |

**Integrations.** Slack and Discord have first-class webhook formats; Zapier,
n8n, Make, HubSpot, Salesforce and anything else with an inbound
webhook URL use `call_webhook` with `format: "json"` (they receive the full
event envelope). Google Calendar sync is not a workflow action — it is
built into the booking engine (see [SCHEDULING.md](SCHEDULING.md)).
Dedicated adapters (e.g. a native HubSpot upsert) slot in as new action
types in `action-registry.ts` without engine changes.

**OpsCorp / back-office systems.** `ops_create` goes through the
`OpsProvider` port (`src/core/ports/ops-provider.ts`, selected by
`OPS_PROVIDER`). `kind` is one of `fsm_ticket`, `technician_job`, `quote`,
`invoice`, `inventory_reservation`, `payment`; `data` carries the
kind-specific fields verbatim. A record that names a customer is also
mirrored onto that customer's timeline, and a `payment` with a positive
`data.amount` is attributed as revenue; that mirroring is best-effort by
design, because throwing after the downstream record exists would make the
engine retry and create a second one (`timelined: false` in the step log
marks the rare miss). The shipped `log` provider records requests
(journeys stay fully exercisable); an OpsCorp REST adapter is a new factory
case (`src/providers/ops/factory.ts`) — workflows, the engine, and every
journey definition stay untouched when the back-end changes.

## Journey templates & the visual builder

`src/core/services/workflows/templates.ts` ships ready-made lifecycle
journeys — **Booking journey** (booked → welcome → 24 h check-in),
**Review & follow-up** (completed → 1 day → review ask → 30 days → rebook
offer), **Related-service upsell** (completed → 7 days → offer + timeline
entry), **Periodic rebooking** (completed → the tenant's own `cadenceDays`
→ "you're due" invite), **No-show recovery**, and **Unhappy customer alert**
(rating < 4 → timeline flag). A template that waits is two workflows: one schedules a
timer (`schedule_followup`), a `followup.due`-triggered companion (matched
by `payload.reason`) continues — waits survive deploys because the timer
lives in Postgres. `{{var.*}}` placeholders (e.g. the review URL) are filled
at install; `{{event.*}}` interpolates per run.

The dashboard's **Automations** page (`/dashboard/automations`) is the
visual builder: a vertical trigger → step → step flow with parameter
editing, template gallery, enable/disable, and delete, backed by the CRUD
API below. Admin-only for writes; members see read-only.

Below the builder, **Run history** answers "did it actually fire?": recent
runs filtered by status (succeeded / failed-retrying / dead letter / skipped
/ running), each expandable into its per-step log with the executor's
returned detail and the failure reason. It loads on demand rather than with
the page — most visits here are about building a journey, not auditing one,
and runs are the largest table on the screen.

| Endpoint | What |
|---|---|
| `GET /api/workflows` | List the business's workflows |
| `POST /api/workflows` | Create (admin) |
| `GET/PATCH/DELETE /api/workflows/:id` | Read / update (version bump) / delete (admin) |
| `GET /api/workflows/templates` | Template gallery |
| `POST /api/workflows/templates` | Install a template's workflows (admin) |
| `GET /api/workflows/runs` | Run history, filterable by `workflowId` / `status` |
| `GET /api/workflows/runs/:runId` | Per-step log for one run |
| `POST /api/workflows/:id/run` | Manual trigger (admin) |

## Retries, timeouts, dead letters

- **Step level**: optional `retry.maxAttempts` (≤5) with `backoffMs` between
  tries, and `timeoutMs` (default 30 s) so a hung integration can't hang a run.
- **Run level**: a run whose step exhausts its budget is marked `failed` with
  `next_attempt_at` = 5 min · 3^(attempt−1) (capped 6 h). The cron worker
  (`/api/cron/workflows`, every 5 min) reclaims due runs and **resumes from
  the failed step** — succeeded steps never re-run.
- **Dead letter**: after `max_attempts` (default 3) the run parks in
  `dead_letter` with its error, visible to the tenant (read RLS) and ready
  for manual re-drive via the manual trigger.

## Built-in CRM (always on)

No configuration needed — the event bus syncs every event that carries an
identity (email or phone):

- `appointment.created` → upsert customer (stage `booked`), increment
  `total_appointments`, timeline entry; `rescheduled`/`cancelled` → timeline.
- `appointment.checked_in`/`appointment.no_show` → timeline entry.
- `appointment.completed` → upsert customer at stage `customer` (a completed
  visit is the funnel's finish line), timeline entry.
- `feedback.received` → timeline entry (kind `review`) with the rating.
- `lead.created`/`lead.updated` → upsert customer (stage `engaged`), timeline.
- **Dedupe/merge**: customers are keyed by normalized email and phone. When
  an email and a phone match two different rows, they merge (keeper: the
  email match) — fields consolidate, counters add up, the loser's timeline
  moves over and it is stamped `merged_into`.
- **Pipeline stage** only moves forward (`lead → engaged → booked →
  customer`); `lost` is resurrected by any new activity.
- **Revenue attribution**: `revenue_total` accumulates via the
  `crm_record_revenue` action (bookings don't carry prices yet — see
  known limits).

## HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/cron/workflows` | `CRON_SECRET` bearer | Fire due timers + retry due runs (Vercel Cron, every 5 min) |
| `POST /api/hooks/:businessId` | `x-webhook-token` header or `?token=` = `business_settings.workflow_webhook_secret` | External systems trigger `webhook.received` workflows. Empty secret = disabled. JSON body ≤ 32 KB becomes the event payload. |
| `POST /api/workflows/:workflowId/run` | Dashboard session (admin) | Manual trigger with an optional JSON payload (event type `manual`) |

## Observability

- Structured JSON logs throughout (`service: "workflow-engine"`,
  `"event-bus"`), each carrying `runId`, `workflowId`, `correlationId`.
- `workflow_events` is the immutable audit trail; `workflow_runs` +
  `workflow_run_logs` are the execution history (per-step, per-attempt).
- Tenants have read access via RLS to events, runs, logs, timers, customers,
  and timelines — a dashboard surface can be built with zero new backend.
- Dead-lettered runs log at `error` level, ready for log-drain alerting.

## Testing

- `workflow-engine.test.ts` — execution order, variable interpolation,
  conditions (match/skip), duplicate-event idempotency, step retries,
  run-level retry + resume-from-failed-step, dead-letter after max attempts,
  step timeout, unregistered action, timer firing, tenant/trigger isolation.
- `workflow-actions.test.ts` — messaging delivery + channel guards, webhook
  envelope/headers/Slack/Discord formats, non-2xx = failure, https-only,
  follow-up timer scheduling (minutes and day cadences, one-year cap), and
  `ops_create` timeline mirroring / payment attribution / survival of a CRM
  outage.
- `workflow-interpolate.test.ts` — path resolution, templates, every
  condition operator.
- `crm-service.test.ts` — normalization, create/update, phone matching,
  duplicate merge, forward-only pipeline, appointment counters, revenue.
- `booking-service.test.ts` asserts bookings emit `appointment.created`.

## Known limits / next steps

1. Conditions are still API-only — the visual builder edits triggers and
   steps, but a workflow's `conditions` array has no editor and is set via
   the CRUD API or a template install.
2. Bookings don't carry prices, so automatic revenue attribution needs the
   `services` catalog (per-service durations + prices) planned in
   SCHEDULING.md; until then revenue arrives via `crm_record_revenue`.
3. `conversation.archived` and CRM-originated triggers are reserved event
   types — emitters land with the dashboard features that produce them.
4. Actions run sequentially; parallel branches and per-branch error policy
   are a deliberate non-goal until a real recipe needs them.
