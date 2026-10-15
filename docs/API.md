# API Reference

> **Coverage note (2026-10-15, updated by the local release-readiness audit):** this reference now covers every route under `src/app/api` (30 `route.ts` files), including the later voice, campaign, learning, admin, analytics, no-show and calendar-OAuth routes in [Routes added after the original reference](#routes-added-after-the-original-reference) (plan task W0.8). Since Workstream 4, protected routes also write durable `audit_logs` rows ([WORKSTREAM_4_REPORT.md](WORKSTREAM_4_REPORT.md)); where a mandatory pre-execution audit write fails the route refuses the work. Descriptions are `source` evidence, not deployment proof.

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

Since Phase 2 the turn runs on the Agent Runtime ([RUNTIME.md](RUNTIME.md)); the envelope is
unchanged. Each turn records tenant-safe usage/latency metadata on the `message_sent` usage
event (`turnId`, provider, model, model calls, tokens when reported, latency, tool rounds,
escalation flag) and emits the `conversation.escalated` business event when a handoff is
newly triggered.

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

### Workflow run history

Dashboard session required; read-only, so members see it too.

- `GET /api/workflows/runs?workflowId=&status=&limit=` — recent runs for the
  caller's business, newest first (`limit` 1–200, default 50; `status` is one
  of `pending|running|succeeded|failed|skipped|dead_letter`). Each row carries
  status, attempt/maxAttempts, the step the run reached, correlation id, the
  last error, and timestamps.
- `GET /api/workflows/runs/:runId` — the per-step log for one run (step id,
  attempt, status, and the executor's returned detail). A run belonging to
  another business returns an empty log rather than a distinguishable 404.

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

---

## Routes added after the original reference

Added 2026-10-15 for plan task W0.8 from the route handlers (`source`). Same envelope and error codes as above; `503 SERVICE_UNAVAILABLE` also appears where a dependency is not configured or unreachable.

### Widget voice (public, widget-key or visitor-token authenticated)

All three need a widget whose receptionist has voice enabled and an allowed origin, and they answer `OPTIONS` preflights. The browser never names a tenant, agent, number or provider: the server resolves them and calls the voice gateway (`VOICE_GATEWAY_INTERNAL_URL`) with an HMAC-signed body (`VOICE_STREAM_TOKEN_SECRET`, at least 32 characters). Without that configuration they return `503`.

- `POST /api/v1/widget/speech` — `{ "widgetKey", "audio": "<base64>" }`, at most about ten seconds of audio (the body is bounded at 430,000 bytes as read, not by `Content-Length`). Transcribes through the gateway's `/web/stt`. Returns `{ "data": { "text" } }`. Limits: 20/min per IP and 20/min per tenant.
- `POST /api/v1/widget/synthesis` — `{ "visitorToken" }` (body at most 1 KB). Synthesizes **only** the latest persisted assistant reply of that visitor's own conversation, through `/web/tts`; the client cannot supply text. `409` if the conversation ended or no reply is ready. Response is `no-store`. Limits: 20/min per IP and per tenant.
- `POST /api/v1/widget/voice-call` — `{ "widgetKey" }`. Returns the gateway's live-call offer: the Pipecat media socket URL, wire format and a short-lived stream token bound to a fresh call id and the tenant's own voice route. Response is `no-store`. Limits: 10/min per IP and per tenant. The token is accepted only by the gateway, and since W1.2 it cannot take over a call that already has a live socket.

### Dashboard APIs (session required)

Tenant identity comes from the signed-in session (`requireBusiness()`), never from the request.

- `GET /api/campaigns` — the business's campaigns, newest first (at most 100).
- `POST /api/campaigns` — admin or owner only. A command, discriminated by `action`:
  - `create` — `{ name, agentId, agentVersionId, phoneNumberId, policy }`; **201** `{ "data": { "id" } }`. Foreign agent, version or number references are refused by the database (`0025` guards).
  - `enroll` — `{ campaignId, contacts: [{ customerId, consentAt }] }` (1–100 contacts; `consentAt` cannot be in the future). Only while the campaign is `draft` or `paused`; duplicates are ignored.
  - `state` — `{ campaignId, state: "active" | "paused" | "cancelled" | "completed" }`.
  - `dispatch` — `{ campaignId, limit: 1–10 }`. Dials only when `HALO_OUTBOUND_ENABLED` is exactly `"true"`; it is `false` under G2.
- `GET /api/learning` — learning proposals (at most 100). `?view=outcomes` returns a disposition summary over the latest 1,000 call outcomes, with `truncated`.
- `POST /api/learning` — admin or owner only. `{ action: "propose", … }` creates a proposal (**201** `{ "data": { "id" } }`); `{ action: "review", id, approve }` reviews it with the caller's own JWT, so the database re-checks admin membership and a passing evaluation, and returns `{ "data": { "draftVersionId" } }`. A review never publishes a live version.
- `GET /api/admin/system-status` — admin or owner only. Operational counts for the caller's tenant only: reminder and workflow queues (pending, overdue, failed, dead-letter), 24-hour turn-latency p50/p95 from at most 500 samples, calendar connection count, LLM health and configuration readiness. `status` is `ok` or `degraded`. Missing counts or query errors return `503 MONITORING_UNAVAILABLE` instead of zeros. `failureRate` is always `null` (no durable provider-failure metric exists). Note: the LLM health check may contact the configured provider.
- `GET /api/analytics/operations?days=30` — operations metrics for the caller's tenant over the trailing period (`days` 1–365, default 30).

### Calendar OAuth (dashboard session, admin or owner)

- `GET /api/oauth/google-calendar/start` — redirects to Google's consent screen with `access_type=offline` and `prompt=consent`. The `state` is HMAC-signed and bound to the business; a 10-minute HTTP-only nonce cookie binds it to this browser. Members, and deployments without Google client credentials or `CALENDAR_CREDENTIALS_ENCRYPTION_KEY`, are redirected to settings with an error.
- `GET /api/oauth/google-calendar/callback` — verifies the state against the nonce cookie and requires the signed-in tenant to equal the state's tenant; otherwise nothing is exchanged or written. Exchanges the code, requires a refresh token, and stores the business-level Google connection with both tokens encrypted (`v1.` AES-256-GCM envelope). Always redirects to settings with `connected` or an error code. Known limit (recorded in [LOCAL_RELEASE_READINESS_REPORT.md](LOCAL_RELEASE_READINESS_REPORT.md)): the previous connection is deleted before the new one is inserted, without a transaction.

### Cron (internal)

Both need `Authorization: Bearer <CRON_SECRET>`, compared in constant time; without `CRON_SECRET` they return `500` and do nothing. Both require a durable pre-execution audit row.

- `GET /api/cron/no-shows` — marks overdue appointments as no-shows for businesses that opted in, emitting `appointment.no_show` for the recovery journey. Re-runs are harmless (swept appointments are terminal). Scheduled every 15 minutes in `vercel.json`. Returns `{ "data": <sweep counts> }`.
- `GET /api/cron/campaigns` — claims up to 20 due campaigns (`schedule_campaign_batch`) and dispatches one contact each. Returns `{ "data": { "dispatched", "failed" } }`, with `503` when any dispatch failed. **Not scheduled** in `vercel.json` (D4); dispatch stays inert while `HALO_OUTBOUND_ENABLED` is not `"true"`.
