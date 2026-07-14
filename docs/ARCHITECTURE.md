# Architecture Guide

## Principles

- **Clean architecture** — domain and application logic (`src/core`) depend on nothing but
  TypeScript. Frameworks, databases and AI vendors live at the edges.
- **Ports & adapters** — every external capability is defined as an interface (a *port*) in
  `src/core/ports` and implemented by *adapters* in `src/providers`. Application code never
  imports a concrete provider; factories select adapters from environment configuration.
- **Feature-based organization** — dashboard code is grouped by feature (`src/features/*`),
  each owning its server actions, forms and components.
- **Multi-tenant by construction** — every tenant-owned row carries `business_id`; Postgres RLS
  enforces isolation for dashboard queries, and the widget API applies explicit tenant scoping
  in a single repository class.

## System diagram

```
┌──────────────────────────┐          ┌──────────────────────────────────────────────┐
│  Customer website        │          │  Next.js app                                 │
│  ┌────────────────────┐  │  HTTPS   │  ┌────────────────────────────────────────┐  │
│  │ widget.js          │──┼─────────▶│  │ /api/v1/widget/*  (public, rate-limited│  │
│  │ (shadow DOM, voice)│  │  CORS    │  │  CORS-checked, service-role + explicit │  │
│  └────────────────────┘  │          │  │  tenant scoping)                       │  │
└──────────────────────────┘          │  └───────────────┬────────────────────────┘  │
                                      │                  ▼                           │
┌──────────────────────────┐          │  ┌────────────────────────────────────────┐  │
│  Business dashboard      │          │  │ core/services                          │  │
│  (browser)               │─────────▶│  │  ChatService · WidgetRepository        │  │
│                          │  cookies │  │  prompt-builder · industry-playbooks   │  │
└──────────────────────────┘          │  │  lead-extractor · lead-scorer          │  │
                                      │  │  retrieval-query · chunker             │  │
                                      │  │  scheduling/ (availability, booking-   │  │
                                      │  │  orchestrator, reminder-service, ...)  │  │
                                      │  └───┬──────┬──────┬──────┬──────┬───────┘  │
                                      │      ▼      ▼      ▼      ▼      ▼          │
                                      │  ┌──────┐┌───────┐┌──────┐┌────────┐┌──────┐│
                                      │  │ LLM  ││Knowl- ││Notif-││Calendar││Messa-││
                                      │  │ port ││edge   ││ication││ port  ││ging  ││
                                      │  │      ││ port  ││ port  ││       ││ port ││
                                      │  └──┬───┘└───┬───┘└──┬───┘└───┬────┘└──┬───┘│
                                      └─────┼────────┼───────┼────────┼────────┼────┘
                                            ▼        ▼       ▼        ▼        ▼
                                      Ollama/OpenAI/ Supabase log     internal/ log (SMS/
                                      Anthropic/     Postgres         Google/   WhatsApp
                                      Gemini/Groq/   (FTS or          Outlook/  pluggable)
                                      Mistral        pgvector)        CalDAV
```

Also wired: `/api/cron/reminders` (Vercel Cron, every 5 min) delivers due
appointment reminders through `ReminderService` + the messaging port; see
[SCHEDULING.md](SCHEDULING.md) for the full appointment-booking data flow.

**Workflow automation layer** (`core/services/workflows/` + `core/services/crm/`): bookings,
leads, and conversation starts emit `BusinessEvent`s through an event bus (fire-and-forget —
automation can never break the emitting flow). Events are recorded as an audit trail, feed an
always-on CRM sync (`customers` + `customer_timeline`, deduped and merged by email/phone), and
trigger tenant-defined workflows executed by `WorkflowEngine`: conditions, templated actions
(messaging port, HTTPS webhooks, CRM, timers), per-step timeouts/retries, run-level backoff
retries via `/api/cron/workflows`, a dead-letter state, and database-enforced idempotency
(unique run per workflow+event). Inbound triggers: `POST /api/hooks/:businessId` (per-tenant
secret) and `POST /api/workflows/:id/run` (admin manual). Full reference:
[WORKFLOWS.md](WORKFLOWS.md).

Dashboard reads/writes go straight from Server Components / Server Actions to Supabase **as the
signed-in user**, so RLS is the enforcement point. The widget path uses the service role but is
confined to `WidgetRepository`, whose every method requires proof of tenant (widget key or
visitor token).

## Layers

| Layer | Location | Depends on |
| --- | --- | --- |
| Domain | `src/core/domain` | nothing |
| Ports | `src/core/ports` | domain |
| Services | `src/core/services` | domain, ports |
| Adapters | `src/providers/*` | ports, vendor SDKs |
| Presentation | `src/app`, `src/features`, `src/components` | services, adapters via factories |
| Widget | `widget/src` | its own API client + the `SpeechProvider` port |

## The provider system

| Port | Phase 1 adapter(s) | Swap path |
| --- | --- | --- |
| `LLMProvider` | Ollama, OpenAI-compatible (OpenAI/Groq/Mistral), Anthropic, Gemini | set `LLM_PROVIDER` env |
| `EmbeddingProvider` | Ollama (`nomic-embed-text`), or disabled | set `EMBEDDING_PROVIDER` env |
| `KnowledgeProvider` | Supabase (FTS, auto-upgrades to pgvector) | implement port, change factory |
| `SpeechProvider` | Browser Web Speech APIs (client-side) | implement port (Whisper/Deepgram/ElevenLabs) |
| `StorageProvider` | Supabase Storage | implement port (S3/GCS/R2) |
| `NotificationProvider` | Structured log | implement port (Resend/SES) |
| `CalendarProvider` | Internal, Google, Outlook, CalDAV | set `staff_members.calendar_provider` / `calendar_connections` row |
| `MessagingProvider` | Structured log | set `MESSAGING_PROVIDER` env, implement port (Twilio SMS/WhatsApp) |

