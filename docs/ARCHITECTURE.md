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

Since HALO Phase 2 the turn runs on the **Agent Runtime** (`packages/runtime/`,
documented in [RUNTIME.md](RUNTIME.md)); `ChatService` is the web-chat adapter
over it.

1. Widget POSTs `{visitorToken, message}` to `/api/v1/widget/messages`.
2. Route validates with Zod, rate-limits per token **and** per IP, resolves the conversation by
   its unguessable visitor token, loads the receptionist + business context, and loads the
   **agent version pinned on the conversation row** (never from the request; a version id that
   does not belong to the tenant cannot resolve).
3. `ChatService.respondForAgent` builds a `TrustedRequestContext` (tenant, conversation, agent,
   version, `turnId`) and calls `AgentRuntime.run`, which:
   - loads bounded conversation state and history (user/assistant rows only),
   - resolves knowledge through the `KnowledgeResolver` for a **context-rewritten** query,
     with count and character budgets (retrieval failure degrades to no knowledge),
   - runs system action providers — the `BookingOrchestrator` (if scheduling is enabled)
     detects intent, fetches real availability, executes any book/reschedule/cancel action and
     hands back a ground-truth section **plus a typed outcome** recording what it did,
   - selects the controlled tools to offer (granted ∩ bound ∩ channel ∩ provider capability;
     none by default),
   - builds the bounded `ConversationContext` and composes the system prompt from the persisted
     agent version (identity → facts → state/recap → knowledge → channel → doctrine → Rules →
     custom instructions → verified actions),
   - calls the configured `LLMProvider` in a bounded loop (≤ 2 tool rounds, turn deadline;
     model-proposed intents are schema-validated, authorized, executed once through
     application-bound executors),
   - validates the reply — act-then-narrate: no booking/cancel/reschedule/handoff claim without
     a verified action; channel length/markdown; no leaked instructions — with one corrective
     regeneration then an honest fallback,
   - decides a typed escalation, updates the rolling recap and state, persists both transcript
     rows (and tool rows) and the state,
   - runs post-turn hooks: lead extraction (**regex for email/phone + JSON-mode LLM pass**,
     scored by `lead-scorer.ts`, notifying the owner on new leads) on the same cadence as before,
     and knowledge-gap recording (`unanswered_question`).
4. Route records usage/latency on the `message_sent` usage event, emits
   `conversation.escalated` when a handoff was newly triggered, and returns `{ data: { reply } }`.
   In voice mode the widget speaks the reply and re-opens the microphone.

Failure isolation: knowledge retrieval, state load/save, system actions and hooks degrade to a
normal turn (recorded in `RuntimeOutput.degraded` and runtime events); a provider failure or
turn deadline yields the honest canned reply; only transcript persistence failure surfaces as an
error. See [RUNTIME.md](RUNTIME.md), [AI.md](AI.md) and [SCHEDULING.md](SCHEDULING.md).

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
