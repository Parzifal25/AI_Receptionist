# AI Receptionist — Current State Audit

**Audit date:** 2026-09-02
**Repository:** `/home/parzifal/AI_Receptionist`
**Commit audited:** `1cd187d` + uncommitted working tree (12 modified tracked files, ~25 untracked new files)
**Method:** source reading (not documentation), plus executed `tsc --noEmit`, `eslint`, `vitest run`, `next build`.
**Scope rule:** no application source was modified during this audit.

---

## A. Executive Summary

### What this application actually is today

A **single-tenant-per-business, multi-tenant SaaS Next.js 16 monolith** that lets a business
configure a text-chat AI receptionist, embed it on their website as a `<script>` tag, and have it:
answer from a Postgres-backed knowledge base, capture leads, book real appointments against a
race-safe appointment table (with optional Google/Outlook/CalDAV sync), fire tenant-defined
workflows off business events, maintain a built-in CRM, and run a post-appointment lifecycle
(confirmations, reminders, self-service reschedule links, intake forms, feedback surveys).

It is **a chat product with a browser-speech accessory**, not a voice product. There is no
telephony, no streaming, and no server-side speech.

### What is production-ready

| Area | Why |
| --- | --- |
| **Workflow engine** (`src/core/services/workflows/`) | Idempotent runs via a DB unique constraint, per-step + per-run retries, exponential backoff, dead-letter terminal state, `SKIP LOCKED` claiming, full step-level execution log, timers. Genuinely well-built. |
| **Appointment booking engine** (`src/core/services/scheduling/`) | The double-booking arbiter is a Postgres `EXCLUDE USING gist` constraint (`0008_appointments.sql:79`), not application logic. Calendar/messaging outages degrade instead of losing bookings. |
| **Database schema + RLS** | 26 tables, every tenant table carries `business_id`, membership-based RLS via `SECURITY DEFINER` helpers, function-level `EXECUTE` grants hardened in `0002_function_grants.sql`. |
| **Provider abstraction layer** (`src/core/ports/` + `src/providers/`) | LLM, embedding, knowledge, calendar, messaging, notification, speech, ops, voice — all ports with factories driven by env. |
| **Security primitives** | `src/lib/ssrf.ts` (DNS-resolving allowlist + `redirect: "manual"`), `src/lib/crypto.ts` (hash-then-`timingSafeEqual`), `src/lib/oauth-state.ts`, `src/lib/safe-redirect.ts`, CSP/HSTS headers in `next.config.ts`. |

### What is MVP-ready

- Chat receptionist end-to-end (widget → API → RAG → LLM → lead capture → CRM → workflows).
- Conversational appointment booking with draft state (`booking-draft.ts`, `0012_booking_drafts.sql`).
- Customer lifecycle: confirmations, reminders, manage-token self-service, intake, feedback, no-show sweep.
- Dashboard: 15 pages covering business profile, receptionist config, knowledge, FAQs, leads, conversations, customers, appointments, automations, analytics, settings, install snippet.

### What is incomplete

- **Voice/telephony** — `src/providers/voice/vapi-voice-provider.ts` + `src/app/api/v1/voice/webhook/route.ts` are a recently-added, untested-in-anger stub. `getVoiceProvider()` is **called from nowhere in `src/`** (verified by grep); only the unit test constructs the provider.
- **SMS** — `MessageChannel` includes `"sms"` and workflow action `send_sms` exists, but no SMS adapter exists. `MESSAGING_PROVIDER` enum is `log | whatsapp | resend | resend+whatsapp`. SMS silently falls to `LogMessagingProvider` (log-only) or throws.
- **Embeddings/vector RAG** — off by default (`EMBEDDING_PROVIDER=none`). Only an Ollama adapter exists; the OpenAI branch **deliberately throws** (`src/providers/embedding/factory.ts:26`) because the pgvector column is hard-coded `vector(768)`.
- **Streaming** — none. `stream: false` in the Ollama adapter; no SSE anywhere.
- **Tool/function calling** — the `LLMProvider` port has no tool concept. Booking "tools" are simulated by injecting a prompt section.
- **Analytics** — numeric counters and tables; no charts.
- **Staff/booking-policy admin UI** — staff rows, slot length, buffers, holidays are configured directly in the database.

### What appears fragile

1. **The working tree does not build.** `next build` fails: `Module not found: Can't resolve '@/lib/errors'` from `src/providers/messaging/whatsapp-messaging-provider.ts:3` and `composite-messaging-provider.ts:3`. The correct path is `@/core/errors/app-error`. One typo, two files.
2. That same import breaks **13 of 48 test files at collection time**, including `multi-tenant-isolation.test.ts` and every booking/chat integration test.
3. `src/app/api/v1/voice/webhook/route.ts` treats a Vapi `call.id` as a Supabase conversation UUID (`repository.appendMessages(call.id, …)`) and discards the conversation it just created. It will fail at runtime against a real database.
4. Two queries select a **non-existent column**: `calendar_connections.status` (`src/app/api/admin/system-status/route.ts:30`, `src/app/dashboard/admin/page.tsx:39`). The schema (`0008_appointments.sql:148`) has no `status`. These degrade to `[]` silently — the admin panel always reports 0 calendars.
5. Rate limiting is **in-process memory** (`src/lib/rate-limit.ts`). On Vercel/Fluid Compute with multiple instances the effective limit is `N × configured`.
6. `getNotificationProvider()` picks Resend only when `MESSAGING_PROVIDER === "resend"` exactly — `"resend+whatsapp"` silently falls back to log-only lead notifications.

### Five biggest technical risks

| # | Risk | Evidence |
| --- | --- | --- |
| 1 | **No phone/telephony runtime at all.** The entire voice stack is browser Web Speech, client-side, half-duplex, tap-to-interrupt. Telephony is greenfield. | `src/providers/speech/browser-speech-provider.ts`, `widget/src/voice-session.ts:28` ("Recognition is OFF while the receptionist speaks") |
| 2 | **No streaming and no tool calling in the LLM port.** Both are hard requirements for sub-second voice turn-taking and for an agent runtime. Retrofitting touches every provider adapter and `ChatService`. | `src/core/ports/llm-provider.ts` (no `stream`, no `tools`), `ollama-provider.ts:29` `stream: false` |
| 3 | **Widget/public API path bypasses RLS entirely.** Everything under `/api/v1/*` and every workflow/CRM/lifecycle service runs on the service-role client and enforces tenancy in TypeScript. One missing `.eq("business_id", …)` is a cross-tenant leak with no database backstop. | `src/lib/supabase/admin.ts`, `WidgetRepository`, `SchedulingRepository`, `SupabaseWorkflowStore`, `SupabaseCrmStore` |
| 4 | **Build/test suite is currently red**, and the red hides the multi-tenant isolation test. Regression protection is not actually running. | `next build`, `vitest run` (14 failed files) |
| 5 | **Retrieval is English-only Postgres FTS by default.** `to_tsvector('english', …)` and `websearch_to_tsquery('english', …)` are hard-coded in the schema; vector search is opt-in, Ollama-only, 768-dim. For Telugu this returns near-noise. | `0001_init.sql` (`content_tsv` generated columns), `0005_retrieval_source_attribution.sql` |

### Five strongest reusable components

| # | Component | Why it survives into HALO nearly untouched |
| --- | --- | --- |
| 1 | **Workflow engine** — `src/core/services/workflows/{engine,types,interpolate}.ts` + `0009_workflows.sql` | Zero product coupling. Depends only on `WorkflowStore` + `ActionRegistry` interfaces. Correct idempotency, retry, backoff, DLQ, resume-from-step semantics. |
| 2 | **Appointment/scheduling engine** — `booking-service.ts`, `availability.ts`, `appointment-state.ts`, `timezone.ts`, `when-parser.ts` + the gist exclusion constraint | Pure functions + one DB invariant. Site-visit scheduling for solar is the same problem. |
| 3 | **Provider/port architecture** — `src/core/ports/*` + `src/providers/*/factory.ts` | Already the shape HALO needs: swap a model/calendar/gateway by env, never by code. |
| 4 | **Multi-tenant schema + RLS foundation** — `0001_init.sql`, `0002_function_grants.sql` | Tenant, membership, roles, per-tenant settings, retention, function-grant hardening. Correct and already hardened against the PostgREST RPC exposure trap. |
| 5 | **Booking orchestrator + draft state** — `booking-orchestrator.ts`, `booking-draft.ts` | The hardest-won logic in the repo: never narrate an action the engine didn't perform, deterministic extraction beats the model, draft survives turns. This is agent-runtime doctrine, not receptionist trivia. |

---

## B. Architecture

### Actual runtime topology

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ CLIENTS                                                                     │
│                                                                             │
│  Visitor's browser on a THIRD-PARTY site        Business owner's browser    │
│  ├─ public/widget.js (12 KB IIFE, shadow DOM)   ├─ Next.js App Router pages │
│  ├─ BrowserSpeechProvider (Web Speech API)      ├─ React 19 Server + Client │
│  └─ VoiceSession state machine (client-side)    └─ Supabase browser client  │
│         │  fetch (CORS, widgetKey + visitorToken)      │  cookie session    │
└─────────┼───────────────────────────────────────────────┼───────────────────┘
          │                                               │
          ▼                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ NEXT.JS 16 APP (one deployable — Vercel)                                    │
│                                                                             │
│  src/proxy.ts (middleware) → session refresh + /dashboard,/onboarding gate  │
│                                                                             │
│  ┌── PUBLIC API (service role, no RLS) ──┐  ┌── DASHBOARD (RLS, as user) ──┐│
│  │ /api/v1/widget/{config,conversations, │  │ Server Components +          ││
│  │            messages,leads}            │  │ Server Actions               ││
│  │ /api/v1/appointments/[manage_token]/* │  │ /api/workflows/*             ││
│  │ /api/v1/voice/{config,webhook}        │  │ /api/analytics/*             ││
│  │ /api/hooks/[businessId]  (HMAC-ish)   │  │ /api/admin/system-status     ││
│  │ /api/cron/* (Bearer CRON_SECRET)      │  │ /api/oauth/google-calendar/* ││
│  └───────────────────────────────────────┘  └──────────────────────────────┘│
│                             │                                               │
│                             ▼                                               │
│  ┌── CORE (src/core) — framework-free business logic ───────────────────┐   │
│  │  services/  chat-service · prompt-builder · retrieval-query ·         │   │
│  │             lead-extractor · lead-scorer · chunker · industry-playbooks│  │
│  │  services/scheduling/  booking-service · booking-orchestrator ·        │   │
│  │             booking-draft · availability · when-parser · timezone      │   │
│  │  services/workflows/   engine · event-bus · action-registry · store    │   │
│  │  services/crm/         crm-service                                    │   │
│  │  services/lifecycle/   lifecycle · confirmation · manage · feedback ·  │   │
│  │                        no-show-sweep                                  │   │
│  │  services/analytics/   lifecycle-analytics · operations-analytics      │   │
│  │  ports/  llm · embedding · knowledge · calendar · messaging ·          │   │
│  │          notification · speech · ops · voice                          │   │
│  └───────────────────────┬───────────────────────────────────────────────┘   │
│                          ▼                                                   │
│  ┌── PROVIDERS (src/providers) — adapters selected by env factories ─────┐   │
│  │ llm/ ollama|anthropic|gemini|openai-compatible(openai,groq,mistral)   │   │
│  │ embedding/ ollama | none            knowledge/ supabase (FTS+vector)  │   │
│  │ calendar/ internal|google|outlook|caldav                              │   │
│  │ messaging/ log|resend|whatsapp|composite    notification/ log|resend   │   │
│  │ ops/ log        speech/ browser (CLIENT-SIDE)    voice/ vapi (unwired) │   │
│  └───────────────────────┬───────────────────────────────────────────────┘   │
└──────────────────────────┼───────────────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXTERNAL                                                                    │
│  Supabase Postgres (26 tables, RLS, pgvector, gist exclusion, SKIP LOCKED)  │
│  Supabase Auth (email/password + OAuth callback)                            │
│  Supabase Storage (bucket `business-assets`, path-prefix RLS)               │
│  LLM API (Ollama localhost by default)  ·  Google/MS OAuth  ·  CalDAV       │
│  Resend  ·  WhatsApp Cloud API  ·  tenant webhooks (Slack/Zapier/n8n/Make)  │
│  Vercel Cron → /api/cron/{retention,reminders,workflows,no-shows}           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend architecture

Two distinct frontends in one repo:

1. **Dashboard** — Next.js App Router, React 19, Tailwind v4. Server Components fetch under RLS via `createSupabaseServerClient()`; mutations are Server Actions in `src/features/*/actions.ts`, each opening with `requireBusiness()`. Client components are leaf-level and interactive-only (`automations-client.tsx` at 741 lines is the largest). No client-side state library, no data-fetching library.
2. **Embeddable widget** — `widget/src/` bundled by esbuild (`scripts/build-widget.mjs`) to `public/widget.js` as an IIFE, ES2019, minified, mounted in a **closed shadow root**. It holds no secrets: only the public `widget_key` and a per-conversation `visitor_token`. It imports two modules from `src/` via an esbuild alias (`@/core/ports/speech-provider`, `@/providers/speech/browser-speech-provider`) — a small but real coupling between the widget bundle and the app source tree.

### Backend architecture

Route handlers are thin. Every one wraps in `withErrorHandling(routeName, …)` (`src/lib/api/respond.ts`) which maps `AppError` → status, `ZodError` → 400 with issue paths, everything else → opaque 500. Response envelope is uniform: `{ data }` or `{ error: { code, message, details? } }`.

Two authorization regimes:
- **Dashboard** — `requireBusiness()` resolves `business_members` under RLS and returns `{ userId, businessId, role }`. Mutating routes additionally check `role !== "member"`.
- **Public** — capability tokens: `widget_key` (tenant), `visitor_token` (conversation), `manage_token` (one appointment), `CRON_SECRET` (jobs), `workflow_webhook_secret` (inbound hooks), `x-vapi-secret` (voice). All secret comparisons go through `timingSafeEqualStr`.

### Database architecture

Supabase Postgres, 12 migrations, 26 tables, `pgcrypto` + `vector` extensions. Business rules are pushed into the database wherever they are invariants rather than policy:
- `appointments_no_overlap` — `EXCLUDE USING gist (staff_id, tstzrange(starts_at, ends_at))` over live statuses. The race arbiter.
- `workflow_runs_idempotent` — `unique (workflow_id, event_id)`. Duplicate event delivery is a no-op by construction.
- `bump_conversation_on_message()` trigger — message counters can't drift.
- `claim_due_workflow_runs` / `claim_due_workflow_timers` / `claim_due_reminders` — `FOR UPDATE SKIP LOCKED`, so overlapping cron ticks are safe.
- `purge_expired_data()` — per-tenant retention in one pass.
- Generated `tsvector` columns for FTS; `vector(768)` column, nullable, for optional embeddings.

### AI architecture

See §4. Summary: a single non-streaming completion per turn, prompt assembled by a pure function, RAG via Postgres RPC, plus **up to two extra LLM calls per turn** (booking action extraction, lead extraction). No tool calling, no memory beyond a 16-message window, no summarization.

### Provider abstraction

Textbook ports-and-adapters. `src/core/ports/*.ts` define interfaces; `src/providers/<kind>/factory.ts` reads `getServerEnv()` and returns a memoized instance; services take providers as **constructor parameters with factory defaults**, which is what makes the test suite able to inject fakes without a DI container. Example: `ChatService(llm, knowledge, notifications, repository, booking, emitEvent)`.

Two leaks in the abstraction, both in the new voice code:
- `src/app/api/v1/voice/webhook/route.ts` hard-codes `model: { provider: "openai", model: "gpt-4" }` in the `assistant-request` response, bypassing the LLM factory entirely.
- `src/providers/voice/vapi-voice-provider.ts:39` does the same in `createAssistant`.

### Integration architecture

Three tiers:
1. **First-class adapters** behind ports — calendars, messaging, LLM, embeddings.
2. **Generic outbound webhook** — the `call_webhook` workflow action with `format: json|slack|discord`. This is how Slack, Zapier, n8n, Make, and any CRM are actually integrated. SSRF-guarded, no redirect following.
3. **Generic inbound webhook** — `POST /api/hooks/[businessId]` authenticated by a per-tenant secret, emitting `webhook.received`.

### Async / background processing

**Cron-driven, no queue infrastructure.** `vercel.json` declares four crons: retention (daily 03:00), reminders (*/5), workflows (*/5), no-shows (*/15). Within a request, "async" means `void promise.catch(…)` fire-and-forget (`emitBusinessEvent` from `ChatService`, `BookingService`, the conversations route). On serverless this is **not guaranteed to complete after the response is returned** — a real durability gap for event emission.

The workflow engine executes runs **inline inside the emitting request** (`WorkflowEngine.dispatch` → `startRun` → `executeRun`), with the cron only handling retries and timers. A workflow with slow steps therefore adds latency to (or gets cut off with) the triggering request.

### Realtime / streaming architecture

**None.** No SSE, no WebSockets, no `ReadableStream`, no Supabase Realtime subscriptions. The widget polls nothing and streams nothing; each turn is one request/response. Verified by grep across `src/` and `widget/`.

### Deployment architecture

Single Vercel project. `npm run build` = `build:widget` (esbuild → `public/widget.js`) then `next build`. Security headers and a CSP are set in `next.config.ts` for every path **except** `/api/v1/widget/*`, which is intentionally cross-origin. `scripts/preflight.ts` (`tsx`) runs `validateProductionReadiness()` as a deploy gate — but it is **not wired into any npm script**.

### Classification: **Modular monolith**

Evidence for, not assertion:
- One `package.json`, one build, one deployable, one database.
- But a real dependency rule is enforced: `src/core/` imports only from `src/core/` and `src/lib/`; it never imports a concrete provider — only ports plus a factory default in a constructor parameter. `import "server-only"` guards server modules at build time.
- Feature slices (`src/features/*`) own their own actions + forms and do not import each other.
- Persistence is behind repositories/stores (`WidgetRepository`, `SchedulingRepository`, `SupabaseWorkflowStore`, `SupabaseCrmStore`) rather than scattered queries.

It is **not** microservices and should not become them: there is no independent scaling axis, no team boundary, and no polyglot need. The one component with a genuinely different runtime profile — a voice/telephony media loop — is a *process* separation concern (long-lived WebSocket connections), not a service-decomposition concern.

---

## 3. Feature-by-Feature Implementation Audit

Status legend: `FULL` · `PARTIAL` · `STUB` · `DOC_ONLY` · `MISSING` · `BROKEN`.
Quality is engineering quality of what exists, not completeness.

| Feature | Status | Evidence | Quality | HALO Reusability |
| --- | --- | --- | --- | --- |
| **Multi-tenancy** | `FULL` | `businesses`/`business_members` + `business_id` on 24 of 26 tables (`0001_init.sql` onward); `is_business_member()`/`is_business_admin()` `SECURITY DEFINER` helpers; `requireBusiness()` (`src/lib/auth.ts:33`) | High on the dashboard path; medium on the service-role path (code-enforced only) | **KEEP** — needs an `agent_id` layer beneath tenant |
| **Authentication** | `FULL` | Supabase Auth; `src/features/auth/actions.ts`; `src/proxy.ts` middleware gate; `/auth/callback`; `safe-redirect.ts` guards the `next` param | High. Email/password + OAuth callback. No MFA, no API keys for machine callers | **KEEP** |
| **RLS** | `PARTIAL` | Policies on all 26 tables; but `calendar_connections` has *no policies at all* by design (`0008:191`), and every public API path uses `getAdminClient()` which **bypasses RLS** | High where applied; the service-role surface is large | **KEEP + extend** — see §7 |
| **Business configuration** | `FULL` | `businesses` (profile, hours JSONB), `business_settings` (domains, retention, notify, webhook secret), `receptionists` (name/greeting/tone/language/custom instructions/branding), `scheduling_settings` (14 columns incl. lifecycle) | High. Config-as-data, exactly the right shape | **KEEP → becomes Agent config** |
| **AI receptionist** | `FULL` | `ChatService.respond()` (`chat-service.ts:60`); orchestrates retrieve → prompt → complete → persist → capture | High. Graceful degradation everywhere; no raw 5xx reaches the widget | **REFACTOR → Agent Runtime** |
| **LLM abstraction** | `PARTIAL` | `src/core/ports/llm-provider.ts` + 4 adapters (ollama, anthropic, gemini, openai-compatible) + factory. **No streaming, no tool calling, no multimodal, no retry** | High for what it covers; the missing 3 are exactly what an agent runtime needs | **REFACTOR** — extend the port |
| **Knowledge base** | `FULL` | `knowledge_documents` + `knowledge_chunks`; `chunker.ts` (paragraph→sentence→hard split, 1200/150); `src/features/knowledge/actions.ts` indexes on save | High. Chunker is well-tested (`tests/unit/chunker.test.ts`) | **KEEP** |
| **RAG** | `PARTIAL` | `SupabaseKnowledgeProvider.search()`: FTS always; vector only if `EMBEDDING_PROVIDER != none`; RRF fusion (`fuseByReciprocalRank`, k=60). Embeddings default **off**; OpenAI branch **throws** by design (768-dim column) | High algorithmically (correct RRF, query normalization, graceful vector failure). Weak operationally — English dictionary hard-coded | **REFACTOR** — needs multilingual + dim-agnostic vectors |
| **FAQ** | `FULL` | `faqs` table with generated `content_tsv`; merged into `search_knowledge` RPC union; `/dashboard/faqs` editor | High | **KEEP** |
| **Chat** | `FULL` | `/api/v1/widget/{conversations,messages}`; `conversations`+`messages` tables; 16-msg history window; 200-message hard cap per conversation | High. Dual rate limiting (token + IP), origin allowlist re-checked per message | **KEEP** |
| **Browser voice** | `PARTIAL` | `widget/src/voice-session.ts` (318 LOC state machine) + `browser-speech-provider.ts` (Web Speech API). Half-duplex, tap-to-interrupt, silence budget, watchdog, generation counters | **High** — the state machine is the best-engineered client code here (440 LOC of tests). But it is fundamentally browser-only | **KEEP the state machine, REPLACE the transport** |
| **Phone/telephony voice** | `STUB` | `vapi-voice-provider.ts` (84 LOC) + `/api/v1/voice/webhook`. `getVoiceProvider()` **has zero callers in `src/`**. Webhook uses `call.id` as a conversation UUID. 3 of its tests fail | Low. Recently added, not integrated, partly incorrect | **REPLACE** |
| **Lead capture** | `FULL` | `lead-extractor.ts` (regex ground truth + LLM JSON pass, regex wins conflicts); `lead-scorer.ts` (323 LOC, 0–100 + hot/warm/cold + signals); `POST /api/v1/widget/leads`; triggered every 3rd message or on `LEAD_TRIGGER_RE` | High. The "regex beats LLM on contact details" decision is correct | **KEEP** — rename to Structured Outcome Extraction |
| **CRM** | `FULL` | `customers` + `customer_timeline`; `CrmService` with email/phone normalization, dedupe, merge (`merged_into`), forward-only stage progression, revenue attribution. Auto-syncs off **every** business event (`event-bus.ts:syncCrm`) | High. Zero-config CRM is a genuine product asset | **KEEP** |
| **Calendar** | `FULL` | `CalendarProvider` port + 4 adapters; `token-source.ts` with single-flight refresh + `onRotate` persistence; Google OAuth connect flow (`/api/oauth/google-calendar/*`) with `oauth-state.ts` CSRF | High. Free/busy via provider APIs, not assumptions | **KEEP** |
| **Appointment booking** | `FULL` | `BookingService` (book/reschedule/cancel/availability); `availability.ts` slot generation; gist exclusion constraint as arbiter; `SlotTakenError` → alternatives; ICS attachments (`src/lib/ics.ts`) | **Highest in the repo.** DB-enforced invariants, graceful external degradation | **KEEP** |
| **Workflows** | `FULL` | `WorkflowEngine` (258 LOC) + `SupabaseWorkflowStore` + `createActionRegistry` (11 actions) + `templates.ts` (365 LOC of prebuilt journeys) + `/dashboard/automations` builder | **Highest in the repo.** See §9 | **KEEP** |
| **Webhooks** | `FULL` | Outbound: `call_webhook` action, SSRF-guarded, `redirect: "manual"`, slack/discord/json formats. Inbound: `/api/hooks/[businessId]` with per-tenant secret, 32 KB cap | High. `src/lib/ssrf.ts` correctly handles IPv4-mapped IPv6, CGNAT, link-local/metadata | **KEEP** |
| **Email** | `PARTIAL` | `ResendMessagingProvider` (retry + SHA-256 idempotency key) and `ResendNotificationProvider`. But `getNotificationProvider()` only matches `"resend"` exactly, so `"resend+whatsapp"` gets log-only lead alerts | Medium. Untracked/new; `resend-messaging.test.ts` is written for **Jest**, not Vitest, and fails to run | **KEEP with fixes** |
| **SMS** | `MISSING` | `MessageChannel` includes `"sms"`; `send_sms` action exists; **no SMS adapter**. `MESSAGING_PROVIDER` enum has no twilio/sms option. Falls to `LogMessagingProvider` | N/A — README claims SMS as a shipped feature; it is log-only | **BUILD NEW** |
| **WhatsApp** | `BROKEN` | `WhatsappMessagingProvider` (Graph API v21, retry) — **does not compile**: `import { AppError } from "@/lib/errors"` (module does not exist) | Would be Medium once the import is fixed; no template-message support (WhatsApp requires approved templates for business-initiated messages) | **KEEP with fixes** |
| **Analytics** | `PARTIAL` | `usage_events` stream; `lifecycle-analytics.ts` (pure metric computation) + `-service.ts`; `operations-analytics-service.ts`; `/dashboard/{analytics,operations,admin}` | Medium. Correct aggregation, but numbers-only, no charts, and `operations` queries a non-existent `calendar_connections.status` | **KEEP the event stream, REBUILD the presentation** |
| **Customer lifecycle** | `FULL` | 7 services under `services/lifecycle/`; `manage_token` capability links; intake forms; feedback/NPS; automatic no-show sweep; confirmation HTML/ICS | High. `appointment-state.ts` is an explicit state machine with `assertTransition` | **KEEP** |
| **Conversation history** | `FULL` | `conversations` + `messages` with DB-maintained counters; `/dashboard/conversations/[id]` transcript view with linked leads | High | **KEEP** — needs call recording/transcript fields for voice |
| **Security** | `PARTIAL` | RLS, function grants, SSRF guard, timing-safe compares, OAuth state, CSP/HSTS, Zod on every input, secrets never client-side. **Gaps:** in-memory rate limiting, unauthenticated `/api/health?deep=1` leaks readiness errors, plaintext OAuth tokens + CalDAV passwords in `calendar_connections`, no audit log | Medium-High | **KEEP + harden** |
| **Testing** | `BROKEN` | 48 test files, 319 tests. **14 files fail** (13 from one bad import, 1 from Jest-in-Vitest), **3 tests fail** (voice webhook). 316 pass. No E2E, no DB tests, no AI evals | Medium. Good unit/integration discipline; currently red | **KEEP the harness, FIX the red** |
| **Deployment** | `BROKEN` | `vercel.json` crons correct; `next.config.ts` headers correct; **`next build` fails** on the working tree | Config quality High; current state unshippable | **KEEP config** |

