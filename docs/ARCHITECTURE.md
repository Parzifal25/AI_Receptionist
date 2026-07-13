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
│                          │  cookies │  │  prompt-builder · lead-extractor       │  │
└──────────────────────────┘          │  │  chunker                               │  │
                                      │  └───┬──────────┬──────────┬──────────────┘  │
                                      │      ▼          ▼          ▼                 │
                                      │  ┌────────┐ ┌─────────┐ ┌──────────────┐     │
                                      │  │ LLM    │ │Knowledge│ │Notification  │     │
                                      │  │ port   │ │ port    │ │ port         │     │
                                      │  └───┬────┘ └────┬────┘ └──────┬───────┘     │
                                      └──────┼───────────┼─────────────┼─────────────┘
                                             ▼           ▼             ▼
                                      Ollama/OpenAI/  Supabase      log (Phase 1)
                                      Anthropic/      Postgres      email (Phase 2)
                                      Gemini/Groq/    (FTS or
                                      Mistral         pgvector)
```

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
   - retrieves tenant-scoped knowledge (FAQ + document chunks) for the message,
   - builds the grounded system prompt (`prompt-builder.ts`) — profile, hours, retrieved
     snippets, anti-hallucination rules, lead-capture behavior,
   - calls the configured `LLMProvider`,
   - persists both turns,
   - periodically runs lead extraction: **regex for email/phone (never hallucinates) + a
     JSON-mode LLM pass for name/intent**; regex wins conflicts. New leads trigger the
     `NotificationProvider`.
4. Reply returns to the widget; in voice mode it is spoken via `SpeechProvider` and the
   microphone re-opens for a hands-free loop.

Failure isolation: knowledge-retrieval errors degrade to profile-only answers; lead-capture
errors are logged and never break the conversation; only an LLM failure surfaces an error to the
visitor.

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
