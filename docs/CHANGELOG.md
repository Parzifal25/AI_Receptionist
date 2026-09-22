# Changelog

## 2026-09-22 — HALO Phase 4.5 Sprint 1: the real voice loop

The first end-to-end path from a real microphone to a real speaker through
HALO. Full detail in [PHASE4_5_SPRINT1_REPORT.md](PHASE4_5_SPRINT1_REPORT.md);
how to run it in [LOCAL_VOICE_LOOP.md](LOCAL_VOICE_LOOP.md).

**Nothing here has been run against a live speech vendor.** No credentials
exist in this repository. Selecting a vendor is a configuration decision, not
a quality claim — Telugu accuracy, voice quality and real latency all remain
unmeasured ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).

### Real speech vendors
- First real STT and TTS adapters (`packages/providers/voice-vendors/`), both
  behind the existing ports, both passing the same contract kit as the fakes.
  Chosen because one vendor accepts μ-law 8 kHz telephony audio *and*
  documents Telugu plus code-mixed input; Deepgram nova-3 transcribes Telugu
  but excludes it from `language=multi`, so Tenglish within one utterance is
  unavailable there.
- Vendor selection is configuration, defaulting to the fakes, and **fails
  closed**: a real vendor without its credential — or TTS without a voice —
  refuses startup rather than answering a call it cannot serve.
- The STT endpoint emits **no transcription confidence**, so the adapter
  reports `null` and declares `reportsConfidence: false`. Consequence: HALO's
  low-confidence read-back of misheard names and numbers does not fire with
  this vendor. Inventing a confidence would switch that behaviour on using
  evidence that does not exist.

### The local loop
- `scripts/local-call.ts` — a laptop pretending to be a phone carrier, over
  the protocol `FakeTelephonyProvider` already defines. Development
  infrastructure: no new server, no second voice path, no `packages/` change.
- It proves vendors, the model, Telugu behaviour and real latency. It proves
  **nothing about telephony** — no PSTN transport, no carrier jitter, no
  Pipecat worker. A good local demo is not a working phone call.

### Latency
- `context_ready` and `llm_first_token` (migration 0023) split `agent_turn`,
  which was one number covering retrieval, context, every model call and
  validation — enough to see a slow call, not enough to diagnose one.
- `llm_first_token` is emitted only when the provider streamed; otherwise
  `agent_turn.firstTokenMs` is explicitly `null`, never zero.
- The phone path now passes an **observation-only** delta consumer.
  `invokeModel` still accumulates the complete result before returning, so
  the reply is validated whole and act-then-narrate is untouched.

### Telugu / Tenglish
- A manual smoke set (`tests/fixtures/voice-smoke-utterances.ts`): eight
  caller behaviours × three language varieties, every non-English line drawn
  from text already in the repository. It invents no Arunodhaya fact — all of
  them are `supplied_pending` — and a test enforces that, including the
  premise.

### Unchanged
Context size (11,612 rendered chars, measured before and after), the golden
corpus (50/50), the runtime, the validator, the tool boundary, tenant
isolation and the Pipecat path. 94 test files / 932 tests → 101 / 999; none
deleted or weakened.

## 2026-09-21 — HALO Phase 4: Pipecat boundary and the Arunodhaya agent

Pipecat becomes the real-time media layer; HALO keeps everything that decides
what the business does. Full detail in [PIPECAT_INTEGRATION.md](PIPECAT_INTEGRATION.md)
and [PHASE4_REPORT.md](PHASE4_REPORT.md).

### Pipecat integration
- `VoiceGateway` gains one injectable `createMediaSession`, defaulting to the
  unchanged Phase 3 in-process engine. Routing, the call row, the state
  machine, transcript and event persistence, outcomes, usage, capacity and
  the transfer boundary are shared by both engines rather than reimplemented.
- `RemoteVoiceSession` runs the conversation policy over reported facts
  instead of audio: turn serialization, delivery truth, the handoff window,
  silence and failure policy, and every spoken line.
- Validated control protocol over `WSS /pipecat/control` (`VOICE_MEDIA_ENGINE=pipecat`),
  authenticated by the Phase 3 stream token unchanged. Identity travels HALO →
  Pipecat only; no inbound frame has a tenant, agent or conversation field.