---

## 4. AI Architecture Deep Dive

### Actual request lifecycle

```text
Visitor types a message in the widget (shadow DOM)
  │
  ▼
POST /api/v1/widget/messages  { visitorToken, message }
  │  ├─ Zod parse (message ≤ 2000 chars)
  │  ├─ rate limit ×2: msg:token:<t> AND msg:ip:<ip>   (20/min each, IN-MEMORY)
  │  ├─ getConversationByToken  → reject if status="ended"
  │  ├─ getReceptionistById     → business + receptionist + allowedDomains
  │  ├─ isOriginAllowed(origin, allowedDomains)        (re-checked every turn)
  │  └─ messageCount ≥ 200 → end conversation, 409
  │
  ▼
ChatService.respond({ business, receptionist, conversationId, userMessage, channel })
  │
  ├─(1) getRecentMessages(conversationId, 16)          ← the ENTIRE memory model
  │
  ├─(2) buildRetrievalQuery(history, userMessage)      ← pure, zero-cost rewrite
  │        if (<6 words OR matches ANAPHORIC_RE)
  │           prepend last 2 visitor messages
  │
  ├─(3) knowledge.search(businessId, retrievalQuery)
  │        normalizeQuery: strip control chars, collapse ws, cap 400 chars
  │        ├─ keywordSearch  → RPC search_knowledge(business_id, q, 6)
  │        │     UNION of knowledge_chunks (ts_rank) + published faqs (ts_rank)
  │        │     SECURITY DEFINER, service_role-only EXECUTE
  │        └─ vectorSearch   → ONLY IF embeddings configured (default: OFF)
  │              embed(query) → RPC match_knowledge_chunks (cosine, 768-dim)
  │              failure ⇒ warn + keyword-only (never fails the turn)
  │        └─ fuseByReciprocalRank([keyword, vector], 6)   RRF k=60
  │        └─ TOTAL failure ⇒ warn + [] (answer from profile alone)
  │
  ├─(4) if (snippets == 0 && isSubstantiveQuestion(msg))
  │        trackEvent("unanswered_question")            ← knowledge-gap telemetry
  │
  ├─(5) booking?.prepareTurn(...)   ══ THE "TOOL LAYER" ══  [LLM CALL #1]
  │        ├─ getSettings → return null if !bookingEnabled
  │        ├─ load booking_drafts row for this conversation
  │        ├─ find live appointment by conversation
  │        ├─ parseWhen(msg) → time window            (pure, no LLM)
  │        ├─ gate: SCHEDULING_INTENT_RE || window || draft has content
  │        ├─ booking.getAvailability(...)            ← REAL slots from DB+calendars
  │        ├─ extractAction(...) JSON-mode LLM call → {action, slotNumber, name,
  │        │                                            phone, email, service, notes}
  │        ├─ mergeDraft(stored, llmFields) then mergeDraft(_, regexFields)
  │        │      ← deterministic extraction applied LAST, so it wins
  │        ├─ resolveSlot(draft, slots) ?? slots[slotNumber-1]   (words > index)
  │        ├─ agreed = action=="book" || COMMITMENT_RE || draft.timeCommitted
  │        ├─ if (slot && complete) → BookingService.book/reschedule  ← REAL WRITE
  │        └─ returns promptSection describing ONLY what actually happened
  │              "## Booking status  You have JUST successfully booked…"
  │              "## Booking status  The booking FAILED: … do NOT pretend"
  │              "## Live scheduling (system-verified, this moment) …"
  │        └─ ANY throw ⇒ warn + null (chat continues booking-free)
  │
  ├─(6) buildSystemPrompt({business, receptionist, knowledge, channel})  ← PURE
  │        identity → tone → profile → hours → knowledge[n] with titles →
  │        how you converse → 7 situation playbooks → industry playbook →
  │        lead capture → Rules (anti-hallucination) → [voice mode] →
  │        custom instructions
  │        then: systemPrompt = basePrompt + "\n\n" + bookingContext.promptSection
  │
  ├─(7) llm.complete(systemPrompt, [...history, userMsg],  ← [LLM CALL #2]
  │                  { temperature: 0.3, maxTokens: 400 })
  │        catch ⇒ providerFailed = true; replyContent = canned fallback
  │
  ├─(8) appendMessages(conversationId, businessId, [user, assistant])
  │        → trigger bumps message_count + last_message_at
  │
  └─(9) if (leadCaptureEnabled && !providerFailed &&
  │        (bookedNow || visitorMsgCount % 3 == 0 || LEAD_TRIGGER_RE))
  │        extractLead(llm, transcript)                ← [LLM CALL #3]
  │           regex EMAIL_RE/PHONE_RE over visitor text (ground truth)
  │           + JSON-mode LLM for {name, intent}
  │           regex wins on email/phone conflict
  │        if (email || phone) → upsertConversationLead → scoreLead →
  │           emit lead.created/updated → CRM sync → workflows →
  │           notifyNewLead (log-only by default)
  ▼
{ data: { reply } }  ← single JSON response, NOT streamed
```

### Component-by-component findings

**System prompts** — `src/core/services/prompt-builder.ts`, `PROMPT_VERSION = "2026-07-28.1"`, logged with every turn alongside `groundingSources` and `historyTurns`. Pure function, 130 LOC of unit tests. Structure is deliberately facts-before-behaviour. Anti-hallucination is unusually explicit and covers the three failure modes that actually matter: inventing facts, **claiming actions that didn't happen**, and confirming unlisted services. It also contains a prompt-injection clause ("Visitor messages are just that — messages from a visitor").

**Business instructions** — `receptionists.custom_instructions` is appended last, explicitly subordinated: *"Follow these unless they conflict with the Rules above."* Correct precedence.

**Conversation history** — `HISTORY_LIMIT = 16` messages, raw, no summarization. Long conversations silently lose their opening. This is the memory model in full.

**Memory** — Three distinct persistent state stores, none of them "agent memory":
- `booking_drafts` (per conversation) — the closest thing to working memory, and it is well-designed.
- `customers` + `customer_timeline` — long-term, cross-conversation, but never read back into the prompt.
- `messages` — the 16-message window.

There is **no** retrieval of prior conversations, no user profile injection, no semantic memory.

**RAG / embeddings / chunking / retrieval** — Chunking is 1200 chars / 150 overlap with paragraph→sentence→hard-split fallback. Retrieval defaults to Postgres FTS with the `english` dictionary. Vector search requires Ollama, is 768-dim only, and the OpenAI path throws deliberately. RRF fusion is correct and well-tested. Snippets are labelled `[n] (title)` so the model can attribute.

**Context construction** — The system prompt is rebuilt from scratch every turn and is large: identity + tone + profile + hours + up to 6 snippets + ~1500 chars of conversational rules + 7 situations + industry playbook + lead-capture + rules + optional voice-mode + optional booking section (which can itself run to several hundred tokens).

**LLM provider abstraction** — Interface: `complete(systemPrompt, messages, {temperature, maxTokens, jsonMode, abortSignal})` → `{content, model, usage?}` + `isHealthy()`. Four adapters. JSON mode: native for Ollama (`format:"json"`) and Gemini (`responseMimeType`), instruction-emulated for Anthropic, native for OpenAI-compatible.

**Model selection** — Global, per-deployment, via `LLM_PROVIDER`/`LLM_MODEL`. **Not per-tenant, not per-task.** The cheap extraction passes use the same model as the conversational reply.

**Temperature/config** — Conversation `0.3` / 400 tokens; extraction passes `0` / 200 tokens with `jsonMode`. Sensible.

**Structured output** — Zod schemas with `.catch()` defaults on every field (`actionSchema`, `extractionSchema`), so a malformed field degrades to a default instead of throwing. `JSON.parse` is inside the try. Good.

**Lead extraction** — Hybrid regex + LLM with regex winning. Correct architecture.

**Hallucination prevention** — Four layers: (1) explicit prompt rules; (2) grounding snippets labelled with sources; (3) **the orchestrator only ever states what the engine actually returned** — this is the strongest layer and is enforced structurally, not by prompting; (4) `unanswered_question` telemetry closes the loop on gaps.

**Unknown-answer handling** — Prompted honest deflection + convert-to-lead. Plus the `isSubstantiveQuestion` gate so greetings don't pollute the gap report.

**Tool/function calling** — **Does not exist as a mechanism.** Booking is orchestrated *around* the LLM: deterministic code decides whether to act, acts, and then tells the model what happened. This is a defensible and in some ways safer design, but it does not generalize — every new capability requires new orchestrator code, not a new tool registration.

**Error handling** — Best-in-repo. LLM failure → canned reply; retrieval failure → profile-only; booking failure → booking-free turn; lead capture failure → warn; event emit failure → warn. The visitor never sees a 5xx from a downstream outage.

### Token / context inefficiencies

