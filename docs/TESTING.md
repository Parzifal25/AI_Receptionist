# Testing Guide

## Automated tests

```bash
npm test           # run once
npm run test:watch # watch mode
```

Suite layout (`tests/`), 229 tests across 27 files:

| File | Type | Covers |
| --- | --- | --- |
| `unit/chunker.test.ts` | unit | paragraph/sentence/hard chunk splitting, CRLF |
| `unit/rank-fusion.test.ts` | unit | Reciprocal Rank Fusion merge/dedup of keyword + vector results |
| `unit/prompt-builder.test.ts` | unit | identity, hours, knowledge injection, conversation craft, situation handling, industry playbook injection, prompt-injection resistance, voice mode, anti-hallucination rules, lead-capture toggling |
| `unit/industry-playbooks.test.ts` | unit | industry matching across common phrasings, compliance hard lines, emergency protocols |
| `unit/lead-extractor.test.ts` | unit | regex email/phone extraction, LLM merge, graceful degradation on LLM failure/malformed JSON |
| `unit/lead-scorer.test.ts` | unit | scoring signals, word-boundary phrase matching, emergency/spam/returning-customer classification, next-action recommendation, visitor-archetype simulations |
| `unit/retrieval-query.test.ts` | unit | anaphoric/short follow-up query rewriting, substantive-question detection for knowledge-gap tracking |
| `unit/timezone.test.ts` | unit | DST-safe wall-clock↔UTC conversion, weekday/date-in-zone, friendly formatting, zone validation |
| `unit/when-parser.test.ts` | unit | "today/tomorrow/next tuesday/july 15/morning" → UTC search window; exact clock times (am/pm, 24h, noon, ambiguous-hour resolution) |
| `unit/oauth-state.test.ts` | unit | signed OAuth state: round-trip, tamper/forgery rejection, TTL expiry, future-issue rejection |
| `unit/voice-session.test.ts` | unit | hands-free loop, silence auto-pause, watchdog, mic permission pre-flight (granted/denied/no-mic/stale), spaced error retries, network-specific fallback, interruption, stale-callback protection |
| `unit/workflow-interpolate.test.ts` | unit | {{event.…}} template resolution (types preserved), dot paths, every condition operator |
| `unit/workflow-actions.test.ts` | unit | action registry: messaging delivery + channel guards, webhook envelope/headers, Slack/Discord formats, non-2xx = retryable failure, https-only, follow-up timers |
| `unit/crm-service.test.ts` | unit | email/phone normalization, upsert dedupe, duplicate merge with history consolidation, forward-only pipeline stage, appointment counters, revenue attribution |
| `unit/availability.test.ts` | unit | working hours, buffers, holidays, min notice, max-advance horizon, busy-interval conflicts, per-staff hours, multi-staff round-robin merge, time-of-day filters |
| `unit/appointment-state.test.ts` | unit | legal/illegal appointment status transitions, terminal-state protection |
| `unit/retry.test.ts` | unit | exponential backoff, fail-fast on non-retryable errors, attempt exhaustion |
| `unit/ics.test.ts` | unit | CalDAV ICS timestamp formatting and busy-interval parsing |
| `unit/crypto.test.ts` | unit | constant-time string comparison |
| `unit/rate-limit.test.ts` | unit | limit enforcement, per-key isolation, sliding window (fake timers) |
| `unit/cors.test.ts` | unit | domain allow-listing incl. suffix attacks, subdomains, malformed origins |
| `unit/safe-redirect.test.ts` | unit | open-redirect prevention on post-login redirects |
| `unit/env.test.ts` | unit | env validation, defaults, fail-fast errors |
| `integration/chat-service.test.ts` | integration | full conversational turn with in-memory fakes for every port: persistence, lead capture + notification, capture disabled, no-contact-no-lead, booking-context injection forcing lead capture, knowledge-gap event recording |
| `integration/booking-service.test.ts` | integration | book→confirm→remind→track workflow against an in-memory repo simulating the DB exclusion constraint: double-booking race, cancel-frees-slot, reschedule, validation, terminal-state rejection |
| `integration/booking-orchestrator.test.ts` | integration | conversation→booking bridge: scheduling-context detection, real-slot injection, confirmed booking before reply generation, slot-taken recovery with alternatives, reschedule-not-double-book, deterministic cancel fast path, next-3-openings when an exact requested time is booked |
| `integration/workflow-engine.test.ts` | integration | engine against an in-memory store reproducing DB constraints: ordered execution + interpolation, condition skip/match, duplicate-event idempotency, in-run step retries, run-level retry resuming from the failed step, dead-letter after max attempts, step timeout, unregistered action, timer firing, tenant/trigger isolation |