Factories (`src/providers/*/factory.ts`) are the only place adapters are constructed. Services
receive providers through constructor injection with factory defaults, which is what makes the
whole conversational pipeline testable with in-memory fakes
(`tests/integration/chat-service.test.ts`).

### Adding an LLM provider

1. Implement `LLMProvider` in `src/providers/llm/<name>-provider.ts`.
2. Register it in `src/providers/llm/factory.ts` and the `LLM_PROVIDER` enum in `src/lib/env.ts`.
3. Done — no service, route or UI changes.

## Conversational turn (data flow)

1. Widget POSTs `{visitorToken, message}` to `/api/v1/widget/messages`.
2. Route validates with Zod, rate-limits per token **and** per IP, resolves the conversation by
   its unguessable visitor token, then loads the receptionist + business context.
3. `ChatService.respond`:
   - fetches recent history, then retrieves tenant-scoped knowledge (FAQ + document chunks) for
     a **context-rewritten** query (`retrieval-query.ts` expands short/anaphoric follow-ups with
     recent visitor turns before searching),
   - runs the `BookingOrchestrator` (if scheduling is enabled for the tenant): detects
     scheduling intent, fetches real availability, executes any book/reschedule/cancel action
     the visitor just confirmed, and returns a prompt section describing what actually happened,
   - builds the grounded system prompt (`prompt-builder.ts`) — identity, tone, profile, hours,
     retrieved snippets, conversation craft and situation-handling rules, the matched
     **industry playbook** (`industry-playbooks.ts`), anti-hallucination and prompt-injection
     rules, lead-capture behavior, plus the booking-orchestrator section when present,
   - calls the configured `LLMProvider`,
   - persists both turns,
   - runs lead extraction (**regex for email/phone (never hallucinates) + a JSON-mode LLM pass
     for name/intent**; regex wins conflicts) periodically, on trigger phrases, or immediately
     when a booking just completed. Extracted leads are scored by `lead-scorer.ts` (0-100,
     temperature, classification, recommended next action) before being persisted. New leads
     trigger the `NotificationProvider`,
   - records an `unanswered_question` usage event when a substantive question retrieved no
     grounding, so the dashboard can surface knowledge gaps.
4. Reply returns to the widget; in voice mode it is spoken via `SpeechProvider` and the
   microphone re-opens for a hands-free loop.

Failure isolation: knowledge-retrieval, booking-orchestration, and lead-capture errors are all
logged and degrade to a normal turn without the corresponding enhancement; only an LLM failure
surfaces an error to the visitor. This is the same design principle used throughout: the AI layer
composes optional enhancements around a conversation that always works. See
[AI.md](AI.md) for the conversational/lead-qualification intelligence and
[SCHEDULING.md](SCHEDULING.md) for the appointment engine.

## Knowledge retrieval

Default is Postgres full-text search (`search_knowledge` SQL function — zero extra
infrastructure, works on day one), which spans both document chunks and published FAQs.
When `EMBEDDING_PROVIDER=ollama` is set, documents are embedded at index time and retrieval
becomes **hybrid**: full-text search and pgvector cosine similarity (`match_knowledge_chunks`)
run in parallel and merge via Reciprocal Rank Fusion (`fuseByReciprocalRank`). Fusion is
rank-based, so the incomparable `ts_rank` and cosine scales combine fairly; it also keeps FAQ
matches (which are not embedded) that a vector-only path would silently drop. A vector-search
failure degrades to keyword-only rather than failing the turn. Both SQL functions are
`SECURITY DEFINER`, tenant-scoped by parameter, and executable only by the service role.

Visitor messages are normalized before retrieval (`normalizeQuery`: whitespace collapse,
control-character stripping, 400-char cap) so pathological input can't distort ranking or the
embedding request. Each retrieved snippet carries a **source label** — the parent document's
title, or the FAQ's category — which is rendered into the grounded prompt (`[n] (Source)`) so
the receptionist can attribute answers and the dashboard can show which source responded. The
system-prompt template is versioned (`PROMPT_VERSION`); every turn logs its prompt version and
grounding-source count for answer-quality analysis.

## Multi-tenancy & auth

- `businesses` is the tenant root; `business_members` links Supabase Auth users with roles
  (`owner` / `admin` / `member`).
- RLS policies call `is_business_member()` / `is_business_admin()` (SECURITY DEFINER helpers) —
  see [SECURITY.md](SECURITY.md).
- `create_business_with_owner` RPC creates business + owner membership + default settings +
  default receptionist atomically.
- Session refresh and route protection happen in `src/proxy.ts` (Next.js middleware).

## Error handling & logging

- `AppError` (`src/core/errors`) carries a machine-readable code + HTTP status; `withErrorHandling`
  maps it (and `ZodError`) to a uniform JSON envelope. Unknown errors log with full detail and
  return an opaque 500.
- `src/lib/logger.ts` emits one JSON object per line (level, time, msg, context) — ingestible by
  any log aggregator without adapters.