| # | Inefficiency | Cost |
| --- | --- | --- |
| 1 | **Up to 3 LLM calls per turn** (booking action extraction, reply, lead extraction). The extraction passes resend a full transcript. | ~2–3× the naive per-turn cost on booking conversations |
| 2 | **Static prompt scaffolding resent every turn** — ~1500+ chars of conversational rules, 7 situations, playbook, and rules block are identical across the whole conversation. No prompt caching is used, and no adapter sets cache breakpoints (Anthropic's `cache_control` is not touched). | Largest single waste; ~40–60% of the system prompt is invariant |
| 3 | **No retry on LLM calls** — a transient 429/503 costs the whole turn and burns the fallback reply. `src/lib/retry.ts` exists and is used by calendar/messaging/Resend/Vapi but **not by any LLM adapter**. | Reliability, not tokens |
| 4 | **No usage aggregation.** `LLMResult.usage` is returned by every adapter and then **discarded** — never persisted, never logged, never billed. | Zero cost visibility per tenant |
| 5 | **No token budget or truncation** on retrieved snippets. Six chunks of up to 1200 chars each = ~7200 chars of context regardless of relevance score. | Bounded but unoptimized |
| 6 | **History is raw, not summarized**, and re-sent in full each turn. | Grows linearly to the 16-message cap |

### Can this AI runtime become HALO's Agent Runtime?

**Score: 6 / 10**

**What earns the 6:**
- The *orchestration doctrine* is right and hard-won: deterministic state (`booking_drafts`) outside the model; act-then-narrate rather than trust-the-model; regex ground truth beating LLM extraction; every branch degrading instead of failing. Most teams learn this after shipping a bad agent. It is already here.
- Clean port boundary (`LLMProvider`) with four working adapters and env-driven selection.
- Prompt construction is a **pure, versioned, unit-tested function** — you can diff, A/B, and attribute behaviour to `PROMPT_VERSION`.
- Structured output with defensive Zod parsing already works in production paths.
- Grounding, source attribution, and knowledge-gap telemetry are already wired.

**What costs the 4:**
- **No streaming.** A voice agent needs first-token latency, not full-response latency. This is a port-level change plus a rewrite of `ChatService.respond`'s return type and every caller.
- **No tool/function calling.** HALO's premise ("Tools" as a first-class layer) has no representation in the current port. Booking is bespoke orchestrator code; a second capability would mean a second orchestrator.
- **Single-agent, single-turn-shaped.** No agent loop (observe → decide → act → observe), no multi-step planning, no per-agent configuration — the "agent" is a `receptionists` row.
- **Memory is a 16-message array.** No summarization, no cross-conversation recall, no profile injection.
- **English-centric retrieval and heuristics.** `ANAPHORIC_RE`, `INTERROGATIVE_RE`, `SCHEDULING_INTENT_RE`, `COMMITMENT_RE`, `LEAD_TRIGGER_RE`, `to_tsvector('english')` — all of it. For a Telugu-first agent, every one of these silently no-ops.
- **No evals.** The test suite pins behaviour of pure functions, not conversation quality.

**Verdict:** this is a very good *receptionist* runtime and a solid *foundation* for an agent runtime. It is roughly 60% of the way there in architecture and 25% of the way there in capability. Keep the doctrine and the prompt-builder discipline; rebuild the execution loop around streaming + tools.

---

## 5. Voice Architecture Deep Dive

### What is actually implemented

There are **two unrelated voice implementations** in this repository, and only one of them works.

#### 5.1 Browser voice (working, shipped)

| Question | Answer | Evidence |
| --- | --- | --- |
| **Speech recognition provider** | Browser Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`). In Chrome this is Google's *cloud* recognition service — audio leaves the device to Google, not to this app. Firefox: unsupported, mic hidden. | `src/providers/speech/browser-speech-provider.ts:24-35` |
| **Speech synthesis provider** | Browser `window.speechSynthesis` + `SpeechSynthesisUtterance`, `rate 1.0`, `lang` from receptionist config. Voice quality is whatever the OS ships. | `browser-speech-provider.ts:119-146` |
| **Browser APIs vs external services** | 100% browser. **No audio ever reaches the server.** The server only sees the final text transcript, arriving as a normal `POST /api/v1/widget/messages`. | `widget/src/voice-session.ts` → `onUserUtterance` → `WidgetApi.sendMessage` |
| **Streaming** | **None.** Recognition is `continuous = false` (one utterance per listen). The LLM reply is a single non-streamed JSON response. TTS begins only after the *complete* reply arrives. | `browser-speech-provider.ts:96`, `ollama-provider.ts:29` |
| **Audio format** | Not applicable — no audio is handled by application code. The browser owns capture, encoding and playback. | — |
| **VAD** | **None of our own.** Endpointing is entirely the browser engine's built-in silence detection (`onend` fires when it decides you stopped). A 20 s watchdog (`DEFAULT_LISTEN_TIMEOUT_MS`) abandons a hung engine. | `voice-session.ts:206-210` |
| **Interruption / barge-in** | **Tap-to-interrupt only, not true barge-in.** Recognition is deliberately OFF while speaking because there is no echo cancellation — full-duplex would hear the receptionist. `interrupt()` cancels TTS and starts listening. | `voice-session.ts:28-32`, `interrupt()` at :150 |
| **Latency handling** | No latency engineering at all. Serial: listen → (network) → LLM (up to 3 calls) → (network) → speak. Realistic turn latency 2–8 s; with CPU Ollama, far worse (`LLM_TIMEOUT_MS` defaults to 60 s). | `chat-service.ts`, `ollama-provider.ts:87` slow-response warning |
| **Silence handling** | Budgeted: each listen with no final transcript increments `silentAttempts`; after 3 the session self-pauses via `onAutoPause()` rather than holding the mic. `no-speech` errors are routed to the same path. | `voice-session.ts:handleSilence` |
| **Error recovery** | Two classes. Fatal (`not-allowed`, `service-not-allowed`, `audio-capture`, unsupported) → immediate `onFallbackToChat(reason)` with a specific message. Transient (`network`, `aborted`, unknown) → retry up to 2× with a 750 ms delay, then fall back. | `voice-session.ts:FATAL_ERRORS`, `handleError` |
| **Conversation synchronization** | **Monotonic generation counters** (`listenGeneration`, `speakGeneration`) invalidate stale async callbacks — a torn-down recognition's late `onEnd` can never drive the current listen. Mic pre-flight via `getUserMedia` is also generation-guarded. | `voice-session.ts:79-90, 122-135, 268` |
| **Voice state management** | Explicit 4-state machine: `idle → listening → processing → speaking → listening`. DOM-free, provider-agnostic, injected `SpeechProvider`. 440 LOC of unit tests. | `voice-session.ts`, `tests/unit/voice-session.test.ts` |

#### Actual browser voice flow

```text
Visitor taps mic in widget (shadow DOM)
  │
  ▼ VoiceSession.start()
  ├─ isRecognitionSupported()?  (also false on insecure origin) ─no─▶ onFallbackToChat("unsupported")
  ├─ requestMicAccess() → getUserMedia({audio}) → release tracks immediately
  │     denied ─▶ onFallbackToChat("mic-blocked")   no device ─▶ ("no-mic")
  ▼
[listening]  recognition.start()  continuous=false, interimResults=true
  ├─ 20 s watchdog armed
  ├─ onResult(interim)  → onTranscript(text, false) → live preview in widget
  ├─ onResult(final)    → clear watchdog → [processing] → onUserUtterance(text)
  ├─ onEnd (no final)   → handleSilence()  (3 strikes → onAutoPause)
  └─ onError            → fatal? fallback : retry ×2 (750 ms apart)
  │
  ▼ widget: POST /api/v1/widget/messages { visitorToken, message }
  │        ══ IDENTICAL PATH TO TEXT CHAT ══
  │        ChatService.respond({ ..., channel: "voice" })
  │           └─ prompt gains a "## Voice mode" section:
  │              "< 2 short sentences · plain words · spell numbers naturally
  │               · read back phone/email · if interrupted, drop your point"
  │        (blocking, non-streamed, 1–3 LLM calls)
  ▼
[speaking]  speech.speak(reply, lang, onEnd)
  ├─ speechSynthesis.cancel() then speak() then resume()  (Chrome pause quirk)
  ├─ onend/onerror both call finish() exactly once
  └─ generation check → [listening] again  (hands-free loop)
       tap during speaking → interrupt() → cancel TTS → listen immediately
```

#### 5.2 Vapi telephony (stub, not integrated, partly broken)

Added in the current uncommitted working tree. What exists:
- `src/core/ports/voice-provider.ts` — a port with `isConfigured()`, `createAssistant()`, `getCallTranscript()`. Note it has **no method to place or receive a call**.
- `src/providers/voice/vapi-voice-provider.ts` (84 LOC) — creates a Vapi assistant with `model: {provider:"openai", model:"gpt-4"}` hard-coded, and fetches a call's messages.
- `src/providers/voice/factory.ts` — `getVoiceProvider()` returns the provider if `VAPI_API_KEY` is set, else `null`.
- `src/app/api/v1/voice/webhook/route.ts` (242 LOC) — handles `assistant-request`, `function-call` (`book_appointment`, `check_availability`), `end-of-call-report`, and an OpenAI-shaped custom-LLM passthrough.
- `src/app/api/v1/voice/config/route.ts` — returns `{voiceEnabled, phoneNumber}`.

**Verified defects:**

1. **`getVoiceProvider()` has zero callers in `src/`** (grep across `src/**`). The factory, port and provider are dead code today; only `tests/unit/vapi-voice-provider.test.ts` instantiates the class.
2. **Conversation identity is wrong.** In `assistant-request` the route calls `repository.createConversation(...)` and **discards the returned row**, then in `end-of-call-report` calls `repository.appendMessages(call.id, business.id, …)` using Vapi's call id as a `conversations.id` UUID. `messages.conversation_id` is a FK to `conversations(id)` — this fails. The custom-LLM branch has the same bug (`conversationId: callId`).
3. **3 of its integration tests fail** (`tests/integration/voice-webhook.test.ts`): `assistant-request`, `end-of-call-report`, `function-call` all return 500 instead of 200.
4. **Signature verification is optional.** If `VAPI_WEBHOOK_SECRET` is unset the `if (vapiSecret)` block is skipped entirely and the webhook accepts unauthenticated POSTs that can create conversations and **book appointments**.
5. **Bypasses the LLM abstraction** — hard-codes OpenAI `gpt-4` in the assistant config.
6. `emitBusinessEvent(...)` is called without `await` or `.catch()` in `end-of-call-report`; it also mislabels a call summary as `type: "feedback.received"` (the code comment admits this: *"or another suitable event type if available"*).
7. No call recording URL, no transcript persistence to a durable table, no structured call outcome, no human handoff/transfer.

### Comparison against the target HALO telephony pipeline

```text
TARGET                              CURRENT REPOSITORY
─────────────────────────────────   ────────────────────────────────────────────
PSTN                                ✗ nothing
  ↓
Telephony Provider                  ~ a Vapi *adapter shell* exists (no dial-out,
(SIP/Twilio/Plivo/Exotel/Vapi)        no dial-in, no number management, unwired)
  ↓
Streaming Audio (bidirectional      ✗ nothing. No WebSocket server, no media
 WebSocket, μ-law/PCM 8–16 kHz)       handling, no audio buffers anywhere
  ↓
VAD (server-side, tunable,          ✗ nothing. Endpointing is the browser's,
 endpointing + turn detection)         opaque and untunable
  ↓
Streaming STT                       ✗ nothing server-side. `SpeechProvider` is a
(Deepgram/Whisper/Sarvam/AI4B)         CLIENT-side port; no server STT adapter
  ↓
HALO Agent Runtime                  ~ ChatService exists but is request/response,
                                       non-streaming, no tools, no interruption
                                       awareness. Reusable as *logic*, not as loop
  ↓
LLM                                 ✓ LLMProvider port + 4 adapters — REUSABLE
                                       (needs a streaming method added)
  ↓
Streaming TTS                       ✗ nothing server-side. Browser speechSynthesis
(ElevenLabs/Azure/Sarvam)              only. No audio chunk emission
  ↓
Telephony Provider                  ✗ nothing
  ↓
PSTN                                ✗ nothing
```

### What can be reused, precisely

| Reusable | Where | Why it survives |
| --- | --- | --- |
| **Voice conversation state machine** | `widget/src/voice-session.ts` | Deliberately DOM-free and provider-agnostic. The `listening→processing→speaking` loop, silence budget, watchdog, generation-counter invalidation, and fatal-vs-transient error taxonomy are all transport-independent. Port it to the server; swap `SpeechProvider` for streaming STT/TTS adapters. **This is the single most reusable piece of the voice stack.** |
| **`SpeechProvider` port shape** | `src/core/ports/speech-provider.ts` | Already anticipates server providers in its own doc comment. Needs new methods for streaming chunks, but the callback shape (`onResult(transcript, isFinal)`) matches how Deepgram/Whisper-streaming actually behave. |
| **Voice-mode prompt section** | `prompt-builder.ts` (`channel === "voice"`) | Short sentences, no symbols, spell numbers, read back contact details, yield on interruption. Correct guidance, already written. |
| **`ChatService` business logic** | `chat-service.ts` | Retrieval, grounding, lead capture, event emission are transport-neutral. Only the *shape* of the call (blocking, returns a full string) must change. |
| **Booking orchestrator + engine** | `scheduling/` | Fully reusable as the tool a phone agent calls. |
| **Conversation/messages schema** | `0001_init.sql` | `conversations.channel` already has a `'voice'` value; `usage_events` has `voice_used`. |
| **`voice_enabled` config + widget UX** | `receptionists.voice_enabled`, widget mic button | Config plumbing already exists. |

### What must be built

1. Telephony integration (inbound + **outbound dialling**, number provisioning, DTMF, transfer/handoff).
2. A long-lived bidirectional media process — Next.js route handlers are the wrong host for a 5-minute WebSocket audio loop. (Vercel Functions do support WebSockets on Fluid Compute, but a dedicated media service is the safer shape.)
3. Server-side streaming STT adapter with partial results + endpointing.
4. Server-side streaming TTS adapter with chunked audio emission and cancellation.
5. Server-side VAD with tunable endpointing and true barge-in (cancel TTS mid-utterance on detected speech).
6. Streaming LLM completion (`LLMProvider.stream()`), sentence-boundary chunking into TTS.
7. Latency budget engineering — target < 800 ms from end-of-speech to first audio byte; today the *first LLM call alone* can exceed that.
8. Call session state, recording storage, transcript persistence, and structured call outcome.
9. Telephony-grade error recovery (dropped call, silence, no-answer, voicemail detection, retry policy).

### How difficult is browser-voice → real phone-call runtime?

## **MAJOR REWRITE**

Not "hard" — *major rewrite*, and the distinction matters for planning.

**Precisely why:**

The current voice system's defining property is that **no audio ever touches this codebase**. The browser captures, encodes, endpoints, transcribes, synthesizes and plays. The application's entire contribution is: receive a final transcript string, return a reply string. Every hard problem in real-time voice — audio transport, buffering, VAD, endpointing, barge-in, jitter, echo, latency, codec negotiation — is currently solved by *somebody else's software running on the visitor's machine*.

A phone runtime must own all of it. That is not an extension of the existing code; it is a new subsystem that happens to reuse the existing *business logic*.

Concretely, of the nine target pipeline stages, **seven do not exist in any form** (PSTN, telephony transport, streaming audio, VAD, streaming STT, streaming TTS, PSTN egress). One exists as a shell (telephony provider). One exists and is reusable with modification (LLM). The agent runtime exists but in the wrong shape (blocking, non-streaming, no tools).

**However — and this is the important qualifier — the rewrite is confined.** It is confined to the *media path*. Everything the agent needs to be useful once it can hear and speak (tenancy, knowledge, retrieval, booking, CRM, workflows, lifecycle, analytics) already exists and is good. A managed telephony platform (Vapi, Retell, Pipecat/Daily, LiveKit Agents, Telnyx) collapses stages 1–5 and 7–9 into a provider integration, at which point the honest estimate drops from "major rewrite" to **"Hard, ~3–5 weeks"** for a demo-quality outbound Telugu agent — because you buy the media loop rather than building it.

Building the media loop in-house (own SIP/WebSocket, own VAD, own barge-in) is a 3–6 month effort with a specialist. **Recommendation: buy stage 1–5 and 7–9; build the agent runtime.**

---

## 6. Database Audit

12 migrations, **26 tables**, extensions `pgcrypto` + `vector`.

### Tables

| # | Table | PK | Tenant key | Key FKs | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `businesses` | `id` uuid | *is* the tenant | — | `slug` unique + regex-checked; `business_hours` jsonb |
| 2 | `business_members` | `(business_id, user_id)` | `business_id` | → `businesses`, → `auth.users` | `role` enum `member_role` |
| 3 | `business_settings` | `business_id` | `business_id` | → `businesses` | `allowed_domains text[]`, `data_retention_days` 30–3650, `workflow_webhook_secret` |
| 4 | `receptionists` | `id` | `business_id` | → `businesses` | `widget_key` unique, `branding` jsonb, tone CHECK |
| 5 | `knowledge_documents` | `id` | `business_id` | → `businesses` | `source_type`/`status` CHECKs |
| 6 | `knowledge_chunks` | `id` | `business_id` | → `documents`, → `businesses` | `embedding vector(768)` nullable; `content_tsv` generated + GIN |
| 7 | `faqs` | `id` | `business_id` | → `businesses` | `content_tsv` generated from question+answer + GIN |
| 8 | `conversations` | `id` | `business_id` | → `businesses`, → `receptionists` | `visitor_token` unique; `channel` chat\|voice; counters maintained by trigger |
| 9 | `messages` | `id` | `business_id` | → `conversations`, → `businesses` | `role` user\|assistant (**no `system`/`tool`**); content ≤ 8000 |
| 10 | `leads` | `id` | `business_id` | → `businesses`, → `conversations` (SET NULL) | `score` 0–100, `temperature`, `qualification` jsonb |
| 11 | `usage_events` | `id` bigint identity | `business_id` | → `businesses` | `event_type` CHECK, extended by 4 migrations; `metadata` jsonb |
| 12 | `staff_members` | `id` | `business_id` | → `businesses` | `working_hours` jsonb, `calendar_provider`, `calendar_ref` |
| 13 | `scheduling_settings` | `business_id` | `business_id` | → `businesses` | 14 cols: timezone, slot/buffer/notice/advance, holidays, reminder leads, location, prep, `intake_form` jsonb, review URL, auto-no-show |
| 14 | `appointments` | `id` | `business_id` | → `businesses`, → `staff_members`, → `conversations`, → `leads` | **`EXCLUDE USING gist`** no-overlap over live statuses; `manage_token` uuid unique |
| 15 | `appointment_reminders` | `id` bigint | `business_id` | → `appointments`, → `businesses` | `status` scheduled\|sent\|failed\|cancelled; partial due index |
| 16 | `calendar_connections` | `id` | `business_id` | → `businesses`, → `staff_members` | **plaintext** `access_token`/`refresh_token`/`basic_password`; RLS on, **no policies** |
| 17 | `workflows` | `id` | `business_id` | → `businesses` | `trigger` text, `conditions` jsonb, `steps` jsonb, `version` int |
| 18 | `workflow_events` | `id` | `business_id` | → `businesses` | append-only outbox; `correlation_id` |
| 19 | `workflow_runs` | `id` | `business_id` | → `workflows`, → `businesses`, → `workflow_events` | **`unique(workflow_id, event_id)`** = idempotency; `current_step`, `attempt`, `next_attempt_at` |
| 20 | `workflow_run_logs` | `id` bigint | via run | → `workflow_runs` | per-step-attempt log with jsonb detail |
| 21 | `workflow_timers` | `id` | `business_id` | → `businesses` | `fire_at`/`fired_at`, partial due index |
| 22 | `customers` | `id` | `business_id` | → `businesses`, → `customers` (`merged_into`) | stage CHECK, `revenue_total numeric(12,2)`, unique-ish partial indexes on lower(email)/phone |
| 23 | `customer_timeline` | `id` bigint | `business_id` | → `businesses`, → `customers` | append-only activity, `detail` jsonb |
| 24 | `appointment_feedback` | `id` | `business_id` | → `appointments`, → `businesses` | rating 1–5, nps 0–10 |
| 25 | `intake_responses` | `id` | `business_id` | → `appointments`, → `businesses` | `answers` jsonb, **unique per appointment** |
| 26 | `booking_drafts` | `conversation_id` | `business_id` | → `conversations`, → `businesses` | conversational working memory; `time_committed` bool |

### Simplified ER diagram

```text
                          auth.users
                              │
                              ▼
                      business_members ──┐
                                         │ role: owner|admin|member
   ┌──────────────────────────────────── businesses ─────────────────────────────┐
   │                                         │                                    │
   │  business_settings (1:1)                │              scheduling_settings(1:1)
   │  ├ allowed_domains[]                    │              ├ timezone/slot/buffer
   │  ├ data_retention_days                  │              ├ intake_form jsonb
   │  └ workflow_webhook_secret              │              └ auto_no_show
   │                                         │
   │  receptionists (1:N)                    │              staff_members (1:N)
   │  ├ widget_key ⚷ (public)                │              ├ working_hours jsonb
   │  ├ greeting/tone/language               │              └ calendar_provider/ref
   │  └ custom_instructions                  │                        │
   │        │                                │                        │
   │        ▼                                │              calendar_connections(1:N)
   │  conversations (1:N)                    │              └ oauth tokens (PLAINTEXT)
   │  ├ visitor_token ⚷ (per session)        │
   │  ├ channel: chat|voice                  │
   │  │      │                               │
   │  │      ├──▶ messages (1:N)  role: user|assistant
   │  │      ├──▶ booking_drafts (1:1)  ← conversational working memory
   │  │      └──▶ leads (0:N)  score/temperature/qualification
   │  │                 │
   │  ▼                 ▼
   │  appointments (1:N) ◀── staff_members
   │  ├ EXCLUDE gist(staff_id, tstzrange) WHERE status live  ← race arbiter
   │  ├ manage_token ⚷ (capability link)
   │  ├──▶ appointment_reminders (1:N)   queue, SKIP LOCKED
   │  ├──▶ appointment_feedback (0:1)
   │  └──▶ intake_responses (0:1, unique)
   │
   │  ── AUTOMATION ─────────────────────────────────────────────────────────────
   │  workflows (1:N) ──┐
   │  workflow_events ──┼──▶ workflow_runs  UNIQUE(workflow_id, event_id)
   │  workflow_timers   │         └──▶ workflow_run_logs (per step attempt)
   │
   │  ── CRM ───────────────────────────────────────────────────────────────────
   │  customers (1:N) ──▶ customer_timeline (1:N)
   │  └ merged_into → customers (self-ref, dedupe)
   │
   │  ── TELEMETRY ─────────────────────────────────────────────────────────────
   └─ usage_events (1:N)  event_type CHECK ∈ {widget_loaded, conversation_started,
       message_sent, lead_captured, voice_used, unanswered_question, +…}
```

### Cross-cutting schema properties

**Primary keys** — `uuid` + `gen_random_uuid()` almost everywhere. Four exceptions use `bigint generated always as identity` for append-only high-volume tables (`usage_events`, `appointment_reminders`, `workflow_run_logs`, `customer_timeline`) — correct choice. Two natural PKs: `business_settings.business_id`, `scheduling_settings.business_id`, `booking_drafts.conversation_id`, and the composite `business_members(business_id, user_id)`.

**Foreign keys** — comprehensive and correctly cascaded. `ON DELETE CASCADE` for owned children, `ON DELETE SET NULL` where the child outlives the parent (`leads.conversation_id`, `appointments.conversation_id`/`lead_id`) — deleting a conversation for retention keeps the lead, which is the right business decision.

**Indexes** — every tenant table has a `business_id`-leading index, usually composite with a sort column (`(business_id, created_at desc)`, `(business_id, score desc, created_at desc)`, `(business_id, starts_at desc)`). Partial indexes for queue patterns (`where status = 'scheduled'`, `where fired_at is null`, `where status = 'failed'`). Two GIN indexes for FTS. Expression indexes for CRM dedupe (`lower(email)`).

**Tenant isolation** — structural: `business_id` on 24 of 26 tables. The two exceptions are `businesses` (which *is* the tenant) and `workflow_run_logs` (which reaches the tenant through its parent run).

**RLS policies** — enabled on all 26 tables. Pattern: `SELECT` for members, `INSERT/UPDATE/DELETE` for members or admins depending on sensitivity. `calendar_connections` deliberately has **RLS enabled with zero policies** (`0008:191` — *"intentionally no policies — service role only"*), which is fail-closed and correct given the plaintext credentials.

**Important enums** — only one real Postgres enum (`member_role`). Everything else is `text` + `CHECK`: appointment status (8 values after `0010`), reminder status, conversation status/channel, lead status/temperature, customer stage, workflow run status, knowledge source/status, receptionist tone. `CHECK` over enum is defensible (cheaper to extend — `0010` extends the appointment status set by drop-and-recreate) but means values are not type-safe at the DB level.

**JSON fields** — 12 jsonb columns, all with `not null default`: `business_hours`, `branding`, `working_hours`, `holidays`, `reminder_lead_minutes`, `intake_form`, `qualification`, `metadata`, `payload` (×2), `conditions`, `steps`, `detail` (×2), `answers`. Workflow `steps`/`conditions` are validated by Zod on read (`workflowDefinitionSchema`) with a malformed definition skipped loudly rather than crashing the engine — good.

**Timestamps** — `created_at timestamptz not null default now()` universally; `updated_at` maintained by a shared `set_updated_at()` trigger on 9 tables. Domain timestamps (`started_at`, `ended_at`, `last_message_at`, `occurred_at`, `fire_at`, `send_at`, `first_seen_at`, `last_seen_at`, `finished_at`) are explicit.

**Soft deletion** — **none anywhere.** All deletes are hard. `customers.merged_into` is the only soft-ish concept (merged records are retained and repointed, not deleted). Retention deletion (`purge_expired_data()`) is hard and cascading.

**Audit information** — **no audit log table.** No `created_by`/`updated_by` on any table. `workflow_run_logs` audits automation execution only; `customer_timeline` audits the customer relationship only; `usage_events` is product telemetry. There is **no record of which user changed which configuration when** — a real gap for a B2B SaaS.

### Can this model support HALO's multi-agent architecture?

**Partially — the tenant/knowledge/workflow/conversation spine transfers; the agent spine does not exist.**

Mapping HALO's concepts onto what is there:

| HALO concept | Current representation | Verdict |
| --- | --- | --- |
| **Tenant** | `businesses` + `business_members` + `business_settings` | ✅ Direct fit |
| **Agent** | `receptionists` — one row, one persona, one channel, no type, no tools, no model config | ⚠️ Conceptually present but structurally too thin. `receptionists` *is* a proto-agent (name, greeting, tone, language, custom instructions, enabled flag) |
| **Agent Version** | **Absent.** `workflows.version` is the only versioning concept in the schema; prompts are versioned only by a TypeScript constant (`PROMPT_VERSION`) | ❌ Missing entirely |
| **Knowledge** | `knowledge_documents` + `knowledge_chunks` + `faqs`, scoped to **business**, not to agent | ⚠️ Right structure, wrong scope for multi-agent |
| **Tools** | **Absent.** No table, no registry, no per-agent tool grants. Booking is hard-coded orchestrator logic | ❌ Missing entirely |
| **Workflows** | `workflows`/`workflow_events`/`workflow_runs`/`workflow_run_logs`/`workflow_timers` | ✅ Excellent fit, tenant-scoped, ready |
| **Conversations** | `conversations` + `messages` | ⚠️ Fits, but `messages.role` CHECK allows only `user`\|`assistant` — **no `system` or `tool` role**, which blocks tool-call transcripts |
| **Calls** | **Absent.** No `calls` table. `conversations.channel='voice'` is the only marker; no duration, direction, recording URL, telephony ids, disposition, cost | ❌ Missing entirely |
| **Actions** | Partially: `workflow_run_logs` records automation steps; `customer_timeline` records outcomes. But no unified per-conversation action ledger | ⚠️ Adjacent structures exist |

### Required schema changes (identified, **not implemented**)

1. **`agents`** — tenant-scoped, typed (`receptionist`\|`sales`\|`support`\|…), with model config, temperature, language(s), channel affinity, persona, status. `receptionists` becomes one row shape within this.
2. **`agent_versions`** — immutable snapshots of prompt + config + tool grants + knowledge bindings, with a pointer to the live version. Conversations record which version served them.
3. **`tools`** + **`agent_tools`** — a tool registry (JSON Schema parameters, handler identifier, auth mode, side-effect class) and per-agent grants. Today booking is the only "tool" and it is compiled in.
4. **`agent_id` on `knowledge_documents`/`knowledge_chunks`** (nullable = tenant-wide), plus a `knowledge_collections` concept so agents can share or isolate corpora.
5. **`calls`** — direction (inbound/outbound), telephony provider + external call id, from/to numbers, started/answered/ended, duration, disposition, recording URL, cost, linked `conversation_id` and `agent_version_id`.
6. **`call_events`** — the media-loop event stream (transcript partials/finals, barge-in, DTMF, transfer, silence), needed for debugging voice latency.
7. **`messages.role`** must accept `system` and `tool`, plus columns for `tool_call_id`, `tool_name`, `tool_args`, `tool_result` (or a sibling `message_parts` table).
8. **`conversation_outcomes`** — the structured result of a conversation (qualified/not, reason, extracted fields, next action, handoff). Today this is smeared across `leads.qualification` and `customer_timeline`.
9. **`embedding` dimension** — `vector(768)` is hard-coded and the OpenAI path deliberately throws. Needs either per-collection dimension columns or a migration strategy (multiple typed columns, or `halfvec`/dimension-per-table).
10. **Multilingual FTS** — `to_tsvector('english', …)` is baked into generated columns on `knowledge_chunks` and `faqs`. Telugu needs either `simple` config + trigram, or vector-primary retrieval.
11. **Encryption for `calendar_connections`** (and any future telephony credentials) — currently plaintext tokens and CalDAV passwords.
12. **`audit_log`** — actor, action, target, before/after, timestamp.
13. **Agent-scoped RLS policies** — every new table needs the `is_business_member()` pattern applied.

---

## 7. Multi-Tenancy Audit

### The two-regime model

This application enforces tenancy in **two structurally different ways**, and the distinction is the single most important thing to understand about its security posture.

```text
REGIME A — DASHBOARD (database-enforced)
  Browser cookie → createSupabaseServerClient() → anon key + user JWT
  → every query runs as `authenticated`
  → RLS policy `is_business_member(business_id)` filters rows IN POSTGRES
  → a missing WHERE clause returns zero rows, not another tenant's rows
  Used by: all Server Components, all Server Actions, /api/workflows/*,
           /api/analytics/*, /api/oauth/*
  Guard:   requireBusiness() → { userId, businessId, role }

REGIME B — PUBLIC / SERVICE (application-enforced)
  widget_key | visitor_token | manage_token | CRON_SECRET | webhook secret
  → getAdminClient() → SERVICE ROLE key → **RLS IS BYPASSED**
  → tenancy exists only as .eq("business_id", …) written by hand in TypeScript
  → a missing WHERE clause returns EVERY tenant's rows
  Used by: /api/v1/**, /api/hooks/*, /api/cron/*, /api/admin/system-status,
           WidgetRepository, SchedulingRepository, SupabaseWorkflowStore,
           SupabaseCrmStore, all lifecycle services, both analytics services,
           the workflow action registry, and event-bus CRM sync
```

Regime B is **most of the interesting code in the repository.**

### Trace by layer

**Authentication** — Supabase Auth issues the JWT; `src/proxy.ts` middleware refreshes the session cookie and redirects unauthenticated users away from `/dashboard` and `/onboarding`. `requireUser()` calls `supabase.auth.getUser()` (server-verified, not a decoded cookie). ✅

**API authorization** — Verified every route (see §B). Dashboard routes: `requireBusiness()` first line, plus `role !== "member"` checks on mutations (`/api/workflows/*`, `/api/oauth/google-calendar/start`, `/api/admin/system-status`). Public routes: capability tokens, all compared with `timingSafeEqualStr`. Cron routes: fail **closed** if `CRON_SECRET` is unset (returns 500, does not run). ✅

**Database queries** — Under Regime A, RLS is the backstop; `src/features/receptionist/actions.ts:55` even comments *"explicit business_id filter is defense in depth"*, which is the right instinct. Under Regime B, the filter **is** the enforcement.

**Supabase RLS** — Policies present and correct on all 26 tables. `is_business_member`/`is_business_admin` are `SECURITY DEFINER` + `stable` + `set search_path = public`, avoiding policy recursion. `0002_function_grants.sql` closes the PostgREST hole properly: `search_knowledge` and `match_knowledge_chunks` are revoked from `anon`/`authenticated` (otherwise anyone with the public anon key could pass an arbitrary `business_id` and read another tenant's knowledge base) and `alter default privileges … revoke execute on functions from public` makes future functions fail closed. This is a genuinely well-reasoned migration. ✅

**Storage** — Bucket `business-assets` is **public-read** with write policies keyed on the first path segment: `is_business_member(((string_to_array(name,'/'))[1])::uuid)`. Writes are correctly tenant-scoped; reads are world-readable by design (logos/avatars). Acceptable for logos; **would be a leak if anything sensitive were ever stored there** — and there is no code-level constraint preventing that.

**Workflows** — `listEnabledWorkflows(businessId, trigger)`, `listRuns(businessId, …)`, `updateWorkflow(id, businessId, …)`, `deleteWorkflow(id, businessId)` all carry `business_id`. `listRunLogs(businessId, runId)` correctly verifies run ownership **before** reading logs. ✅ **But:** `updateRun(id, patch)` and `appendLog(entry)` are keyed **by id only** — safe today because ids come from a tenant-scoped read, but with no database backstop.

**Integrations** — Outbound webhooks fire with the tenant's own URL and are SSRF-guarded. Inbound `/api/hooks/[businessId]` requires a per-tenant secret and rejects when the secret is empty (feature disabled). ✅

**Calendar credentials** — `getCalendarConnection(businessId, …)` filters by `business_id`; token rotation updates by connection `id`. Table has RLS with **no policies**, so only the service role can reach it. Correct isolation — but the credentials are stored **in plaintext**.

**Knowledge** — Retrieval goes through `SECURITY DEFINER` RPCs that take `target_business_id` and filter inside SQL, executable only by `service_role`. Indexing filters `business_id` on delete and stamps it on insert. ✅ Strongest-isolated subsystem.

**Conversations** — `getConversationByToken(visitorToken)` looks up by the unique token (the capability). Messages are then written with the conversation's own `business_id`. `getRecentMessages(conversationId, …)` filters by `conversation_id` only — safe because the conversation was resolved by token.

**Leads** — `upsertConversationLead(businessId, conversationId, …)` scoped. Dashboard reads under RLS. ✅

**Analytics** — Both services filter every query by `business_id`. ✅ (One query in `lifecycle-analytics-service.ts` counts `staff_members` with `.eq("business_id", businessId)` — correct.)

### Queries that depend only on application-level filtering

These are the ones to know about. None is a *demonstrated* leak; each is a *missing backstop*.

| Location | Query | Risk |
| --- | --- | --- |
| `scheduling-repository.ts:213` | `getAppointment(appointmentId)` — `.eq("id", …)` only | Callers resolve ids from tenant-scoped reads or `manage_token`. A future caller accepting a client-supplied id would leak an appointment cross-tenant. |
| `scheduling-repository.ts:243,264,323` | `updateAppointmentStatus` / `updateAppointmentTimes` / `setExternalEventId` — id only | Same shape, but these are **writes**. |
| `scheduling-repository.ts:227` | `findLiveAppointmentByConversation(conversationId)` — conversation id only | Conversation id comes from a token-resolved row. |
| `scheduling-repository.ts:338,389` | `getBookingDraft` / `clearBookingDraft` — `conversation_id` only | Same. |
| `scheduling-repository.ts:120` | `listOverdueLiveAppointments(nowISO, limit)` — **no tenant filter at all, by design** | The no-show sweep is intentionally global. Documented in `ROADMAP.md` as a fairness issue (one tenant's backlog delays others), not a leak — but it means a bug in the sweep affects every tenant at once. |
| `scheduling-repository.ts:437,464,473,481` | Reminder claim/mark/requeue — global claim then id-keyed updates | Same global-worker pattern. |
| `supabase-workflow-store.ts:updateRun/appendLog` | id-only writes | Ids originate tenant-scoped. |
| `supabase-crm-store.ts:77,87,93,110` | `update(id, …)`, `markMerged(loserId, keeperId)`, `appendTimeline(businessId, customerId, …)` | `markMerged` takes two customer ids with **no business check** — a cross-tenant merge would be possible if either id were ever attacker-influenced. |
| `widget-repository.ts:164,201,223,251` | Message/conversation operations keyed by `conversation_id` | Token-resolved. |
| `event-bus.ts:trackCustomerCreated` | inserts `usage_events` with the passed `businessId` | Fine. |

**Assessment:** the discipline is consistently good — I found **no query that accepts a client-supplied identifier and reads across tenants**. Every id-only query is reached through a token- or membership-resolved parent. But the pattern is one careless commit away from a leak in ~15 places, with no database-level net beneath it.

### Concrete tenancy risks found

1. **`GET /api/health?deep=1` is unauthenticated** and returns `readiness.errors` and `readiness.warnings` verbatim — these include messages naming missing environment variables and, critically, `"Database connectivity check failed: <postgres error message>"`. Rate-limited to 6/min/IP, but it is an information disclosure to anonymous callers. (`src/app/api/health/route.ts:46-60`, `src/lib/startup-check.ts:62`)
2. **Vapi webhook accepts unauthenticated requests when `VAPI_WEBHOOK_SECRET` is unset** — the check is inside `if (vapiSecret)`. With a known `widget_key` (which is public by design, embedded in every customer's website HTML), an anonymous caller could reach `book_appointment`/`check_availability` for that tenant. The cron routes get this right (fail closed); the voice webhook does not. (`src/app/api/v1/voice/webhook/route.ts:33-41`)
3. **`widget_key` is a bearer credential with no rotation UI.** It is public by design and rate-limited, and origin-checked *only if* the tenant configured `allowed_domains` — which **defaults to empty = allow any origin** (`0001_init.sql`, `isOriginAllowed` returns `true` for an empty list). A new tenant's widget is embeddable by anyone until they configure domains.
4. **Rate limits are per-process** (`src/lib/rate-limit.ts` in-memory `Map`). On multi-instance deployment the effective per-tenant limit is `instances × limit`, and all limits reset on deploy.
5. **Plaintext OAuth tokens and CalDAV passwords** in `calendar_connections`. Isolation is correct (service-role only); confidentiality at rest depends entirely on Postgres/Supabase disk encryption. A service-role key compromise or a SQL-injection anywhere yields every tenant's Google Calendar refresh token.
6. **No audit log** — a cross-tenant access, if it happened, would leave no trace.
7. **`multi-tenant-isolation.test.ts` does not compile** (it references `ManageService`, `crm`, and `workflow` which the mock harness does not export). The one automated check of this property is currently not running.

---

## 8. Tool / Integration Architecture

### Every external integration in the repository

| Tool/Integration | Location | Interface | Auth | Tenant-aware | Reusable for HALO |
| --- | --- | --- | --- | --- | --- |
| **Google Calendar** | `providers/calendar/google-calendar-provider.ts`, `token-source.ts`, `app/api/oauth/google-calendar/{start,callback}` | `CalendarProvider` port (`listBusy`, `createEvent`, `updateEvent`, `deleteEvent`) | OAuth2 + auto-refresh with single-flight and `onRotate` persistence; CSRF via `oauth-state.ts` | ✅ per-business row in `calendar_connections`, resolved by `businessId` | ✅ **KEEP as-is** |
| **Outlook Calendar** | `providers/calendar/outlook-calendar-provider.ts` | same port | OAuth2 (Microsoft common tenant) | ✅ | ✅ KEEP |
| **CalDAV** | `providers/calendar/caldav-calendar-provider.ts` | same port | HTTP Basic (username/password, **plaintext at rest**) | ✅ | ✅ KEEP |
| **Internal calendar** | `providers/calendar/internal-calendar-provider.ts` | same port, no-op writes | none | ✅ | ✅ KEEP (default) |
| **Resend (email)** | `providers/messaging/resend-messaging-provider.ts`, `providers/notification/resend-notification-provider.ts` | `MessagingProvider` / `NotificationProvider` | API key (global, **not per-tenant**) | ⚠️ global sender identity; `RESEND_FROM_EMAIL` is deployment-wide | ✅ KEEP; needs per-tenant sender |
| **WhatsApp Cloud API** | `providers/messaging/whatsapp-messaging-provider.ts` | `MessagingProvider` | Bearer token + phone-number id (global) | ⚠️ global | ⚠️ **BROKEN** (bad import); no template support |
| **SMS** | — | `MessageChannel` has `"sms"`, action `send_sms` exists | — | — | ❌ **MISSING — must build** |
| **Generic outbound webhook** | `workflows/action-registry.ts:call_webhook` | workflow action, `format: json\|slack\|discord` | tenant-supplied URL; no signing of outbound requests | ✅ URL comes from the tenant's own workflow definition | ✅ **KEEP** — this is the integration escape hatch |
| **Slack** | *via* `call_webhook` with `format: "slack"` → `{text}` | no dedicated adapter | tenant's incoming-webhook URL | ✅ | ✅ KEEP |
| **Discord** | *via* `call_webhook` with `format: "discord"` → `{content}` | no dedicated adapter | tenant's webhook URL | ✅ | ✅ KEEP |
| **Zapier / n8n / Make** | *via* `call_webhook` (`format: "json"`, sends the full event envelope) **and** inbound `POST /api/hooks/[businessId]` | generic | outbound: tenant URL; inbound: per-tenant `workflow_webhook_secret`, timing-safe | ✅ both directions | ✅ KEEP |
| **Built-in CRM** | `services/crm/crm-service.ts` + `supabase-crm-store.ts`; actions `crm_upsert_customer`, `crm_record_timeline`, `crm_record_revenue` | internal service + `CrmStore` port | n/a (internal) | ✅ `business_id` on every call | ✅ **KEEP** |
| **External CRM (HubSpot/Salesforce)** | *none* | — | — | — | via `call_webhook` only; ❌ no adapter |
| **Ops/FSM back-office** | `core/ports/ops-provider.ts` + `providers/ops/log-ops-provider.ts`; action `ops_create` | `OpsProvider` port (6 record kinds) | n/a — only a **log** implementation exists | ✅ `businessId` + `correlationId` passed | ⚠️ **port only** — this is the OpsCorp seam, deliberately abstract |
| **LLM providers** | `providers/llm/{ollama,anthropic,gemini,openai-compatible}` + factory | `LLMProvider` port | API key from env (global) | ❌ **not tenant-aware** — one model for the whole deployment | ✅ KEEP the port; ⚠️ needs per-agent model selection |
| **Ollama embeddings** | `providers/embedding/ollama-embedding-provider.ts` | `EmbeddingProvider` port | none (local) | n/a | ⚠️ 768-dim hard-coded |
| **Vapi (voice)** | `providers/voice/vapi-voice-provider.ts` + `/api/v1/voice/webhook` | `VoiceProvider` port | API key; webhook `x-vapi-secret` **optional** | ⚠️ tenant resolved from `?key=` widget key | ❌ **REPLACE** |
| **Supabase (DB/Auth/Storage)** | `lib/supabase/{admin,server,client}.ts` | SDK | service role / anon+JWT | ✅ RLS or explicit filters | ✅ KEEP |
| **Vercel Cron** | `vercel.json` → 4 endpoints | HTTP GET | `Authorization: Bearer CRON_SECRET`, timing-safe, fail-closed | n/a (global workers) | ⚠️ **REPLACE** for anything long-running |

### Coupling assessment

**Tightly coupled — none in the core.** The only hard-coded third-party references in business logic are in the new voice webhook (`model: {provider:"openai", model:"gpt-4"}` in `route.ts:106` and `vapi-voice-provider.ts:39`). Everything else routes through a port.

**Modular — yes, genuinely.** Nine ports, each with a factory keyed on an env enum. `ChatService`, `BookingService`, `ReminderService`, `WorkflowEngine`, and every lifecycle service accept their providers as constructor parameters with factory defaults. That is what makes the fake-injection test style possible without a DI container.

**Provider-agnostic — mostly.** Two leaks worth naming:
- `EmbeddingProvider` is not truly agnostic: the `vector(768)` column means only 768-dim models work, and the factory throws on OpenAI to say so honestly.
- `MessagingProvider.supports(channel)` is a runtime capability check rather than a type-level one, so `send_sms` compiles fine and fails at execution.

**Reusable — high.** The `ports/` directory is the most directly portable artifact in the repository; it could be lifted into a HALO core package essentially unchanged.

**Safe for LLM invocation — this is the important finding.**

**No tool in this codebase is currently invocable by the LLM.** There is no function-calling mechanism (§4). The model never chooses an action; deterministic code decides, executes, and then *reports* to the model. That is why the anti-hallucination guarantee holds structurally.

If HALO exposes these as real LLM-callable tools, the safety profile changes and each needs classification:

| Tool | Side effect | Safe for direct LLM invocation? |
| --- | --- | --- |
| `check_availability` / `getAvailability` | read-only | ✅ Yes — idempotent, tenant-scoped, cheap |
| `search_knowledge` | read-only | ✅ Yes |
| `book_appointment` | **writes + sends messages + emits events** | ⚠️ Only with confirmation gating. Already protected by the DB exclusion constraint (double-booking is impossible), and `BookingResult` returns a typed failure instead of throwing — good tool ergonomics. Needs an idempotency key per conversation turn. |
| `cancel` / `reschedule` | **destructive** | ⚠️ Requires explicit confirmation; today the orchestrator gates this with `CANCEL_RE` + an existing-appointment check, which is stricter than an LLM decision would be |
| `crm_upsert_customer` / `crm_record_timeline` | write, append-only, forward-only stage | ✅ Low risk by construction |
| `crm_record_revenue` | financial write | ❌ Not without human approval |
| `call_webhook` | **arbitrary outbound HTTP** | ❌ **Never let a model choose the URL.** Safe only with a tenant-preconfigured allowlist. The SSRF guard protects the network but not the *choice of destination* |
| `send_email` / `send_sms` / `send_whatsapp` | **irreversible external messaging** | ❌ Not with model-chosen recipients. Recipient must come from tenant data, not from the transcript |
| `ops_create` | **creates tickets/invoices/payments downstream** | ❌ Human-approval class. The registry already notes that a retry would create a *second* ticket, and deliberately makes the timeline mirror best-effort to avoid it |
| `schedule_followup` | arms a timer (capped at 1 year) | ✅ Low risk, well-bounded |

**Recommendation for HALO:** classify every tool as `read` / `write-reversible` / `write-irreversible` / `external-send` in the tool registry, and let the runtime enforce confirmation policy per class rather than trusting per-prompt instructions.

---

## 9. Workflow Engine Audit

`src/core/services/workflows/` — 5 files, ~1000 LOC, plus `0009_workflows.sql`.

### Event model

`BusinessEvent { id, businessId, type, correlationId, occurredAt, payload }` with **16 closed event types** (`BUSINESS_EVENT_TYPES` in `core/domain/workflow.ts`): 6 appointment lifecycle, `feedback.received`, `lead.created/updated`, `conversation.started/archived`, `customer.created/updated`, `followup.due`, `webhook.received`, `manual`.

`correlationId` threads one visitor journey across events, runs and logs — typically the conversation id or appointment id. Every event is persisted to `workflow_events` **before** dispatch, giving an append-only outbox/audit trail.

Single front door: `emitBusinessEvent()` in `event-bus.ts`. It runs the always-on CRM sync first, then dispatches workflows, and **never throws** — both stages are individually caught.

### Trigger system

`workflows.trigger` is a single event type; `listEnabledWorkflows(businessId, trigger)` selects on the partial index `workflows_trigger_idx (business_id, trigger) where enabled`. Three trigger sources:
1. Product events emitted from `ChatService`, `BookingService`, lifecycle services.
2. Inbound webhook → `webhook.received`.
3. Manual run from the dashboard → `runManually(workflow, event)`.
Plus timers re-entering as `followup.due` via the cron.

### Condition evaluation

`eventMatches(event, conditions)` in `interpolate.ts` — dot-path extraction (`payload.serviceName`) with 7 operators: `eq`, `neq`, `contains`, `exists`, `not_exists`, `gt`, `lt`. Conditions are AND-ed. A run that fails conditions is created and immediately marked `skipped` — so the *decision not to act* is recorded, which is the right call for debuggability.

### Action execution

11 registered actions: `send_email`, `send_sms`, `send_whatsapp`, `call_webhook`, `crm_upsert_customer`, `crm_record_timeline`, `crm_record_revenue`, `schedule_followup`, `request_review`, `ops_create`, `track_analytics`. Params support `{{event.…}}` interpolation resolved per step (`interpolateParams`). An unregistered action fails the step with a clear message rather than crashing the engine.

### Retries

Two independent levels, correctly layered:
- **Step-level (in-run):** `step.retry.maxAttempts` (1–5) with fixed `backoffMs` (0–60 000), executed inline.
- **Run-level (cross-request):** on step failure the run goes `failed` with `next_attempt_at = now + runBackoffMs(attempt)` where backoff is `5 min × 3^(attempt-1)` capped at 6 h. After `maxAttempts` (default 3) the run becomes `dead_letter` with `finishedAt` set.

Per-step timeout: `step.timeoutMs` or 30 s default, enforced by a `withTimeout` wrapper that clears its timer on both paths.

### Queues

**No queue infrastructure.** The pattern is DB-as-queue:
- `workflow_runs` with `status='failed' AND next_attempt_at <= now()` claimed by `claim_due_workflow_runs(batch_size)` using `FOR UPDATE SKIP LOCKED`, flipping rows to `running` inside the same statement.
- `workflow_timers` with `fired_at IS NULL AND fire_at <= now()` claimed the same way.
Both are `SECURITY DEFINER`, revoked from `public/anon/authenticated`.

This is a legitimate and well-executed pattern at this scale. `SKIP LOCKED` makes overlapping cron ticks safe.

### Scheduling

`schedule_followup` arms a `workflow_timers` row (`delayMinutes` or `delayDays`, capped at one year to stop a templated variable parking a timer past any retention window). The cron fires due timers as fresh `followup.due` events through the normal `emitBusinessEvent` path, so timers get the full event/idempotency/CRM treatment.

### Dead-letter handling

`status = 'dead_letter'` is terminal, with `error` and `finishedAt` set and an `error`-level log carrying `runId`, `workflowId`, `correlationId`, `stepId`, `attempt`. Dead-lettered runs are visible in `/dashboard/automations` and counted in the admin panel. **There is no automated replay** — re-running a dead-letter is manual.

### Idempotency

Three mechanisms, in order of strength:
1. **`unique(workflow_id, event_id)`** on `workflow_runs`. `createRun` catches Postgres `23505` and returns `null`; the engine treats `null` as "already handled" and returns. Duplicate event delivery is a no-op **by database constraint**, not by convention. This is the correct design.
2. **`currentStep` resume** — a retried run resumes at the first step that has not succeeded; completed steps never re-execute.
3. **Action-level care** — `ops_create` deliberately makes its CRM-timeline mirror best-effort *because throwing there would cause the engine to retry and create a second invoice*. That comment shows the author reasoned about at-least-once semantics rather than assuming exactly-once.

### Execution history

`workflow_run_logs`: one row per **step per run-attempt**, with `status` (`succeeded`/`failed`/`skipped`), the step's returned detail or error, and `stepAttempt` for in-run retries. `listRunLogs(businessId, runId)` verifies run ownership before returning logs. Surfaced in the dashboard automations UI.

### Failure handling

`dispatch()` wraps everything in try/catch and only logs — automation can never break the booking or chat flow that emitted the event. `emitBusinessEvent` adds a second `.catch()` (the code calls it "belt-and-braces"). Malformed workflow definitions are Zod-validated on read and skipped loudly so one bad definition doesn't take down a tenant's other workflows.

### Weaknesses

1. **Runs execute inline in the emitting request.** `dispatch` → `startRun` → `executeRun` runs the whole workflow synchronously. A workflow with a slow webhook adds that latency to the request that emitted the event — or, on serverless, gets **killed when the response returns**, because emission is `void`-ed fire-and-forget. The retry path recovers it 5 minutes later, but the first attempt is unreliable by construction. **This is the engine's most significant flaw.**
2. **Linear steps only.** No branching, no parallel steps, no fan-out, no sub-workflows, no loops. `conditions` gate the whole workflow, not individual steps.
3. **No cancellation** of an in-flight or scheduled run/timer.
4. **No global concurrency or rate control** — a tenant workflow that sends email has no per-tenant throughput cap.
5. **Timer resolution is the cron interval** (5 min), so "follow up in 10 minutes" is really 10–15 minutes.
6. **No dead-letter replay UI.**
7. **`workflow_events` grows unbounded** — retention purges conversations and usage events but not workflow events/runs/logs.
8. **Version pinning is recorded but not honoured**: `workflow_runs.workflow_version` stores the version at creation, but `processDue` re-fetches the *current* workflow via `getWorkflow(run.workflowId)` — a retry after an edit executes the **new** definition against the old event.

### Can this workflow engine become HALO's business process engine?

**Score: 8 / 10**

**Why 8:** Everything genuinely hard about a workflow engine is present and correct — DB-enforced idempotency, two-level retries with sane backoff, dead-letter terminal state, resume-from-step, `SKIP LOCKED` claiming, per-step timeouts, full execution history, timers, tenant scoping, defensive definition parsing, and total isolation from the flows that feed it. The store and registry are interfaces, so persistence and actions are both swappable. It has zero coupling to "receptionist" as a domain — the event types are the only product-specific thing, and they are a single `const` array.

**Why not 10:** inline execution inside the emitting request (needs a real queue or a durable-execution runtime); linear-only step topology; the version-pinning bug; no cancellation or replay.

**Path to 10:** move `executeRun` behind a durable queue (Vercel Queues, or a workflow runtime like Vercel WDK / Temporal / Inngest) so emission enqueues and a worker executes; honour `workflow_version` on retry; add branching and parallel steps; add cancellation and replay. None of that requires rewriting the engine's semantics — the state machine is already right.

**This is the single strongest candidate for promotion to HALO Core, ahead of everything else in the repository.**

---

## 10. Testing & Reliability

### Executed results

All commands run against the working tree on 2026-09-02.

| Check | Command | Result |
| --- | --- | --- |
| **Type check** | `npx tsc --noEmit` | ❌ **FAIL** — 47 errors (2 in `src/`, 45 in `tests/`) |
| **Lint** | `npx eslint` | ❌ **FAIL** — 49 problems (31 errors, 18 warnings) |
| **Unit + integration tests** | `npx vitest run` | ❌ **FAIL** — 14 of 48 files failed; 3 of 319 tests failed; 316 passed |
| **Build** | `npx next build` | ❌ **FAIL** — `Module not found: Can't resolve '@/lib/errors'` |
| **E2E** | — | **NOT CONFIGURED** — no Playwright/Cypress; `docs/ROADMAP.md:122` lists it as debt |
| **Database tests** | — | **NOT CONFIGURED** — no `supabase start` harness; RLS policies are never executed by a test |
| **AI / eval tests** | — | **NOT CONFIGURED** — `docs/AI.md` limitation #6 admits *"no LLM-judged conversation-quality benchmark yet"* |
| **Security tests** | `tests/unit/{ssrf,cors,crypto,oauth-state,safe-redirect,rate-limit}.test.ts` | ✅ **PASS** — 6 files covering the security primitives |
| **Voice tests** | `tests/unit/voice-session.test.ts` (440 LOC) | ✅ **PASS** |
| **Voice webhook tests** | `tests/integration/voice-webhook.test.ts` | ❌ **FAIL** — 3 of 4 tests |
| **Workflow tests** | `workflow-{engine,actions,interpolate,templates}.test.ts` | ✅ **PASS** |
| **Multi-tenant isolation test** | `tests/integration/multi-tenant-isolation.test.ts` | ❌ **FAIL (does not compile)** |

### Root causes, in order of blast radius

**1. One typo breaks the build and 13 test files.**

```
src/providers/messaging/composite-messaging-provider.ts:3
src/providers/messaging/whatsapp-messaging-provider.ts:3
    import { AppError } from "@/lib/errors";      ← module does not exist
                                                    (correct: "@/core/errors/app-error")
```

Import trace from the build output:
```
whatsapp-messaging-provider → messaging/factory → workflows/event-bus
  → app/api/v1/widget/conversations/route.ts        (App Route)
  → lifecycle/feedback-service → manage-service → app/appt/[token]/page.tsx  (Server Component)
```

Because `messaging/factory` is imported by `event-bus`, and `event-bus` is imported by almost everything, this single unresolved import cascades into: `booking-conversation`, `booking-orchestrator`, `booking-service`, `chat-service`, `composite-messaging` (×2), `lifecycle-service`, `multi-tenant-isolation`, `provider-failures`, `whatsapp-delivery`, `no-show-sweep`, `whatsapp-messaging` test files.

**2. A Jest test file in a Vitest project.**

`tests/unit/resend-messaging.test.ts` uses `jest.fn()`, `beforeEach`, `describe`, `it`, `expect` as globals. Vitest is configured **without** `globals: true` (`vitest.config.ts` has no such option) and there is no Jest. Result: `ReferenceError: beforeEach is not defined` plus 40 TypeScript errors in that one file.

**3. Voice webhook tests fail on a mocking error that reveals a real design issue.**

```
TypeError: (…) is not a constructor
  at src/app/api/v1/voice/webhook/route.ts:86
```
The route calls `new WidgetRepository()` **inside** the handler, and the test's `vi.mock` returns a plain object factory rather than a constructor. The test is wrong, but the route's direct instantiation of concrete classes (rather than accepting injected dependencies, as `ChatService` and `BookingService` do) is what makes it hard to test. All three failures are `expect(500).toBe(200)`.

**4. Type errors in new tests** — `email-delivery.test.ts` (missing `contentType` on an attachment), `whatsapp-delivery.test.ts` and `email-delivery.test.ts` (`callArgs` possibly undefined), `provider-failures.test.ts` (`messagingProvider` not on the harness type), `multi-tenant-isolation.test.ts` (`ManageService` not exported; `crm`/`workflow` not on the harness).

**5. Lint** — 31 errors, all `@typescript-eslint/no-explicit-any`, concentrated in the newest code: `voice/webhook/route.ts`, `vapi-voice-provider.ts`, `resend-messaging-provider.ts`, `operations-analytics-service.ts`, `startup-check.ts`, and 5 new test files. 18 unused-variable warnings.

### What the passing 316 tests actually cover

Strong: pure functions and algorithms. `availability`, `when-parser`, `timezone`, `appointment-state`, `booking-draft`, `chunker`, `rank-fusion` (RRF), `retrieval-query`, `lead-extractor`, `lead-scorer`, `prompt-builder`, `industry-playbooks`, `ics`, `confirmation-content`, `lifecycle-analytics`, `lifecycle-settings`, `workflow-interpolate`, `workflow-templates`, `retry`, `env`. Plus the security primitives and the 440-LOC voice state machine.

Integration tests use hand-written in-memory fakes (`tests/mocks/in-memory-scheduling.ts`, `in-memory-workflow-store.ts`) that deliberately reproduce production semantics — the workflow store fake reproduces the `(workflow_id, event_id)` uniqueness constraint, which is why the idempotency tests are meaningful.

### What is not covered at all

- **RLS policies.** Zero tests execute against Postgres. The most security-critical layer is verified only by reading SQL.
- **API routes.** No route handler except the voice webhook is exercised. Auth guards, rate limits, CORS enforcement, and error mapping are untested end-to-end.
- **Server Actions / dashboard.** No component or action tests.
- **The widget bundle.** `widget.ts` (311 LOC) and `api.ts` are untested; only the extracted `voice-session.ts` is.
- **Migrations.** Never applied in CI; no schema-drift check. This is how `calendar_connections.status` came to be queried without anyone noticing it doesn't exist.
- **Conversation quality.** No golden transcripts, no LLM-judge, no regression harness for prompt changes — despite `PROMPT_VERSION` existing precisely to enable that.

### Reliability verdict

The *design* for reliability is well above average: every external dependency degrades rather than fails, retries exist where they matter, the database enforces the two invariants that must never break, and the code is written to be injectable and therefore testable. The *current state* of the harness is red, and the red is masking the multi-tenant isolation check. Two of the four failures are one-line fixes.

---

## 11. Production Readiness

| Dimension | Assessment | Evidence |
| --- | --- | --- |
| **Secrets management** | **Good.** Zod-validated env schema failing fast with readable issue paths (`src/lib/env.ts`); memoized. Service-role key guarded by `import "server-only"`. No secret reaches the browser — the widget holds only a public `widget_key`. `.env.example` documents every variable. ⚠️ `.env.local` is present in the working tree (gitignored, but present on disk). ⚠️ Per-tenant provider credentials (Resend sender, WhatsApp number) are deployment-global. | `lib/env.ts`, `lib/supabase/admin.ts` |
| **Error handling** | **Excellent.** `withErrorHandling` on every route maps `AppError`→status, `ZodError`→400 with issue paths, unknown→opaque 500 with full server-side logging. Every external dependency has an explicit degradation path (LLM→canned reply, retrieval→profile-only, booking→booking-free turn, calendar→DB is truth, messaging→logged failure). `src/components/error-boundary.tsx` for the client. | `lib/api/respond.ts`, `core/errors/app-error.ts`, `chat-service.ts` |
| **Logging** | **Good.** Zero-dependency structured JSON logger, one object per line, level-filtered by `LOG_LEVEL`, `logger.child({service})` context, `Error` serialized with stack. Ingestible by any aggregator. ⚠️ No request/trace id correlating a request across services — `correlationId` exists but only inside the workflow subsystem. ⚠️ Full outbound message bodies are logged by `LogMessagingProvider` (the default), including visitor phone/email — a PII-in-logs concern. | `lib/logger.ts` |
| **Monitoring** | **Partial.** `GET /api/health` (cheap liveness) and `?deep=1` (LLM probe + DB probe + provider config), `GET /api/admin/system-status` (queue depths, failed runs, calendar counts), `/dashboard/admin`. ⚠️ `?deep=1` is **unauthenticated and leaks readiness error strings**. ⚠️ Both status endpoints query the non-existent `calendar_connections.status`. | `api/health/route.ts`, `api/admin/system-status/route.ts`, `lib/startup-check.ts` |
| **Observability** | **Weak.** No metrics, no tracing, no APM, no error aggregation. `LLMResult.usage` is returned by every adapter and **discarded** — there is zero token-cost visibility per tenant. Grounding telemetry (`groundingSources`, `promptVersion`, `historyTurns`) is logged but never aggregated. `usage_events` is product analytics, not operational telemetry. | `chat-service.ts:105`, all LLM adapters |
| **Rate limiting** | **Insufficient for production.** In-memory sliding window with idle-bucket sweep — correct algorithm, wrong topology. Per-process, so `N` instances = `N ×` the limit; resets on every deploy. The interface is deliberately `async` so a Redis/Upstash adapter drops in without touching call sites. Applied to: widget messages (token+IP), sessions, config, appointment manage, deep health, voice webhook. **Not applied to** the dashboard API or Server Actions. | `lib/rate-limit.ts` |
| **Retries** | **Inconsistent.** `withRetry` + `isTransientHttpError` exist and are used by calendar adapters, Resend, WhatsApp, and Vapi. **Not used by any LLM adapter** — a single transient 429/503 costs the whole conversational turn. Workflow steps and runs have their own two-level retry. Reminders retry 3× with 10-min backoff. | `lib/retry.ts`, `providers/llm/*` |
| **Idempotency** | **Strong where it matters.** `unique(workflow_id, event_id)` on workflow runs; `EXCLUDE USING gist` on appointments; `unique(appointment_id)` on intake; pessimistic reminder claiming (rows come back already marked failed with attempts bumped, so a crash can't double-send); SHA-256 idempotency key on Resend sends; `onConflict` upserts on drafts/feedback. ⚠️ `upsertConversationLead` is read-then-write (documented debt: worst case a duplicate lead). ⚠️ No idempotency on the inbound `/api/hooks` endpoint — a retrying sender creates duplicate events. | `0008`, `0009`, `0010`, `scheduling-repository.ts` |
| **Database safety** | **Excellent.** The two invariants that must never break are enforced by Postgres, not code: no overlapping live appointments (gist exclusion), no duplicate workflow runs (unique). Plus: CHECK constraints on every status/enum column, `ends_at > starts_at`, FK cascades reasoned per-relationship, `SECURITY DEFINER` functions with locked `search_path`, `SKIP LOCKED` claiming, DB-maintained counters via trigger. ⚠️ No connection pooling configuration (Supabase pooler assumed). ⚠️ No migration runner in CI — migrations are applied by hand. | `supabase/migrations/*` |
| **Background jobs** | **Adequate but fragile.** Four Vercel crons (retention daily, reminders */5, workflows */5, no-shows */15), all fail-closed on a missing `CRON_SECRET`, all timing-safe authenticated, all using `SKIP LOCKED` claiming so overlaps are safe. ⚠️ **No queue** — the workflow engine executes inline in the emitting request and relies on `void`-ed fire-and-forget, which serverless does not guarantee completes. ⚠️ Batch sizes are global, not round-robin per tenant (documented). ⚠️ 5-minute cron granularity caps timer precision. | `vercel.json`, `api/cron/*`, `workflows/engine.ts` |
| **Deployment** | ❌ **Currently broken.** `next build` fails. Config itself is good: widget bundled pre-build, security headers + CSP per-path (correctly excluding the cross-origin widget API), `poweredByHeader: false`, `scripts/preflight.ts` readiness gate. ⚠️ Preflight is **not wired into any npm script**. ⚠️ No CI workflow at all (`.github/` absent) — nothing runs lint/typecheck/tests on a push. | `next.config.ts`, `vercel.json`, `package.json` |
| **Backups** | **Not addressed in-repo.** Entirely delegated to Supabase's managed backups. No documented RPO/RTO, no restore drill, no export path. | — |
| **Migrations** | **Well-written, poorly operationalized.** 12 sequential SQL files, each with a substantial header comment explaining *why*. Idempotent guards (`if not exists`, `on conflict do nothing`) in places. But: no migration tooling, no rollback scripts, no CI application, no drift detection. `README.md` says *"apply every file in supabase/migrations/ (0001 → 0009)"* — the count is stale; there are 12. The `calendar_connections.status` bug is a direct consequence of no drift checking. | `supabase/migrations/`, `README.md:53` |
| **Scaling** | **Bottlenecks identified.** (1) In-memory rate limiting breaks horizontally. (2) Provider factory singletons are per-process — fine, but LLM concurrency is unbounded. (3) Inline workflow execution puts unbounded third-party latency on the request path. (4) The no-show sweep and reminder claim are global batches, so a large tenant starves others. (5) `HISTORY_LIMIT=16` + full prompt re-send means token cost scales linearly with turns with no caching. (6) Vector search is `ORDER BY embedding <=> query` with **no ANN index** (no `ivfflat`/`hnsw` on `knowledge_chunks.embedding`) — a sequential scan per query once corpora grow. | multiple |
| **Security** | **Good primitives, three real gaps.** ✅ RLS + hardened function grants; SSRF guard with DNS resolution and no redirect following; timing-safe secret comparison; OAuth state CSRF; open-redirect guard; CSP/HSTS/frame-ancestors; Zod on every input; prompt-injection clause in the system prompt; shadow-DOM widget isolation; `server-only` build-time guards. ❌ Unauthenticated `/api/health?deep=1` leaks readiness errors. ❌ Voice webhook signature check is skipped when the secret is unset. ❌ Plaintext OAuth tokens and CalDAV passwords at rest. Plus: no audit log, no MFA, no per-tenant key rotation UI, `allowed_domains` defaults to allow-any. | `lib/{ssrf,crypto,oauth-state,safe-redirect}.ts`, `next.config.ts` |

