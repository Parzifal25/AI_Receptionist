# Changelog

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
