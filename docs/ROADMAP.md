# Roadmap, Limitations & Technical Debt

## Shipped since Phase 1

- **AI intelligence overhaul** — layered conversation-craft prompt, 14 industry playbooks,
  lead scorer v2 (classification + recommended next action), contextual RAG query rewriting,
  unanswered-question knowledge-gap tracking. See [AI.md](AI.md).
- **Appointment booking + calendar integration** — availability engine, booking workflow
  (book/reschedule/cancel), state machine, race-safe double-booking prevention, Google/Outlook/
  CalDAV/internal calendar adapters, reminder queue + cron delivery, exact clock-time parsing,
  Google Calendar OAuth connect flow (Settings card with an operator setup wizard). The AI now
  completes bookings inside the conversation, not just talks about them. See
  [SCHEDULING.md](SCHEDULING.md).
- **Workflow automation platform + built-in CRM** — business events trigger tenant-defined
  workflows (conditions, templated actions, retries, dead-letter queue, execution history,
  timers, inbound webhook + manual triggers) and an always-on CRM (customer dedupe/merge,
  pipeline stages, timeline, revenue attribution). See [WORKFLOWS.md](WORKFLOWS.md).
- **Customer lifecycle platform** — HTML/ICS/WhatsApp confirmations, self-service
  reschedule/cancel/check-in links, reminder analytics, intake forms, day-of status tracking
  (checked in / running late / in progress), thank-yous, satisfaction surveys, review &
  rebook journey templates, a visual workflow builder, searchable customers + timeline,
  appointments board, lifecycle analytics dashboard, and the OpsCorp-ready `OpsProvider`
  port. See [LIFECYCLE.md](LIFECYCLE.md).
- **Voice reliability** — microphone permission pre-flight, spaced recognition retries,
  network-specific and secure-context-aware fallbacks, Chrome synthesis workarounds.

## Version 2 roadmap

The V1 lifecycle platform shipped 2026-07-14. V2 turns "works end to end,
log-delivered" into "carrier-grade in production":

**Delivery (highest leverage — everything already routes through ports)**
1. **Twilio `MessagingProvider`** — real SMS + WhatsApp (Cloud API); the whole
   confirmation/reminder/journey pipeline lights up with one factory case.
2. **Resend/SES email adapter** — real HTML email + ICS delivery; also covers
   the lead-notification `NotificationProvider`.
3. **OpsCorp `OpsProvider` adapter** — REST client for FSM tickets, jobs,
   quotes, invoices, inventory reservations, payments (`ops_create` is live
   against the log adapter today).

**Lifecycle completeness**
4. **Automatic no-show sweep** — cron flags confirmed appointments past
   end + grace as no-shows (feeds the recovery journey without staff input).
5. **Settings UI for lifecycle content** — location address, prep
   instructions, intake-form editor, review URL, reminder schedules.
6. **Staff & scheduling-settings management UI** + appointments calendar view.
7. **Per-service catalog** — durations, prices (revenue attribution gets
   exact), per-service intake forms and prep content.
8. **Payments** — deposit at booking via a `payment` ops record / Stripe;
   ties revenue attribution to real money movement.

**Automation platform**
9. **Run-history browser** in the automations UI (workflow_runs/logs are
   already tenant-readable).
10. **Condition editor + branching** — visual conditions; parallel branches
    and per-branch error policy in the engine.
11. **Native CRM adapters** (HubSpot, Salesforce) as first-class actions.
12. **Per-tenant message templates + localization** (reminder/confirmation
    copy is centralized in `confirmation-content.ts` ready to template).

**Platform**
13. **Redis rate limiting + timer/queue hardening** for multi-instance deploys.
14. **Streaming responses** to the widget; server-side voice (Phase 3 pull-in).
15. **E2E suite** — `supabase start` + Playwright over booking → manage link →
    check-in → complete → survey → journey firing.
16. **Knowledge ingestion** (PDF/DOCX upload, URL crawl) and team management UI.

## Phase 3+

- Server-side voice (Whisper/Deepgram STT, ElevenLabs TTS) behind the existing `SpeechProvider`
  port — removes browser-support constraints and enables consistent voices
- Telephony (Twilio) voice channel
- Payments & subscriptions (Stripe), usage-based plans
- Native CRM adapters (HubSpot, Salesforce) as first-class workflow actions (both already
  reachable today via `call_webhook`)
- Per-service appointment durations (a `services` catalog, vs. one slot length per business today)
- LLM-judged conversation-quality eval harness (scripted visitor personas replayed per
  `PROMPT_VERSION`)

## Known limitations (Phase 1, by design)

| Limitation | Impact | Path |
| --- | --- | --- |
| In-memory rate limiter | resets on deploy; per-instance when scaled out | Redis adapter behind the existing async interface |
| Browser speech only | voice quality varies; recognition unsupported in Firefox (widget hides the mic there) | server speech providers (Phase 3) |
| Lead notifications are log-only | no email alerts yet | email `NotificationProvider` (Phase 2) |
| No streaming | replies appear all at once | SSE from the messages endpoint |
| One business per user in the UI | schema supports many; no switcher UI | business picker (Phase 2) |
| Embedding upgrade requires Ollama | default is Postgres FTS (works well for FAQs/short docs) | OpenAI embeddings + dimension migration documented in the factory |
| Analytics are counters + placeholder | no charts | Phase 2 dashboard |
| English-optimized retrieval | FTS uses the `english` dictionary | per-language tsvector config |

## Technical debt (tracked, deliberate)

1. **`upsertConversationLead` read-then-write** — not atomic under concurrent requests for the
   same conversation; worst case is a duplicate lead. Fix: unique partial index on
   `conversation_id` + `on conflict` upsert.
2. **Message-count update** in `WidgetRepository.appendMessages` is a second round-trip; a
   Postgres trigger would be cleaner and race-free.
3. **Widget config fetch happens twice** for a message turn (conversation lookup + receptionist
   context). A single RPC would halve widget-API DB round-trips.
4. **No retry/backoff** on LLM calls — a single transient provider error surfaces to the
   visitor. Add bounded retry with jitter in the provider base (the `withRetry` helper added
   for calendar/messaging adapters in `src/lib/retry.ts` is directly reusable here).
5. **`escapeHtml` + innerHTML in the widget** works but a `createElement`-only builder would
   remove the need for escaping entirely.
6. **E2E coverage** — RLS policies and API routes are manually tested; add a `supabase start` +
   Playwright suite in CI.
7. **No scheduling dashboard** — staff, scheduling settings, and calendar OAuth connections are
   configured directly in the database today; the booking engine is complete but has no
   management UI yet.
8. **Reminder/confirmation copy is fixed English** — no per-tenant templates or visitor-language
   matching, unlike the conversational layer which already mirrors the visitor's language.