### Production Readiness Score: **5 / 10**

**How the score is composed.**

Start from what a production-ready B2B SaaS needs and score what exists:

- **+3 — Data layer.** The schema, constraints, RLS, function grants, and queue-claiming patterns are genuinely production-grade. Two critical invariants are database-enforced. This is the part I would ship as-is.
- **+2 — Error handling and degradation.** Every external dependency has a thought-through failure path. The visitor never sees a raw 5xx because an LLM timed out. This is unusually disciplined.
- **+1 — Security primitives.** SSRF, timing-safe compares, OAuth state, CSP, RLS grants — all correct, all tested.
- **+1 — Operational scaffolding.** Structured logging, health endpoints, cron auth, readiness checks, retention job. Present and coherent.
- **−1 — The build is broken.** Not shippable today. Weighted lightly because it is a two-line fix, but it is also evidence that nothing gates merges.
- **−1 — No CI, no E2E, no DB tests, no eval harness.** The test suite is currently red and the multi-tenant isolation check is among the failures. There is no automation preventing this state.
- **−1 — Observability and cost blindness.** No metrics, no tracing, no error aggregation, and token usage is captured then thrown away. You cannot operate a multi-tenant LLM product without per-tenant cost visibility.
- **−1 — Scaling topology.** In-memory rate limiting, inline workflow execution on `void`-ed promises, no ANN index on vectors, global-batch workers.
- **−1 — Three concrete security gaps** (unauthenticated readiness leak, optional webhook signature, plaintext credentials at rest) plus no audit log.

