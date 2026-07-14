# API Reference

All application data access for the dashboard happens through Server Components and Server
Actions under RLS — there is no private REST API. The endpoints below are the **public widget
API** consumed by `widget.js`, plus health.

## Conventions

- Envelope: success → `{ "data": ... }`, failure → `{ "error": { "code", "message", "details?" } }`
- Error codes: `VALIDATION_ERROR` 400 · `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 ·
  `CONFLICT` 409 · `RATE_LIMITED` 429 · `PROVIDER_ERROR` 502 · `INTERNAL_ERROR` 500
- CORS: every endpoint answers `OPTIONS` preflights. If the business configured allowed
  domains, other origins receive `FORBIDDEN`.
- Rate limits (per IP unless noted): config 60/min · conversations & leads 10/min ·
  messages 20/min per IP **and** 20/min per visitor token.

---

### `GET /api/v1/widget/config?key=<widgetKey>`

Widget bootstrap. `key` is the public widget key from the embed snippet.

**200**
```json
{
  "data": {
    "receptionistName": "Riley",
    "businessName": "Acme Dental",
    "greeting": "Hi! Welcome — how can I help you today?",
    "language": "en",
    "voiceEnabled": true,
    "branding": {
      "theme": "auto",
      "primaryColor": "#4f46e5",
      "position": "bottom-right",
      "avatarUrl": "",
      "launcherLabel": "Chat with us"
    }
  }
}
```

`404 NOT_FOUND` — unknown key or receptionist deactivated.

---

### `POST /api/v1/widget/conversations`

Starts a conversation and mints the **visitor token** — the browser's only credential, held in
`sessionStorage`, scoped to one conversation.

**Request** `{ "widgetKey": "...", "channel": "chat" | "voice", "pageUrl": "https://..." }`

**201** `{ "data": { "visitorToken": "…48-hex…", "greeting": "Hi! …" } }`

---

### `POST /api/v1/widget/messages`

One conversational turn.

**Request** `{ "visitorToken": "...", "message": "What are your hours?" }` (message ≤ 2000 chars)

**200** `{ "data": { "reply": "We're open Monday to Friday, 9 to 5." } }`

`404` unknown token · `409` conversation ended · `429` rate limited · `502` AI provider down.

---

### `POST /api/v1/widget/leads`

Explicit lead submission (requires email **or** phone). Merges into the conversation's lead.

**Request**
```json
{ "visitorToken": "...", "name": "Jane", "email": "jane@example.com", "phone": "", "intent": "Booking" }
```

**201** `{ "data": { "saved": true } }`

---

### `GET /api/health`

Liveness by default — no outbound calls, always `200` while the process is up:
`{ "data": { "status": "ok", "time": "…" } }`

Add `?deep=1` for a readiness probe that also checks LLM connectivity (`200`
healthy, `503` degraded). The deep probe is rate limited (6/min per IP) to
prevent amplification against the AI provider:
`{ "data": { "status": "ok", "llm": { "provider": "ollama", "healthy": true }, "time": "…" } }`

---

### `GET /api/cron/retention` (internal)

Scheduled data-retention purge. Deletes conversations and usage events older
than each tenant's `data_retention_days`. Requires
`Authorization: Bearer <CRON_SECRET>`; unauthenticated calls get `401`. Wired to
a daily Vercel Cron in `vercel.json`. Returns
`{ "data": { "conversations": <n>, "events": <n> } }`.

---

### `GET /api/cron/reminders` (internal)

Delivers due appointment reminders (booking confirmations are sent inline at
booking time, not via this route). Claims rows with `FOR UPDATE SKIP LOCKED`
so overlapping runs never double-send; failed deliveries retry with backoff
up to 3 attempts. Requires `Authorization: Bearer <CRON_SECRET>`. Wired to a
5-minute Vercel Cron in `vercel.json`. Returns
`{ "data": { "sent": <n>, "skipped": <n>, "failed": <n> } }`. See
[SCHEDULING.md](SCHEDULING.md).

---

### `GET /api/cron/workflows` (internal)

Fires due workflow timers (scheduled follow-ups) and retries failed workflow
runs whose backoff has elapsed. `FOR UPDATE SKIP LOCKED` claiming makes
overlapping runs safe. Requires `Authorization: Bearer <CRON_SECRET>`. Wired
to a 5-minute Vercel Cron in `vercel.json`. Returns
`{ "data": { "timersFired": <n>, "runsRetried": <n> } }`. See
[WORKFLOWS.md](WORKFLOWS.md).

---

### `POST /api/hooks/:businessId`

Inbound workflow trigger for external systems (Zapier, n8n, Make, custom).
Auth: `x-webhook-token` header (or `?token=`) matching the tenant's
`business_settings.workflow_webhook_secret`; an empty secret disables the
route (`401`). JSON body (≤ 32 KB) becomes the `webhook.received` event
payload. Returns **200** `{ "data": { "accepted": true } }`.

---

### `POST /api/workflows/:workflowId/run`

Manual workflow trigger. Dashboard session required, admin role only; the
workflow must belong to the caller's business. Optional JSON body becomes
the payload of a synthetic `manual` event. Returns **200**
`{ "data": { "started": true } }`.

### Workflow CRUD & templates

Dashboard session required; writes are admin-only.

- `GET /api/workflows` — list the business's workflows.
- `POST /api/workflows` — create; body is a workflow definition without
  `id`/`businessId`/`version` (validated by `workflowDefinitionSchema`).
- `GET /api/workflows/:id` / `PATCH` (partial update, bumps `version`) /
  `DELETE`.
- `GET /api/workflows/templates` — built-in journey template gallery.
- `POST /api/workflows/templates` — `{ "templateId": "...", "variables": {…} }`
  installs a template's workflows. **201** with the created definitions.

### `GET /api/analytics/lifecycle?days=30`

Dashboard session required. Customer-lifecycle metrics for the caller's
business over the trailing period (`days` 1–365, default 30): booking
conversion, reminder success, no-show rate, review rate, CLV, repeat
customers, revenue, utilization, peak booking hours, AI success rate.
See [LIFECYCLE.md](LIFECYCLE.md#analytics).

### Appointment self-service (public, token-authenticated)

The `manage_token` in confirmation/reminder links is the entire credential.
Rate-limited per IP; malformed and unknown tokens both return **404**.

- `GET /api/v1/appointments/:token` — appointment facts, business contact,
  directions/prep content, intake form + submission state, feedback state,
  and (while the appointment is live) reschedule slots.
- `POST /api/v1/appointments/:token` — body is one of
  `{ "action": "cancel", "reason?" }`,
  `{ "action": "reschedule", "startsAt", "staffId" }` (slot must come from
  the offered list; conflicts return **409** with fresh guidance),
  `{ "action": "check_in" }`, `{ "action": "running_late" }`.
- `POST /api/v1/appointments/:token/feedback` —
  `{ "rating": 1–5, "nps?": 0–10, "comment?" }`; valid once the visit
  happened. Emits `feedback.received`.
- `POST /api/v1/appointments/:token/intake` — `{ "answers": {fieldId: value} }`
  validated against the business's intake form.

---

## Appointment booking (in-conversation)

There is no separate booking REST API — booking happens *inside* the
`/api/v1/widget/messages` turn. When a business has enabled scheduling, the
`BookingOrchestrator` detects scheduling intent, checks live availability,
and executes book/reschedule/cancel actions before the reply is generated;
the `reply` field in the existing response narrates the result. See
[SCHEDULING.md](SCHEDULING.md) for the full flow and the `appointments`,
`staff_members`, `scheduling_settings`, and `appointment_reminders` tables
that back it (`supabase/migrations/0008_appointments.sql`).