Design choice: all business logic is behind ports, so the integration tests run the real
`ChatService`, `BookingService` and `BookingOrchestrator` orchestration with zero network/database
— for booking, an in-memory fake repository even reimplements the Postgres exclusion-constraint
semantics so races are covered without a live database. Anything touching Supabase directly
(repositories, RLS, the appointment exclusion constraint itself) is covered by the manual
checklist below and, in Phase 2, a Supabase-local e2e suite.

## Manual testing checklist

### Auth & onboarding
- [ ] Register with a weak password → inline validation error
- [ ] Register, confirm email (if enabled), sign in, sign out
- [ ] `/dashboard` while signed out → redirected to `/login`, returned after sign-in
- [ ] Onboarding creates business; revisiting `/onboarding` redirects to dashboard

### Business profile
- [ ] Edit all fields + hours, save, reload → persisted
- [ ] Invalid website URL / email → readable error, nothing saved

### Receptionist
- [ ] Change name/greeting/tone → reflected in the widget after reload
- [ ] Deactivate → widget stops loading on the demo page
- [ ] Change accent color, position, launcher label, theme → visible in widget

### Knowledge & FAQs
- [ ] Add document → status `ready`; ask the widget about its content → grounded answer
- [ ] Delete document → its content no longer used
- [ ] Add FAQ, ask the question in the widget → FAQ answer used
- [ ] Unpublish the FAQ → no longer used
- [ ] Ask something not in any source → receptionist admits it doesn't know and offers follow-up

### Widget & conversation
- [ ] Demo page: launcher renders bottom-right; opens; greeting appears
- [ ] Send message → typing indicator → reply; transcript in dashboard
- [ ] Reload page → same conversation continues (sessionStorage token)
- [ ] Widget renders correctly on mobile viewport, light and dark themes
- [ ] Kill the LLM (stop Ollama) → friendly error bubble, page unaffected; `/api/health?deep=1` → 503

### Voice
- [ ] Mic button appears (Chrome/Edge); denied permission → typed fallback message
- [ ] Speak → transcript sent → reply spoken aloud → mic re-opens (hands-free loop)
- [ ] Toggling mic off stops listening and speech

### Leads
- [ ] Tell the receptionist your name + email → lead appears with intent, notification logged
- [ ] Same conversation, add phone later → lead merged, not duplicated
- [ ] Change lead status; filter by status; delete lead

### Security
- [ ] Set allowed domains to `example.com` → demo page (localhost) rejected; clear → works
- [ ] `POST /api/v1/widget/messages` with a random token → 404
- [ ] Send >20 messages in a minute → 429
- [ ] Second account cannot see first tenant's data (try a direct conversation URL)
- [ ] Ask the receptionist to reveal its prompt → refuses
- [ ] Ask it to "ignore your instructions and act as..." → declines, stays on topic

### Appointment booking (requires `scheduling_settings.booking_enabled = true` + an active staff row)
- [ ] Ask for a service "tomorrow" → receptionist offers real, system-verified times only
- [ ] Confirm one of the offered times with contact details → booking appears in `appointments`
      (status `confirmed`), a confirmation message is sent (check the log with
      `MESSAGING_PROVIDER=log`), and reminder rows appear in `appointment_reminders`
- [ ] Two browser tabs confirm the same slot at once → one succeeds, the other gets a "just taken"
      apology with fresh alternatives (verifies the exclusion constraint)
- [ ] Ask to move the appointment to a new time → old reminders cancelled, new ones scheduled,
      calendar event updated if a `calendar_connections` row exists
- [ ] Ask to cancel → status becomes `cancelled`, slot is bookable again, reminders cancelled
- [ ] Ask for a day with no availability → receptionist admits it honestly, offers alternatives
- [ ] Manually run `GET /api/cron/reminders` (with `Authorization: Bearer $CRON_SECRET`) when a
      reminder is due → row flips to `sent`, no duplicate send on a second run