**5/10 means:** this would run a pilot with a handful of design-partner tenants on a single instance, and the data would stay correct. It would not survive a security review, a multi-instance deployment, or a month of unattended operation without the observability and queueing gaps being closed. Notably, **the gaps are all infrastructural, not architectural** — none of them requires rethinking the domain model, which is the expensive kind of problem.

---

## 12. HALO Reusability Analysis

### KEEP — becomes HALO Core with minimal or no change

| Module / file | Current responsibility | Future responsibility in HALO | Reason |
| --- | --- | --- | --- |
| `src/core/services/workflows/{engine,types,interpolate}.ts` | Executes tenant workflows off business events | **HALO Workflow Engine** — unchanged semantics, moved behind a durable queue | Zero product coupling. Idempotency, retries, backoff, DLQ, resume, timers are all correct. Depends only on two interfaces. §9 scores it 8/10. |
| `supabase/migrations/0009_workflows.sql` | Workflow persistence + `SKIP LOCKED` claim functions | Same tables in HALO's schema | The `unique(workflow_id, event_id)` constraint *is* the idempotency guarantee. Don't reinvent it. |
| `src/core/services/scheduling/{availability,when-parser,timezone,appointment-state}.ts` | Slot generation, natural-language time parsing, tz math, appointment state machine | **HALO Scheduling primitives**, exposed as agent tools | Pure functions, heavily unit-tested, domain-neutral. Site-visit scheduling for solar is the identical problem. |
| `supabase/migrations/0008_appointments.sql` (gist exclusion constraint) | Prevents double-booking | Same | The race arbiter is a database constraint, not application logic. This is the correct design and it is rare. |
| `src/core/ports/*.ts` (9 ports) | Interface definitions for every external capability | **HALO provider contracts package** | Already the exact shape HALO needs. Lift essentially verbatim; extend `LLMProvider` and `SpeechProvider`. |
| `src/providers/calendar/*` (4 adapters + `token-source.ts`) | Google/Outlook/CalDAV/internal calendar access | **HALO Calendar integration** | Single-flight OAuth refresh with rotation persistence is subtle and correct. |
| `src/core/services/crm/crm-service.ts` | Dedupe, merge, stage progression, revenue | **HALO CRM Core** | `CrmStore` port already abstracts persistence. Forward-only stages and email/phone normalization are right. |
| `src/lib/{ssrf,crypto,oauth-state,safe-redirect,retry,logger,rate-limit,ics}.ts` | Security and utility primitives | **HALO platform utilities** | All correct, all tested. `rate-limit` keeps its async interface and gains a Redis adapter. |
| `supabase/migrations/{0001,0002}.sql` (tenancy + grants) | Tenant, membership, RLS helpers, function grant hardening | **HALO Tenant Layer** foundation | `0002` in particular closes a non-obvious PostgREST hole. Keep the pattern for every new table. |
| `src/core/services/chunker.ts`, `retrieval-query.ts`, `fuseByReciprocalRank` | Chunking, query rewriting, rank fusion | **HALO Knowledge primitives** | RRF implementation is textbook-correct. Chunker is well-tested. (Query-rewrite regexes need multilingual work — see REFACTOR.) |
| `src/core/services/lifecycle/*` (7 services) | Confirmations, reminders, self-service tokens, intake, feedback, no-show sweep | **HALO Customer Lifecycle** | Capability-token (`manage_token`) design is clean and reusable for any post-interaction flow. |
| `src/lib/api/respond.ts`, `core/errors/app-error.ts` | Uniform envelope + error mapping | **HALO API conventions** | Small, correct, consistently applied. |

### REFACTOR — valuable but too tightly coupled to the receptionist product

| Module / file | Current responsibility | Future responsibility | Reason |
| --- | --- | --- | --- |
| `src/core/services/chat-service.ts` | One conversational turn: retrieve → prompt → complete → persist → capture lead | **HALO Agent Runtime turn loop** — streaming, tool-calling, channel-agnostic | The orchestration *sequence* is right; the *shape* is wrong. Returns a complete string; must yield chunks. Hard-codes lead extraction as a special case; should be one configured post-turn extractor. Assumes exactly one agent type. |
| `src/core/services/prompt-builder.ts` | Builds the receptionist system prompt | **HALO prompt composition** — agent-type-driven templates | The *architecture* (pure, versioned, testable, facts-before-behaviour, explicit anti-hallucination) is exactly right and should be the HALO standard. The *content* is receptionist-specific and hard-coded. Needs: template stored per agent version, not compiled in; multilingual; sections composable per agent type. |
| `src/core/services/scheduling/booking-orchestrator.ts` + `booking-draft.ts` | Bridges conversation ↔ booking engine via draft state | **HALO structured-slot-filling / tool-mediation layer** | This is the most valuable *idea* in the repo: deterministic state outside the model, act-then-narrate, regex beats LLM on verifiable fields, never claim an unperformed action. Generalize from "booking draft" to "task draft with a schema"; today `BookingDraft` fields are hard-coded to appointments. |
| `src/core/services/lead-extractor.ts` + `lead-scorer.ts` | Extract and score a lead | **HALO structured outcome extraction** — schema-driven | Correct hybrid (regex ground truth + LLM). But the schema is fixed to `{name,email,phone,intent}` and the scorer's phrase lists are English-only and receptionist-domain. Arunodhaya needs `{bill_amount, property_type, location, timeline, …}`. Make the schema a per-agent config. |
| `src/providers/llm/*` (4 adapters) | Non-streaming completion | **HALO Model Runtime** | Adapters are fine; the *port* is missing `stream()`, `tools`, tool-result messages, prompt caching, and retry. Every adapter needs the additions; none needs rewriting. |
| `src/providers/knowledge/supabase-knowledge-provider.ts` + FTS schema | Hybrid FTS+vector retrieval | **HALO Knowledge Runtime** | RRF and graceful degradation stay. Must change: `english` dictionary baked into generated columns; `vector(768)` hard-coded; no ANN index; knowledge scoped to business rather than agent/collection. |
| `src/core/services/industry-playbooks.ts` (14 playbooks, 254 LOC) | Injects industry-specific guidance into the prompt | **HALO agent knowledge/config** — moved out of code entirely | This is business-specific logic living in core runtime code, which is exactly what the HALO principles forbid. It should be agent configuration or knowledge-base content, not a TypeScript array. Good *content*, wrong *location*. |
| `src/core/services/workflows/action-registry.ts` | 11 built-in workflow actions | **HALO Tool Runtime** — one registry serving both workflows and LLM tool-calls | The registry shape (`(params, ctx) => Promise<detail>`) is already the right tool signature. Needs: JSON Schema per tool, side-effect classification, per-agent grants, and LLM-invocation safety policy (§8). |
| `src/features/*` (dashboard slices) | Receptionist dashboard | **HALO Control Plane** | Structure is fine; every page assumes one receptionist per business. Needs an agent dimension throughout. |

### WRAP — keep mostly intact behind a HALO interface

| Module / file | Current responsibility | Future responsibility | Reason |
| --- | --- | --- | --- |
| `src/core/services/scheduling/booking-service.ts` | Availability, book, reschedule, cancel + confirmations + events | Wrapped as **HALO tools**: `check_availability`, `book_appointment`, `reschedule`, `cancel` | The logic is production-grade and returns typed results (`{ok:false, reason:"slot_taken", alternatives}`) rather than throwing — already excellent tool ergonomics. Wrap with JSON Schema + idempotency keys; don't touch the internals. |
| `src/core/services/workflows/event-bus.ts` | Emits events, runs CRM sync, dispatches workflows | Wrapped as **HALO Event Bus** with a durable queue behind it | Correct front-door concept. The `syncCrm` switch is receptionist-shaped and should become a subscriber rather than an inline branch, but the seam is right. |
| `src/providers/messaging/*` | Email/WhatsApp/log delivery | Wrapped as **HALO Notification/Messaging service** | Port is right; needs per-tenant credentials, SMS, WhatsApp templates, and delivery-status tracking. |
| `src/core/services/analytics/*` + `usage_events` | Metric computation over an event stream | Wrapped as **HALO Analytics** | The event-stream-plus-pure-computation split is correct. Presentation and voice-specific metrics are additive. |
| `widget/` (311 + 209 + 78 LOC) | Embeddable chat widget | Wrapped as **HALO Web Channel adapter** | Shadow-DOM isolation, no-secrets design, and the API client are all sound. It becomes one channel among phone/WhatsApp/web. |
| `src/lib/auth.ts` + `src/proxy.ts` | Session + tenant resolution | Wrapped as **HALO Tenant Context** | `requireBusiness()` becomes `requireTenant()` returning agent-capable context. One-business-per-user assumption must go. |

### REPLACE — architecture unsuitable for HALO

| Module / file | Current responsibility | Why it must be replaced |
| --- | --- | --- |
| `src/providers/voice/vapi-voice-provider.ts` + `factory.ts` + `core/ports/voice-provider.ts` | Vapi assistant creation + transcript fetch | The port has **no method to place or receive a call** — it cannot express outbound dialling, which is Arunodhaya's core requirement. It is unwired (`getVoiceProvider()` has no callers), hard-codes `openai/gpt-4`, and its tests fail. Replace with a real telephony port. |
| `src/app/api/v1/voice/webhook/route.ts` | Vapi webhook handler | Treats a Vapi `call.id` as a `conversations.id` UUID (FK violation); discards the conversation it creates; skips signature verification when the secret is unset; mislabels call summaries as `feedback.received`; bypasses the LLM factory. 242 LOC that needs rewriting, not fixing. |
| `src/providers/speech/browser-speech-provider.ts` | Client-side Web Speech STT/TTS | Correct for a web widget, structurally incapable of serving telephony. HALO needs server-side streaming STT/TTS. **Keep the file for the web channel; it cannot be the voice runtime.** |
| Cron-as-queue (`vercel.json` + `api/cron/*` + inline `executeRun`) | Background work | 5-minute granularity, global batches, and `void`-ed fire-and-forget on serverless. A voice product needs sub-second async and guaranteed delivery. Replace with a durable queue/workflow runtime; keep the *worker logic*. |
| `src/lib/rate-limit.ts` **implementation** | In-process sliding window | Per-process state cannot enforce a shared limit. The **interface stays** (it was designed for exactly this swap); the implementation becomes Redis/Upstash. |
| `receptionists` table as the agent model | Agent identity | One persona, one channel, no type, no model config, no tools, no versioning. Replace with `agents` + `agent_versions` (§6). |
| `EMBEDDING_PROVIDER` + `vector(768)` | Optional embeddings | Dimension is hard-coded in the schema and the OpenAI path deliberately throws. A multilingual agent needs a multilingual embedding model, which will not be 768-dim Ollama. Replace the storage strategy. |

### BUILD NEW — capabilities HALO needs that do not exist

| Capability | Why it doesn't exist today | Notes |
| --- | --- | --- |
| **Telephony runtime** (PSTN in/out, number provisioning, DTMF, transfer, voicemail detection) | Zero code. §5. | Buy, don't build: Vapi / Retell / LiveKit Agents / Pipecat / Exotel for India. |
| **Streaming media loop** (bidirectional audio WebSocket, jitter buffering, codec handling) | Zero code. Next.js route handlers are the wrong host for a 5-minute audio session. | Needs a long-lived process, not a serverless function. |
| **Server-side streaming STT** with partial results + endpointing | Only a client-side `SpeechProvider` exists. | Telugu-capable: Sarvam AI, AI4Bharat IndicWhisper, Google STT `te-IN`, Deepgram (limited Telugu). |
| **Server-side streaming TTS** with chunked emission and cancellation | Only browser `speechSynthesis`. | Telugu-capable: Sarvam, ElevenLabs multilingual, Google/Azure `te-IN`. Voice quality is the demo's make-or-break. |
| **Server-side VAD + true barge-in** | Endpointing is the browser's, opaque and untunable. `voice-session.ts:28` documents why full-duplex was impossible client-side. | Silero VAD or provider-native. Barge-in = cancel TTS mid-utterance on detected speech. |
| **LLM streaming + tool calling** | `LLMProvider` has neither. §4. | Port extension + all four adapters. Prerequisite for everything voice. |
| **Agent runtime loop** (observe → decide → act → observe, multi-step, interruptible) | `ChatService.respond` is a single request/response turn. | The core new engineering. |
| **Tool registry with schemas, grants, and safety classes** | Booking is compiled-in orchestrator code. §8. | `tools` + `agent_tools` tables + runtime policy enforcement. |
| **Agent + agent-version model** (config, prompt, tools, knowledge, model, versioning, rollback) | `receptionists` is a single flat row; prompts are a TS constant. | §6 items 1–3. |
| **Outbound campaign engine** (contact lists, dialling policy, retry/no-answer rules, DNC, call windows, pacing) | Entire product is inbound-only. Arunodhaya is outbound-first. | Substantial. Also carries regulatory weight in India (TRAI/DND). |
| **Call records + recordings + transcripts + structured outcomes** | No `calls` table, no recording storage, no outcome schema. | §6 items 5, 6, 8. |
| **Human handoff / live transfer** | Nothing. The prompt tells the model to offer a phone number. | Warm transfer, agent availability, whisper. |
| **Multilingual runtime** (Telugu retrieval, code-switching, transliteration, language detection) | `to_tsvector('english')` in generated columns; every heuristic regex is English. | Deep change: schema, retrieval, extraction, scoring, prompts, TTS/STT. |
| **Per-tenant cost + token accounting** | `LLMResult.usage` is discarded everywhere. | Needed before any voice product ships — voice minutes and tokens are the COGS. |
| **Evaluation harness** (golden transcripts, LLM judge, regression on `PROMPT_VERSION`) | `PROMPT_VERSION` exists specifically to enable this; nothing consumes it. | Essential for a Telugu agent where you cannot eyeball quality. |
| **Audit log** | No table, no `created_by` anywhere. | B2B requirement. |
| **Durable queue** | Cron-as-queue. | Vercel Queues / WDK, Inngest, or Temporal. |
| **CI pipeline** | No `.github/`. Build is currently broken with nothing to catch it. | Day-one item. |

