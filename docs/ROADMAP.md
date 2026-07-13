# Roadmap, Limitations & Technical Debt

## Shipped since Phase 1

- **AI intelligence overhaul** — layered conversation-craft prompt, 14 industry playbooks,
  lead scorer v2 (classification + recommended next action), contextual RAG query rewriting,
  unanswered-question knowledge-gap tracking. See [AI.md](AI.md).
- **Appointment booking + calendar integration** — availability engine, booking workflow
  (book/reschedule/cancel), state machine, race-safe double-booking prevention, Google/Outlook/
  CalDAV/internal calendar adapters, reminder queue + cron delivery. The AI now completes
  bookings inside the conversation, not just talks about them. See [SCHEDULING.md](SCHEDULING.md).

## Phase 2 (next)

- **Scheduling dashboard UI** — staff management, scheduling-settings form, calendar OAuth
  connect flow, appointments calendar view (the booking *engine* is done; the *management
  surface* isn't — see [SCHEDULING.md](SCHEDULING.md#known-limits--next-steps))
- **Real SMS/WhatsApp delivery** — implement `MessagingProvider` for Twilio (ports/factory
  already in place; only the adapter is missing)
- **Email notifications** — Resend/SES adapter for `NotificationProvider` (port already exists)
- **Analytics dashboard** — charts over `usage_events` (volume, busiest hours, answer rate,
  lead conversion, unanswered-question digest)
- **Knowledge ingestion** — file upload (PDF/DOCX) via `StorageProvider`, URL crawling
- **Team management UI** — invite members, role management (schema already supports it)
- **Multiple receptionists per business** + per-page targeting
- **Streaming responses** — token streaming to the widget for faster perceived latency

## Phase 3+

- Server-side voice (Whisper/Deepgram STT, ElevenLabs TTS) behind the existing `SpeechProvider`
  port — removes browser-support constraints and enables consistent voices
- Telephony (Twilio) voice channel
- Payments & subscriptions (Stripe), usage-based plans
- CRM integrations (HubSpot, Salesforce) fed from leads
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