- Interruption is cut locally by Pipecat and reported afterwards; HALO records
  which sentences the caller actually heard, chunk by chunk.
- Reference worker client in `services/pipecat-worker` — **NOT VERIFIED**.

### Negotiation and objections (`packages/negotiation`, industry-neutral)
- Commercial policy schema, deterministic concession authorization, and
  objection handling as tenant content. Nothing has a default value: a null
  concession value is UNSET, not discretionary, and a malformed policy is
  refused outright.
- `offer_concession` re-checks the policy at execution time and returns no
  permitted claim on refusal.

### Language and qualification
- The act-then-narrate guard is no longer English-only. Claim phrases, the
  safe fallback line and human-request phrases are tenant-authored per
  language; `claimGuardCoverage()` reports what an agent has no guard for.
- Three qualification defects found by the golden corpus and fixed: field
  scrambling during a read-back, free text being read back on every answer,
  and answered-but-unconfirmed fields counting as unresolved.
- Do-not-call lexicon gains transliteration variants.

### Arunodhaya (configuration only, `src/content/tenants/arunodhaya`)
- Agent, Telugu prompt and voice lines, qualification schema, objection
  catalog, commercial policy, escalation rules and a structured knowledge
  base in which **every business fact is `supplied_pending`**. The agent
  cannot state a price, offer a discount or mention financing, and a test
  asserts no rupee or percent figure exists anywhere in its configuration.
- 50 golden conversations (50/50), an evaluation runner, a context-budget
  measurement, and an idempotent demo seed/reset.

### Not done, and not claimed
No call has been placed through any engine. No STT or TTS vendor is chosen or
scored. Telugu speech quality, real latency and the reference worker are all
unverified. Prompt caching is still not implemented.

## 2026-09-15 — HALO Phase 2: Agent Runtime

The conversational turn now runs on a generic, channel-independent Agent
Runtime (`packages/runtime/`, [RUNTIME.md](RUNTIME.md)); `ChatService` is
its web-chat adapter and the public API is unchanged.

### Runtime
- Typed contracts (`RuntimeInput/Output`, `TrustedRequestContext`,
  `ChannelProfile`, `ConversationContext`, `ToolIntent/Result`,
  `EscalationDecision`, `UsageMetadata`, `RuntimeEvent`).
- Channel profiles (`web-chat`, `web-voice`), bounded deterministic context
  builder, pure prompt composer over the persisted agent version
  (`PROMPT_COMPOSER_VERSION = 2026-09-15.1`), knowledge resolver adapter with
  count/character budgets, capability-aware LLM adapter (streaming and native
  tools where supported, honest fallback otherwise, deadline race, explicit
  retry policy, normalized usage), closed tool registry + four-stage intent
  boundary, bounded orchestration loop, response validator enforcing
  act-then-narrate, rolling recap memory, typed escalation, tenant-safe
  runtime events.
- Migration `0019_conversation_state.sql`: typed conversation state per
  conversation (RLS members-read; service-role write).
- LLM port: `capabilities()`, `stream()`, tool descriptors/calls, finish
  reasons, `timeoutMs`; OpenAI-compatible and Anthropic adapters gain
  streaming + native tools; Ollama gains streaming; Gemini declares
  completion-only.
- Scheduling engine exposed as a runtime system action with a typed outcome
  (`BookingTurnOutcome`), so replies can only confirm what the engine did.
- New business event `conversation.escalated` for tenant workflows; usage and
  latency recorded on every `message_sent` usage event.

### Hardening found on the way (Phase 1.5)
- `AppError` factories accept `details` (typecheck was failing in
  `packages/agents`); `check:rls` resets the schema so it is idempotent in CI
  and now also verifies `conversation_state` isolation.

### Tests & gates
- 118 new tests (565 total, all green): runtime units, provider streaming,
  orchestration bounds, ten golden transcripts, route-level security.
- New `npm run check:architecture` gate (runtime boundaries, provider
  direction, closed tool registry, RLS on every table) wired into CI;
  `npm run perf:baseline` and [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md).


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