---

## 13. HALO Architecture Mapping

### `HALO / Tenant Layer`

```text
Existing component:   businesses, business_members, business_settings, member_role enum,
                      is_business_member()/is_business_admin(), requireBusiness(), src/proxy.ts
Current location:     supabase/migrations/0001_init.sql, 0002_function_grants.sql, src/lib/auth.ts
Reusable?:            YES — near-verbatim. The strongest foundation in the repo after workflows.
Required refactor:    (1) requireBusiness() assumes ONE business per user (limit(1).maybeSingle()) —
                          needs an explicit tenant/agent selector.
                      (2) Add agent-scoped policies as new tables land.
                      (3) Provider credentials (Resend sender, WhatsApp number, LLM key) are
                          deployment-global; HALO needs per-tenant provider config.
Missing capability:   Audit log; MFA; machine/API-key auth for programmatic tenants;
                      per-tenant secret storage (encrypted); tenant-level quotas and billing.
Risk:                 MEDIUM. Regime B (service-role, RLS-bypassed) is most of the codebase (§7).
                      Every new HALO table inherits that pattern unless the discipline is enforced.
```

### `HALO / Agent Layer`

```text
Existing component:   receptionists table (name, greeting, tone, language, custom_instructions,
                      widget_key, is_active, lead_capture_enabled, voice_enabled, branding)
                      + industry-playbooks.ts + prompt-builder.ts
Current location:     0001_init.sql, src/core/services/{prompt-builder,industry-playbooks}.ts
Reusable?:            PARTIALLY — the *concept* (agent config as tenant data) is right and proven.
                      The *structure* is a single flat row with no type, tools, model, or version.
Required refactor:    Replace with agents + agent_versions (§6). Move the prompt template OUT of
                      TypeScript into agent_versions. Move industry playbooks out of core code
                      into agent config/knowledge — business-specific logic in core runtime is
                      exactly what the HALO principles forbid.
Missing capability:   Agent types; per-agent model + temperature; per-agent tool grants;
                      per-agent knowledge bindings; immutable versions with rollback;
                      draft/publish; A/B between versions; multi-agent-per-tenant.
Risk:                 LOW-MEDIUM. Additive schema work. The main cost is threading agent_id
                      through ~15 service call sites and every dashboard page.
```

### `HALO / Agent Runtime`

```text
Existing component:   ChatService.respond() + BookingOrchestrator.prepareTurn() + booking-draft
Current location:     src/core/services/chat-service.ts, scheduling/booking-{orchestrator,draft}.ts
Reusable?:            THE DOCTRINE YES, THE LOOP NO. §4 scores it 6/10.
                      Keep: act-then-narrate; deterministic state outside the model; regex ground
                      truth beating LLM extraction; graceful degradation of every dependency;
                      grounding telemetry; pure versioned prompt construction.
Required refactor:    Rewrite the turn loop: streaming output, tool-calling, interruption
                      awareness, multi-step agent loop, channel abstraction (web/phone/WhatsApp),
                      per-agent config rather than one receptionist.
Missing capability:   Streaming; tools; agent loop; memory beyond a 16-message window;
                      summarization; per-turn cost accounting; interruption/barge-in handling;
                      evals.
Risk:                 HIGH — this is the largest single piece of new engineering, and it sits on
                      the critical path for the Arunodhaya demo. Mitigate by generalizing the
                      booking orchestrator's proven doctrine rather than starting from a blank file.
```

### `HALO / Knowledge`

```text
Existing component:   knowledge_documents, knowledge_chunks (vector(768) + generated tsvector),
                      faqs, search_knowledge()/match_knowledge_chunks() RPCs,
                      SupabaseKnowledgeProvider (hybrid + RRF), chunker.ts, retrieval-query.ts
Current location:     0001/0005_*.sql, src/providers/knowledge/, src/core/services/{chunker,retrieval-query}.ts
Reusable?:            STRUCTURE YES, CONFIGURATION NO.
Required refactor:    (1) to_tsvector('english') is baked into GENERATED columns on two tables —
                          changing it requires a migration that rewrites both.
                      (2) vector(768) is hard-coded; the OpenAI branch deliberately throws.
                      (3) No ANN index (ivfflat/hnsw) — sequential scan per vector query.
                      (4) Knowledge is business-scoped; HALO needs agent/collection scoping.
                      (5) retrieval-query.ts anaphora regexes are English-only.
Missing capability:   Multilingual retrieval (Telugu); document ingestion beyond paste (PDF/URL/
                      crawl — source_type has 'file'/'url' values with no implementation);
                      re-ranking; citations surfaced to the user; per-collection embedding models.
Risk:                 MEDIUM-HIGH for Arunodhaya specifically. English FTS over Telugu content
                      returns near-noise, so vector retrieval becomes mandatory, which forces the
                      dimension problem immediately.
```

### `HALO / Tool Runtime`

```text
Existing component:   createActionRegistry() — 11 actions with a (params, ctx) => detail signature;
                      BookingService as the de-facto only "tool"
Current location:     src/core/services/workflows/action-registry.ts, scheduling/booking-service.ts
Reusable?:            THE REGISTRY SHAPE YES. The executor signature is already tool-shaped, and
                      BookingService returns typed results rather than throwing — good ergonomics.
Required refactor:    Unify: today the action registry serves workflows only and the LLM cannot
                      invoke anything. One registry must serve both workflow steps and LLM tool
                      calls. Add JSON Schema per tool, per-agent grants, and side-effect
                      classification (read / write-reversible / write-irreversible / external-send)
                      with runtime confirmation policy — see the §8 safety table.
Missing capability:   Tool schemas; agent-tool grants; per-call idempotency keys; approval
                      workflows for irreversible tools; tool-call transcripts (messages.role
                      CHECK allows only user|assistant — no 'tool' role); per-tool observability.
Risk:                 MEDIUM. Letting a model choose call_webhook URLs or message recipients is
                      the single most dangerous change available; the safety classification must
                      land before the tools do.
```

### `HALO / Workflow Engine`

```text
Existing component:   WorkflowEngine, SupabaseWorkflowStore, event-bus, templates.ts,
                      0009_workflows.sql, /dashboard/automations
Current location:     src/core/services/workflows/*
Reusable?:            YES — the strongest single candidate for promotion. §9 scores it 8/10.
Required refactor:    (1) Move executeRun behind a durable queue — today it runs INLINE in the
                          emitting request via a void-ed promise, which serverless does not
                          guarantee completes.
                      (2) Honour workflow_runs.workflow_version on retry (currently re-fetches
                          the CURRENT definition — a retry after an edit runs new steps against
                          an old event).
                      (3) Add branching, parallel steps, cancellation, dead-letter replay.
                      (4) BUSINESS_EVENT_TYPES is a closed 16-value array — needs agent/call events.
Missing capability:   Queue; step topology beyond linear; per-tenant concurrency limits;
                      sub-minute timer resolution; workflow_events retention.
Risk:                 LOW. The semantics are correct; the changes are infrastructural.
```

### `HALO / Voice Runtime`

```text
Existing component:   VoiceSession state machine (widget/src/voice-session.ts, 318 LOC + 440 LOC tests),
                      SpeechProvider port, "## Voice mode" prompt section
Current location:     widget/src/, src/core/ports/speech-provider.ts, src/providers/speech/
Reusable?:            THE STATE MACHINE YES — it is deliberately DOM-free and provider-agnostic,
                      and the silence budget, watchdog, generation-counter invalidation and
                      fatal-vs-transient error taxonomy are all transport-independent.
                      THE TRANSPORT NO — 100% browser Web Speech; no audio touches this codebase.
Required refactor:    Port VoiceSession to the server; replace SpeechProvider with streaming
                      STT/TTS adapters; add real barge-in (the current design explicitly disables
                      full-duplex because there is no echo cancellation — voice-session.ts:28).
Missing capability:   Everything in the media path: streaming audio, VAD, endpointing, barge-in,
                      latency budget, audio buffering, codec handling, call state, recording.
Risk:                 HIGH. §5 verdict: MAJOR REWRITE if built in-house; HARD (~3–5 weeks) if a
                      managed voice platform supplies the media loop. This is the decisive
                      architectural choice for the Arunodhaya timeline.
```

### `HALO / Telephony`

```text
Existing component:   VoiceProvider port + VapiVoiceProvider + /api/v1/voice/webhook
Current location:     src/core/ports/voice-provider.ts, src/providers/voice/, src/app/api/v1/voice/
Reusable?:            NO. The port has no method to place or receive a call. getVoiceProvider()
                      has zero callers in src/. The webhook uses a Vapi call.id as a conversations.id
                      UUID (FK violation), discards the conversation it creates, skips signature
                      verification when the secret is unset, and hard-codes openai/gpt-4.
                      3 of its 4 integration tests fail.
Required refactor:    Replace entirely. New port: placeCall(), handleInbound(), transfer(),
                      hangup(), sendDTMF(), getRecording(), plus call lifecycle events.
Missing capability:   Everything — PSTN, numbers, outbound dialling, campaigns, DNC/TRAI
                      compliance, call windows, pacing, voicemail detection, transfer, recording.
Risk:                 HIGH for Arunodhaya (outbound is the product) and carries India regulatory
                      weight. Mitigate by choosing a provider with Indian PSTN reach early.
```

### `HALO / Integrations`

```text
Existing component:   9 provider ports + factories; call_webhook action (slack/discord/json)
                      with an SSRF guard; inbound /api/hooks/[businessId] with per-tenant secret
Current location:     src/core/ports/, src/providers/, workflows/action-registry.ts, api/hooks/
Reusable?:            YES — the port+factory pattern is exactly HALO's shape, and the generic
                      webhook is the right escape hatch (Slack, Zapier, n8n, Make, any CRM).
Required refactor:    Per-tenant credentials (today Resend sender / WhatsApp number / LLM key are
                      deployment-global). Fix the two BROKEN imports. Add SMS. Add WhatsApp
                      template-message support (required for business-initiated messages).
Missing capability:   SMS adapter; WhatsApp templates; outbound webhook signing; delivery-status
                      tracking; an OAuth-app framework for tenant-authorized third parties;
                      real OpsProvider implementation (only a log adapter exists).
Risk:                 LOW. Additive, well-seamed work.
```

### `HALO / CRM`

```text
Existing component:   customers + customer_timeline; CrmService (dedupe, merge, forward-only
                      stages, revenue); always-on sync from every business event; leads +
                      lead-scorer; /dashboard/customers
Current location:     src/core/services/crm/, workflows/event-bus.ts (syncCrm), 0009_workflows.sql
Reusable?:            YES — zero-config CRM driven off the event stream is a genuine asset and
                      transfers unchanged.
Required refactor:    syncCrm() is an inline switch inside the event bus; make it a subscriber.
                      lead-scorer's phrase lists are English-only and receptionist-domain.
                      Lead schema is fixed to {name,email,phone,intent} — needs per-agent
                      qualification schemas (Arunodhaya: bill amount, property type, timeline).
Missing capability:   Pipeline/deal objects; assignment and ownership; activity tasks;
                      bidirectional sync with external CRMs; per-agent outcome schemas.
Risk:                 LOW.
```

### `HALO / Analytics`

```text
Existing component:   usage_events stream + lifecycle-analytics (pure computation) +
                      operations-analytics + 3 dashboard pages
Current location:     src/core/services/analytics/, 0001/0007/0008/0009/0010_*.sql
Reusable?:            YES for the event-stream + pure-computation split, which is the right shape.
Required refactor:    Two queries select a NON-EXISTENT column (calendar_connections.status) and
                      silently return [] — the admin panel always reports zero calendars.
                      usage_events.event_type is a CHECK constraint extended by four separate
                      migrations; it needs agent/call event types.
Missing capability:   Voice metrics (call duration, connect rate, talk ratio, interruptions,
                      latency percentiles); per-tenant token/minute COGS (LLMResult.usage is
                      captured then DISCARDED everywhere); funnel and cohort analysis; charts.
Risk:                 LOW technically, HIGH commercially — you cannot price or operate a voice
                      product without per-call cost visibility.
```

### `HALO / Control Plane`

```text
Existing component:   15 dashboard pages, Server Actions in src/features/*/actions.ts,
                      /api/workflows/*, /api/analytics/*, /api/admin/system-status,
                      health + readiness checks, preflight script
Current location:     src/app/dashboard/, src/features/, src/lib/startup-check.ts
Reusable?:            PARTIALLY — patterns and auth guards are sound; every page assumes one
                      receptionist per business.
Required refactor:    Add the agent dimension throughout. Fix the calendar_connections.status
                      queries. Authenticate /api/health?deep=1 (it currently leaks readiness
                      error strings, including database error messages, to anonymous callers).
                      Wire scripts/preflight.ts into an npm script — it exists but nothing calls it.
Missing capability:   Agent builder UI (prompt, tools, knowledge, model, version, rollback);
                      call review UI (recording + transcript + outcome); campaign management;
                      staff/booking-policy admin (currently DB-only); tenant/agent switcher;
                      audit log viewer; cost dashboard; eval results.
Risk:                 MEDIUM — large surface area, but purely additive UI work with no
                      architectural risk.
```

---

## 14. Arunodhaya Gap Analysis

**Target:** a Telugu-first outbound AI solar sales/qualification agent for **Arunodhaya Solar Systems**.

Effort key: **S** ≈ 1–3 days · **M** ≈ 1–2 weeks · **L** ≈ 3–5 weeks · **XL** ≈ 6+ weeks (specialist or vendor).

| Arunodhaya Requirement | Existing Capability | Gap | Effort |
| --- | --- | --- | --- |
| **Outbound phone calls** | **Nothing.** The entire product is inbound web chat. `VoiceProvider` port has no `placeCall()`; `getVoiceProvider()` has zero callers. No PSTN, no numbers, no dialler. | Telephony provider with Indian PSTN reach (Exotel/Twilio India/Plivo, or a managed voice platform: Vapi, Retell, LiveKit Agents). Number provisioning, outbound dialling, call state, DTMF, hangup, transfer. Plus a **campaign engine**: contact lists, pacing, retry-on-no-answer, call windows, DND/TRAI compliance. | **XL** |
| **Telugu language** | Config only. `receptionists.language` is a free-text column; the prompt says *"Respond in the language the visitor writes in, defaulting to `{language}`"*. **No Telugu anywhere in the runtime.** Retrieval is `to_tsvector('english')` baked into generated columns. Every heuristic regex (`ANAPHORIC_RE`, `INTERROGATIVE_RE`, `SCHEDULING_INTENT_RE`, `COMMITMENT_RE`, `CANCEL_RE`, `LEAD_TRIGGER_RE`, `GREETING_RE`, all of `lead-scorer.ts`) is English-only and will silently never fire. | Telugu STT + TTS (Sarvam AI, AI4Bharat, Google `te-IN`, Azure). A Telugu-competent LLM. Multilingual retrieval — English FTS over Telugu returns noise, so vector search becomes **mandatory**, which immediately forces the hard-coded `vector(768)` problem. Rewrite or remove every English heuristic. Telugu prompt + confirmation templates (`confirmation-content.ts` is fixed English). | **L** |
| **Telugu-English code switching** | **Nothing.** No language detection, no transliteration, no mixed-script handling. FTS would tokenize Romanized Telugu as unknown English words. | Code-switch-tolerant STT (most Indic STT handles this better than Western models). Prompt guidance for natural Telugu-English mixing as spoken in Hyderabad/Andhra. Retrieval that survives mixed script — vector embeddings from a multilingual model, plus transliteration normalization. Evaluate specifically on code-switched utterances. | **M** |
| **Natural conversation** | **Strong, and transferable.** `prompt-builder.ts` already encodes: 1–3 sentence replies, one question per turn, acknowledge-before-asking, never re-ask a known detail, match their pace, own mistakes, vary phrasing. `## Voice mode` adds: <2 sentences, plain words, spell numbers naturally, read back contact details, yield on interruption. `booking-draft` prevents the "and can I take your name?" loop. | The *doctrine* transfers directly; the *content* is receptionist-shaped and English. Needs: Telugu-native phrasing (not translated English), sales-conversation rules rather than reception rules, and — critically — **streaming + barge-in**, without which a "natural" phone conversation is impossible regardless of prompt quality. | **M** (given the runtime) |
| **Solar domain knowledge** | **Structure exists, content does not.** `knowledge_documents` + `knowledge_chunks` + `faqs` + chunker + hybrid retrieval + source attribution all work. `industry-playbooks.ts` has 14 playbooks — **none for solar**. | Ingest Arunodhaya's actual content: panel types, capacities, subsidy schemes (PM Surya Ghar), net metering, payback math, warranties, installation process, pricing bands. Must be **Telugu-retrievable**. Note: `source_type` allows `'file'` and `'url'` but only paste-text ingestion is implemented. | **M** |
| **Lead qualification** | **Architecture yes, schema no.** `lead-extractor.ts` (regex ground truth + LLM JSON) and `lead-scorer.ts` (0–100 + hot/warm/cold + explainable signals) are well-built. But the schema is hard-coded to `{name, email, phone, intent}` and the scorer's phrase lists are English receptionist vocabulary. | Per-agent qualification schema (see the specific fields below). Generalize `LeadDraft` from four fixed fields to a configured JSON Schema. Rewrite scoring for solar-purchase intent. Reuse the hybrid extraction *pattern* — it is the right one. | **M** |
| **Objection handling** | **Pattern exists.** `prompt-builder.ts` has 7 situation playbooks (upset visitor, pricing, booking, can't-answer, wants-a-human, silent visitor, goodbye) plus per-industry `emergency` and `compliance` rules — the exact shape objection handling needs. | Solar-specific objections: *"too expensive"*, *"how long is payback"*, *"will it work in monsoon"*, *"what about maintenance"*, *"my neighbour's system failed"*, *"is the subsidy real"*, *"I'll think about it"*. In Telugu, as agent config/knowledge — **not** hard-coded in `industry-playbooks.ts`, which is business logic in core runtime code and violates the HALO principles. | **S–M** |
| **Collect electricity bill information** | **Nothing.** No numeric/currency extraction. `PHONE_RE`/`EMAIL_RE` are the only deterministic extractors. `intake_form` jsonb on `scheduling_settings` is a *web form* builder, not conversational slot filling. | Add to the qualification schema: monthly bill amount (₹), units consumed (kWh), connection type (domestic/commercial/agricultural), DISCOM. Needs Telugu numeral handling (spoken *"రెండు వేలు"* / "two thousand" / "2000") — a genuinely fiddly extraction problem. The `booking-draft` merge pattern (deterministic last, so regex wins) is the right mechanism to reuse. | **M** |
| **Property type** | **Nothing.** No property concept in the schema or extraction. | Schema field: independent house / apartment / commercial / factory / farmland; roof type; approximate roof area; shading; ownership (owner vs tenant — a hard disqualifier). Conversational slot filling. | **S** |
| **Location** | **Weak.** `businesses.address` is a free-text column for the *business*, not the prospect. No geocoding, no service-area logic, no pincode handling. | Prospect location capture: district / mandal / village / pincode. Service-area validation. Feeds site-visit scheduling and technician routing. | **S–M** |
| **Solar requirement** | **Nothing.** | Derived field: required kW from bill/units, panel count, rooftop feasibility, on-grid vs off-grid vs hybrid, battery interest. Some of this is *computation* on collected inputs — a deterministic tool the agent calls, not something the LLM should compute. | **M** |
| **Purchase timeline** | **Partial.** `when-parser.ts` parses time expressions well and `lead-scorer.ts` has urgency signals — but both are English-only and tuned to appointment scheduling, not purchase horizon. | Timeline bucket: immediate / 1–3 months / 3–6 months / just exploring. Telugu time expressions. This is the highest-signal qualification field for sales prioritization. | **S** |
| **Appointment / site-visit scheduling** | **STRONG — the single biggest existing asset for this use case.** `BookingService` (availability → book → confirm → remind → reschedule → cancel), `staff_members` as technicians, gist exclusion constraint preventing double-booking, Google/Outlook/CalDAV sync, `when-parser`, timezone handling, `booking-draft` conversational state, reminders queue, ICS attachments, `manage_token` self-service links. | Reuse nearly as-is. Needs: exposure as a **tool** rather than compiled-in orchestration; Telugu confirmation copy (`confirmation-content.ts` is fixed English); travel-time buffers between site visits; technician geographic assignment. A site visit is structurally identical to an appointment. | **S–M** |
| **CRM updates** | **STRONG.** `customers` + `customer_timeline`, dedupe by normalized email/phone, merge with `merged_into`, forward-only stage progression (lead→engaged→booked→customer), revenue attribution, and **automatic sync off every business event** with zero configuration. Workflow actions `crm_upsert_customer`/`crm_record_timeline`/`crm_record_revenue`. | Add call events to the timeline (`syncCrm` handles 9 event types, none of them call-related). Add solar-specific fields (bill, kW, property, timeline) — today `customers` has no custom-field mechanism. | **S** |
| **Call transcript** | **Nothing durable.** `messages` stores chat turns, but the voice webhook's transcript path is **broken** — it calls `appendMessages(call.id, …)` with a Vapi call id as a `conversations.id` UUID (FK violation). `messages.role` CHECK allows only `user`\|`assistant`, so tool calls cannot be transcribed. | A `calls` table + turn-level transcript with timestamps and speaker labels, linked to `conversation_id` and `agent_version_id`. Telugu transcript display in the dashboard. | **M** |
| **Call recording** | **Nothing.** No storage, no URL field, no consent handling. Supabase Storage exists but only for `business-assets` (public-read bucket). | Recording capture (provider-supplied), private storage with signed URLs, retention policy, and **consent/disclosure** — recording announcements are a compliance requirement for outbound calls in India. | **M** |
| **Structured lead outcome** | **Partial pattern.** `leads.qualification` jsonb + `score` + `temperature` exist, and `lead-scorer.ts` produces explainable signals. But there is no per-conversation outcome schema and no call disposition concept. | `conversation_outcomes` / call disposition: qualified / not-qualified (+reason) / callback-requested / not-interested / wrong-number / no-answer / DNC, plus the extracted qualification payload. This is the **primary deliverable to the Arunodhaya sales team** — it deserves a first-class schema, not a jsonb blob. | **M** |
| **Human handoff** | **Nothing operational.** The prompt tells the model to offer the business phone number and take a callback number; there is no transfer mechanism, no agent-availability model, no escalation trigger. | Warm transfer to a human agent mid-call (telephony-provider feature), availability/queue model, escalation triggers (frustration, explicit request, high-value prospect), whisper/context handoff. | **M** |

### What Arunodhaya can genuinely reuse today

Roughly **40–45% of the required system already exists and is good**, concentrated in exactly the places that are expensive to build well:

- **Multi-tenant foundation** — tenant, membership, roles, RLS, per-tenant settings, retention. Days of work already done correctly.
- **Site-visit scheduling** — the appointment engine with a database-enforced no-double-booking constraint, calendar sync, reminders, and self-service reschedule links. This is the second-largest asset after workflows and maps onto solar site visits with almost no change.
- **Workflow engine** — post-call follow-up sequences ("send the quote", "remind in 3 days", "notify sales on Slack", "create a ticket") are exactly what it was built for, with idempotency and retries already correct.
- **CRM** — every qualified prospect becomes a deduped customer record with a timeline, automatically.
- **Knowledge/RAG structure** — chunking, hybrid retrieval, RRF fusion, source attribution, and knowledge-gap telemetry all work; they need Telugu-capable retrieval, not redesign.
- **Provider abstraction** — swapping to a Telugu-capable LLM is an env change today.
- **Conversation doctrine** — the anti-hallucination stance, act-then-narrate discipline, and draft-state slot filling are the hardest-won parts of the codebase and transfer directly to a sales agent.

### What must be built, in blunt terms

**The entire voice path, and the language.** Telephony, streaming audio, VAD, streaming STT, streaming TTS, barge-in, latency engineering, call records, recordings, outbound campaigns, and human transfer — none of it exists in any form. On top of that, Telugu is not a configuration change: it invalidates English FTS (forcing vector retrieval, which forces the hard-coded 768-dim problem) and silently disables roughly a dozen English regex heuristics that currently do real work.

The honest framing: **Arunodhaya reuses the back half of this system (booking, CRM, workflows, knowledge, tenancy) and needs a new front half (voice + language + agent runtime).**

---

## 15. Recommended Migration Strategy

### Decision

# ▶ Strategy 4 — Extract AI Receptionist into HALO Core

*(with the AI Receptionist retained as the first HALO tenant application, not as a fork and not as a rewrite)*

### Why this one, and not the other four

**Not (1) Build HALO from scratch.** This throws away four things that are expensive to get right and are already correct here: a workflow engine with database-enforced idempotency and two-level retries (§9, 8/10); an appointment engine whose race arbiter is a Postgres `EXCLUDE USING gist` constraint rather than application logic; a multi-tenant schema with RLS plus the non-obvious PostgREST function-grant hardening in `0002`; and — least replaceable — the *conversational doctrine* in `booking-orchestrator.ts` (never narrate an action the engine didn't perform; deterministic state outside the model; regex ground truth beats LLM extraction). Teams usually learn that last one by shipping a bad agent first. Rebuilding costs 3–4 months to arrive back at parity.

**Not (2) Fork.** A fork means two divergent codebases with a shared history and no shared code. Every bug fix in the workflow engine, every RLS hardening, every calendar adapter improvement gets fixed twice or not at all. Given that ~45% of HALO's needs are already met by this code, a fork guarantees the worst outcome: duplicated maintenance of the *good* parts while the *new* parts (voice, agents) diverge anyway.

**Not (3) Extend AI Receptionist directly.** Tempting, and wrong for a specific structural reason: the agent model. `receptionists` is one flat row per business — one persona, one channel, no type, no tools, no model config, no versioning. Every dashboard page, every service call site, and `requireBusiness()` itself assume one receptionist per business. Bolting multi-agent, multi-channel, tool-calling and versioning onto that in place means a long-lived broken-main period on a product that (per its own docs and git history) is being actively developed. It also keeps business-specific logic — `industry-playbooks.ts` in core runtime code — exactly where the HALO principles say it must not live.

**Not (5) Hybrid: reuse foundation + build new runtime.** This is the closest alternative and is genuinely defensible — it is essentially strategy 4 without the discipline of extraction. The problem is that "reuse the foundation" without a real package boundary degrades into copy-paste within six weeks, and you end up at (2) by accident. Strategy 4 is the hybrid *with an enforced seam*.

**Strategy 4 wins because** the codebase already has the seam. `src/core/` never imports a concrete provider; it depends on `src/core/ports/*` and takes providers as constructor parameters with factory defaults. That is precisely why the test suite can inject fakes without a DI container — and precisely why `core/` + `ports/` + `providers/` can be lifted into shared packages with mechanical, reviewable changes rather than a redesign. The extraction is *already 70% done by the original architecture*; what remains is moving files and adding an agent dimension.

### What happens to the existing AI Receptionist

**It stays alive and becomes HALO's first tenant application** — and it should, for three reasons:

1. **It is the regression harness for HALO Core.** 316 passing tests, real conversational flows, and a working end-to-end product. If extracting the workflow engine breaks it, you find out in minutes rather than in front of Arunodhaya.
2. **It is a second, structurally different agent type.** An inbound web-chat receptionist and an outbound Telugu phone sales agent stress opposite axes of the agent model. Building HALO against only one of them produces an abstraction fitted to that one.
3. **It has commercial value.** It is a shippable SaaS today (modulo the build fix). Killing it converts a revenue-capable asset into sunk cost.

Concretely: AI Receptionist becomes `apps/receptionist` in the HALO repo, consuming `@halo/core`, `@halo/workflows`, `@halo/scheduling`, `@halo/knowledge` and `@halo/providers` as workspace packages. Its `receptionists` row becomes an `agents` row of type `receptionist`. Its dashboard becomes the control-plane's first agent-builder consumer.

**Freeze feature development on it during Phase 1** (~2 weeks). Bug fixes only. Extraction against a moving target is how extractions fail.

### Repository strategy

**A single monorepo — `halo/` — using npm workspaces (already the package manager here) or pnpm.**

Not multi-repo, for a concrete reason: HALO Core and the two applications will change together constantly for the first six months. Every agent-model change touches core, the receptionist app, and the Arunodhaya app in one logical commit. Multi-repo turns that into three PRs, version bumps, and a lockstep release dance — for a team that has no need for independent release cadences yet.

Not microservices at the code level either. §B classifies the current system as a modular monolith and finds no independent scaling axis. The **one** genuinely different runtime profile is the voice media loop (long-lived bidirectional WebSocket audio sessions, latency-critical, stateful), which does not fit serverless request/response. That is a **process** separation — `services/voice-gateway` deployed separately — not a decomposition of the domain. Everything else stays in the monolith deployable.

Git strategy: **keep the existing repository's history.** `git mv` the extracted directories into `packages/` rather than starting fresh, so `git log --follow` still explains why the gist exclusion constraint exists and why `0002_function_grants.sql` revokes what it revokes. That commentary is unusually good in this repo and is worth preserving.

### Migration order

The ordering principle: **de-risk the unknown before industrializing the known.** The voice runtime is the only part with genuine technical uncertainty (§5: MAJOR REWRITE in-house, HARD with a vendor). Everything else is work with a known shape. So a throwaway voice spike comes *early*, in parallel with extraction, not after it.

```
0. Baseline          — fix the build, add CI, freeze features.        [BLOCKING]
   └─ in parallel ─▶ Voice spike: one Telugu call, end to end, throwaway code.
                     Answers: which vendor, what latency, is Telugu TTS good enough?
1. Extract Core      — workspaces; move ports/providers/workflows/scheduling/knowledge.
                     AI Receptionist must stay green throughout. Mechanical, reviewable.
2. Agent Model       — agents + agent_versions + tools + agent_tools schema.
                     Migrate receptionists → agents. Prompt template moves OUT of TypeScript.
3. Agent Runtime     — streaming LLM port, tool calling, agent loop.
                     Prove it on the EXISTING chat product first (lower risk, instant feedback).
4. Voice/Telephony   — productionize the spike: voice-gateway service, calls schema,
                     recordings, transcripts, outbound campaigns.
5. Arunodhaya Agent  — Telugu retrieval, solar knowledge, qualification schema, objections.
                     Mostly configuration and content IF phases 2–4 landed correctly.
                     (If it needs core code changes, phase 2 was done wrong.)
6. Control Plane     — agent builder, call review, campaign management.
7. Hardening         — Redis rate limiting, durable queue, observability, cost accounting,
                     evals, security fixes, audit log.
```

Two ordering choices worth defending:

- **Agent Runtime (3) before Voice (4).** Streaming and tool-calling are prerequisites for voice, and proving them against the existing text chat gives a fast, cheap feedback loop. Debugging a tool-calling bug over a phone line is an order of magnitude harder than debugging it in a browser.
- **Control Plane (6) after Arunodhaya (5).** The demo can be driven by seeded configuration and SQL. Building the agent-builder UI before you know what an agent actually needs is how you build the wrong UI.

### Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Voice latency makes the demo feel robotic** — target <800 ms end-of-speech→first-audio; the *first LLM call alone* can exceed that today | High | Critical | Vendor spike in Phase 0 with a measured latency budget. Streaming TTS on sentence boundaries. Cheap fast model for the conversational turn. Kill the second and third LLM calls per turn (booking extraction, lead extraction) from the voice path. |
| **Telugu TTS quality is not good enough to be persuasive** | Medium | Critical | Evaluate Sarvam / AI4Bharat / Google `te-IN` / ElevenLabs multilingual **in Phase 0, with native speakers**, before any architecture commits. This is a go/no-go input, not a later optimization. |
| **Extraction drags on and blocks everything** | Medium | High | Timebox Phase 1 to 2 weeks. Move files, don't redesign. AI Receptionist green after every PR. If a module resists extraction, leave it in the app and revisit. |
| **Agent abstraction fitted to one use case** | Medium | High | Design phase 2 against *both* the receptionist and Arunodhaya concurrently. If Arunodhaya later needs core changes, that is the signal the abstraction is wrong. |
| **Telugu retrieval forces the vector-dimension problem immediately** — `vector(768)` is hard-coded and the OpenAI path deliberately throws | High | Medium | Decide the embedding model in Phase 0 alongside STT/TTS. Plan the dimension migration in Phase 1, not Phase 5. |
| **The service-role/RLS-bypass pattern (§7) propagates into every new HALO table** | High | High | Establish the rule in Phase 1: every new table gets RLS policies *in the same migration*. Fix and re-enable `multi-tenant-isolation.test.ts` as a gate. |
| **India telephony/regulatory friction** (DND/TRAI, number provisioning, recording consent) | Medium | High | Choose a provider with Indian PSTN reach early (Exotel/Twilio India/Plivo). Treat DNC and call-window rules as Phase 4 requirements, not Phase 7. |
| **No CI means the build breaks again** — it is broken right now | Certain (already occurred) | Medium | Phase 0. Non-negotiable. |
| **Cost blindness at voice scale** — `LLMResult.usage` is currently discarded everywhere | High | High | Token + minute accounting lands in Phase 3, not Phase 7. Voice minutes are the COGS. |

### Expected development effort

Assuming **2–3 engineers**, one with real-time audio experience (or a managed voice platform substituting for that skill), and **buying stages 1–5 and 7–9 of the media path** rather than building them:

| Phase | Elapsed | Notes |
| --- | --- | --- |
| 0 — Baseline + voice spike | **1 week** | Build fix is hours; CI is a day; the spike is the week. Parallelizable. |
| 1 — Extract Core | **2 weeks** | Mechanical. Bounded by review, not invention. |
| 2 — Agent model | **2–3 weeks** | Schema + migration + threading `agent_id` through ~15 call sites and the dashboard. |
| 3 — Agent runtime | **3–4 weeks** | The largest genuinely new engineering. Streaming + tools + loop, proven on text first. |
| 4 — Voice/telephony | **4–6 weeks** | With a vendor. **Double it if built in-house** (§5: major rewrite). |
| 5 — Arunodhaya agent | **2–3 weeks** | Mostly Telugu content, knowledge and config — *if* phases 2–4 landed correctly. |
| 6 — Control plane | **3–4 weeks** | Additive UI, parallelizable with 5 and 7. |
| 7 — Production hardening | **3–4 weeks** | Queue, Redis, observability, cost, evals, security, audit. |

**Critical path to a credible Arunodhaya demo (phases 0→1→2→3→4→5): ~13–17 weeks (3–4 months).**
**Full production-grade HALO including control plane and hardening: ~6–7 months.**

**Faster path if the demo date is nearer than that:** run Arunodhaya on a managed voice platform (Vapi/Retell) wired directly to the *existing* `BookingService` and `CrmService` via HTTP tools, skipping phases 1–3 entirely. That yields a working Telugu demo in **3–5 weeks** — but it is a demo-grade integration, not HALO, and the agent lives in the vendor's console rather than in your agent model. Do this only as a deliberate, time-boxed sales artifact, and start Phase 0/1 in parallel. Do **not** let it become the architecture.

---

## 16. Proposed Target Repository

Derived from what actually exists, not from a template. Every `←` line names the real source path.

```text
halo/
├── package.json                          ← npm workspaces (already the package manager)
├── turbo.json | nx.json                    (optional; only once build times justify it)
│
├── apps/
│   ├── receptionist/                     ← the ENTIRE current src/app + src/features
│   │   ├── app/                          ← src/app/{dashboard,onboarding,(auth),appt,widget-demo}
│   │   ├── features/                     ← src/features/* (9 slices, unchanged structure)
│   │   ├── widget/                       ← widget/src/* + scripts/build-widget.mjs
│   │   └── package.json                    depends on @halo/* packages
│   │
│   ├── arunodhaya/                       ← NEW. Thin: config + knowledge + tools + prompts.
│   │   ├── agent.config.ts                 If this needs core changes, the agent model is wrong.
│   │   ├── knowledge/                      solar content (Telugu + English)
│   │   ├── prompts/                        Telugu sales persona, objection playbooks
│   │   └── tools/                          solar-sizing calculator, subsidy lookup
│   │
│   └── console/                          ← NEW. HALO control plane (agent builder, call review,
│                                            campaigns). Grows out of apps/receptionist/dashboard.
│
├── packages/
│   ├── core/                             ← src/core/domain/* + src/core/errors/*
│   │   ├── domain/                       ← types.ts, scheduling.ts, workflow.ts
│   │   └── errors/                       ← app-error.ts
│   │
│   ├── ports/                            ← src/core/ports/* — LIFT VERBATIM (9 ports)
│   │                                        llm · embedding · knowledge · calendar · messaging
│   │                                        · notification · speech · ops · (voice → replaced)
│   │
│   ├── providers/                        ← src/providers/*
│   │   ├── llm/                          ← 4 adapters + factory (extend port: stream, tools)
│   │   ├── embedding/                    ← ollama (+ multilingual, dimension-agnostic)
│   │   ├── knowledge/                    ← supabase-knowledge-provider (RRF stays)
│   │   ├── calendar/                     ← google · outlook · caldav · internal · token-source
│   │   ├── messaging/                    ← log · resend · whatsapp · composite (FIX the imports)
│   │   ├── notification/                 ← log · resend
│   │   ├── ops/                          ← log (the OpsCorp seam — stays abstract)
│   │   ├── speech/                       ← browser (WEB CHANNEL ONLY — not the voice runtime)
│   │   └── telephony/                    ← NEW. Replaces src/providers/voice/ entirely.
│   │
│   ├── agent-runtime/                    ← REFACTOR of src/core/services/chat-service.ts
│   │   ├── loop.ts                         streaming, tool-calling, interruptible turn loop
│   │   ├── prompt/                       ← prompt-builder.ts (template moves to agent_versions)
│   │   ├── memory/                       ← history window + NEW summarization
│   │   ├── extraction/                   ← lead-extractor.ts + lead-scorer.ts, schema-driven
│   │   └── slot-filling/                 ← GENERALIZED booking-draft.ts (the key idea)
│   │
│   ├── voice-runtime/                    ← PORT of widget/src/voice-session.ts to the server
│   │   ├── session.ts                      the state machine (DOM-free already — reusable)
│   │   ├── vad.ts                        ← NEW
│   │   ├── stt/                          ← NEW streaming adapters (Sarvam/AI4Bharat/Deepgram)
│   │   ├── tts/                          ← NEW streaming adapters (Sarvam/ElevenLabs/Azure)
│   │   └── barge-in.ts                   ← NEW (impossible client-side; see voice-session.ts:28)
│   │
│   ├── knowledge/                        ← chunker.ts · retrieval-query.ts · rank fusion
│   │                                        + NEW multilingual retrieval
│   │
│   ├── tools/                            ← UNIFIED registry serving BOTH workflow steps and
│   │   ├── registry.ts                     LLM tool calls. Grows from action-registry.ts.
│   │   ├── schemas/                      ← NEW JSON Schema per tool
│   │   └── safety.ts                     ← NEW side-effect classification (§8 table)
│   │
│   ├── workflows/                        ← src/core/services/workflows/* — HIGHEST-VALUE LIFT
│   │                                        engine · types · interpolate · action-registry
│   │                                        · supabase-store · templates   (+ durable queue)
│   │
│   ├── scheduling/                       ← src/core/services/scheduling/* — LIFT NEARLY AS-IS
│   │                                        booking-service · availability · when-parser
│   │                                        · timezone · appointment-state · repository
│   │
│   ├── lifecycle/                        ← src/core/services/lifecycle/* (7 services)
│   ├── crm/                              ← src/core/services/crm/*
│   ├── analytics/                        ← src/core/services/analytics/* + NEW voice/cost metrics
│   │
│   ├── tenancy/                          ← src/lib/auth.ts + src/proxy.ts + supabase clients
│   │                                        requireBusiness() → requireTenant() + agent context
│   │
│   └── platform/                         ← src/lib/* — LIFT VERBATIM
│                                            ssrf · crypto · oauth-state · safe-redirect · retry
│                                            · logger · rate-limit (impl → Redis) · ics · env
│                                            · api/{respond,cors}
│
├── services/
│   └── voice-gateway/                    ← NEW. THE ONLY PROCESS SEPARATION IN THIS DESIGN.
│                                            Long-lived bidirectional audio WebSocket sessions.
│                                            Justified by runtime profile (stateful, latency-
│                                            critical, minutes-long), NOT by domain decomposition.
│
├── database/
│   ├── migrations/                       ← supabase/migrations/0001–0012 UNCHANGED (keep history)
│   │   ├── 0013_agents.sql                 NEW: agents, agent_versions
│   │   ├── 0014_tools.sql                  NEW: tools, agent_tools
│   │   ├── 0015_calls.sql                  NEW: calls, call_events, recordings, outcomes
│   │   ├── 0016_multilingual.sql           NEW: FTS config + vector dimension strategy
│   │   ├── 0017_audit_log.sql              NEW
│   │   └── 0018_credential_encryption.sql  NEW: calendar_connections + telephony secrets
│   └── seeds/                              receptionist demo tenant · arunodhaya demo tenant
│
├── infrastructure/
│   ├── vercel.json                       ← existing crons (+ queue config)
│   ├── ci/                               ← NEW. Does not exist today; build is currently broken.
│   └── voice-gateway/                    ← NEW deploy manifests (Fly/Railway/ECS)
│
├── tests/
│   ├── unit/ integration/                ← tests/* (48 files, 319 tests — FIX the 14 red files)
│   ├── e2e/                              ← NEW Playwright (ROADMAP.md:122 lists this as debt)
│   ├── db/                               ← NEW RLS policy tests (zero exist today)
│   └── evals/                            ← NEW golden transcripts + LLM judge, keyed on
│                                            PROMPT_VERSION (which exists precisely for this)
│
└── docs/                                 ← docs/* (16 files, genuinely good) + this audit
```

### Explicit mapping of every existing directory

| Current path | Destination | Action |
| --- | --- | --- |
| `src/core/domain/` | `packages/core/domain/` | Move |
| `src/core/errors/` | `packages/core/errors/` | Move |
| `src/core/ports/` | `packages/ports/` | Move verbatim; extend `LLMProvider` (stream/tools) and `SpeechProvider`; **replace** `voice-provider.ts` |
| `src/core/services/chat-service.ts` | `packages/agent-runtime/loop.ts` | **Refactor** — streaming, tools, agent loop |
| `src/core/services/prompt-builder.ts` | `packages/agent-runtime/prompt/` | Refactor — template to `agent_versions` |
| `src/core/services/{lead-extractor,lead-scorer}.ts` | `packages/agent-runtime/extraction/` | Refactor — schema-driven |
| `src/core/services/{chunker,retrieval-query}.ts` | `packages/knowledge/` | Move; add multilingual |
| `src/core/services/industry-playbooks.ts` | `apps/*/knowledge` or agent config | **Move out of core** — business logic must not live in runtime code |
| `src/core/services/widget-repository.ts` | `apps/receptionist/` | Stays with the app (widget-specific) |
| `src/core/services/scheduling/` | `packages/scheduling/` | Move nearly as-is; expose as tools |
| `src/core/services/workflows/` | `packages/workflows/` | Move; add durable queue |
| `src/core/services/crm/` | `packages/crm/` | Move |
| `src/core/services/lifecycle/` | `packages/lifecycle/` | Move |
| `src/core/services/analytics/` | `packages/analytics/` | Move; add voice + cost metrics |
| `src/providers/{llm,embedding,knowledge,calendar,messaging,notification,ops}/` | `packages/providers/*` | Move; fix the two broken imports; add SMS |
| `src/providers/speech/` | `packages/providers/speech/` | Move — **web channel only** |
| `src/providers/voice/` | — | **Delete**; replaced by `packages/providers/telephony/` |
| `src/lib/` | `packages/platform/` | Move verbatim; `rate-limit` impl → Redis |
| `src/lib/{auth.ts,supabase/}`, `src/proxy.ts` | `packages/tenancy/` | Move; add agent context |
| `src/app/`, `src/features/`, `src/components/` | `apps/receptionist/` | Move |
| `widget/`, `scripts/build-widget.mjs` | `apps/receptionist/widget/` | Move |
| `supabase/migrations/` | `database/migrations/` | Move — **keep 0001–0012 unchanged** |
| `tests/` | `tests/` | Move; fix the 14 red files; add `e2e/`, `db/`, `evals/` |
| `docs/` | `docs/` | Keep |
| `scripts/preflight.ts` | `infrastructure/ci/` | Move; **wire into an npm script** (nothing calls it today) |

---

## 17. Development Plan

### Phase 0 — Baseline

**Objective:** make the repository green and shippable, stop the bleeding, and resolve the one genuine technical unknown (voice) before committing to any architecture.

| | |
| --- | --- |
| **Files/modules affected** | `src/providers/messaging/{whatsapp,composite}-messaging-provider.ts` (the `@/lib/errors` import), `tests/unit/resend-messaging.test.ts` (Jest→Vitest), `tests/integration/voice-webhook.test.ts`, `src/app/api/admin/system-status/route.ts` + `src/app/dashboard/admin/page.tsx` (`calendar_connections.status`), `src/app/api/health/route.ts` (auth the deep probe), `src/app/api/v1/voice/webhook/route.ts` (fail closed without a secret), `src/providers/notification/log-notification-provider.ts` (the `resend+whatsapp` fallback), `package.json` (wire `preflight`) |
| **New components** | `.github/workflows/ci.yml` — typecheck + lint + test + build on every push. **Nothing gates merges today, which is how the build came to be broken.** |
| **Voice spike (parallel, throwaway)** | One outbound Telugu call end-to-end through a managed platform (Vapi / Retell / LiveKit / Exotel). Measure: end-of-speech → first-audio latency; Telugu TTS naturalness **judged by native speakers**; code-switch STT accuracy; barge-in behaviour; Indian PSTN reach and per-minute cost. Delete the code afterwards — the output is a decision memo. |
| **Dependencies** | None. This phase blocks everything else. |
| **Risks** | Voice spike returns a bad answer (Telugu TTS not persuasive enough) — that is *exactly why it runs first*; it is a go/no-go input, not an optimization. |
| **Effort** | **1 week** (build fix: hours · CI: 1 day · spike: the week, parallel) |

**Exit criteria:** `tsc`, `eslint`, `vitest run`, `next build` all green in CI. `multi-tenant-isolation.test.ts` compiles and passes. A written vendor decision with measured latency and native-speaker TTS assessment.

---

### Phase 1 — Extract Core

**Objective:** establish the package boundary with zero behaviour change. AI Receptionist stays green after every single PR.

| | |
| --- | --- |
| **Files/modules affected** | Everything moves; nothing changes semantically. `src/core/ports/` → `packages/ports/`; `src/lib/` → `packages/platform/`; `workflows/`, `scheduling/`, `crm/`, `lifecycle/`, `analytics/`, `knowledge` primitives → their own packages; `src/providers/*` → `packages/providers/`; `src/app` + `src/features` + `widget/` → `apps/receptionist/`; `supabase/migrations` → `database/migrations` **unchanged**. |
| **New components** | npm workspaces root; per-package `package.json` + `tsconfig`; path-alias rewrite (`@/` → `@halo/*`); one CI job per package. |
| **Dependencies** | Phase 0 (you cannot safely refactor against a red build). |
| **Risks** | Scope creep — the failure mode is "while I'm in here, let me also improve…". **Move files; do not redesign.** Timebox to 2 weeks; if a module resists extraction, leave it in the app and revisit in Phase 2. |
| **Effort** | **2 weeks** — mechanical, bounded by review rather than invention. |

**Exit criteria:** `apps/receptionist` builds, deploys and passes all tests while importing only `@halo/*` packages. No `packages/*` file imports from `apps/*`.

---

### Phase 2 — Agent Layer

**Objective:** replace the single flat `receptionists` row with a real agent model, and move business-specific logic out of runtime code.

| | |
| --- | --- |
| **Files/modules affected** | `packages/agent-runtime/prompt/` (template moves out of TypeScript into data), `packages/tenancy` (`requireBusiness()` → tenant + agent context — it currently does `limit(1).maybeSingle()`, hard-coding one business per user), every service call site that takes `businessId`, all 15 dashboard pages, `industry-playbooks.ts` (**leaves core entirely**). |
| **New components** | Migrations `0013_agents.sql` (`agents`, `agent_versions`) and `0014_tools.sql` (`tools`, `agent_tools`) — with RLS policies **in the same migration**, per the Phase-1 rule. Data migration `receptionists` → `agents` (type `receptionist`). Agent config resolver. |
| **Dependencies** | Phase 1. |
| **Risks** | Designing the abstraction against one use case. **Mitigation: design against the receptionist *and* Arunodhaya concurrently.** If Phase 5 later needs core changes, this phase was done wrong — treat that as the acceptance test. |
| **Effort** | **2–3 weeks** |

**Exit criteria:** the receptionist runs entirely from an `agents` + `agent_versions` row. A second agent can be created for the same tenant. Prompts are versioned data with rollback, not a TypeScript constant.

---

### Phase 3 — Agent Runtime

**Objective:** streaming + tool calling + an interruptible agent loop — proven on the existing text chat before any phone line is involved.

| | |
| --- | --- |
| **Files/modules affected** | `packages/ports/llm-provider.ts` (add `stream()`, `tools`, tool-result messages, prompt-cache hints); all 4 LLM adapters; `packages/agent-runtime/loop.ts` (rewrite of `chat-service.ts`); `packages/tools/registry.ts` (unify `action-registry.ts` so **one** registry serves workflow steps *and* LLM tool calls); `packages/scheduling` exposed as tools; migration for `messages.role` (the CHECK allows only `user`\|`assistant` — no `tool` role, which blocks tool-call transcripts). |
| **New components** | Tool JSON Schemas; `packages/tools/safety.ts` implementing the §8 side-effect classification (`read` / `write-reversible` / `write-irreversible` / `external-send`) with runtime confirmation policy; per-turn token + cost accounting (`LLMResult.usage` is currently **captured and discarded everywhere**); conversation summarization for the 16-message window; SSE streaming on the widget messages endpoint. |
| **Dependencies** | Phase 2. |
| **Risks** | Largest genuinely new engineering, on the critical path. **Mitigations:** generalize the proven `booking-orchestrator` doctrine rather than starting blank; keep the deterministic-state-outside-the-model discipline; land the safety classification *before* the tools, because letting a model choose `call_webhook` URLs or message recipients is the single most dangerous change available. |
| **Effort** | **3–4 weeks** |

**Exit criteria:** the existing chat product runs on the new runtime with streamed replies and booking as a real tool call — behaviour equal or better, verified by the (now-green) integration tests.

---

### Phase 4 — Voice / Telephony

**Objective:** productionize the Phase 0 spike into a real voice runtime.

| | |
| --- | --- |
| **Files/modules affected** | `packages/providers/voice/` **deleted**; `packages/providers/telephony/` created; `widget/src/voice-session.ts` ported to `packages/voice-runtime/session.ts` (it is already DOM-free and provider-agnostic — the most reusable piece of the voice stack); `packages/agent-runtime/loop.ts` gains interruption awareness. |
| **New components** | `services/voice-gateway` — the **only** process separation in this design, justified by runtime profile (stateful, minutes-long, latency-critical WebSocket audio), not by domain decomposition. Streaming STT + TTS adapters. Server-side VAD + true barge-in (impossible client-side — `voice-session.ts:28` documents why). Migration `0015_calls.sql` (`calls`, `call_events`, recordings, outcomes). Outbound campaign engine: contact lists, pacing, retry-on-no-answer, call windows, **DND/TRAI compliance**. Human transfer. Recording storage with signed URLs and consent disclosure. |
| **Dependencies** | Phase 3 (streaming + tools are prerequisites) and the Phase 0 vendor decision. |
| **Risks** | **Latency** — target <800 ms end-of-speech→first-audio; today the *first LLM call alone* can exceed that. Mitigate by cutting the 2nd/3rd LLM calls from the voice path, chunking TTS on sentence boundaries, and using a fast model for the conversational turn. **Regulatory** — Indian outbound calling carries DND/TRAI and recording-consent obligations; these are Phase 4 requirements, not Phase 7 polish. |
| **Effort** | **4–6 weeks** with a managed platform. **Double it if the media loop is built in-house** (§5: major rewrite). |

**Exit criteria:** a scheduled outbound campaign places calls, converses in Telugu with working barge-in, books a site visit through the existing `BookingService`, and writes a structured outcome plus a recording and transcript.

---

### Phase 5 — Arunodhaya Agent

**Objective:** the first real HALO tenant — and the acceptance test for phases 2–4.

| | |
| --- | --- |
| **Files/modules affected** | Ideally **none in `packages/`**. If this phase needs core changes, the agent model is wrong. |
| **New components** | `apps/arunodhaya/`: Telugu sales persona and objection playbooks (as agent config/knowledge, **not** as another `industry-playbooks.ts`); solar knowledge base (panels, capacities, PM Surya Ghar subsidy, net metering, payback, warranties, pricing bands) in Telugu + English; qualification schema (bill ₹/units, connection type, DISCOM, property type, roof area, ownership, district/mandal/pincode, required kW, timeline bucket); a solar-sizing tool (deterministic computation the agent *calls* — not something the LLM should compute); Telugu confirmation/reminder templates (`confirmation-content.ts` is fixed English today). Migration `0016_multilingual.sql` — FTS config plus the vector-dimension strategy, because `to_tsvector('english')` is baked into generated columns and `vector(768)` is hard-coded with the OpenAI path deliberately throwing. |
| **Dependencies** | Phases 2–4. The multilingual migration should be *planned* in Phase 1 and *applied* here. |
| **Risks** | Telugu retrieval quality — English FTS over Telugu returns near-noise, so vector search becomes mandatory and the dimension problem lands immediately. Also: ~12 English-only regex heuristics (`SCHEDULING_INTENT_RE`, `COMMITMENT_RE`, `LEAD_TRIGGER_RE`, `ANAPHORIC_RE`, all of `lead-scorer.ts`) silently stop firing — they must be rewritten or removed, not left to no-op. |
| **Effort** | **2–3 weeks** |

**Exit criteria:** a native Telugu speaker completes a qualification call, is correctly scored, has a site visit booked, and the sales team receives a structured outcome with transcript and recording.

---

### Phase 6 — Dashboard / Control Plane

**Objective:** make HALO operable by people who don't write SQL.

| | |
| --- | --- |
| **Files/modules affected** | `apps/console/` grows out of `apps/receptionist/dashboard`. |
| **New components** | Agent builder (prompt, tools, knowledge, model, version, publish/rollback, A/B); call review (recording + transcript + outcome, Telugu display); campaign management; staff/booking-policy admin (**currently database-only** — `ROADMAP.md:124`); tenant/agent switcher; cost dashboard; audit-log viewer; eval results. |
| **Dependencies** | Phase 2 for the agent model; Phase 4 for call data. |
| **Risks** | Low — additive UI, no architectural risk. Deliberately **after** Arunodhaya: building the agent builder before you know what an agent needs produces the wrong builder. The demo can run on seeded config and SQL. |
| **Effort** | **3–4 weeks**, parallelizable with 5 and 7. |

---

### Phase 7 — Production Hardening

**Objective:** close every gap §11 scored against (5/10).

| | |
| --- | --- |
| **Files/modules affected** | `packages/platform/rate-limit.ts` (implementation only — the async interface was designed for exactly this swap); `packages/workflows/engine.ts` (move `executeRun` behind a durable queue; **honour `workflow_runs.workflow_version` on retry** — it currently re-fetches the *current* definition, so a retry after an edit runs new steps against an old event); all LLM adapters (add `withRetry`, which exists and is used by calendar/messaging/Resend but by **no** LLM adapter); `calendar_connections` credential encryption. |
| **New components** | Redis/Upstash rate limiter; durable queue (Vercel Queues/WDK, Inngest, or Temporal); metrics + tracing + error aggregation; per-tenant token/minute cost accounting; `0017_audit_log.sql`; `0018_credential_encryption.sql`; ANN index on `knowledge_chunks.embedding` (currently a sequential scan per vector query); `tests/e2e/` (Playwright), `tests/db/` (RLS policy tests — **zero exist today**), `tests/evals/` (golden transcripts + LLM judge keyed on `PROMPT_VERSION`, which exists precisely to enable this); workflow-event retention. |
| **Dependencies** | Phases 3–5. Two items should be pulled **earlier**: cost accounting into Phase 3 (voice minutes and tokens are the COGS — you cannot price the product without it), and the security fixes into Phase 0 (they are one-liners). |
| **Risks** | Deferred indefinitely under demo pressure. Mitigate by treating the queue and cost accounting as Phase 3/4 requirements rather than Phase 7 polish. |
| **Effort** | **3–4 weeks** |

**Exit criteria:** production readiness ≥ 8/10 — multi-instance safe, observable, cost-attributed, audited, with RLS and conversation quality under automated test.

---

## 18. Final Verdict

```text
RECOMMENDATION:
  Strategy 4 — Extract AI Receptionist into HALO Core.
  Lift core/ + ports/ + providers/ into shared packages; keep AI Receptionist
  alive as HALO's first tenant application and regression harness; build the
  agent runtime and voice runtime as new packages beside them. Single monorepo,
  history preserved. One process separation only: services/voice-gateway.

REUSABLE FOUNDATION:
  ~45%
  Workflow engine (8/10), appointment/scheduling engine, multi-tenant schema +
  RLS + function grants, 9 provider ports and their adapters, CRM, lifecycle,
  knowledge structure, platform utilities, and the conversational doctrine in
  booking-orchestrator.ts. Weighted by value rather than line count, this is
  the expensive-to-get-right half.

NEW ENGINEERING:
  ~40%
  The entire voice path (telephony, streaming audio, VAD, streaming STT/TTS,
  barge-in, latency budget, call records, recordings, outbound campaigns,
  human transfer), the agent + agent-version + tool model, the streaming
  tool-calling agent loop, multilingual retrieval, and per-tenant cost
  accounting. None of it exists in any form today.

REFACTOR:
  ~15%
  ChatService → streaming agent loop. prompt-builder → agent-version templates.
  booking-orchestrator/booking-draft → generalized schema-driven slot filling.
  lead-extractor/lead-scorer → configurable outcome extraction.
  action-registry → unified tool registry with safety classes.
  industry-playbooks → out of core entirely (business logic in runtime code).
  LLMProvider port → add stream(), tools, retry, prompt caching.

BIGGEST RISK:
  Voice latency and Telugu TTS quality — the two things that decide whether the
  Arunodhaya demo sounds like a person or a robot, and neither has been measured.
  Today the FIRST LLM call alone can exceed the 800 ms end-of-speech→first-audio
  budget, and the runtime makes up to THREE LLM calls per turn with no streaming.
  This is why the Phase 0 spike runs before any architecture is committed: it is
  a go/no-go input, not a later optimization.

  Runner-up: the service-role/RLS-bypass pattern (§7). Most of the interesting
  code runs on the service role with tenancy enforced only in TypeScript, across
  ~15 id-keyed queries with no database backstop — and the one automated check of
  that property, multi-tenant-isolation.test.ts, currently does not compile.

FASTEST PATH TO ARUNODHAYA:
  A managed voice platform (Vapi / Retell / LiveKit / Exotel) wired directly to
  the EXISTING BookingService and CrmService as HTTP tools, with Telugu STT/TTS
  from Sarvam or AI4Bharat, and solar knowledge loaded into the existing
  knowledge_chunks tables. Skips phases 1–3 entirely.
  → a working Telugu demo in 3–5 weeks.
  This is a deliberate, time-boxed SALES ARTIFACT, not the architecture. The
  agent lives in the vendor's console rather than in your agent model. Run
  Phase 0 and Phase 1 in parallel so it never becomes the foundation.

ESTIMATED TIME:
  Demo-grade Telugu agent (managed platform, existing services):   3–5 weeks
  HALO critical path to a credible Arunodhaya agent (phases 0–5): 13–17 weeks
  Full production-grade HALO incl. control plane + hardening:      6–7 months
  Assumes 2–3 engineers, one with real-time audio experience (or a managed
  voice platform substituting for that skill), and BUYING the media loop.
  Building the media loop in-house roughly doubles phase 4.
```

### The five questions, answered explicitly

---

#### 1. Can we build HALO on top of this codebase?

**Yes — for the back half of the system, and with one structural change up front.**

What genuinely transfers is the part that is expensive to get right and cheap to underestimate: a workflow engine whose idempotency is a database constraint rather than a convention; an appointment engine whose double-booking arbiter is a Postgres `EXCLUDE USING gist` constraint; a multi-tenant schema with RLS plus the non-obvious PostgREST function-grant hardening in `0002`; nine provider ports with working adapters; and the conversational doctrine in `booking-orchestrator.ts` — never narrate an action the engine didn't perform, keep deterministic state outside the model, let regex beat the LLM on verifiable fields. Most teams learn that last one by shipping a bad agent first. It is already here, tested, and in production shape.

The structural change is the agent model. `receptionists` is one flat row per business — one persona, one channel, no type, no tools, no model config, no versioning — and `requireBusiness()` hard-codes one business per user. That must be replaced with `agents` + `agent_versions` before anything multi-agent is built on top, which is why it is Phase 2 and not an afterthought.

What does **not** transfer is the front half: there is no voice runtime, no telephony, no streaming, no tool calling, and no agent loop. Those are new engineering regardless of the foundation you choose.

The honest summary: this codebase saves roughly three to four months of foundation work and saves you from several architectural mistakes you would otherwise make. It does not shorten the voice-runtime problem at all.

---

#### 2. Should we keep the existing AI Receptionist product alive?

**Yes — and not primarily for sentimental or revenue reasons.**

Three arguments, in order of weight:

1. **It is the regression harness for HALO Core.** 316 passing tests over real conversational flows. If extracting the workflow engine or generalizing the prompt builder breaks something, you find out in minutes rather than in front of Arunodhaya. Extractions performed without a live consumer drift silently.
2. **It is a second, structurally opposite agent type.** An inbound web-chat receptionist and an outbound Telugu phone sales agent stress different axes of the agent model — channel, direction, language, tool set, outcome schema. An abstraction designed against only one of them will fit only that one. This is the single best defence against building the wrong agent model in Phase 2.
3. **It is commercially live.** Modulo a two-line build fix, it is a shippable multi-tenant SaaS. Killing it converts a revenue-capable asset into sunk cost for no engineering benefit.

The one discipline required: **freeze feature development on it during Phase 1** (~2 weeks, bug fixes only). Extraction against a moving target is how extractions fail.

---

#### 3. What should become HALO Core?

In descending order of confidence:

| Promote to Core | Why |
| --- | --- |
| **`packages/workflows`** — engine, store, action registry, templates, `0009_workflows.sql` | The strongest single asset in the repository (§9, 8/10). Zero product coupling; correct idempotency, two-level retries, backoff, dead-letter, resume-from-step, `SKIP LOCKED` claiming, per-step timeouts, full execution history. Needs a durable queue and the version-pinning fix — infrastructure, not semantics. |
| **`packages/ports`** — the 9 provider interfaces | Already exactly HALO's shape. Lift verbatim; extend `LLMProvider` (stream, tools) and `SpeechProvider`; replace `voice-provider.ts`. |
| **`packages/scheduling`** — booking service, availability, when-parser, timezone, state machine, gist constraint | Pure functions plus one database invariant. A solar site visit is structurally identical to an appointment. Expose as tools rather than rewriting. |
| **`packages/tenancy`** — tenant, membership, roles, RLS helpers, function grants | Correct and already hardened. Needs the one-business-per-user assumption removed and an agent dimension added. |
| **`packages/platform`** — ssrf, crypto, oauth-state, safe-redirect, retry, logger, rate-limit, ics, env, api conventions | All correct, all tested. Only `rate-limit`'s *implementation* changes (the async interface was designed for exactly this swap). |
| **`packages/crm`** + **`packages/lifecycle`** | Zero-config CRM driven off the event stream, and capability-token self-service flows. Both transfer nearly unchanged. |
| **`packages/knowledge`** — chunker, retrieval-query, RRF fusion, hybrid provider | Structure and algorithms are right; configuration (English FTS, 768-dim vectors, no ANN index) must change. |
| **`packages/providers`** — llm, embedding, calendar, messaging, notification, ops adapters | Move as-is; fix the two broken imports; add SMS. |

**Explicitly NOT core:** `industry-playbooks.ts` (business-specific logic sitting in runtime code — the clearest violation of the HALO principle that business logic belongs in agent configuration, knowledge, tools, or adapters); `widget-repository.ts` (widget-specific); `src/providers/voice/*` (replaced); the receptionist prompt *content* (moves into `agent_versions` as data).

**Keep the OpsCorp seam abstract.** `OpsProvider` with only a log adapter is the right shape: HALO Core knows about "create a back-office record", not about OpsCorp. Do not let a concrete OpsCorp adapter leak into core.

---

#### 4. What must be newly engineered for phone-based AI employees?

Nine things, none of which exist in any form today:

1. **Telephony** — PSTN in and out, number provisioning, DTMF, transfer, hangup, voicemail detection. The current `VoiceProvider` port has *no method to place or receive a call*, which is disqualifying for an outbound product.
2. **A streaming media loop** — bidirectional audio over a long-lived WebSocket, buffering, codec handling. This is the one component that genuinely does not fit the serverless request/response model, and the one justified process separation (`services/voice-gateway`).
3. **Server-side VAD with tunable endpointing** — today endpointing is the browser's, opaque and untunable.
4. **Streaming STT** with partial results — the existing `SpeechProvider` is client-side by design.
5. **Streaming TTS** with chunked emission and mid-utterance cancellation.
6. **True barge-in** — `voice-session.ts:28` documents precisely why it was impossible client-side (no echo cancellation, so recognition is disabled while speaking). On the server it becomes possible and mandatory.
7. **Streaming + tool-calling in the LLM port**, and an interruptible agent loop around it. The current runtime makes up to three blocking LLM calls per turn and returns one complete string.
8. **Call records, recordings, transcripts, and structured outcomes** — no `calls` table exists; `messages.role` cannot even represent a tool call.
9. **Outbound campaigns** — contact lists, pacing, retry-on-no-answer, call windows, and DND/TRAI compliance. The entire product is inbound-only today.

Plus one cross-cutting item that is easy to defer and expensive to defer: **per-tenant token and minute accounting**. `LLMResult.usage` is returned by every adapter and discarded everywhere. Voice minutes and tokens are the COGS of this product; you cannot price or operate it blind.

**The decisive recommendation: buy items 1–6, build 7–9.** A managed voice platform collapses the media path into a provider integration and turns §5's "major rewrite" verdict into a four-to-six-week integration. Building SIP, VAD and barge-in in-house is a three-to-six-month effort requiring a specialist, and it is not where the product differentiates.

---

#### 5. What should we build first for the Telugu Arunodhaya demo?

**First, before any code: the Phase 0 voice spike.** One outbound Telugu call, end to end, through a managed platform. Measure four things: end-of-speech→first-audio latency; Telugu TTS naturalness *judged by native speakers*; code-switched (Telugu-English) STT accuracy; and Indian PSTN reach with per-minute cost. Then delete the code — the deliverable is a decision memo, not a branch.

This runs first because it is the only genuine unknown in the entire plan, and because a bad answer on Telugu TTS quality changes the architecture rather than the schedule. Everything else in this audit is work with a known shape.

**Then, in build order:**

1. **Fix the build and add CI** (hours + one day). Nothing gates merges today, which is how `next build` came to be broken by a single mistyped import.
2. **Telugu retrieval.** This is the highest-risk *non-voice* item and it is routinely underestimated. `to_tsvector('english')` is baked into generated columns on two tables, so English FTS over Telugu content returns near-noise — which makes vector search mandatory, which immediately forces the hard-coded `vector(768)` problem and the deliberately-throwing OpenAI embedding path. Decide the embedding model alongside STT/TTS in Phase 0, not in Phase 5.
3. **The qualification schema and extraction.** Bill amount in ₹ and units, connection type, DISCOM, property type, roof area, ownership (a hard disqualifier), district/mandal/pincode, required kW, timeline bucket. Reuse the proven hybrid pattern from `lead-extractor.ts` — deterministic extraction applied *last* so it beats the model — but generalize the schema from the four hard-coded fields. Telugu numeral handling (spoken *"రెండు వేలు"* vs "two thousand" vs "2000") is the fiddly part; budget for it.
4. **Solar knowledge, in Telugu.** Panels, capacities, PM Surya Ghar subsidy, net metering, payback arithmetic, warranties, installation process, pricing bands. As knowledge-base content and agent configuration — *not* as a fifteenth entry in `industry-playbooks.ts`.
5. **Site-visit booking as a tool.** This is nearly free: `BookingService` already does availability → book → confirm → remind → reschedule → cancel, with double-booking prevented by a database constraint and calendar sync working. It needs Telugu confirmation copy (`confirmation-content.ts` is fixed English) and travel-time buffers between visits. Treat technicians as `staff_members`.
6. **Structured call outcome delivered to the sales team.** Disposition (qualified / not-qualified + reason / callback / not-interested / wrong-number / no-answer / DNC) plus the qualification payload, transcript, and recording. This is the actual product deliverable for Arunodhaya, and it deserves a first-class schema rather than a jsonb blob on `leads`.

**What to deliberately *not* build for the demo:** the agent-builder UI, campaign management at scale, human transfer, and the full control plane. Seed the agent with configuration and SQL. Building the agent builder before you know what an agent needs produces the wrong builder — which is exactly why Phase 6 sits after Phase 5 in the plan.

---

*Audit performed 2026-09-02 against commit `1cd187d` plus the uncommitted working tree. All build, lint, typecheck and test results in §10 were executed, not inferred. No application source was modified.*
