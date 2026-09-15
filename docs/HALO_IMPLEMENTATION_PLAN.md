# HALO — Implementation Plan

**Document status:** PLAN. Nothing in this document is implemented.
**Plan date:** 2026-09-04
**Repository:** `/home/parzifal/AI_Receptionist` — branch `main`, commit `1cd187d` + uncommitted working tree
**Baseline:** [`docs/CURRENT_STATE_AUDIT.md`](CURRENT_STATE_AUDIT.md) (audit date 2026-09-02)
**Strategy:** Strategy 4 — Extract AI Receptionist into HALO Core
**First customer:** Arunodhaya Solar Systems
**First flagship agent:** Telugu-first Solar Sales & Lead Qualification Agent

---

## How to read this document

Every claim of the form *"X exists / X is broken / X is missing"* in §1 was re-verified against
source on 2026-09-04, not copied from the audit. Verification commands and their output are
recorded in §1.7. Where the audit and the repository disagree, the repository wins and the
discrepancy is flagged explicitly (§1.8).

Every phase in §4–§16 carries: scope, files touched, new components, interfaces, dependencies,
tests, acceptance criteria, rollback, and effort. **A phase is not done until its acceptance
criteria pass in CI.** Nothing here may be reported as implemented on the strength of this
document alone.

Phase numbering follows the HALO plan (Phase 0 … Phase 12). The audit (§17 of
`CURRENT_STATE_AUDIT.md`) used its own 0–7 numbering; §3.3 maps the two.

---

# 1. Current-State Baseline

## 1.1 Current architecture

A **multi-tenant Next.js 16 modular monolith** on Vercel + Supabase Postgres. One `package.json`,
one build, one deployable, one database. 12 SQL migrations, 26 tables, 18 dashboard pages,
48 test files.

```text
Visitor browser (3rd-party site)              Business owner browser
  public/widget.js (IIFE, closed shadow DOM)    Next.js App Router / React 19 RSC
  BrowserSpeechProvider (Web Speech API)        Supabase browser client (cookie session)
  VoiceSession state machine (client-side)
         │ fetch: widgetKey + visitorToken            │ cookie session
         ▼                                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ NEXT.JS 16 APP — src/proxy.ts middleware gates /dashboard, /onboarding    │
│                                                                          │
│  REGIME B: PUBLIC API           │  REGIME A: DASHBOARD                   │
│  service role, RLS BYPASSED     │  anon key + user JWT, RLS ENFORCED     │
│  /api/v1/{widget,appointments,  │  Server Components + Server Actions     │
│           voice}/*              │  /api/workflows/*  /api/analytics/*     │
│  /api/hooks/[businessId]        │  /api/admin/system-status               │
│  /api/cron/* (CRON_SECRET)      │  /api/oauth/google-calendar/*           │
│                          ▼                                               │
│  src/core/  — framework-free. Imports only core/ + lib/. Never a          │
│               concrete provider; only ports + factory defaults in ctors.  │
│    services/ chat-service · prompt-builder · retrieval-query ·            │
│              lead-extractor · lead-scorer · chunker · industry-playbooks  │
│    services/scheduling/ booking-service · booking-orchestrator ·          │
│              booking-draft · availability · when-parser · timezone        │
│    services/workflows/  engine · event-bus · action-registry · store      │
│    services/crm/ · services/lifecycle/ (7) · services/analytics/ (2)      │
│    ports/ llm · embedding · knowledge · calendar · messaging ·            │
│           notification · speech · ops · voice                            │
│                          ▼                                               │
│  src/providers/ — adapters chosen by env factories                       │
│    llm/ ollama|anthropic|gemini|openai-compatible(openai,groq,mistral)    │
│    embedding/ ollama|none    knowledge/ supabase (FTS + optional vector)  │
│    calendar/ internal|google|outlook|caldav   messaging/ log|resend|      │
│    whatsapp|composite   notification/ log|resend   ops/ log               │
│    speech/ browser (CLIENT-SIDE)   voice/ vapi (UNWIRED)                  │
└──────────────────────────────────────────────────────────────────────────┘
                          ▼
  Supabase Postgres (26 tables, RLS, pgvector, gist exclusion, SKIP LOCKED)
  Supabase Auth · Supabase Storage (business-assets) · Vercel Cron ×4
  Ollama (default LLM) · Google/MS OAuth · CalDAV · Resend · WhatsApp Cloud API
```

Two authorization regimes, and the distinction dominates the security posture:

| | Regime A — Dashboard | Regime B — Public/Service |
| --- | --- | --- |
| Client | `createSupabaseServerClient()` (anon + JWT) | `getAdminClient()` (service role) |
| Tenancy enforced by | **Postgres RLS** | **Hand-written `.eq("business_id", …)` in TypeScript** |
| Missing WHERE clause yields | zero rows | **every tenant's rows** |
| Surface | Server Components, Server Actions, `/api/workflows`, `/api/analytics`, `/api/oauth` | `/api/v1/**`, `/api/hooks/*`, `/api/cron/*`, all repositories, all lifecycle services, workflow engine, CRM |

Regime B is most of the interesting code in the repository.

## 1.2 Current strengths

Ranked by how expensive they would be to rebuild:

1. **Workflow engine** (`src/core/services/workflows/`, `0009_workflows.sql`) — idempotency is a
   database constraint (`unique(workflow_id, event_id)`), not a convention; two-level retries with
   exponential backoff (`5 min × 3^(attempt-1)`, capped 6 h); dead-letter terminal state;
   resume-from-step; `FOR UPDATE SKIP LOCKED` claiming; per-step timeouts; full step-level
   execution log; timers. Zero product coupling. Audit score 8/10.
2. **Appointment engine** (`src/core/services/scheduling/`, `0008_appointments.sql`) — the
   double-booking arbiter is `EXCLUDE USING gist (staff_id, tstzrange(starts_at, ends_at))` over
   live statuses, not application logic. Calendar/messaging outages degrade instead of losing
   bookings. `BookingService` returns typed results (`{ok:false, reason:"slot_taken", alternatives}`)
   rather than throwing — already excellent tool ergonomics.
3. **Multi-tenant schema + RLS + function grants** — `business_id` on 24 of 26 tables;
   `is_business_member()` / `is_business_admin()` `SECURITY DEFINER` helpers with locked
   `search_path`; `0002_function_grants.sql` revokes `search_knowledge` and
   `match_knowledge_chunks` from `anon`/`authenticated` and sets `alter default privileges …
   revoke execute on functions from public`, closing a non-obvious PostgREST hole.
4. **Ports-and-adapters discipline** — 9 ports in `src/core/ports/`, each with an env-keyed
   factory. Services take providers as constructor parameters with factory defaults, which is why
   the test suite injects fakes without a DI container.
5. **Conversational doctrine** in `booking-orchestrator.ts` (499 LOC) — deterministic state
   outside the model (`booking_drafts`); act-then-narrate (the prompt section describes only what
   the engine actually did); regex ground truth applied *last* so it beats LLM extraction; every
   branch degrades instead of failing. This is the least replaceable asset in the repository.
6. **Error handling** — `withErrorHandling` on every route; every external dependency has an
   explicit degradation path (LLM → canned reply, retrieval → profile-only, booking →
   booking-free turn, event emit → warn). The visitor never sees a raw 5xx from an outage.
7. **Security primitives** — `src/lib/ssrf.ts` (DNS-resolving allowlist, `redirect: "manual"`,
   handles IPv4-mapped IPv6/CGNAT/link-local/metadata), `crypto.ts` (hash-then-`timingSafeEqual`),
   `oauth-state.ts`, `safe-redirect.ts`, CSP/HSTS in `next.config.ts`. All unit-tested and passing.
8. **Prompt construction** — `prompt-builder.ts` is a pure, unit-tested function carrying an
   explicit `PROMPT_VERSION = "2026-07-28.1"` logged with every turn alongside `groundingSources`
   and `historyTurns`. Diffable, attributable, A/B-able.

## 1.3 Current technical debt

| # | Debt | Evidence (verified) |
| --- | --- | --- |
| 1 | **No CI.** `.github/` does not exist. Nothing runs typecheck/lint/test/build on push. | `ls .github` → no such directory |
| 2 | **`scripts/preflight.ts` is wired into nothing.** The readiness gate exists and is never called. | `grep -n preflight package.json vercel.json` → no matches |
| 3 | **`LLMResult.usage` is captured and discarded.** All four adapters populate it; the only other reference in `src/` is the port definition. Zero cost visibility per tenant. | `grep -rn "promptTokens\|completionTokens" src/` → only `src/core/ports/llm-provider.ts:15` |
| 4 | **No LLM retry.** `src/lib/retry.ts` is used by calendar, messaging, Resend and Vapi — by no LLM adapter. A transient 429/503 costs the whole turn. | `grep -rn withRetry src/providers/llm/` → none |
| 5 | **Up to 3 LLM calls per turn**, each resending the full transcript; ~40–60% of the system prompt is invariant and re-sent every turn; no prompt caching (`cache_control` untouched in the Anthropic adapter). | `chat-service.ts`, `booking-orchestrator.ts`, `lead-extractor.ts` |
| 6 | **In-process rate limiting.** Correct sliding-window algorithm, wrong topology: `N` instances = `N ×` the limit, resets on deploy. Interface is already `async` for exactly this swap. | `src/lib/rate-limit.ts:43` `async check(...)` |
| 7 | **Workflow runs execute inline in the emitting request** via `void`-ed fire-and-forget, which serverless does not guarantee completes. Recovery is the 5-minute retry cron. | `engine.ts` `dispatch → startRun → executeRun`; `emitBusinessEvent` callers use `void … .catch()` |
| 8 | **Workflow version pinning recorded but not honoured.** `workflow_runs.workflow_version` is stored, but `processDue` re-fetches the *current* definition. | `engine.ts:103` `this.store.getWorkflow(run.workflowId)` |
| 9 | **`getNotificationProvider()` matches `"resend"` exactly**, so `MESSAGING_PROVIDER="resend+whatsapp"` silently yields log-only lead alerts. | `log-notification-provider.ts:35` |
| 10 | **No ANN index on `knowledge_chunks.embedding`.** Only `business_idx`, `document_idx`, `tsv_idx (gin)`. Vector search is a sequential scan. | `0001_init.sql:194-196` |
| 11 | **Plaintext OAuth tokens and CalDAV passwords** in `calendar_connections` (`access_token`, `refresh_token`, `basic_password` are bare `text`). Isolation is correct (RLS on, zero policies = service-role only); confidentiality at rest is not. | `0008_appointments.sql:148-161` |
| 12 | **No audit log.** No table, no `created_by`/`updated_by` on any table. No record of which user changed which configuration when. | schema-wide |
| 13 | **`messages.role` CHECK allows only `user`\|`assistant`.** No `system`, no `tool` — tool-call transcripts cannot be represented. | `0001_init.sql:302` |
| 14 | **`requireBusiness()` hard-codes one business per user** (`.limit(1).maybeSingle()`), with a code comment acknowledging it. | `src/lib/auth.ts` |
| 15 | **`GET /api/health?deep=1` is unauthenticated** and returns `readiness.errors`/`warnings` verbatim, including database error strings. Rate-limited 6/min/IP only. | `src/app/api/health/route.ts:35-56` |
| 16 | **`workflow_events`/`runs`/`logs` grow unbounded** — `purge_expired_data()` covers conversations and usage events, not automation history. | `0004_data_retention.sql` |
| 17 | **`upsertConversationLead` is read-then-write**, not atomic. Worst case: duplicate lead. Documented in `ROADMAP.md`. | `widget-repository.ts` |
| 18 | **`industry-playbooks.ts` (254 LOC, 14 playbooks) is business-specific logic living in core runtime code** — the clearest violation of the HALO principle that business knowledge belongs in configuration, knowledge, tools or adapters. | `src/core/services/industry-playbooks.ts` |

## 1.4 Current broken functionality — verified 2026-09-04

All four gates were executed against the working tree on 2026-09-04 and **all four fail**,
reproducing the audit exactly.

### TypeScript errors — 47

```
$ npx tsc --noEmit  →  47 errors
  38  tests/unit/resend-messaging.test.ts        Jest globals in a Vitest project
   3  tests/integration/multi-tenant-isolation.test.ts
   2  tests/integration/email-delivery.test.ts
   1  tests/integration/whatsapp-delivery.test.ts
   1  tests/integration/provider-failures.test.ts
   1  src/providers/messaging/whatsapp-messaging-provider.ts
   1  src/providers/messaging/composite-messaging-provider.ts
```

### ESLint errors — 49 problems (31 errors, 18 warnings)

```
$ npx eslint  →  ✖ 49 problems (31 errors, 18 warnings)
```
All 31 errors are `@typescript-eslint/no-explicit-any`, concentrated in the newest untracked code
(`voice/webhook/route.ts`, `vapi-voice-provider.ts`, `resend-messaging-provider.ts`,
`operations-analytics-service.ts`, `startup-check.ts`, 5 new test files). 18 unused-variable
warnings.

### Vitest failures — 14 files, 3 tests

```
$ npx vitest run
  Test Files  14 failed | 34 passed (48)
       Tests   3 failed | 316 passed (319)
```
- 13 files fail at **collection time** from one bad import (below), including
  `tests/integration/multi-tenant-isolation.test.ts` — **the only automated check of tenant
  isolation is not running.**
- 1 file (`tests/unit/resend-messaging.test.ts`) fails because it is written for Jest
  (`jest.fn()`, bare `describe`/`it`/`expect`/`beforeEach`) and `vitest.config.ts` sets no
  `globals: true`.
- The 3 individual test failures are all in `tests/integration/voice-webhook.test.ts`:
  `assistant-request`, `end-of-call-report`, `function-call` each `expect(500).toBe(200)`.

### Next build failure

```
$ npx next build
  Module not found: Can't resolve '@/lib/errors'
  Import map: aliased to relative './src/lib/errors' inside of [project]/
```
`src/lib/errors` **does not exist**; the correct module is `@/core/errors/app-error`. Two files
carry the typo (`whatsapp-messaging-provider.ts:3`, `composite-messaging-provider.ts:3`) and
because `messaging/factory` is imported by `workflows/event-bus`, which is imported by nearly
everything, the failure cascades into both an App Route and a Server Component:

```
whatsapp-messaging-provider → messaging/factory → workflows/event-bus
  → app/api/v1/widget/conversations/route.ts                        (App Route)
  → lifecycle/feedback-service → manage-service → app/appt/[token]/page.tsx  (Server Component)
```

**One typo, two files, and it takes down the build and 13 test files.**

### Calendar schema mismatch

Two queries select a column that does not exist:

```
src/app/api/admin/system-status/route.ts:28   .from("calendar_connections").select("id, status")
src/app/dashboard/admin/page.tsx:40           .from("calendar_connections").select("status")
```

`0008_appointments.sql:148-161` defines `calendar_connections` with columns
`id, business_id, staff_id, provider, calendar_ref, access_token, refresh_token, expires_at,
basic_username, basic_password, created_at` — **no `status`**. Supabase returns an error which
both call sites swallow into `[]`, so the admin panel silently and permanently reports zero
calendars. This is a direct consequence of item 1.3#1: no migration application in CI, no schema
drift check.

### Dead Vapi implementation

```
$ grep -rn "getVoiceProvider" src/
src/providers/voice/factory.ts:8:export function getVoiceProvider(): VoiceProvider | null {
```

**Zero callers.** The port, factory and provider are dead code in `src/`; only
`tests/unit/vapi-voice-provider.test.ts` constructs the class. Further verified defects:

- `src/core/ports/voice-provider.ts` exposes `isConfigured()`, `createAssistant()`,
  `getCallTranscript()` and **no method to place or receive a call** — disqualifying for an
  outbound product.
- `src/app/api/v1/voice/webhook/route.ts` calls `repository.createConversation(...)` at line 106
  and discards the result, then at line 217 calls `repository.appendMessages(call.id, business.id,
  …)` using Vapi's call id as a `conversations.id` UUID. `messages.conversation_id` is a FK to
  `conversations(id)`; this fails against a real database. The custom-LLM branch repeats it
  (`conversationId: callId` at line 63).
- Hard-codes `model: { provider: "openai", model: "gpt-4" }`, bypassing the LLM factory entirely.
- `emitBusinessEvent(...)` in `end-of-call-report` is called without `await` or `.catch()`, and
  mislabels a call summary as `type: "feedback.received"`.
- No call recording, no durable transcript, no structured outcome, no transfer.

### Missing webhook verification

```ts
// src/app/api/v1/voice/webhook/route.ts:33-41
const vapiSecret = env.VAPI_WEBHOOK_SECRET;
if (vapiSecret) {                                  // ← skipped entirely when unset
  const signature = request.headers.get("x-vapi-secret");
  if (!signature || !timingSafeEqualStr(signature, vapiSecret)) { … }
}
```

If `VAPI_WEBHOOK_SECRET` is unset the block never runs and the endpoint accepts unauthenticated
POSTs that can create conversations and **invoke `book_appointment`**. The tenant is resolved from
the `?key=` widget key, which is public by design (embedded in every customer's page HTML). The
cron routes get this right and fail closed on a missing `CRON_SECRET`; the voice webhook does not.

### Discarded LLM usage data

Every adapter populates `LLMResult.usage`:
`ollama-provider.ts:98`, `openai-compatible-provider.ts:71`, `gemini-provider.ts:74`
(plus the Anthropic adapter). Outside `src/core/ports/llm-provider.ts:15` there is **no reference
to `promptTokens` or `completionTokens` anywhere in `src/`** — not persisted, not logged, not
aggregated, not billed. There is zero per-tenant cost visibility, and voice minutes plus tokens
are the COGS of the product HALO is meant to be.

### English-centric retrieval

```
0001_init.sql:190  content_tsv tsvector generated always as (to_tsvector('english', content)) stored
0001_init.sql:207  content_tsv … (to_tsvector('english', question || ' ' || answer)) stored
0001_init.sql:232  with q as (select websearch_to_tsquery('english', query) as tsq)
0005_retrieval_source_attribution.sql:28  … websearch_to_tsquery('english', query) …
```

The `english` dictionary is baked into **generated columns** on `knowledge_chunks` and `faqs`,
which means changing it is a table-rewriting migration, not a config flag. Vector search is the
only escape and it is off by default:

```
env.ts:26   EMBEDDING_PROVIDER: z.enum(["ollama","openai","none"]).default("none")
0001_init.sql:188   embedding vector(768)
0005:61 / 0001:257  query_embedding vector(768)
embedding/factory.ts   case "openai": throw new Error("… requires a vector-dimension migration")
```

So for Telugu: FTS returns near-noise, vector search is opt-in and Ollama-only at a hard-coded
768 dimensions, and the OpenAI path deliberately throws. **Telugu retrieval is blocked on a schema
decision, not on a prompt.**

### English-only regex assumptions

Verified present and English-only:

| Regex | File |
| --- | --- |
| `GREETING_RE`, anaphora/short-follow-up rewrite, `INTERROGATIVE_RE` | `retrieval-query.ts:56` and surrounding |
| `LEAD_TRIGGER_RE` (`book\|booking\|appointment\|schedule\|quote\|…`) | `chat-service.ts:34` |
| `CANCEL_RE` (`cancel\|call (it )?off\|can't make\|…`) | `booking-orchestrator.ts:32` |
| `SCHEDULING_INTENT_RE`, `COMMITMENT_RE` | `booking-orchestrator.ts` |
| `LABEL_RE` (name/phone/email labels) | `booking-draft.ts:84` |
| `HIGH_INTENT_RE`, `URGENCY_RE`, `EMERGENCY_RE`, `NEAR_TIMELINE_RE`, `RETURNING_RE`, `DECISION_MAKER_RE`, `SPAM_RE`, `DISENGAGED_RE` | `lead-scorer.ts:194-201` |
| all 14 `match:` patterns | `industry-playbooks.ts` |

`EMAIL_RE` and `PHONE_RE` are script-neutral and survive. Everything else **silently never fires**
on a Telugu conversation. They do not error; they no-op, which is worse — the system appears to
work while its entire deterministic layer is switched off. Every one must be rewritten,
made language-pluggable, or deliberately removed. `when-parser.ts` (English time expressions) and
`confirmation-content.ts` (fixed English copy) are in the same category.

### Missing phone voice runtime

Verified: there is no server-side speech anywhere. `src/providers/speech/browser-speech-provider.ts`
runs `SpeechRecognition` / `speechSynthesis` **in the visitor's browser**. No audio reaches this
codebase at any point. The server sees a final transcript string arriving as an ordinary
`POST /api/v1/widget/messages`.

### Missing real-time telephony architecture

Of the nine stages of a phone-agent pipeline, seven do not exist in any form:

```text
TARGET                       CURRENT
PSTN                         ✗ nothing
Telephony provider           ~ adapter shell, unwired, no dial in/out
Streaming audio (WS)         ✗ nothing — no WebSocket, no media handling, no buffers
VAD / endpointing            ✗ nothing — endpointing is the browser's, opaque, untunable
Streaming STT                ✗ nothing server-side
HALO Agent Runtime           ~ ChatService exists, wrong shape (blocking, no tools, no streaming)
LLM                          ✓ port + 4 adapters — reusable, needs stream()
Streaming TTS                ✗ nothing server-side
PSTN egress                  ✗ nothing
```

Also verified absent: any SSE, `ReadableStream`, WebSocket or Supabase Realtime subscription in
`src/` or `widget/`. `LLMProvider` has no `stream()` and no `tools` (full port reproduced below).

```ts
// src/core/ports/llm-provider.ts — the complete interface, verified
export interface LLMProvider {
  readonly name: string;
  complete(systemPrompt: string, messages: ChatMessage[], options?: LLMCompletionOptions): Promise<LLMResult>;
  isHealthy(): Promise<boolean>;
}
```

## 1.5 Reusable components

| Component | Path | Why it survives |
| --- | --- | --- |
| Workflow engine + store + registry + templates | `src/core/services/workflows/`, `0009_workflows.sql` | Zero product coupling; DB-enforced idempotency; correct retry/DLQ/resume semantics |
| Scheduling primitives | `scheduling/{availability,when-parser,timezone,appointment-state}.ts` | Pure functions, heavily tested; a solar site visit *is* an appointment |
| Double-booking constraint | `0008_appointments.sql` gist exclusion | The race arbiter is Postgres, not code. Rare and correct |
| 9 provider ports | `src/core/ports/*.ts` | Already HALO's exact shape |
| Calendar adapters + `token-source.ts` | `src/providers/calendar/` | Single-flight OAuth refresh with rotation persistence is subtle and correct |
| CRM | `src/core/services/crm/`, `customers`+`customer_timeline` | Zero-config, event-driven, dedupe/merge/forward-only stages |
| Lifecycle (7 services) | `src/core/services/lifecycle/` | Capability-token (`manage_token`) self-service is reusable for any post-interaction flow |
| Knowledge primitives | `chunker.ts`, `retrieval-query.ts`, RRF fusion | Textbook-correct RRF (k=60), well-tested chunker |
| Platform utilities | `src/lib/{ssrf,crypto,oauth-state,safe-redirect,retry,logger,rate-limit,ics,env}.ts` | All correct, all tested |
| Tenancy foundation | `0001_init.sql`, `0002_function_grants.sql` | Correct and already hardened against the PostgREST RPC trap |
| Voice state machine | `widget/src/voice-session.ts` (318 LOC + 440 LOC tests) | DOM-free, provider-agnostic; silence budget, watchdog, generation-counter invalidation, fatal-vs-transient error taxonomy are all transport-independent |
| API conventions | `src/lib/api/respond.ts`, `core/errors/app-error.ts` | Small, correct, consistently applied |
| Booking orchestrator doctrine | `booking-orchestrator.ts`, `booking-draft.ts` | The single most valuable *idea* in the repo |

## 1.6 Components requiring refactoring vs replacement

**Refactor** (valuable, wrong shape): `chat-service.ts` → streaming tool-calling agent loop ·
`prompt-builder.ts` → agent-version templates (keep the pure/versioned/tested architecture,
move the content to data) · `booking-orchestrator.ts`/`booking-draft.ts` → generalized
schema-driven slot filling · `lead-extractor.ts`/`lead-scorer.ts` → configurable outcome
extraction · all 4 LLM adapters → add `stream()`, tools, retry, cache hints ·
`supabase-knowledge-provider.ts` + FTS/vector schema → multilingual, dimension-flexible, ANN
indexed · `action-registry.ts` → unified tool registry with schemas and safety classes ·
`src/features/*` → agent dimension throughout · `event-bus.ts` `syncCrm` switch → a subscriber.

**Replace** (architecture unsuitable): `src/providers/voice/*` + `core/ports/voice-provider.ts` +
`/api/v1/voice/webhook` (no dial method, unwired, FK-violating, optionally unauthenticated) ·
`receptionists`-as-agent-model → `agents` + `agent_versions` · cron-as-queue for anything
latency-sensitive → durable queue (keep the worker logic) · `rate-limit.ts` *implementation* →
Redis (the async interface stays) · `EMBEDDING_PROVIDER` + `vector(768)` storage strategy.

**Move out of core entirely:** `industry-playbooks.ts` → agent configuration/knowledge.

## 1.7 Verification log

| Claim | Command | Result |
| --- | --- | --- |
| TS errors | `npx tsc --noEmit` | 47 errors — matches audit |
| Lint | `npx eslint` | 49 problems (31 errors, 18 warnings) — matches audit |
| Tests | `npx vitest run` | 14/48 files failed, 3/319 tests failed, 316 passed — matches audit |
| Build | `npx next build` | `Module not found: Can't resolve '@/lib/errors'` — matches audit |
| `src/lib/errors` exists? | `ls src/lib/errors*` | No such file. `src/core/errors/app-error.ts` exists |
| `calendar_connections.status` | `sed -n '148,161p' 0008_appointments.sql` | Column absent — confirmed |
| Vapi wired? | `grep -rn getVoiceProvider src/` | 1 hit: its own definition. Confirmed dead |
| Usage persisted? | `grep -rn "promptTokens\|completionTokens" src/` | 1 hit: the port. Confirmed discarded |
| English FTS | `grep -rn "to_tsvector\|websearch_to_tsquery" supabase/migrations/` | 4 hits, all `'english'` |
| Vector dim | `grep -rn "vector(" supabase/migrations/` | 3 hits, all `vector(768)` |
| ANN index | `grep -rn "ivfflat\|hnsw" supabase/migrations/` | none |
| CI | `ls .github` | No such directory |
| Preflight wired | `grep -n preflight package.json vercel.json` | No matches |
| `messages.role` | `0001_init.sql:302` | `check (role in ('user','assistant'))` |
| One business per user | `src/lib/auth.ts` | `.limit(1).maybeSingle()` + acknowledging comment |
| Migrations / tables | `ls supabase/migrations` / `grep -c "^create table"` | 12 files, 26 tables — matches audit |
| Playbooks | `grep -n 'id: "' industry-playbooks.ts` | 14, none solar-related |
| Arunodhaya docs | `grep -rli "arunodhaya\|solar" docs/ src/` | Only `CURRENT_STATE_AUDIT.md` |
| Branches | `git branch -a` | `main` only, plus `origin/main` |

## 1.8 Discrepancies found against the audit

Three, all minor. None changes a conclusion; recorded because Critical Rule 18 requires it.

1. **Dashboard page count.** The audit says "15 dashboard pages" (§A, §13). `find src/app/dashboard
   -name page.tsx` returns **18**: admin, analytics, appointments, automations,
   conversations, conversations/[id], customers, customers/[id], faqs, install, knowledge, leads,
   operations, (root), profile, receptionist, settings, settings/lifecycle. Plan uses 18.
2. **`docs/TESTING.md` is stale.** It states "229 tests across 27 files"; the suite is 319 tests
   across 48 files. The audit correctly used the executed numbers; the doc was never updated.
   Add doc-freshness to the Phase 0 definition of done.
3. **`docs/ROADMAP.md` predates the audit's findings** and still lists "Twilio MessagingProvider"
   as item 1 while untracked Resend/WhatsApp adapters now exist in the working tree (broken).
   Not a contradiction of the audit — a stale doc. Reconciled in Phase 0.

Everything else in the audit that this plan depends on was reproduced exactly.

## 1.9 Capabilities HALO does not currently have

```text
✗ Agent model (agents, agent types, versions, per-agent model/tools/knowledge/guardrails)
✗ Agent runtime loop (observe → decide → act → observe; multi-step; interruptible)
✗ LLM streaming            ✗ LLM tool/function calling      ✗ Prompt caching
✗ Tool registry, schemas, per-agent grants, safety classes, tool audit log
✗ Channel abstraction (one runtime serving web + phone + WhatsApp)
✗ Telephony (PSTN in/out, numbers, DTMF, transfer, voicemail detection)
✗ Streaming media loop     ✗ Server-side VAD               ✗ Barge-in
✗ Server-side streaming STT                                ✗ Server-side streaming TTS
✗ calls / call_events / recordings / transcripts / structured outcomes
✗ Outbound campaign engine (lists, pacing, retry, call windows, DNC/TRAI)
✗ Human handoff / warm transfer
✗ Multilingual retrieval (Telugu), language detection, code-switch handling, transliteration
✗ Per-tenant token + minute + cost accounting and quotas
✗ Conversation memory beyond a 16-message window (no summarization, no cross-conversation recall)
✗ Evaluation harness (golden transcripts, LLM judge, regression on PROMPT_VERSION)
✗ Audit log                ✗ Durable queue                 ✗ CI pipeline
✗ Per-tenant provider credentials (Resend sender, WhatsApp number, LLM key are deployment-global)
✗ SMS adapter              ✗ WhatsApp template messages    ✗ E2E and DB (RLS) tests
```

---

# 2. Target HALO Architecture

## 2.1 Shape

**A modular monolith with exactly one process separation.**

The audit classified the current system as a modular monolith with a real, enforced dependency
rule (`src/core/` imports only `src/core/` and `src/lib/`, never a concrete provider). That
classification stands and the target preserves it. There is no independent scaling axis, no team
boundary, and no polyglot need — with **one** exception: the voice media loop is a stateful,
minutes-long, latency-critical bidirectional audio session, which is a *runtime profile* mismatch
with serverless request/response. That justifies `services/voice-gateway` as a separate process,
**not** a decomposition of the domain. No other service split is proposed anywhere in this plan.

## 2.2 Target architecture, adapted to this repository

```text
                                  HALO PLATFORM
                                        │
                ┌───────────────────────┴───────────────────────┐
                │                                               │
          CONTROL PLANE                                  EXECUTION PLANE
    (Next.js app: apps/console + apps/receptionist)   (packages/agent-runtime + tools
                │                                      + workflows, in the same deployable)
    Tenant mgmt      ← businesses/business_members/    Agent Runtime   ← REFACTOR chat-service
                       business_settings  KEEP         Conversations   ← conversations/messages
    Agent mgmt       ← BUILD NEW: agents,              Reasoning       ← LLM port + stream + tools
                       agent_versions                  Tool Execution  ← REFACTOR action-registry
    Knowledge        ← knowledge_documents/chunks/      Workflow Exec   ← KEEP workflow engine
                       faqs  REFACTOR (multilingual)                      (behind a durable queue)
    Integrations     ← 9 ports + factories  KEEP
    Configuration    ← receptionists → agent_versions
    Analytics        ← usage_events  KEEP + extend
                │                                               │
                └───────────────────────┬───────────────────────┘
                                        │
                              CHANNEL ABSTRACTION
                    (packages/channels — BUILD NEW, thin)
                                        │
            ┌───────────────────────────┼───────────────────────────┐
            │                           │                           │
           WEB                        PHONE                     MESSAGING
   widget/ + /api/v1/widget   services/voice-gateway      WhatsApp / SMS / Email
      KEEP, add SSE            BUILD NEW (only process       providers/messaging
            │                   separation in this plan)      KEEP + fix + extend
            │                           │
            │                   Telephony provider (BUY)
            │                           │
            │                   Streaming audio (WS, μ-law/PCM 8 kHz)
            │                           │
            │                   VAD → endpointing → barge-in
            │                           │
            │                   Streaming STT / Streaming TTS
            │                           │
            └───────────────────────────┼───────────────────────────┘
                                        │
                                  AGENT RUNTIME
                     (channel-independent — the same intelligence
                      serves a web chat turn and a phone call turn)
                                        │
                ┌───────────────────────┼───────────────────────┐
                │                       │                       │
            KNOWLEDGE                 TOOLS                  WORKFLOWS
    packages/knowledge          packages/tools          packages/workflows
    chunker · retrieval-query   ONE registry serving     engine · store · timers
    · RRF · multilingual        BOTH workflow steps      KEEP semantics,
      REFACTOR                  AND LLM tool calls       add durable queue
                                  REFACTOR
                │                       │                       │
                └───────────────────────┼───────────────────────┘
                                        │
                                BUSINESS ADAPTERS
                ┌───────────────────────┼───────────────────────┐
               CRM                  Calendar                Messaging
      packages/crm  KEEP    providers/calendar KEEP   providers/messaging KEEP+FIX
      + packages/lifecycle  (google/outlook/caldav/    (log/resend/whatsapp/composite,
        KEEP                 internal + token-source)   + SMS BUILD NEW)
                                        │
                                  DATA PLANE
              Supabase Postgres · RLS on every table · pgvector ·
              EXCLUDE gist (bookings) · unique(workflow,event) (idempotency) ·
              SKIP LOCKED claiming · Supabase Storage (recordings, private)
```

## 2.3 Target repository layout

Derived from the audit's §16 and reconciled with what actually exists. Every `←` names a real path.

```text
halo/                                     ← same git repository, history preserved via git mv
├── package.json                          ← npm workspaces (npm is already the package manager)
├── apps/
│   ├── receptionist/                     ← src/app + src/features + src/components + widget/
│   ├── console/                          ← NEW, grows out of apps/receptionist/dashboard
│   └── arunodhaya/                       ← NEW, thin: config + knowledge + prompts + 1–2 tools
├── packages/
│   ├── core/                             ← src/core/domain + src/core/errors
│   ├── ports/                            ← src/core/ports (9; extend LLM+Speech, replace voice)
│   ├── providers/{llm,embedding,knowledge,calendar,messaging,notification,ops,speech,telephony}
│   ├── agent-runtime/                    ← REFACTOR chat-service + prompt-builder + extraction
│   │                                       + generalized slot-filling (from booking-draft)
│   ├── voice-runtime/                    ← PORT of widget/src/voice-session.ts + NEW vad/stt/tts
│   ├── channels/                         ← NEW, thin: web · phone · whatsapp adapters
│   ├── knowledge/                        ← chunker · retrieval-query · RRF + multilingual
│   ├── tools/                            ← UNIFIED registry (grows from action-registry.ts)
│   ├── workflows/                        ← src/core/services/workflows (highest-value lift)
│   ├── scheduling/  crm/  lifecycle/  analytics/   ← src/core/services/* moved
│   ├── tenancy/                          ← src/lib/auth.ts + src/proxy.ts + supabase clients
│   └── platform/                         ← src/lib/* (rate-limit impl → Redis)
├── services/
│   └── voice-gateway/                    ← NEW. The only process separation.
├── database/migrations/                  ← supabase/migrations 0001–0012 UNCHANGED + 0013…
├── infrastructure/{ci,vercel,voice-gateway}/
├── tests/{unit,integration,e2e,db,evals}/
└── docs/
```

## 2.4 Architectural invariants (non-negotiable)

1. **HALO Core is business-agnostic.** No `packages/*` file may reference solar, Arunodhaya,
   OpsCorp, or any named industry. `industry-playbooks.ts` leaves core in Phase 1.
2. **Dependency direction.** `packages/*` must never import from `apps/*` or `services/*`.
   `packages/core` and `packages/ports` import nothing but each other and `packages/platform`.
   Enforced by an ESLint `no-restricted-imports` rule in CI, not by convention.
3. **Every new table ships RLS policies in the same migration.** No exceptions, no follow-ups.
4. **Invariants live in Postgres.** Anything that must never be violated under concurrency gets a
   constraint (as booking and workflow idempotency already do), not application logic.
5. **Act-then-narrate.** The runtime states only what a tool actually returned. Never a prompt
   instruction where a structural guarantee is available.
6. **Deterministic state lives outside the model.** Slot-filling, drafts, and outcomes are rows.
7. **The LLM never executes arbitrary code and never chooses an unbounded destination.**
   No model-chosen webhook URLs, no model-chosen message recipients.
8. **One agent runtime, many channels.** A phone turn and a web turn differ only in the channel
   adapter and the response *shape* (audio chunks vs SSE tokens) — never in the intelligence.
9. **No new microservice** without a demonstrated runtime-profile mismatch. Today exactly one
   qualifies.
10. **`OpsProvider` stays abstract.** Core knows "create a back-office record", never OpsCorp.

---

# 3. Migration Strategy — Executing "Extract into HALO Core"

## 3.1 What extraction means here, concretely

The audit's central observation is that **the seam already exists**: `src/core/` never imports a
concrete provider, services take providers as constructor parameters with factory defaults, and
that is exactly why the test suite injects fakes without a DI container. Extraction is therefore
*moving files and adding an agent dimension*, not a redesign.

Three rules govern Phase 1 and prevent the classic extraction failure:

- **Move, do not improve.** A file changes its path and its import specifiers. Nothing else.
  Every "while I'm in here" is a separate, later PR.
- **The receptionist stays green after every PR.** It is the regression harness. A red suite
  means the extraction stops, not that the suite gets skipped.
- **Timebox.** If a module resists extraction, leave it in `apps/receptionist` and revisit in a
  later phase. A stranded module is cheaper than a stalled phase.

The AI Receptionist is **not** discarded. It becomes `apps/receptionist`, HALO's first tenant
application, for three reasons: it is the regression harness for Core; it is a structurally
opposite second agent type (inbound / web / English / chat) that stops the agent model being
fitted to Arunodhaya alone; and it is commercially shippable once the build is fixed.

**Freeze receptionist feature development for the duration of Phase 1. Bug fixes only.**

## 3.2 Component migration register

Effort key: **S** ≈ 1–3 days · **M** ≈ 1–2 weeks · **L** ≈ 3–5 weeks · **XL** ≈ 6+ weeks.
Risk is the risk of *this migration action*, not of the component.

### KEEP — minimal change

| Component | Current location | Current responsibility | HALO responsibility | Action | Dependencies | Risk | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Workflow engine | `src/core/services/workflows/{engine,types,interpolate,supabase-workflow-store,templates}.ts` | Executes tenant workflows off business events | HALO Workflow Engine, unchanged semantics | `git mv` → `packages/workflows`; queue + version-pinning fix deferred to Phase 7 | Phase 0 | Low | S |
| Workflow schema | `supabase/migrations/0009_workflows.sql` | Persistence + `SKIP LOCKED` claim fns | Same | Move file path only; **do not edit** | — | Low | S |
| Booking constraint | `0008_appointments.sql` gist exclusion | Race arbiter for double-booking | Same | Move file path only; **do not edit** | — | Low | S |
| Scheduling primitives | `scheduling/{availability,when-parser,timezone,appointment-state}.ts` | Slot generation, NL time parsing, tz math, state machine | HALO scheduling primitives, exposed as tools | Move; `when-parser` gains a language dimension in Phase 3 | Phase 0 | Low | S |
| 9 provider ports | `src/core/ports/*.ts` | Interface definitions | HALO provider contracts | Move verbatim (`voice-provider.ts` excepted — see REPLACE) | Phase 0 | Low | S |
| Calendar adapters | `src/providers/calendar/*` + `token-source.ts` | Google/Outlook/CalDAV/internal | Same | Move | Phase 0 | Low | S |
| CRM | `src/core/services/crm/`, `supabase-crm-store.ts` | Dedupe, merge, stages, revenue | HALO CRM Core | Move; per-agent outcome schema added in Phase 2 | Phase 0 | Low | S |
| Lifecycle (7 services) | `src/core/services/lifecycle/` | Confirmations, reminders, manage tokens, intake, feedback, no-show sweep | HALO Customer Lifecycle | Move; copy templating in Phase 3 | Phase 0 | Low | S |
| Platform utilities | `src/lib/{ssrf,crypto,oauth-state,safe-redirect,retry,logger,ics,env}.ts` | Security + utility primitives | HALO platform | Move verbatim | Phase 0 | Low | S |
| Tenancy schema | `0001_init.sql`, `0002_function_grants.sql` | Tenants, membership, RLS helpers, grant hardening | HALO Tenant Layer | Move file paths only; **do not edit** | — | Low | S |
| API conventions | `src/lib/api/respond.ts`, `core/errors/app-error.ts` | Envelope + error mapping | HALO API conventions | Move verbatim | Phase 0 | Low | S |
| Knowledge primitives | `chunker.ts`, `retrieval-query.ts`, RRF fusion | Chunking, query rewrite, rank fusion | HALO knowledge primitives | Move; multilingual work is Phase 3 | Phase 0 | Low | S |
| Widget bundle | `widget/`, `scripts/build-widget.mjs` | Embeddable chat widget | HALO Web Channel | Move into `apps/receptionist/widget` | Phase 0 | Low | S |

### REFACTOR — improve abstraction, preserve behaviour

| Component | Current location | Current responsibility | HALO responsibility | Action | Dependencies | Risk | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ChatService` | `src/core/services/chat-service.ts` (218 LOC) | One blocking turn: retrieve → prompt → complete → persist → capture | Channel-independent streaming, tool-calling agent loop | Rewrite the loop; keep the sequence and every degradation path | Phases 1, 2 | **High** | L |
| `prompt-builder.ts` | `src/core/services/` (187 LOC) | Builds the receptionist system prompt | Agent-version-driven prompt composition | Keep pure/versioned/tested architecture; move *content* into `agent_versions` rows | Phase 1 | Medium | M |
| `booking-orchestrator.ts` + `booking-draft.ts` | `scheduling/` (499 + LOC) | Bridges conversation ↔ booking engine via draft state | Generalized schema-driven slot filling / tool mediation | Generalize `BookingDraft`'s fixed fields to a configured JSON Schema; preserve merge order (deterministic last) | Phase 2 | **High** | M |
| `lead-extractor.ts` + `lead-scorer.ts` | `src/core/services/` | Extract + score a lead, 4 fixed fields | Configurable structured outcome extraction | Keep the hybrid regex-beats-LLM pattern; make schema + phrase lists per-agent and per-language | Phases 2, 3 | Medium | M |
| 4 LLM adapters | `src/providers/llm/*` | Non-streaming completion | HALO Model Runtime | Extend the port (`stream`, `tools`, tool messages, cache hints, retry); adapters gain methods, none is rewritten | Phase 2 | Medium | M |
| Knowledge provider + FTS/vector schema | `providers/knowledge/`, `0001`, `0005` | Hybrid FTS+vector, RRF | Multilingual, dimension-flexible, ANN-indexed retrieval | Keep RRF and graceful degradation; replace the storage/config strategy | Phase 3 | **High** | M |
| `action-registry.ts` | `workflows/` (11 actions) | Workflow step executors | ONE registry serving workflow steps AND LLM tool calls | Add JSON Schema, side-effect class, per-agent grants; executor signature already `(params, ctx) => detail` | Phase 6 | Medium | M |
| `event-bus.ts` `syncCrm` | `workflows/event-bus.ts` | Inline CRM sync switch | A subscriber among several | Extract the switch to a subscriber; keep the never-throws front door | Phase 7 | Low | S |
| Dashboard slices | `src/features/*` (9), `src/app/dashboard` (18 pages) | Receptionist dashboard | HALO Control Plane | Thread the agent dimension through | Phase 1 | Medium | L |
| `requireBusiness()` | `src/lib/auth.ts` | Resolves one business per user | `requireTenant()` returning tenant + agent context | Remove `.limit(1)`, add selector | Phase 1 | Medium | S |
| Analytics services | `src/core/services/analytics/` | Metric computation over `usage_events` | HALO Analytics | Keep event-stream + pure-computation split; fix `calendar_connections.status`; add voice + cost metrics | Phases 0, 10 | Low | M |

### WRAP — abstraction around an intact implementation

| Component | Current location | Current responsibility | HALO responsibility | Action | Dependencies | Risk | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BookingService` | `scheduling/booking-service.ts` | Availability, book, reschedule, cancel + confirmations + events | Four HALO tools | Wrap with JSON Schema + idempotency key + safety class. **Do not touch the internals** — typed results are already good tool ergonomics | Phase 6 | Low | S |
| `emitBusinessEvent` | `workflows/event-bus.ts` | Event front door | HALO Event Bus behind a durable queue | Wrap; enqueue instead of executing inline | Phase 7 | Medium | M |
| Messaging providers | `src/providers/messaging/*` | Email/WhatsApp/log delivery | HALO Messaging service | Wrap; add per-tenant credentials, SMS, WhatsApp templates, delivery status | Phase 0 (fix), 6 | Low | M |
| `usage_events` + analytics | `0001`/`0007`–`0010`, `analytics/` | Product telemetry | HALO Analytics + cost | Wrap; extend `event_type` CHECK for agent/call events | Phase 10 | Low | S |
| Widget | `widget/` | Embeddable chat | Web channel adapter | Wrap behind `packages/channels/web` | Phase 2 | Low | S |
| Browser speech | `providers/speech/browser-speech-provider.ts` | Client-side STT/TTS | **Web channel only.** Never the voice runtime | Wrap; explicitly out of the phone path | Phase 4 | Low | S |

### REPLACE — remove eventually

| Component | Current location | Why replaced | Replacement | Dependencies | Risk | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| Vapi voice stack | `providers/voice/*`, `core/ports/voice-provider.ts`, `app/api/v1/voice/*` | Port has no method to place or receive a call; unwired; uses `call.id` as a `conversations.id` UUID (FK violation); optional signature check; hard-codes `openai/gpt-4`; 3 failing tests | `packages/ports/telephony-provider.ts` + `packages/providers/telephony/*` + `services/voice-gateway` | Phase 4 GO | **High** | L |
| `receptionists` as the agent model | `0001_init.sql` | One flat row: one persona, one channel, no type, no model config, no tools, no version | `agents` + `agent_versions` (+ compatibility view) | Phase 1 | Medium | M |
| `vector(768)` + `EMBEDDING_PROVIDER` strategy | `0001:188`, `0005:61`, `embedding/factory.ts` | Dimension hard-coded in schema; OpenAI path deliberately throws; no ANN index | Model-tagged embedding table, ANN indexed | Phase 3 | **High** | M |
| `to_tsvector('english')` generated columns | `0001:190`, `0001:207` | English dictionary baked into generated columns; returns near-noise for Telugu | Per-collection FTS config + trigram + vector-primary retrieval | Phase 3 | **High** | M |
| `rate-limit.ts` implementation | `src/lib/rate-limit.ts` | Per-process state cannot enforce a shared limit | Redis/Upstash adapter behind the **unchanged** async interface | Phase 11 | Low | S |
| Cron-as-queue for latency-sensitive work | `vercel.json`, `api/cron/*`, inline `executeRun` | 5-min granularity, global batches, `void`-ed promises on serverless | Durable queue; **keep the worker logic verbatim** | Phase 7 | Medium | M |
| `industry-playbooks.ts` | `src/core/services/` | Business-specific logic in core runtime code | Agent configuration + knowledge content | Phase 1 | Low | S |

### BUILD NEW

| Capability | HALO responsibility | Dependencies | Risk | Effort |
| --- | --- | --- | --- | --- |
| `agents` + `agent_versions` + config resolver | The agent spine | Phase 1 | Medium | M |
| `tools` + `agent_tools` + safety policy engine | Tool Runtime | Phase 2 | **High** (LLM-invoked side effects) | M |
| LLM `stream()` + tool-calling across 4 adapters | Reasoning | Phase 1 | Medium | M |
| Agent loop (observe → decide → act → observe, interruptible) | Agent Runtime | Phase 1 | **High** | L |
| Memory: rolling summarization + cross-conversation recall | Agent Runtime | Phase 2 | Medium | M |
| Multilingual retrieval (Telugu + code-switch) | Knowledge | Phase 1 | **High** | M |
| Language detection + per-language heuristics registry | Agent Runtime | Phase 3 | Medium | S |
| `services/voice-gateway` (media loop, VAD, barge-in) | Voice Runtime | Phase 4 GO | **Highest** | L–XL |
| Streaming STT + TTS adapters (Telugu) | Voice Runtime | Phase 4 GO | **High** | M |
| `telephony-provider` port + adapter | Telephony | Phase 4 GO | High | M |
| `calls`, `call_events`, recordings, `conversation_outcomes` | Call data model | Phase 5 | Medium | M |
| Outbound campaign engine (lists, pacing, windows, DNC/TRAI) | Campaigns | Phase 5 | High (regulatory) | M–L |
| Human handoff / warm transfer | Escalation | Phase 5 | Medium | M |
| Per-tenant token + minute + cost accounting, quotas | Observability | Phase 2 | Low | M |
| Audit log | Security | Phase 11 | Low | S |
| Durable queue | Workflows | Phase 7 | Medium | M |
| CI pipeline | Everything | Phase 0 | Low | S |
| Eval harness (golden transcripts, LLM judge, Telugu set) | Testing | Phase 3 | Medium | M |
| E2E (Playwright) + DB/RLS tests | Testing | Phase 0/12 | Low | M |
| SMS adapter, WhatsApp templates, per-tenant credentials | Messaging | Phase 6 | Low | M |

## 3.3 Phase numbering: this plan vs the audit

The audit's §17 development plan used its own 0–7 numbering. This document uses the HALO plan's
0–12. They are the same work, differently sliced — the mapping is recorded so neither document has
to be re-read to follow the other.

| Audit phase (§17) | This plan | Difference |
| --- | --- | --- |
| 0 — Baseline (+ voice spike in parallel) | **Phase 0** (stabilize) + **Phase 4** (voice spike) | The spike is promoted to its own numbered GO/NO-GO gate, because a NO-GO changes the architecture and deserves an explicit decision point rather than a parallel task |
| 1 — Extract Core | **Phase 1a** | Unchanged |
| 2 — Agent Layer | **Phase 1b** | Merged into Phase 1 so the extraction and the agent model land as one milestone (M1) |
| 3 — Agent Runtime | **Phase 2** | Unchanged. Cost capture is pulled in here (audit put it in 7) |
| 4 — Voice / Telephony | **Phase 5** | Unchanged, but gated on Phase 4 and with compliance moved in from audit phase 7 |
| 5 — Arunodhaya Agent | **Phase 3** (multilingual) + **Phase 8** (the agent) | **The one substantive re-ordering.** The audit folded Telugu retrieval into the Arunodhaya phase; this plan pulls it forward to its own phase because it is a schema decision (`vector(768)`, `to_tsvector('english')` in generated columns) that must be made before, not during, agent construction |
| 6 — Control Plane | **Phase 9** | Unchanged, still after Arunodhaya |
| 7 — Production Hardening | **Phases 10, 11, 12** | Split into cost/observability, security, and testing so each has its own acceptance criteria |
| *(implicit in the audit)* | **Phase 6** (tools), **Phase 7** (workflow integration) | Given explicit phases because the tool safety classification is a gating design decision, not a sub-task |

---

# Phase 0 — Stabilize the Existing Product

**Goal:** a known-good, gated baseline. Nothing else in this plan may start until Phase 0's
definition of done passes in CI.
**Branch prefix:** `stabilization/*`
**Effort:** **S** — 4–6 engineering days, of which the decision track (§P0.4) runs in parallel.

## P0.1 Verified issues to fix

Each row was validated against the repository on 2026-09-04 (§1.7). Items the audit mentioned that
did **not** survive validation are listed in §P0.2 with the reason.

| # | Issue | Files | Fix | Verifies |
| --- | --- | --- | --- | --- |
| 1 | `AppError` import path — breaks the build and 13 test files | `src/providers/messaging/whatsapp-messaging-provider.ts:3`, `composite-messaging-provider.ts:3` | `@/lib/errors` → `@/core/errors/app-error` | `next build`, 13 test files collect |
| 2 | Jest test file in a Vitest project | `tests/unit/resend-messaging.test.ts` | Rewrite to Vitest (`import { describe, it, expect, beforeEach, vi } from "vitest"`, `jest.fn()` → `vi.fn()`, `jest.Mock` → `Mock`). Do **not** set `globals: true` — explicit imports are the existing convention across the other 47 files | 38 TS errors, 1 test file |
| 3 | `calendar_connections.status` does not exist | `src/app/api/admin/system-status/route.ts:28`, `src/app/dashboard/admin/page.tsx:40` | Select real columns (`id, provider, business_id`) and report counts by `provider`. **Decide, don't guess:** either drop the status concept or add a `status` column in a migration — this plan recommends dropping it, since nothing else references it | Admin panel shows real calendar counts |
| 4 | Voice webhook accepts unauthenticated POSTs when `VAPI_WEBHOOK_SECRET` is unset | `src/app/api/v1/voice/webhook/route.ts:33-41` | **Fail closed**, matching the cron routes: no secret configured ⇒ 503 and the route is disabled. Never `if (secret) { verify }` | New test: unset secret ⇒ 503 |
| 5 | Voice webhook uses a Vapi `call.id` as a `conversations.id` UUID | same file, lines 63, 149, 217 | See §P0.3 — **remove**, do not repair | `voice-webhook.test.ts` deleted with the route |
| 6 | 31 `no-explicit-any` lint errors + 18 unused-var warnings | `voice/webhook/route.ts`, `vapi-voice-provider.ts`, `resend-messaging-provider.ts`, `operations-analytics-service.ts`, `startup-check.ts`, 5 test files | Type them. Where a third-party payload is genuinely unknown, parse it with Zod at the boundary rather than casting — this is the existing convention | `eslint` → 0 problems |
| 7 | Type errors in new tests | `email-delivery.test.ts` (missing `contentType`), `whatsapp-delivery.test.ts` + `email-delivery.test.ts` (`callArgs` possibly undefined), `provider-failures.test.ts` (`messagingProvider` absent from harness type), `multi-tenant-isolation.test.ts` (`ManageService` not exported; `crm`/`workflow` absent from harness) | Extend `tests/mocks/in-memory-scheduling.ts` to export what the tests need; fix the assertions | `tsc` → 0 errors |
| 8 | `getNotificationProvider()` matches `"resend"` exactly | `src/providers/notification/log-notification-provider.ts:35` | `env.MESSAGING_PROVIDER.includes("resend")` | New unit test for all 4 enum values |
| 9 | `/api/health?deep=1` leaks readiness error strings anonymously | `src/app/api/health/route.ts:35-56` | Require `CRON_SECRET` (or a new `ADMIN_PROBE_SECRET`) for `deep=1`; unauthenticated callers get `{status}` only. Keep shallow liveness public | New route test |
| 10 | `scripts/preflight.ts` wired into nothing | `package.json` | Add `"preflight": "tsx scripts/preflight.ts"` and call it in the CI deploy gate | CI job runs it |
| 11 | No CI | `.github/workflows/ci.yml` (new) | See §P0.5 | Every push gated |
| 12 | `docs/TESTING.md` and `docs/ROADMAP.md` are stale (§1.8) | `docs/` | Update counts and shipped/not-shipped status | Doc review |

## P0.2 Audit items deliberately NOT actioned in Phase 0

Critical Rule: validate each, do not blindly implement.

| Audit item | Decision | Why |
| --- | --- | --- |
| "Add webhook signature verification" | **Partially.** Fail-closed the Vapi webhook (P0.1#4), then delete the route (P0.3). The inbound `/api/hooks/[businessId]` already verifies a per-tenant secret with `timingSafeEqualStr` and rejects when the secret is empty — verified correct, no change | Fixing what is already correct is churn |
| "Fix in-memory rate limiting" | **Deferred to Phase 11.** | Requires Redis infrastructure. The interface is already async for this swap; single-instance pilot is safe |
| "Encrypt `calendar_connections` credentials" | **Deferred to Phase 11.** | Needs a KMS decision and a data migration; isolation (service-role only) is already correct |
| "Add an audit log" | **Deferred to Phase 11.** | New table + call sites across the app; not a stabilization item |
| "Move workflow execution behind a queue" | **Deferred to Phase 7.** | Infrastructure choice; the 5-minute retry path currently recovers |
| "Honour `workflow_version` on retry" | **Deferred to Phase 7.** | Real bug (`engine.ts:103`), but it changes execution semantics and needs its own tests. Not a build-unblocker |
| "Preserve working appointment constraints" | **Verified, no change.** `EXCLUDE USING gist` in `0008_appointments.sql` and `unique(workflow_id, event_id)` in `0009_workflows.sql` are correct and must not be touched in any phase | Rule 7 |

## P0.3 The Vapi decision: remove, do not repair

The audit offers "fix or remove". **Remove**, for four reasons that were each verified:

1. `getVoiceProvider()` has **zero callers in `src/`** — deleting it removes no capability.
2. The `VoiceProvider` port has **no method to place or receive a call**, so it cannot express
   Arunodhaya's core requirement no matter how the webhook is repaired.
3. The webhook's conversation-identity bug is not a typo: it discards a created conversation and
   then passes a Vapi call id where a `conversations.id` FK is required, in two separate branches.
   Repairing it means designing the call↔conversation model — which is Phase 5 work.
4. Keeping a half-wired, LLM-factory-bypassing, optionally-unauthenticated webhook in the tree is
   a live security surface for zero benefit.

**Action:** delete `src/providers/voice/`, `src/core/ports/voice-provider.ts`,
`src/app/api/v1/voice/`, `tests/unit/vapi-voice-provider.test.ts`,
`tests/integration/voice-webhook.test.ts`, and the `VAPI_*` env entries. This removes 3 of the 3
failing tests and a meaningful share of the 31 lint errors. Phase 5 builds the real telephony port.

*If the team wants a fast vendor demo before Phase 5, run it on a throwaway branch
(`voice/spike-*`) that is never merged — see §Phase 4.*

## P0.4 Parallel decision track (starts day 1, does not block P0.1)

Two decisions have long lead times and gate later phases. They start now, in parallel, because
they are procurement and evaluation, not code (Critical Rule 14).

- **Embedding architecture decision** (input to Phase 3) — see §Phase 3.
- **Telugu STT/TTS + telephony vendor evaluation** (input to Phase 4) — see §Phase 4.
  Account setup, Indian number KYC and DLT/TRAI registration alone can take 1–3 weeks of
  calendar time; start the paperwork in Phase 0.

## P0.5 CI pipeline (new — `.github/workflows/ci.yml`)

```yaml
# Conceptual — not implemented.
on: [push, pull_request]
jobs:
  verify:
    steps:
      - npm ci
      - npm run lint                 # eslint          → 0 errors, 0 warnings
      - npx tsc --noEmit             # typecheck       → 0 errors
      - npm test                     # vitest run      → 48/48 files, 0 failures
      - npm run build                # widget + next build
      - npm run preflight            # validateProductionReadiness()
      - npm run check:migrations     # NEW — see below
      - npm run check:boundaries     # NEW — dependency-direction lint (from Phase 1)
```

Two new checks earn their place from evidence in this repository:

- **`check:migrations`** — apply `supabase/migrations/*` to a throwaway Postgres in CI and diff the
  resulting schema against a committed snapshot. The `calendar_connections.status` bug shipped
  precisely because nothing does this. This is the single highest-value new check.
- **`check:boundaries`** — ESLint `no-restricted-imports` enforcing §2.4 rule 2. Added in Phase 1;
  scaffolded here.

## P0.6 Tests added in Phase 0

| Test | Level | Asserts |
| --- | --- | --- |
| `tests/integration/multi-tenant-isolation.test.ts` | integration | **Restored to executing.** Cross-tenant reads/writes rejected across scheduling, CRM, workflow and manage paths |
| `tests/unit/notification-factory.test.ts` | unit | All 4 `MESSAGING_PROVIDER` values select the right notification provider |
| `tests/integration/health-route.test.ts` | integration | `?deep=1` without the probe secret returns no `readiness.errors` |
| `tests/unit/resend-messaging.test.ts` | unit | Rewritten to Vitest; retry + SHA-256 idempotency key behaviour preserved |
| `tests/db/schema-drift.test.ts` | db | Every column referenced by `.select()` in `src/` exists in the applied schema |

## P0.7 Definition of Done

```text
npm run build            → PASS   (build:widget + next build)
npm test                 → PASS   48/48 files, 319+/319+ tests, 0 failures
npm run lint             → PASS   0 errors, 0 warnings
npx tsc --noEmit         → PASS   0 errors
npm run preflight        → PASS   wired and green
npm run check:migrations → PASS   applied schema matches the committed snapshot
tenant isolation tests   → PASS   multi-tenant-isolation.test.ts executing, not just compiling
CI                       → GREEN  all of the above run on every push and PR to main
```

Additional gates specific to this repository:

```text
No route selects a column absent from supabase/migrations/          (schema-drift test)
No webhook or cron route authenticates conditionally on a secret being present (fail closed)
src/providers/voice/ and src/app/api/v1/voice/ removed              (grep returns nothing)
docs/TESTING.md and docs/ROADMAP.md reconciled with reality         (§1.8)
main is protected: no merge without a green CI run
```

**Rollback:** every item is an independent PR on `stabilization/*`. Reverting any one restores the
prior state; there are no migrations and no data changes in Phase 0.

---

# Phase 1 — Extract HALO Core

**Goal:** the package boundary, the agent model, and zero behaviour change to the receptionist.
**Branch prefix:** `halo-core/*`
**Depends on:** Phase 0 (you cannot safely refactor against a red build).
**Effort:** **L** — 3–4 weeks (1a ≈ 2 weeks mechanical, 1b ≈ 1.5–2 weeks agent model).

## P1.1 Sub-phase 1a — workspaces and file moves (mechanical)

npm workspaces (npm is already the package manager; no new tooling). One PR per package, in
dependency order so the receptionist stays green throughout:

```text
1. packages/platform     ← src/lib/* (except auth.ts, supabase/, api/)
2. packages/core         ← src/core/domain, src/core/errors
3. packages/ports        ← src/core/ports (minus voice-provider.ts, deleted in Phase 0)
4. packages/providers/*  ← src/providers/* (minus voice/, deleted in Phase 0)
5. packages/knowledge    ← chunker.ts, retrieval-query.ts, rank fusion
6. packages/scheduling   ← src/core/services/scheduling/*
7. packages/workflows    ← src/core/services/workflows/*
8. packages/crm, packages/lifecycle, packages/analytics
9. packages/tenancy      ← src/lib/auth.ts, src/proxy.ts, src/lib/supabase/*
10. apps/receptionist    ← src/app, src/features, src/components, widget/, build-widget.mjs
11. database/migrations  ← supabase/migrations (git mv; files unchanged)
```

Rules: `git mv` (never delete-and-recreate) so `git log --follow` preserves the migration
commentary, which is unusually good in this repo. Path aliases `@/*` → `@halo/*`. **No semantic
change in any PR of sub-phase 1a.** `check:boundaries` lands with PR 1 and tightens with each move.

`industry-playbooks.ts` does **not** move to a package. It is business content: its 14 playbooks
become seed rows of agent configuration/knowledge in sub-phase 1b, and the module is deleted from
core (§2.4 rule 1).

## P1.2 Sub-phase 1b — the agent model

### Concept hierarchy

```text
Tenant  (businesses)                                       EXISTS — keep
  └── Agent  (agents)                                      NEW
        └── Agent Version  (agent_versions)                NEW — immutable snapshot
              └── Agent Configuration                      NEW — jsonb, validated by Zod
                    ├── Identity      name, persona, avatar, voice id
                    ├── Objective     what a successful conversation achieves
                    ├── Instructions  prompt template + custom instructions
                    ├── Language      primary, fallbacks, code-switch policy
                    ├── Voice         tts voice, speaking rate, barge-in policy
                    ├── Knowledge     collection bindings + retrieval policy
                    ├── Tools         granted tool ids + per-tool policy
                    ├── Workflows     which triggers this agent may emit
                    └── Guardrails    refusals, escalation triggers, PII rules
```

### Tables (design only — no migration is written in this phase)

**`agents`**
| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | `gen_random_uuid()` |
| `business_id` | uuid not null → `businesses` on delete cascade | tenant key, indexed first |
| `type` | text not null check in (`receptionist`,`sales`,`support`,`qualification`,`appointment`,`custom`) | CHECK over enum, matching the existing convention |
| `slug` | text not null | unique per business |
| `display_name` | text not null | |
| `status` | text not null check in (`draft`,`active`,`paused`,`archived`) default `draft` | |
| `live_version_id` | uuid null → `agent_versions` | deferrable FK (chicken-and-egg with versions) |
| `default_channel` | text not null check in (`web`,`phone`,`whatsapp`,`sms`) default `web` | affinity, not restriction |
| `created_at`/`updated_at` | timestamptz | `set_updated_at()` trigger, as elsewhere |

Indexes: `(business_id, status)`, `unique (business_id, slug)`.

**`agent_versions`** — immutable
| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `agent_id` | uuid not null → `agents` on delete cascade | |
| `business_id` | uuid not null → `businesses` | denormalized for RLS + index leading |
| `version` | int not null | `unique (agent_id, version)` |
| `config` | jsonb not null | the block above; Zod-validated on read, malformed = skip loudly (the `workflowDefinitionSchema` precedent) |
| `prompt_template` | text not null | **the content that leaves `prompt-builder.ts`** |
| `prompt_version` | text not null | seeded from `PROMPT_VERSION` |
| `model` | jsonb not null | `{provider, model, temperature, maxTokens}` — per-agent, per-task |
| `published_at` | timestamptz null | null = draft |
| `created_by` | uuid null → `auth.users` | **first `created_by` in the schema** — the audit log seed |
| `created_at` | timestamptz | |

Immutability: `update`/`delete` policies denied for everyone except an archive flag; editing
creates version *n+1*. Enforced by policy **and** a `BEFORE UPDATE` trigger.

**`tools`** and **`agent_tools`** — designed here, populated in Phase 6 (§Phase 6).

**Knowledge scoping** — `knowledge_collections (id, business_id, name, language, embedding_model,
embedding_dim)` plus `collection_id` on `knowledge_documents`; a null binding on an agent means
"all tenant collections", preserving today's behaviour. Chunk-level `agent_id` is deliberately
**not** added: collections are the right granularity and avoid a second scoping axis.

**Conversation ↔ agent version linkage (required)**
```sql
-- design only
alter table conversations add column agent_id uuid references agents(id);
alter table conversations add column agent_version_id uuid references agent_versions(id);
```
Both nullable during migration, backfilled, then `not null` in a follow-up migration.
**Every production conversation records the agent version that served it.** This is the
precondition for evals, A/B, incident forensics and cost attribution, and it is cheap now and
expensive later.

**`messages.role`** — extend the CHECK to `('user','assistant','system','tool')` and add
`tool_call_id text`, `tool_name text`, `tool_args jsonb`, `tool_result jsonb` (nullable). A
sibling `message_parts` table was considered and rejected: it doubles the read path for the
runtime's hottest query (`getRecentMessages`) to buy generality nothing needs yet.

### Relationships

```text
businesses 1─N agents 1─N agent_versions
agents.live_version_id ──▶ agent_versions.id
conversations N─1 agents          conversations N─1 agent_versions
agent_versions N─M tools  (via agent_tools)
agents N─M knowledge_collections  (via agent_knowledge, or a config binding)
receptionists ─── data-migrated ──▶ agents(type='receptionist') + agent_versions(version=1)
```

### Indexes

`agents (business_id, status)` · `agents unique (business_id, slug)` ·
`agent_versions (agent_id, version desc)` · `agent_versions (business_id, published_at desc)` ·
`conversations (business_id, agent_id, started_at desc)` ·
`agent_tools (agent_version_id)` · partial `agents (business_id) where status='active'`.

### RLS

Every new table gets policies **in the same migration** (§2.4 rule 3), following the existing
pattern exactly: `select` for `is_business_member(business_id)`, `insert`/`update`/`delete` for
`is_business_admin(business_id)`. `agent_versions` denies `update`/`delete` to all roles.
Any new `SECURITY DEFINER` function is revoked from `public`/`anon`/`authenticated` per the
`0002_function_grants.sql` precedent.

### Versioning and rollback

Draft → publish → live. Publishing sets `published_at` and repoints `agents.live_version_id`
in one transaction. Rollback is repointing `live_version_id` to an earlier version — no data
rewrite, no migration. In-flight conversations keep their pinned `agent_version_id`.

### Backwards compatibility

- `receptionists` **is not dropped in this phase.** A data migration creates one `agents` row +
  one `agent_versions` row per receptionist; the `widget_key` moves to `agents`. `receptionists`
  is then replaced by a **view** over `agents`/`agent_versions` so any missed read path keeps
  working, and is dropped only after a full release cycle with zero reads observed.
- The widget contract (`widget_key`, `visitor_token`, response envelope) does not change.
- `PROMPT_VERSION` remains as the *code* version of the prompt *assembler*; the *content* version
  is `agent_versions.version`. Both are logged per turn.

### Migration strategy (planned, not executed)

```text
0013_agents.sql            agents, agent_versions, RLS, indexes, immutability trigger
0014_agent_backfill.sql    receptionists → agents + agent_versions v1 (idempotent, re-runnable)
0015_conversation_agent.sql conversations.agent_id/agent_version_id (nullable) + backfill
0016_messages_tool_role.sql messages.role CHECK extension + tool columns
0017_knowledge_collections.sql collections + knowledge_documents.collection_id (nullable)
0018_receptionists_view.sql  drop table, create compatible view   [after a full release cycle]
```
Each migration is forward-only and idempotent (`if not exists`, `on conflict do nothing`),
matching the existing style. Rollback for 0013–0017 is a paired `down` script that drops only
what that file added; 0018 is the one irreversible step and is deliberately last and delayed.

## P1.3 Acceptance criteria

```text
apps/receptionist builds, deploys and passes 100% of tests importing only @halo/* packages
No packages/* file imports from apps/* or services/*        (check:boundaries green)
No packages/* file references a named industry or business  (grep gate in CI)
The receptionist runs entirely from agents + agent_versions rows
A second agent of a different type can be created for the same tenant and holds a conversation
Every new conversation row carries agent_id and agent_version_id
Prompt content lives in agent_versions.prompt_template, not in a TypeScript constant
Publishing v2 and rolling back to v1 changes behaviour without a deploy
All Phase 0 gates still green
```

**Rollback:** sub-phase 1a is pure `git mv` — revert the PR. Sub-phase 1b's schema is additive
with paired down-scripts; `receptionists` survives as a table until 0018, so a rollback at any
point before that restores the old read path intact.

**Risk:** the abstraction gets fitted to the receptionist. **Mitigation:** design 1b against the
receptionist *and* the Arunodhaya agent spec (§Phase 8) concurrently, and treat "Phase 8 needs a
`packages/` change" as the falsification test for this phase.

---

# Phase 2 — Agent Runtime

**Goal:** a channel-independent, streaming, tool-calling agent loop, proven on the **existing web
chat** before any phone line exists.
**Branch prefix:** `agent-runtime/*`
**Depends on:** Phase 1.
**Effort:** **L** — 4–5 weeks. The largest genuinely new engineering on the critical path.

## P2.0 Why this precedes voice

Streaming and tool calling are prerequisites for voice, and debugging a tool-calling bug over a
phone line is an order of magnitude harder than debugging it in a browser. Proving the runtime on
text gives an instant, cheap, reproducible feedback loop with the 316 passing tests as a net.

## P2.1 The loop

```text
turn(input) →
  1  ContextBuilder        load conversation, agent version, tenant, channel, locale
  2  ConversationState     history window + rolling summary + open slots + pending tool calls
  3  KnowledgeResolver     rewrite query → hybrid retrieve → rank → budget → cite
  4  PromptComposer        agent_versions.prompt_template + facts + knowledge + tool descriptions
  5  ToolSelector          filter granted tools by agent, channel, policy, conversation state
  6  LLMAdapter            stream(system, messages, tools) → text deltas | tool calls
  7  ⟳ if tool call: authorize → execute → validate result → append tool message → back to 6
                     (bounded: max N tool rounds per turn)
  8  ResponseValidator     grounding, refusals, PII, length/channel constraints
  9  MemoryManager         persist messages, update summary, update slot state
 10  Extraction            schema-driven outcome extraction (post-turn, may be async)
 11  EscalationManager     evaluate handoff triggers
 12  Emit                  usage + cost + business events
```

`ChatService.respond()`'s *sequence* (retrieve → prompt → complete → persist → capture) is
preserved. What changes: the return type becomes a stream, steps 5–7 replace the bespoke booking
orchestration, and every step reads its policy from `agent_versions` instead of a constant.

## P2.2 Component specifications

### Context Builder
- **Responsibility:** assemble everything the turn needs, once, with no LLM involvement.
- **Reuse:** `WidgetRepository.getRecentMessages`, `getReceptionistById` (→ agent resolver from
  Phase 1), `requireTenant()`.
- **New:** agent-version resolution + caching; channel descriptor (`web|phone|whatsapp`) carrying
  latency budget, max reply length, and whether interruption is possible.
- **Interface:** `buildContext(input: TurnInput): Promise<TurnContext>`
- **In:** `{conversationId, agentId, channel, locale, userInput}`
  **Out:** `{tenant, agent, agentVersion, history, summary, slots, channelProfile}`
- **Tests:** version pinning (an in-flight conversation keeps its version after a publish);
  missing agent → typed `AppError`; channel profile defaults.
- **Failure modes:** agent archived mid-conversation (serve the pinned version, log); version row
  deleted (impossible — immutable).

### Conversation State
- **Responsibility:** the durable working memory of a conversation.
- **Reuse:** `booking_drafts` is the proven precedent — generalize it to
  `conversation_state (conversation_id pk, business_id, slots jsonb, summary text,
  pending_tool_calls jsonb, updated_at)`.
- **New:** rolling summarization when history exceeds the window (today `HISTORY_LIMIT = 16`
  silently drops the opening of long conversations).
- **Interface:** `load(conversationId)` / `merge(state, patch)` / `persist(state)`
- **Tests:** merge order (**deterministic extraction applied last, so it beats the model** — the
  existing `booking-draft` invariant, kept); summary never contradicts a filled slot;
  concurrent-turn safety (upsert with `on conflict`, matching the drafts precedent).
- **Failure modes:** state load fails ⇒ degrade to history-only, never fail the turn.

### Prompt Composer
- **Responsibility:** pure function, `(agentVersion, context) → systemPrompt`.
- **Reuse:** `prompt-builder.ts` **architecture verbatim** — pure, unit-tested, versioned,
  facts-before-behaviour, explicit anti-hallucination, prompt-injection clause, custom
  instructions subordinated last. This is already the HALO standard.
- **New:** the *content* comes from `agent_versions.prompt_template` with typed slots, not from
  compiled-in strings; sections are composable per agent type; language-aware (Phase 3).
- **Interface:** `compose(template, facts, knowledge, tools, channel, locale): {prompt, version}`
- **Tests:** the existing 130 LOC of prompt-builder tests are ported and extended per agent type;
  golden-prompt snapshots per `(agent_version, channel, locale)`.
- **Failure modes:** malformed template ⇒ fall back to the last published version and alert
  (never to an empty prompt).

### Knowledge Resolver
- **Responsibility:** query rewrite → retrieve → fuse → budget → cite.
- **Reuse:** `buildRetrievalQuery`, `SupabaseKnowledgeProvider`, `fuseByReciprocalRank` (k=60),
  `isSubstantiveQuestion` gap telemetry, source labelling `[n] (title)`.
- **New:** collection binding from the agent version; a **token budget** on snippets (today six
  chunks × up to 1200 chars are injected regardless of score); language-aware retrieval (Phase 3);
  optional re-rank.
- **Interface:** `resolve(query, agentVersion, locale): Promise<{snippets, sources, budgetUsed}>`
- **Tests:** RRF correctness (existing); budget truncation preserves the top-ranked snippet;
  retrieval failure ⇒ `[]` and the turn continues (existing behaviour, preserved).

### Tool Selector
- **Responsibility:** decide which granted tools are offered to the model **this turn**.
- **Reuse:** the `action-registry` executor signature `(params, ctx) => Promise<detail>`.
- **New:** filter by agent grant, channel (no `send_email` mid-phone-call unless configured),
  conversation state (no `reschedule` without a live appointment — today `booking-orchestrator`
  gates exactly this and is stricter than an LLM would be; **keep that**), and safety class.
- **Interface:** `select(agentVersion, state, channel): ToolDescriptor[]`
- **Tests:** an ungranted tool is never offered; a state-gated tool disappears when its
  precondition is unmet; the offered set is deterministic for a given state.

### LLM Adapter
- **Responsibility:** the extended `LLMProvider` port.
- **Reuse:** all four adapters keep `complete()` and `isHealthy()`; none is rewritten.
- **New port surface** (design):
  ```ts
  interface LLMProvider {
    readonly name: string;
    complete(system, messages, options?): Promise<LLMResult>;
    stream(system, messages, options?): AsyncIterable<LLMDelta>;   // NEW
    supports(feature: "stream" | "tools" | "jsonMode" | "promptCache"): boolean;  // NEW
    isHealthy(): Promise<boolean>;
  }
  type LLMDelta = { type: "text"; text: string }
                | { type: "tool_call"; id: string; name: string; args: unknown }
                | { type: "usage"; usage: LLMUsage }
                | { type: "done"; finishReason: string };
  ```
  Plus `tools?: ToolDescriptor[]` and `cacheBreakpoints?` on options, and `withRetry` wrapping
  every adapter call (`src/lib/retry.ts` exists and is used by calendar/messaging/Resend but by
  **no** LLM adapter today).
- **Tests:** per adapter — text streaming, tool-call streaming, mid-stream abort, transient-error
  retry, `supports()` truthfulness, usage always emitted.
- **Failure modes:** provider without streaming ⇒ `stream()` yields one delta from `complete()`
  (graceful, not an error). Provider without tools ⇒ Tool Selector falls back to the
  orchestrator-mediated path for that agent, logged as a capability downgrade.

### Response Validator
- **Responsibility:** the last structural guard before the user hears/sees anything.
- **Reuse:** the anti-hallucination doctrine and the existing degradation ladder.
- **New:** assert the reply claims no action absent from this turn's tool results
  (**act-then-narrate as a check, not only a prompt**); enforce channel constraints (voice: ≤ 2
  short sentences, no markdown, no symbols); PII redaction policy from guardrails; refusal policy.
- **Interface:** `validate(reply, toolResults, agentVersion, channel): {ok, reply, violations[]}`
- **Tests:** a reply claiming a booking with no successful `book_appointment` result is rejected
  and regenerated once, then falls back to a safe reply; voice replies never contain markdown.

### Memory Manager
- **Responsibility:** persistence and compaction.
- **Reuse:** `appendMessages` + the `bump_conversation_on_message()` trigger.
- **New:** rolling summary; cross-conversation recall for a known customer (the `customers` +
  `customer_timeline` data already exists and is **never read back into the prompt** today);
  explicit retention/PII interaction with `purge_expired_data()`.
- **Tests:** a 60-turn conversation retains its opening facts via summary; summarization failure
  degrades to the raw window; recall respects tenant + consent.

### Workflow State
- **Responsibility:** the agent's view of workflows it may trigger and timers awaiting it.
- **Reuse:** `emitBusinessEvent` and the entire workflow engine, unchanged (§Phase 7).
- **New:** agent-scoped event types added to `BUSINESS_EVENT_TYPES` (a 16-value closed array
  today); correlation of a conversation/call to runs.
- **Tests:** an event emitted by the runtime reaches a matching workflow exactly once
  (the `unique(workflow_id, event_id)` guarantee is exercised by existing fakes).

### Escalation Manager
- **Responsibility:** decide when a human must take over.
- **Reuse:** the "wants a human" situation playbook already in the prompt.
- **New:** typed triggers (explicit request, repeated failure to answer, guardrail violation,
  frustration signal, high-value prospect, tool failure on an irreversible action); channel-aware
  action (web: notify + capture callback; phone: warm transfer, Phase 5).
- **Tests:** each trigger fires deterministically; escalation is always recorded as an outcome.

## P2.3 Channel independence

`packages/channels/*` is deliberately thin. A channel adapter supplies only:

```ts
interface ChannelProfile {
  id: "web" | "phone" | "whatsapp" | "sms";
  maxReplyChars: number;
  supportsInterruption: boolean;
  supportsRichText: boolean;
  latencyBudgetMs: number;
  render(delta: LLMDelta): void;     // SSE tokens | TTS sentence chunks | message parts
}
```

Everything above `render` is identical for a phone call and a web chat. **If a future change
requires a channel-specific branch inside the runtime, that is a design smell to be resolved by
extending `ChannelProfile`, not by branching.**

## P2.4 Cost accounting lands here, not in Phase 10

`LLMResult.usage` is currently discarded (verified §1.4). It becomes a first-class output of every
turn in this phase, because voice minutes and tokens are the product's COGS and Phase 4's
go/no-go depends on knowing per-turn cost. Schema and dashboards are Phase 10; **capture** is
Phase 2.

## P2.5 Tests

| Level | Suite | Asserts |
| --- | --- | --- |
| Unit | prompt composer, tool selector, response validator, state merge, summarizer | pure-function behaviour, per component above |
| Unit | 4 LLM adapters | streaming, tool-call parsing, abort, retry, usage |
| Integration | full turn on in-memory fakes | text turn, tool turn, multi-tool turn, tool failure, LLM failure, retrieval failure |
| Integration | booking-as-tool parity | **every existing booking integration test passes unchanged against the new runtime** |
| Eval | golden transcripts | ≥ parity with the current runtime on grounding and capture rate |
| Perf | turn latency | first-token p50/p95 recorded per provider as a baseline for Phase 4 |

## P2.6 Acceptance criteria

```text
The existing chat product runs entirely on the new runtime
Replies stream to the widget over SSE
Booking is a real tool call, not compiled-in orchestration
All pre-existing booking/chat integration tests pass UNCHANGED
No reply claims an action that no tool result supports        (validator test)
Per-turn usage {model, promptTokens, completionTokens, latencyMs, toolCalls} is persisted
A phone-shaped ChannelProfile drives the same loop in a harness with no phone line attached
Tool-call turns are transcribed (messages.role='tool')
Phase 0 and Phase 1 gates still green
```

**Rollback:** the runtime ships behind a per-agent feature flag on `agent_versions.config`
(`runtime: "legacy" | "halo"`). `ChatService` remains callable until every agent is flipped and a
release cycle has passed. Flipping back is a config change, not a deploy.

---

# Phase 3 — Multilingual Intelligence

**Goal:** Telugu, Telugu-English code switching, and multilingual retrieval — designed and
validated **before** phone voice, because language failures are invisible in a voice demo and get
blamed on the audio stack.
**Branch prefix:** `halo-core/multilingual-*`
**Depends on:** Phase 1 (collections). The *decision* (§P3.2) is made in Phase 0.
**Effort:** **M–L** — 3–4 weeks including evaluation.

## P3.1 The four verified obstacles

| Obstacle | Evidence | Consequence |
| --- | --- | --- |
| `to_tsvector('english')` | `0001_init.sql:190`, `:207` — inside **generated columns** on `knowledge_chunks` and `faqs`; `0001:232` and `0005:28` use `websearch_to_tsquery('english', …)` | Telugu text is stemmed by English rules and tokenized as unknown words. Retrieval is near-noise. Changing a generated column is a table-rewriting migration, not a config flag |
| `vector(768)` | `0001:188`, `0001:257`, `0005:61` | Only 768-dim models are storable. Nearly every strong multilingual embedding model is 1024 or 3072 dims |
| OpenAI embedding path | `providers/embedding/factory.ts` — `case "openai": throw new Error(…)` | The escape hatch is deliberately closed, and honestly so. Enabling it *requires* the dimension migration |
| English-only regexes | 20+ patterns, enumerated in §1.4 | The entire deterministic layer silently no-ops on Telugu. **This is the most dangerous item**: nothing errors, so the system looks like it works |

Plus a fifth, unlisted in the audit but verified: **no ANN index** on `knowledge_chunks.embedding`
(`0001:194-196` has only `business_idx`, `document_idx`, and a GIN on `content_tsv`). Once vector
search becomes mandatory for Telugu, every query is a sequential scan.

## P3.2 Embedding model selection — criteria first, model second

**Do not choose by popularity or by leaderboard rank.** The selection criteria, in priority order,
derived from this product's actual constraints:

1. **Telugu representation in training data**, measured on *our* corpus — not MTEB average.
   Telugu is agglutinative and low-resource; general multilingual benchmarks over-report it.
2. **Code-switch and transliteration robustness.** Real Hyderabad/Andhra speech mixes Telugu
   script, Romanized Telugu ("current bill entha vastundi"), and English technical terms
   ("net metering", "subsidy", "kilowatt"). The model must place these near each other.
3. **Dimension flexibility.** Matryoshka-capable models (truncatable embeddings) let us fix one
   storage dimension now and change models later without a second rewrite. This directly
   addresses the `vector(768)` trap — **do not repeat it**.
4. **Deployment mode and data residency.** Arunodhaya's prospect data is Indian PII. A self-hosted
   model keeps embeddings on our infrastructure; a hosted API is faster to ship. This is a
   compliance decision as much as a technical one and must be made explicitly.
5. **Query latency.** The retrieval step sits inside a voice turn's latency budget (§Phase 4).
   Embedding a query must be ≤ 80 ms p95, which effectively rules out large self-hosted models on
   CPU-only infrastructure.
6. **Cost at corpus scale** — indexing cost is one-off; query cost is per turn, per call.
7. **Measured retrieval quality on our own eval set** (§P3.5) — the tiebreaker, and the only
   criterion that is allowed to overrule the others.

**Candidate set to bench** (all must be measured, none is pre-selected):
`BAAI/bge-m3` (1024, dense+sparse+multi-vector, strong multilingual) ·
`intfloat/multilingual-e5-large` (1024) ·
Cohere `embed-multilingual-v3` (1024) ·
OpenAI `text-embedding-3-large` (3072, MRL-truncatable to 1024) ·
Google `gemini-embedding-001` (3072, MRL-truncatable) ·
an AI4Bharat / IndicBERT-family Indic-specialist as the Indic-tuned control.

**Recommendation on storage dimension, independent of the winner: standardize on 1024.** Every
candidate can produce 1024 dims natively or by Matryoshka truncation, so the schema stops being
coupled to one vendor. That is the actual lesson of `vector(768)`.

**Decision record:** the bake-off output is a written memo — winner, runner-up, measured nDCG@5
and Recall@10 per language bucket, latency, cost, deployment mode — committed as
`docs/decisions/0001-embedding-model.md`. Phase 3 implementation does not start without it.

## P3.3 Retrieval architecture

```text
query (Telugu | Romanized Telugu | English | mixed)
  │
  ├─ language detection  → {primary, confidence, isCodeSwitched}
  ├─ normalization       → Unicode NFC, digit normalization (Telugu/Devanagari/ASCII → ASCII),
  │                        optional transliteration to a second query variant
  ▼
  ├─ VECTOR  (primary for Telugu)     embed(query) → ANN over knowledge_embeddings
  ├─ FTS     (primary for English)    per-collection tsvector config
  └─ TRIGRAM (fallback for both)      pg_trgm on content — catches names, product codes, typos
  ▼
fuseByReciprocalRank([...], k=60)   ← EXISTING, unchanged, already correct
  ▼
budget + cite  →  [n] (title) snippets
```

Language decides *weighting*, not *mechanism*: all three legs always run, RRF fuses them, and a
per-collection weight vector tunes the mix. That keeps one code path and preserves the existing
graceful degradation (a failing leg contributes nothing and never fails the turn).

## P3.4 Schema changes (design only)

```text
0019_multilingual_retrieval.sql   (planned, not written)

knowledge_collections
  + language              text not null default 'en'
  + fts_config            regconfig not null default 'english'   -- 'simple' for Telugu
  + embedding_model       text not null
  + embedding_dim         int  not null default 1024

knowledge_embeddings                          -- NEW: model-tagged, replaces the inline column
  chunk_id     uuid   → knowledge_chunks on delete cascade
  business_id  uuid   → businesses          -- RLS + index leading
  model        text   not null
  embedding    vector(1024) not null
  primary key (chunk_id, model)
  index using hnsw (embedding vector_cosine_ops)     -- the missing ANN index
  index (business_id)

knowledge_chunks
  + content_tsv_simple  tsvector generated always as (to_tsvector('simple', content)) stored
  + gin index on content_tsv_simple
  + gin index on content gin_trgm_ops                 -- requires pg_trgm
  (content_tsv stays; the english column is not dropped — English tenants still use it)

match_knowledge_chunks()  → takes (business_id, collection_ids[], model, query_embedding, k)
search_knowledge()        → takes an fts config parameter instead of hard-coded 'english'
  both remain SECURITY DEFINER and stay revoked from public/anon/authenticated (0002 precedent)
```

**Why a separate `knowledge_embeddings` table rather than widening the column:** it lets two
models coexist during a re-embedding migration, makes re-embedding additive and resumable, and
removes the dimension from the chunk table permanently. `knowledge_chunks.embedding` is retained
(unused) for one release, then dropped.

**Backwards compatibility:** existing English tenants keep `to_tsvector('english')` and keyword-
first retrieval with no behaviour change. Vector search remains optional per collection. No tenant
is forced to re-index. `EMBEDDING_PROVIDER=none` continues to work.

**Migration sequence:** add tables/columns → backfill embeddings per collection in a resumable
background job → flip the collection's retrieval policy → verify against the eval set → drop the
legacy column one release later.

## P3.5 Evaluation dataset and quality metrics

**The dataset is a deliverable of this phase, not a by-product.** Without it, "Telugu retrieval
works" is an opinion.

`tests/evals/retrieval/te-IN.jsonl` — **≥ 200 queries**, each `{query, language_bucket,
relevant_chunk_ids[], notes}`, split across five buckets:

| Bucket | n | Example shape |
| --- | --- | --- |
| Pure Telugu script | 50 | "సోలార్ ప్యానెల్ వారంటీ ఎన్ని సంవత్సరాలు?" |
| Romanized Telugu | 40 | "solar panel warranty enni years?" |
| Code-switched | 50 | "మా current bill 3000 vastundi, subsidy ela?" |
| English technical | 30 | "net metering process" |
| Adversarial | 30 | misspellings, ASR-style errors, digit-word mixes, honorifics |

Queries must be written by or reviewed with **native Telugu speakers**; the adversarial bucket
should be seeded from real STT output once Phase 4 produces any (this is a feedback loop, and the
dataset is expected to grow).

**Metrics and acceptance thresholds:**

| Metric | Threshold | Rationale |
| --- | --- | --- |
| Recall@10, per bucket | ≥ 0.85 | If the right chunk is not in the top 10, no re-ranking saves the turn |
| nDCG@5, per bucket | ≥ 0.70 | The agent sees ~6 snippets; ranking within them matters |
| Code-switched vs pure-Telugu Recall@10 gap | ≤ 0.10 | Code switching is the *normal* case for this customer, not an edge case |
| Query embed + retrieve latency | p95 ≤ 250 ms | Fits inside the voice turn budget (§Phase 4) |
| Zero-result rate on the eval set | ≤ 2% | Feeds the existing `unanswered_question` telemetry |

**Baseline to beat:** the current English-FTS-only path measured on the same set. Publish both
numbers. If the multilingual path does not clear the baseline by a wide margin on the Telugu
buckets, the model choice is wrong — not the architecture.

## P3.6 Language-aware extraction and heuristics

The English regexes (§1.4) must be **rewritten, made language-pluggable, or deliberately removed —
never left to no-op.** Design:

```ts
interface LanguagePack {
  code: "en" | "te" | "te-en";
  detect(text: string): number;                      // confidence
  intents: Record<IntentName, RegExp[]>;             // scheduling, commitment, cancel, lead-trigger
  scoringPhrases: Record<SignalName, string[]>;      // replaces lead-scorer's compiled lists
  numerals: { parse(text: string): number | null };  // "రెండు వేలు" | "two thousand" | "2000" | "2k"
  timeExpressions: WhenParserRules;                  // replaces when-parser's English rules
  labels: Record<FieldName, RegExp>;                 // replaces booking-draft's LABEL_RE
}
```

A pack is selected per agent version's language config, with an explicit
`unsupported → LLM-extraction-only` fallback so an unwritten pack degrades **loudly** (a logged
capability downgrade and a metric), never silently.

Specific extraction targets for the Arunodhaya agent, each needing deterministic handling because
the LLM is unreliable on exactly these:

| Field | Difficulty | Approach |
| --- | --- | --- |
| **Numbers** | High | Telugu numerals spoken as words ("రెండు వేలు" = 2000), Indian grouping ("2 lakh", "1.5 lakhs"), ASR digit strings, mixed forms ("రెండు thousand"). Deterministic parser + unit test corpus |
| **Indian currency** | High | ₹ / Rs / rupees / రూపాయలు; lakh/crore scaling; "3k" | 
| **Electricity bill** | High | Amount (₹/month) vs units (kWh) — **prospects conflate them**. Must disambiguate by unit words and plausible ranges, and confirm back |
| **Solar capacity** | Medium | kW / KW / కిలోవాట్; "3 kilowatt", "3kv" (a common ASR error for kW) |
| **Names** | High | Telugu script and Roman; honorifics (గారు / "garu"), initials-first convention ("K. Ramesh"), village-name-as-surname. **Never normalize aggressively** — echo back for confirmation instead |
| **Addresses** | High | district / mandal / village / pincode. Pincode (6 digits) is the reliable deterministic anchor; the rest is fuzzy-matched against a service-area list |
| **Telugu text handling** | Medium | Unicode NFC normalization; ZWJ/ZWNJ stripping for matching but **not** for storage or display |

**Every one of these gets a unit test corpus before it gets an implementation.** These are the
fiddly, unglamorous items that decide whether the agent sounds competent.

## P3.7 Multilingual prompts

- `agent_versions.prompt_template` is authored **natively in Telugu**, not translated from English.
  Translated prompts produce translated-sounding output, which native listeners detect instantly.
- An explicit code-switch policy in the template: *mirror the prospect's mix; keep established
  English technical terms in English; never switch scripts mid-sentence for the same word.*
- The existing voice-mode rules ("< 2 short sentences, plain words, spell numbers naturally, read
  back phone/email, if interrupted drop your point") are **already correct** and are translated in
  spirit, not word-for-word.
- Lifecycle copy (`confirmation-content.ts`, fixed English today) becomes per-tenant, per-language
  templates. This is on the demo's critical path: a Telugu call that sends an English SMS
  confirmation breaks the illusion completely.

## P3.8 Acceptance criteria

```text
docs/decisions/0001-embedding-model.md exists, with measured numbers and a named winner
tests/evals/retrieval/te-IN.jsonl exists with ≥200 native-reviewed queries across 5 buckets
Recall@10 ≥ 0.85 and nDCG@5 ≥ 0.70 in every bucket
Code-switched Recall@10 within 0.10 of pure-Telugu Recall@10
Retrieval p95 ≤ 250 ms with the ANN index in place
Every English-only regex is either language-pluggable, rewritten, or deleted — grep-audited in CI
An unsupported language degrades loudly (logged + metered), never silently
An existing English tenant's retrieval results are byte-identical before and after the migration
A Telugu numeral/currency/capacity test corpus passes deterministically
```

**Rollback:** all schema changes are additive; retrieval policy is per-collection, so a bad rollout
is reverted by flipping one collection's policy back to `english`/keyword-first. No tenant is
migrated without its eval numbers being published first.

---

# Phase 4 — Voice Feasibility Spike  ⟨GO / NO-GO GATE⟩

**Goal:** answer, with measurements rather than assumptions, whether a Telugu phone agent can be
built to a standard Arunodhaya's prospects will tolerate — and if so, on which stack.
**Branch prefix:** `voice/spike-*` — **throwaway. Never merged to `main`.**
**Depends on:** vendor accounts + Indian number KYC/DLT started in Phase 0.
**Effort:** **S–M** — 1–2 weeks of engineering, but 1–3 weeks of *calendar* time for
number provisioning and regulatory registration. Start the paperwork on day 1 of Phase 0.

**Deliverable: a decision memo (`docs/decisions/0002-voice-stack.md`), not a branch.**

## P4.0 Why this is a gate and not a task

Every other item in this plan is work of known shape. The voice stack is the only genuine unknown,
and a bad answer changes the *architecture*, not the schedule:

- If Telugu TTS is not persuasive, the flagship agent is a chat/WhatsApp agent and Phase 5 is
  deferred — a product decision worth weeks.
- If code-switched STT accuracy is poor on numbers and names, the qualification data is unusable
  and the agent must confirm every field back, which changes conversation design and doubles turn
  count.
- If end-to-end latency cannot be brought under a conversational threshold, the agent must be
  redesigned around the latency (filler phrases, early acknowledgements, streaming partial
  commitments) rather than pretending it away.

## P4.1 STT evaluation

**Candidates** (all must support **streaming with partial results** — a batch-only API is
disqualified regardless of accuracy): Sarvam AI (Saarika) · AI4Bharat IndicWhisper / IndicConformer
(self-host) · Google Cloud STT `te-IN` (Chirp) · Azure Speech `te-IN` · Deepgram · OpenAI
streaming transcription. Test each on the **same recordings**.

**Test set:** ≥ 60 utterances recorded by ≥ 6 native speakers (mixed genders, mixed
Telangana/Andhra accents, mixed ages), captured **over a phone line at 8 kHz μ-law** — not from a
laptop microphone. Laptop-quality audio will flatter every vendor and invalidate the entire
exercise.

| Dimension | What to measure | Why it matters here |
| --- | --- | --- |
| Telugu accuracy | WER on pure-Telugu utterances | Baseline comprehension |
| Code switching | WER on Telugu-English mixed utterances, plus **term-level** accuracy on "subsidy", "net metering", "kilowatt", "EMI" | This is the normal case, not an edge case |
| **Names** | Exact-match rate on 20 Telugu names incl. honorifics and initials | A misheard name kills the CRM record and the callback |
| **Numbers** | Exact-match on bill amounts, kWh, pincodes, 10-digit mobile numbers | **The single most important metric.** A wrong digit in a phone number makes the whole call worthless |
| **Addresses** | District/mandal/village recognition rate against a fixed list | Feeds service-area validation and site-visit routing |
| Background noise | WER delta at ~15 dB SNR (traffic, TV, family) | Indian residential calls are rarely quiet |
| Interruptions | Does the stream recover cleanly when the speaker talks over TTS? | Prerequisite for barge-in |
| Endpointing | Time from true end-of-speech to `is_final`; false-cut rate mid-sentence | Directly enters the latency budget |

**Acceptance thresholds** (proposed; ratify before running, not after):
pure-Telugu WER ≤ 20% · code-switched WER ≤ 25% · **10-digit mobile number exact-match ≥ 95%** ·
bill-amount exact-match ≥ 90% · pincode exact-match ≥ 95% · endpointing p95 ≤ 700 ms ·
false mid-sentence cut rate ≤ 5%.

The number thresholds are deliberately far stricter than the WER thresholds. A qualification agent
can tolerate imperfect prose; it cannot tolerate a wrong phone number.

## P4.2 TTS evaluation

**Candidates:** Sarvam (Bulbul) · AI4Bharat Indic-TTS · Google `te-IN` (incl. Neural2/Studio
voices) · Azure `te-IN` · ElevenLabs multilingual. Streaming with chunked emission **and
mid-utterance cancellation** is mandatory — without cancellation there is no barge-in.

| Dimension | Method | Threshold |
| --- | --- | --- |
| Telugu naturalness | MOS 1–5 from ≥ 5 native speakers, blind, over a phone line | **mean ≥ 3.8** |
| Indian pronunciation | Error count on 30 items: place names, ₹ amounts, kW, "PM Surya Ghar", brand names | ≤ 2 errors |
| Code switching | Are embedded English words pronounced in Indian English, not read letter-by-letter or with an American accent? | ≥ 4/5 acceptable |
| Conversational tone | Does it sound like a person on a call or like an IVR announcement? | ≥ 3.5/5 |
| Time to first audio byte | measured, streaming | p95 ≤ 300 ms |
| Cancellation latency | time from cancel signal to silence | ≤ 150 ms |
| Cost | per minute at expected volume | recorded |

**MOS ≥ 3.8 is the make-or-break number for the demo.** Below that, prospects hang up regardless of
how good the reasoning is, and the honest recommendation becomes: ship Arunodhaya on WhatsApp/chat
first and treat phone as a later phase.

## P4.3 Latency — measure, do not assume

The 800 ms figure commonly cited is a Western-datacenter, English-model, well-provisioned number.
**Do not assume it is achievable here.** Realistic per-stage budget for Telugu over Indian PSTN,
to be filled in with *measured* values:

```text
Stage                                   Optimistic   Realistic   Measured
─────────────────────────────────────────────────────────────────────────
End of speech → VAD endpoint fires          150 ms      250 ms       ___
  → STT final transcript                    150 ms      300 ms       ___
  → Agent runtime (retrieve + prompt)         80 ms      200 ms       ___
  → LLM first token                          250 ms      500 ms       ___
  → First TTS audio byte                     150 ms      300 ms       ___
  → Telephony/network to caller's ear        100 ms      250 ms       ___
─────────────────────────────────────────────────────────────────────────
TOTAL end-of-speech → first audio            880 ms     1800 ms       ___
```

**Proposed acceptance targets, to be ratified against measurement:**
p50 ≤ 1200 ms, p95 ≤ 2000 ms. Above ~2.5 s p95 the conversation stops feeling like a conversation.

Mitigations to test *during* the spike, not after:
- Cut the 2nd and 3rd LLM calls from the voice path (booking extraction, lead extraction move
  post-turn or async). Today the runtime makes up to **three** blocking LLM calls per turn.
- Chunk TTS on sentence boundaries so speech starts before the reply completes.
- Prompt caching for the invariant 40–60% of the system prompt.
- A fast, small model for the conversational turn and a stronger model only for extraction.
- Early acknowledgement tokens ("అలాగే…") emitted while the model is still thinking — a
  conversation-design mitigation, and honest, since a human does the same.

## P4.4 Telephony evaluation

Indian PSTN reach is a hard requirement. **Candidates:** Exotel · Twilio India · Plivo · Ozonetel ·
Knowlarity; managed voice-agent platforms that bundle the media loop: Vapi · Retell · LiveKit
Agents · Pipecat/Daily.

Assess: Indian inbound + **outbound** DID availability and KYC lead time; TRAI/DLT registration
requirements; DND scrubbing obligations for outbound; per-minute cost; media transport (SIP vs
WebSocket) and codec; latency from an Indian region; recording capture; warm transfer support;
webhook signing; SLA and support responsiveness.

## P4.5 Buy vs build

The audit's verdict stands and this plan adopts it: **buy the media loop, build the agent.**
Building SIP, VAD, jitter handling and barge-in in-house is a 3–6 month effort requiring a
real-time audio specialist and is not where this product differentiates. A managed platform
collapses stages 1–5 and 7–9 into a provider integration.

**However**, the buy decision must preserve HALO's architecture: the agent must run in
`packages/agent-runtime`, invoked by the vendor over a streaming interface — **not** authored in
the vendor's console. A vendor-hosted agent is a demo, not a platform. The evaluation must
therefore also score: *can this vendor call our LLM/agent endpoint and stream audio back, or does
it insist on owning the reasoning loop?*

## P4.6 Test script and dataset (deliverables)

```text
spike/
  record-utterances.md      protocol: 6+ speakers, phone line, 8 kHz, consent recorded
  dataset/                  60+ utterances × 5 buckets, transcribed ground truth
  bench-stt.ts              same audio → every vendor → WER + field-level exact-match
  bench-tts.ts              same 30 sentences → every vendor → audio for blind MOS scoring
  bench-latency.ts          instrumented end-to-end call, per-stage timestamps, 30 runs
  mos-form.md               blind scoring sheet for native speakers
  RESULTS.md                raw numbers, no interpretation
```

Ground-truth transcripts and MOS scoring must involve native Telugu speakers. **Non-speakers
cannot evaluate this**, and getting it wrong here invalidates everything downstream.

## P4.7 The gate

```text
GO         all thresholds met by at least one viable stack
           → Phase 5 proceeds; the memo names the stack and pins the measured latency budget

CONDITIONAL GO   STT/TTS pass, latency lands in 2.0–2.5 s p95
           → Phase 5 proceeds WITH mandatory conversation-design mitigations (early
             acknowledgements, shorter turns, aggressive confirmation of numbers), and the
             latency mitigations of §P4.3 become Phase 5 acceptance criteria, not optimizations

NO-GO      Telugu TTS MOS < 3.5, or mobile-number exact-match < 90%, or p95 > 3 s
           → Phase 5 is DEFERRED. The Arunodhaya flagship ships as a Telugu WhatsApp + web
             agent on the Phase 2 runtime (which is channel-independent by construction, so
             this costs no rework), and the voice track is revisited when the vendor landscape
             moves. This is a legitimate outcome, not a failure — it is exactly what the gate
             exists to catch, and it protects the ~6 weeks Phase 5 would otherwise consume.
```

**Fallback strategy in all three branches:** the agent runtime, knowledge, tools, workflows,
booking, CRM and outcomes are channel-independent (§P2.3). A NO-GO removes the phone channel and
nothing else. **This is the single most important structural property of the plan** — it is what
makes the voice risk survivable.

## P4.8 Acceptance criteria

```text
docs/decisions/0002-voice-stack.md exists, with the measured latency table filled in
Per-vendor STT WER and field-level exact-match numbers published for all 5 buckets
Blind MOS scores from ≥5 native Telugu speakers, over a phone line, published
Measured end-of-speech → first-audio p50 and p95 from ≥30 instrumented calls
A written GO / CONDITIONAL GO / NO-GO with the named stack and the ratified latency budget
The spike branch is deleted; no spike code is merged
```

---

# Phase 5 — Phone / Telephony Runtime

**Goal:** production telephony — inbound and outbound — driving the Phase 2 agent runtime.
**Branch prefixes:** `voice/*` (media + STT/TTS), `telephony/*` (provider, calls, campaigns)
**Depends on:** Phase 2 (streaming + tools), Phase 3 (Telugu), **Phase 4 GO**.
**Effort:** **L** — 5–7 weeks with a managed media loop. **Double it if built in-house.**

## P5.1 Architecture

```text
Customer ──PSTN── Telephony provider ──streaming audio (WS, μ-law/PCM 8 kHz)──┐
                          ▲                                                    │
                          │                                                    ▼
                          │                                   services/voice-gateway
                          │                                   (the ONLY process separation)
                          │                                     ├─ session manager (per call)
                          │                                     ├─ VAD + endpointing
                          │                                     ├─ streaming STT client
                          │                                     ├─ barge-in controller
                          │                                     └─ streaming TTS client
                          │                                                    │
                          │                              packages/voice-runtime/session.ts
                          │                              (PORT of widget/src/voice-session.ts)
                          │                                                    │
                          │                              packages/agent-runtime (UNCHANGED)
                          │                                 ChannelProfile: phone
                          │                                 → LLM stream → tool calls
                          └────────────audio out───────────────────────────────┘
                                                                               │
                                                            packages/tools → BookingService,
                                                            CRM, workflows, messaging
```

`services/voice-gateway` is a long-lived Node process (Fly/Railway/ECS — **not** a Vercel
function; a minutes-long stateful audio session is the wrong shape for request/response, even
though Vercel Functions now support WebSockets). It holds no business logic: it owns the media
path and calls the agent runtime over an internal streaming interface.

**`widget/src/voice-session.ts` is the seed for `packages/voice-runtime/session.ts`.** It is
already DOM-free and provider-agnostic, with a 4-state machine, silence budget, watchdog,
generation-counter invalidation of stale async callbacks, and a fatal-vs-transient error taxonomy
— all transport-independent, and all covered by 440 LOC of tests. Port it; swap `SpeechProvider`
for streaming adapters; add barge-in (impossible client-side — `voice-session.ts:28` documents
why: recognition is disabled while speaking because there is no echo cancellation).

## P5.2 Ports

```ts
// packages/ports/telephony-provider.ts — replaces the deleted voice-provider.ts
interface TelephonyProvider {
  readonly name: string;
  placeCall(req: PlaceCallRequest): Promise<CallHandle>;      // OUTBOUND — the missing capability
  acceptInbound(evt: InboundCallEvent): Promise<CallHandle>;
  transfer(callId: string, to: TransferTarget): Promise<void>;
  hangup(callId: string, reason: HangupReason): Promise<void>;
  sendDtmf(callId: string, digits: string): Promise<void>;
  getRecording(callId: string): Promise<RecordingRef | null>;
  verifyWebhook(raw: string, headers: Headers): boolean;      // MANDATORY, fail closed
}

interface StreamingSttProvider {
  open(opts: {language: string; sampleRate: number; codec: Codec}): SttStream;
}
interface SttStream {
  write(chunk: Uint8Array): void;
  on(evt: "partial" | "final" | "endpoint" | "error", cb): void;   // matches Deepgram/Sarvam shape
  close(): Promise<void>;
}

interface StreamingTtsProvider {
  synthesize(text: string, opts: TtsOptions): AsyncIterable<Uint8Array>;
  cancel(handle: TtsHandle): void;              // barge-in depends on this
}
```

`verifyWebhook` is on the interface rather than in the route, so no adapter can be added that
forgets it, and so the Phase 0 failure mode (verification skipped when the secret is unset) cannot
recur by construction.

## P5.3 Call state machine — technical state

```text
                     ┌──────────────────────────────────────────┐
CREATED ─▶ QUEUED ─▶ DIALING ─▶ RINGING ─▶ CONNECTED ─▶ IN_CONVERSATION ─▶ COMPLETING ─▶ COMPLETED
   │          │         │          │           │              │                  │
   │          │         │          │           │              ├─▶ TRANSFERRED ───┤
   │          │         │          │           │              └─▶ INTERRUPTED ───┤
   │          │         │          ├─▶ NO_ANSWER                                 │
   │          │         │          ├─▶ BUSY                                      │
   │          │         ├─▶ FAILED (provider/network/invalid number)             │
   │          └─▶ CANCELLED (campaign paused, DNC hit, call window closed)       │
   └─────────────────────────────────────────────────────────────────────────────┘

INBOUND: RINGING ─▶ CONNECTED ─▶ IN_CONVERSATION ─▶ …   (CREATED/QUEUED/DIALING skipped)
Terminal: COMPLETED · FAILED · NO_ANSWER · BUSY · CANCELLED · TRANSFERRED
```

Implemented with an explicit `assertTransition()`, exactly like the existing
`scheduling/appointment-state.ts` — a proven pattern in this codebase with terminal-state
protection already unit-tested.

## P5.4 Business outcome — separate from technical state

**Kept deliberately separate.** A `COMPLETED` call can be a `NOT_INTERESTED` outcome; a
`NO_ANSWER` call has no outcome at all. Conflating them is how call analytics becomes useless.

```text
conversation_outcomes.disposition ∈
  QUALIFIED · NOT_QUALIFIED (+ reason) · CALLBACK_REQUESTED · NOT_INTERESTED ·
  WRONG_NUMBER · LANGUAGE_BARRIER · DO_NOT_CALL · APPOINTMENT_BOOKED ·
  ESCALATED_TO_HUMAN · NO_OUTCOME (call never reached conversation)
```

This is the **primary deliverable to the Arunodhaya sales team** and gets a first-class schema —
not a jsonb blob on `leads`, which is where this information is smeared today.

## P5.5 Data model (design only)

```text
0020_calls.sql  (planned)

calls
  id uuid pk · business_id · agent_id · agent_version_id · conversation_id (nullable)
  direction ('inbound'|'outbound') · provider · provider_call_id (unique per provider)
  from_number · to_number · campaign_id (nullable)
  state (CHECK, §P5.3) · state_changed_at
  queued_at · dialed_at · answered_at · ended_at · duration_seconds
  hangup_cause · recording_ref (nullable) · recording_consent_at (nullable)
  cost_minutes numeric · cost_estimate numeric
  index (business_id, created_at desc), (business_id, state), (campaign_id, state)

call_events                    -- the media-loop debug stream; ANY latency investigation needs it
  id bigint identity · call_id · business_id · at timestamptz
  type ('stt_partial'|'stt_final'|'endpoint'|'tts_start'|'tts_first_byte'|'tts_cancel'|
        'barge_in'|'dtmf'|'silence'|'transfer'|'provider_error'|'agent_turn')
  latency_ms int null · detail jsonb
  index (call_id, at)

call_transcript_turns
  id bigint identity · call_id · business_id · turn_index
  speaker ('agent'|'caller') · text · language · started_at · ended_at
  stt_confidence numeric null · agent_message_id uuid null → messages(id)

campaigns / campaign_contacts   -- §P5.7
```

All tables carry `business_id`, a `business_id`-leading index, and RLS policies in the same
migration. `usage_events.event_type` CHECK is extended for call events (the established pattern —
it has already been extended by four migrations).

## P5.6 Media-loop behaviours

| Concern | Design |
| --- | --- |
| **Streaming** | Bidirectional WS to the provider; inbound audio → VAD → STT; outbound TTS chunks written as produced |
| **VAD** | Server-side, tunable per agent version (silence threshold, min-speech, endpoint hangover). Provider-native VAD is acceptable if tunable; otherwise Silero |
| **Barge-in** | Caller speech detected while TTS is playing ⇒ cancel TTS within ≤ 150 ms, flush the output buffer, abort the in-flight LLM stream, start a new turn. **This is the single most-noticed quality signal on a phone call** |
| **Interruption** | The agent's partial utterance is recorded as delivered-partial in the transcript so the model knows what the caller actually heard |
| **Silence** | Reuse the existing silence budget from `voice-session.ts` (n silent turns → prompt → then a graceful close), tuned for phone rather than browser |
| **Retries** | Transient provider errors: reconnect the media socket once mid-call with the session preserved; a second failure ends the call as `FAILED` with a recorded reason |
| **Disconnects** | Any terminal state finalizes the transcript, computes the outcome from what was gathered, and emits the business event — **a dropped call must still produce a lead record** |
| **Recording** | Provider-captured; stored in a **private** Supabase Storage bucket with signed URLs. The existing `business-assets` bucket is public-read and must **never** hold recordings |
| **Transcripts** | Turn-level, timestamped, speaker-labelled, language-tagged, linked to `messages` |
| **Metadata** | Direction, numbers, durations, hangup cause, per-stage latencies, provider ids, cost |
| **Latency** | The §P4.3 budget becomes an enforced SLO: `call_events` latency percentiles are dashboarded and alerted |
| **Provider failure** | Circuit-break to a secondary provider if configured; else fail the call cleanly and requeue per campaign policy |
| **Human transfer** | Warm transfer with whisper context; agent availability model; the conversation summary is delivered to the human before the bridge |
| **Compliance** | See §P5.8 |

## P5.7 Outbound campaigns

The entire existing product is inbound-only; Arunodhaya is outbound-first. This is substantial new
work and carries regulatory weight.

```text
campaigns          id · business_id · agent_id · agent_version_id · name · status
                   call_window (local start/end) · timezone · max_attempts ·
                   retry_backoff_minutes · pacing (calls/min) · concurrency_cap
campaign_contacts  id · campaign_id · business_id · phone · name · payload jsonb
                   state ('pending'|'queued'|'in_progress'|'done'|'suppressed')
                   attempts · last_attempt_at · next_attempt_at · suppression_reason
```

Dialling policy: never outside the configured local call window; never more than `max_attempts`;
exponential retry on `NO_ANSWER`/`BUSY`; **immediate permanent suppression on `DO_NOT_CALL`,
`WRONG_NUMBER`, or a DNC-registry hit**. The claim pattern reuses `FOR UPDATE SKIP LOCKED`, which
is already proven in this codebase for reminders, workflow runs and timers.

## P5.8 Compliance and consent (India)

Not Phase 11 polish. **Phase 5 requirements.**

- **DNC/DND scrubbing** against India's registry before every outbound attempt, plus a
  tenant-level internal suppression list. A suppressed number is never dialled, and the attempt is
  recorded as suppressed.
- **TRAI / DLT registration** for the calling entity and, where applicable, message templates.
- **Recording consent disclosure** at the start of every recorded call, in Telugu, before any
  personal data is collected. `calls.recording_consent_at` records it; **no consent ⇒ no
  recording**, and the call still proceeds.
- **AI disclosure** — the agent identifies itself as an automated assistant when asked and,
  per policy, proactively. This should be a guardrail in `agent_versions.config`, not a prompt
  suggestion.
- **Call windows** enforced in the dialler, not in the prompt.
- **Retention** — recordings and transcripts inherit `business_settings.data_retention_days` and
  are purged by the existing `purge_expired_data()` path, extended to cover them and storage
  objects.
- **Number management** — provisioning, KYC records, per-tenant number assignment, caller-ID
  configuration, and a per-tenant reputation/complaint view.

## P5.9 Tests

| Level | Suite | Asserts |
| --- | --- | --- |
| Unit | call state machine | every legal transition; terminal protection; inbound skips dial states |
| Unit | ported voice session | the existing 440 LOC of tests pass against streaming adapters |
| Unit | VAD + barge-in controller | cancel within budget on simulated overlap; no false barge-in from TTS bleed |
| Unit | campaign dialler | call-window enforcement, retry backoff, suppression, pacing, concurrency cap |
| Integration | media loop against a fake provider | full call: connect → 6 turns → book → hang up |
| Integration | failure injection | STT drop, TTS drop, LLM timeout, provider disconnect, caller hangs up mid-tool-call |
| Integration | webhook auth | unsigned/wrong-signature webhook rejected; missing secret ⇒ route disabled |
| Manual | live calls | ≥ 20 real Telugu calls scored by native speakers (automation cannot judge this) |

## P5.10 Acceptance criteria

```text
An outbound campaign places calls within its call window, honours DNC and retry policy,
  and never exceeds its pacing or concurrency caps
An inbound call to a provisioned number is answered by the correct tenant's agent
The agent converses in Telugu with working barge-in (TTS cancelled ≤150 ms after caller speech)
The agent books a site visit through the EXISTING BookingService, with the gist exclusion
  constraint still the double-booking arbiter (unchanged)
Every call writes: a calls row with a terminal state, a turn-level transcript, per-stage
  latencies in call_events, a structured conversation_outcomes row, and a cost estimate
A recorded call has recording_consent_at set, disclosed in Telugu, stored in a PRIVATE bucket
A dropped call still produces a lead record and a business event
Measured end-of-speech → first-audio p50/p95 meet the Phase 4 ratified budget in production
Human transfer works with whisper context
Technical call state and business outcome are separately queryable
```

**Rollback:** the phone channel is a `ChannelProfile`. Disabling the campaign scheduler and the
inbound number mapping removes the channel without touching the agent runtime, the web channel, or
any business logic. `services/voice-gateway` deploys and rolls back independently of the monolith.

---

# Phase 6 — HALO Tool Runtime

**Goal:** one tool registry serving **both** workflow steps and LLM tool calls, with authorization,
safety classes and an audit trail — so a new agent capability is a registration, not new
orchestrator code.
**Branch prefix:** `halo-core/tools-*`
**Depends on:** Phase 2 (tool calling in the port). Can run **in parallel** with Phase 3.
**Effort:** **M** — 2–3 weeks.

## P6.1 Execution path

```text
Agent (agent_version)
  │  ToolSelector: which granted tools are offered this turn
  ▼
Tool Registry            name → {json schema, executor, side-effect class, timeout, retry policy}
  │
  ▼
Tool Authorization       agent grant? channel allowed? tenant scope? state precondition?
  │                      side-effect class permits autonomous invocation?
  ▼
Tool Execution           Zod-validate args → inject tenant ctx → idempotency key → timeout → retry
  │
  ▼
Result Validation        typed result parsed; failures are VALUES, not exceptions
  │
  ▼
Audit Log                tool_invocations row: who, what, args, result, latency, outcome
  │
  ▼
Back to the model as a tool message (messages.role='tool')
```

The executor signature `(params, ctx) => Promise<detail>` already exists in
`workflows/action-registry.ts` and is already tool-shaped. That registry is **grown**, not
replaced, so the 11 existing workflow actions become tools automatically and every existing
workflow keeps working unchanged.

## P6.2 Safety classification — the gating design decision

The current system is safe by construction because **the LLM cannot invoke anything**;
deterministic code decides, acts, and then reports. Exposing real tools changes that safety
profile, so classification must land **before** the tools do.

| Class | Meaning | Runtime policy |
| --- | --- | --- |
| `read` | Idempotent, no side effect | Model may invoke freely |
| `write-reversible` | Creates/updates recoverable state | Model may invoke; idempotency key required; audited |
| `write-irreversible` | Financial or externally-visible permanent effect | **Never model-initiated.** Requires explicit human or workflow approval |
| `external-send` | Sends a message to a third party | Model may invoke **only** with a recipient resolved from tenant data — never from the transcript — and a tenant-preconfigured template |

Applied to what exists today (from the audit's §8 analysis, adopted):

| Tool | Source | Class | Notes |
| --- | --- | --- | --- |
| `check_availability` | `BookingService.getAvailability` | `read` | Idempotent, tenant-scoped, cheap |
| `search_knowledge` | `KnowledgeProvider.search` | `read` | |
| `get_customer` | `CrmService` | `read` | Tenant-scoped lookup |
| `book_appointment` | `BookingService.book` | `write-reversible` | Double-booking already impossible (gist constraint); typed `{ok:false, reason, alternatives}` result is ideal tool ergonomics. **Requires a per-conversation-turn idempotency key** |
| `reschedule_appointment` / `cancel_appointment` | `BookingService` | `write-reversible` | Explicit confirmation gate retained. Today `CANCEL_RE` + a live-appointment check gates this, which is *stricter* than an LLM decision — **keep the gate** |
| `crm_upsert_customer` / `crm_record_timeline` | `CrmService` | `write-reversible` | Append-only, forward-only stages, low risk by construction |
| `crm_record_revenue` | `CrmService` | `write-irreversible` | Financial. Human approval |
| `send_email` / `send_sms` / `send_whatsapp` | `MessagingProvider` | `external-send` | Recipient from tenant data only |
| `call_webhook` | action registry | `external-send` | **Never let a model choose the URL.** Tenant-preconfigured allowlist only. The SSRF guard protects the network, not the choice of destination |
| `ops_create` | `OpsProvider` | `write-irreversible` | Creates tickets/invoices downstream; a retry creates a *second* one (the registry already reasons about this) |
| `schedule_followup` | workflow timers | `write-reversible` | Bounded (capped at 1 year) |
| `transfer_to_human` | telephony | `write-reversible` | Phase 5 |
| `solar_sizing` | Arunodhaya | `read` | Pure computation, Phase 8 |

**Rule (§2.4 #7): the LLM never executes arbitrary code and never chooses an unbounded
destination.** Enforced by the class, in the runtime, not by prompt text.

## P6.3 Per-tool specification (required for every registration)

```ts
interface ToolDefinition {
  name: string;                       // stable; part of the agent_version contract
  version: number;                    // schema changes bump this; grants pin a version
  description: string;                // the model reads this — the highest-leverage 200 chars
  parameters: JSONSchema;             // Zod → JSON Schema, single source of truth
  result: JSONSchema;
  sideEffect: "read" | "write-reversible" | "write-irreversible" | "external-send";
  auth: "tenant-context" | "tenant-credential" | "platform-credential";
  tenantScope: "required";            // ctx.businessId is injected, NEVER a model argument
  timeoutMs: number;                  // default 30 000, matching the workflow step default
  retry: { maxAttempts: 1|2|3; backoffMs: number; retryOn: "transient" };
  idempotency: "none" | "key-required";
  audit: "always";
  onFailure: "return-typed-failure";  // failures are values; the model is told and can recover
}
```

**Tenant isolation:** `business_id` is injected from the turn context and is **never** a model-
supplied argument. Any tool whose executor accepts a tenant identifier from `params` fails a CI
lint. This closes the largest new attack surface a tool runtime introduces.

**Idempotency:** `write-reversible` and `write-irreversible` tools require a key derived from
`(conversationId, turnIndex, toolName, argsHash)`, so a stream retry or a duplicate model call
cannot double-book or double-send. This mirrors the workflow engine's
`unique(workflow_id, event_id)` discipline, which is the strongest idempotency mechanism in the
codebase today.

**Audit logging:** every invocation writes `tool_invocations (id, business_id, conversation_id,
call_id, agent_version_id, tool_name, tool_version, args_redacted, result_summary, side_effect,
authorized_by, latency_ms, status, error, created_at)`. PII in args is redacted per the tool's
declared fields. This table doubles as the seed of the general audit log (Phase 11).

## P6.4 Schema (design only)

```text
0021_tools.sql  (planned)
tools              id · name · version · description · parameters jsonb · result jsonb ·
                   side_effect · auth · timeout_ms · retry jsonb · idempotency · enabled
                   unique (name, version)        -- platform-scoped, not tenant-scoped
agent_tools        agent_version_id · tool_id · policy jsonb (confirmation, rate limit,
                   channel restriction) · primary key (agent_version_id, tool_id)
tool_invocations   as above; RLS in the same migration; (business_id, created_at desc) index
```

`tools` is a platform catalogue (no `business_id`); `agent_tools` and `tool_invocations` are
tenant-scoped and carry RLS.

## P6.5 Tests

| Level | Asserts |
| --- | --- |
| Unit | Schema validation rejects malformed args; `business_id` is never accepted from params |
| Unit | Each safety class enforces its policy; a `write-irreversible` tool cannot be model-initiated |
| Unit | Idempotency key collapses duplicate invocations to one effect |
| Unit | Timeout and retry behave per definition; a failure returns a typed value, never throws into the loop |
| Integration | All 11 existing workflow actions execute unchanged through the unified registry |
| Integration | Cross-tenant attempt (forged `businessId` in args) is rejected and audited |
| Integration | Booking through the tool path produces identical results to the direct path |
| Security | Model-chosen `call_webhook` URL is refused; only allowlisted destinations execute |

## P6.6 Acceptance criteria

```text
One registry serves workflow steps and LLM tool calls
Every tool has a JSON Schema, a side-effect class, a timeout, a retry policy and an audit rule
No tool accepts a tenant identifier as a model-supplied argument     (CI lint)
write-irreversible tools cannot be invoked by a model, in any configuration
external-send tools resolve recipients from tenant data only
Every invocation writes a tool_invocations row
Per-agent grants are enforced; an ungranted tool is neither offered nor executable
All 11 pre-existing workflow actions pass their existing tests unchanged
Booking via tool call is behaviourally identical to booking via the orchestrator
```

**Rollback:** grants live in `agent_versions`. Revoking a tool from an agent version, or
publishing the prior version, disables it instantly with no deploy.

---

# Phase 7 — Workflow Engine Integration

**Goal:** connect HALO agents to the **existing** workflow engine, and close its three known
structural gaps — without changing its semantics, which are correct.
**Branch prefix:** `halo-core/workflows-*`
**Depends on:** Phases 1, 2. Parallelizable with Phases 3 and 6.
**Effort:** **M** — 2–3 weeks.

## P7.1 What is preserved (Critical Rule 7)

Verified present and correct; **do not modify**:
`unique(workflow_id, event_id)` idempotency · two-level retries (per-step `maxAttempts` with fixed
backoff; per-run `5 min × 3^(attempt-1)` capped at 6 h) · `dead_letter` terminal state ·
resume-from-`current_step` · `FOR UPDATE SKIP LOCKED` claiming · per-step timeouts · the
append-only `workflow_events` outbox · step-level `workflow_run_logs` · Zod-validated definitions
skipped loudly rather than crashing a tenant's other workflows · `emitBusinessEvent` never throwing
into the flow that emitted.

## P7.2 Agent → workflow integration

Agents trigger workflows through the **existing single front door**, `emitBusinessEvent()`. No new
path. `BUSINESS_EVENT_TYPES` (a closed 16-value array today) is extended:

```text
+ conversation.completed        + conversation.escalated
+ agent.qualified               + agent.disqualified
+ call.started                  + call.completed        + call.failed
+ call.no_answer                + call.transferred
+ outcome.recorded
```

The `usage_events.event_type` CHECK is extended in the same migration, following the established
pattern (it has already been extended by four migrations).

Arunodhaya's target journey, expressed entirely in existing engine primitives:

```text
Lead Created  (import or inbound)
  → campaign queues an outbound call
  → Agent Calls Lead                          call.started
  → conversation → qualification              agent.qualified
  → Schedule Site Visit                       tool: book_appointment  (EXISTING BookingService)
  → appointment.created                       ← EXISTING event, already emitted
  → Confirmation (Telugu WhatsApp/SMS/email)  ← EXISTING lifecycle service
  → CRM Update                                ← EXISTING always-on syncCrm
  → Sales Handoff                             ← call_webhook (Slack) or ops_create
  → schedule_followup +3 days if no decision   ← EXISTING workflow timer
```

**Every step after "Schedule Site Visit" already exists and works.** That is the reuse argument in
one diagram.

## P7.3 The three structural gaps to close

| Gap | Evidence | Fix | Risk |
| --- | --- | --- | --- |
| **Runs execute inline in the emitting request** via `void`-ed fire-and-forget, which serverless does not guarantee completes | `engine.ts` `dispatch → startRun → executeRun`; `void emitBusinessEvent(...)` at call sites | `emitBusinessEvent` **enqueues**; a worker executes. Keep `executeRun` byte-identical — only its caller changes. Vercel Queues, Inngest or a DB-backed queue reusing the proven `SKIP LOCKED` claim pattern | Medium — behaviour change under load; mitigate with a per-tenant flag and a shadow period running both paths |
| **Version pinning recorded but not honoured** — a retry after an edit runs the *new* steps against an *old* event | `engine.ts:103` `this.store.getWorkflow(run.workflowId)` | Persist the definition snapshot on the run (or fetch by `(workflowId, workflow_version)`) and execute that | Low — but it changes retry semantics, so it needs its own test |
| **`workflow_events`/`runs`/`logs` grow unbounded** | `purge_expired_data()` covers conversations and usage events only | Extend retention to automation history, respecting `data_retention_days` | Low |

Deferred beyond this phase, deliberately: branching/parallel steps, run cancellation, dead-letter
replay UI, per-tenant concurrency caps, sub-minute timer resolution. None blocks Arunodhaya.

## P7.4 The four guarantees, restated as tests

| Guarantee | Mechanism (existing unless noted) | Test |
| --- | --- | --- |
| **Deterministic** | Conditions are pure (`eventMatches`, 7 operators, AND-ed); steps are ordered; interpolation is pure | Same event + same definition ⇒ same step sequence, 100 runs |
| **Idempotent** | `unique(workflow_id, event_id)`; `createRun` catches `23505` and returns null | Duplicate event delivery ⇒ exactly one run (already covered by the in-memory fake, which reproduces the constraint) |
| **Observable** | `workflow_run_logs` per step per attempt; `correlation_id` threads the journey | Every terminal run has a complete log chain; a call correlates to its runs |
| **Retry-safe** | Two-level retries; resume from `current_step`; completed steps never re-execute | A step failing at attempt 1 and succeeding at attempt 2 executes prior steps exactly once |
| **Tenant-aware** | `business_id` on every table; `listRunLogs` verifies run ownership before reading | Cross-tenant run/log access rejected (extends the restored isolation test) |

`updateRun(id, patch)` and `appendLog(entry)` are keyed by id only — safe today because ids come
from tenant-scoped reads, but with no database backstop. Phase 11 adds RLS policies to close it;
this phase adds the isolation test that would catch a regression.

## P7.5 Acceptance criteria

```text
Agent conversations and calls emit business events through the EXISTING emitBusinessEvent front door
The Arunodhaya journey (§P7.2) runs end to end on existing engine primitives
Emission enqueues; a worker executes; no workflow runs inline in a request that returns a response
A retry after a workflow edit executes the PINNED version, not the current one
Automation history is covered by tenant retention
All existing workflow tests pass UNCHANGED
Idempotency, retry, dead-letter, resume and SKIP LOCKED semantics are byte-identical to today
```

**Rollback:** the queue is introduced behind a per-tenant flag with a shadow period. Flipping back
restores inline execution, which is today's behaviour.

---

# Phase 8 — Arunodhaya Solar Sales Agent

**Goal:** the first real HALO tenant — and the falsification test for Phases 1–7.
**Branch prefix:** `arunodhaya/*`
**Depends on:** Phases 1, 2, 3, 6, 7 (+ Phase 5 for the phone channel; the agent ships on
web/WhatsApp without it).
**Effort:** **M** — 2–3 weeks, *if* the preceding phases landed correctly.

> ### ⚠ Acceptance test for the whole plan
> **This phase should require ZERO changes under `packages/`.** Everything below is configuration,
> knowledge, prompts, a qualification schema, one computational tool, and workflow definitions.
> If Phase 8 needs a core code change, the agent model (Phase 1) or the tool runtime (Phase 6) was
> designed wrong — treat that as a defect in the earlier phase, not as scope in this one.

> ### ⚠ Business facts are NOT in this repository
> Verified 2026-09-04: `grep -rli "arunodhaya\|solar" docs/ src/` returns **only
> `CURRENT_STATE_AUDIT.md`**. There is no Arunodhaya business document, price list, product
> catalogue, service area, warranty policy or subsidy guidance anywhere in this repository, and
> none is invented here (Critical Rule 4). Every item marked **⟨SUPPLIED⟩** below must come from
> verified Arunodhaya business documents before implementation begins. §P8.13 lists exactly what
> to request.

## P8.1 Agent identity

| Field | Value |
| --- | --- |
| `agents.type` | `sales` |
| `agents.slug` | `arunodhaya-solar-sales` |
| Display name, persona, gender, voice | **⟨SUPPLIED⟩** — Arunodhaya chooses; the voice is picked from the Phase 4 shortlist by native speakers |
| Primary language | Telugu (`te-IN`) |
| Code-switch policy | Mirror the prospect; keep established English technical terms in English |
| Channels | Phone (outbound-primary, inbound-secondary) · WhatsApp · web |
| Disclosure | Identifies as an automated assistant for Arunodhaya when asked, and proactively per the guardrail policy |

## P8.2 Objective

A successful conversation produces **one** of:
(a) a qualified prospect with a booked site visit;
(b) a qualified prospect with a scheduled callback;
(c) a clean disqualification with a recorded reason;
(d) a `DO_NOT_CALL` suppression.

Explicitly **not** an objective: closing a sale, quoting a price, or promising a subsidy amount on
the call. Those are human-sales and compliance territory, and the guardrails forbid them.

## P8.3 Knowledge  ⟨SUPPLIED⟩

Structure (exists today: `knowledge_documents` → `knowledge_chunks` → hybrid retrieval → source
attribution). Content does not. Required collections, all needing a **Telugu-retrievable** version:

```text
products            panel types, capacities, inverters, mounting, batteries        ⟨SUPPLIED⟩
pricing             indicative bands and what drives them (NOT firm quotes)        ⟨SUPPLIED⟩
subsidy             the schemes Arunodhaya actually supports and their real terms  ⟨SUPPLIED⟩
net_metering        DISCOM process as Arunodhaya actually experiences it           ⟨SUPPLIED⟩
installation        timeline, site requirements, what the customer must provide    ⟨SUPPLIED⟩
warranty_service    warranty terms, AMC, response times                            ⟨SUPPLIED⟩
service_area        districts/mandals actually served                              ⟨SUPPLIED⟩
company             history, certifications, references                            ⟨SUPPLIED⟩
```

**Ingestion caveat:** `knowledge_documents.source_type` allows `'file'` and `'url'` but **only
paste-text ingestion is implemented**. If Arunodhaya supplies PDFs or a website, either PDF/URL
ingestion becomes real work in this phase (**M**) or the content is manually transcribed. Confirm
the delivery format before estimating.

## P8.4 Qualification schema

Per-agent, driven by the Phase 2 schema-driven extraction (generalizing the four hard-coded fields
in `lead-extractor.ts`). The scaffold from the brief, with types, extraction strategy and
disqualification rules made explicit:

```json
{
  "property_type":             "",
  "location":                  "",
  "monthly_electricity_bill":  "",
  "existing_solar":            "",
  "required_capacity":         "",
  "purchase_timeline":         "",
  "interest_level":            "",
  "appointment_requested":     ""
}
```

| Field | Type | Extraction | Notes |
| --- | --- | --- | --- |
| `property_type` | enum: independent_house · apartment · commercial · industrial · agricultural | LLM + Telugu keyword list | Apartment usually means no individual roof rights — a qualification branch, **not** an automatic disqualifier |
| `location` | `{district, mandal, village, pincode}` | **Deterministic**: 6-digit pincode regex is the anchor; district/mandal fuzzy-matched against the ⟨SUPPLIED⟩ service-area list | Drives service-area validation and site-visit routing |
| `monthly_electricity_bill` | `{amount_inr?, units_kwh?, confidence}` | **Deterministic** Telugu/Indian numeral parser (§P3.6) | Prospects conflate ₹ and kWh. Disambiguate by unit words and plausible range, then **confirm back** |
| `existing_solar` | bool + `{capacity_kw?, age_years?}` | LLM + keywords | Existing system ⇒ a different conversation (expansion/AMC), not the standard pitch |
| `required_capacity` | `{kw, basis}` | **Deterministic tool** (`solar_sizing`) — computed, never LLM arithmetic | Sizing rule and assumptions are ⟨SUPPLIED⟩ |
| `purchase_timeline` | enum: immediate · 1_3_months · 3_6_months · exploring | LLM + Telugu time expressions (needs the `te` language pack) | The **highest-signal** field for sales prioritization |
| `interest_level` | enum: hot · warm · cold | Derived by the scorer, not asked | Explainable signals, as the existing scorer already does |
| `appointment_requested` | bool + slot ref | Set only when `book_appointment` **actually succeeded** | Never model-asserted (act-then-narrate) |
| `ownership` | enum: owner · tenant · joint | LLM + keywords | **Hard disqualifier**: a tenant cannot authorize a rooftop installation |
| `roof` | `{type?, approx_area_sqft?, shading?}` | LLM, low confidence expected | Confirmed at the site visit, not on the call |
| `decision_maker` | bool | LLM | Determines whether to book or to ask for the decision maker |
| `consent_to_contact` | bool + timestamp | Explicit | Compliance |

**Never invent a sizing formula.** `solar_sizing` implements Arunodhaya's own rule ⟨SUPPLIED⟩ and
returns `{kw, panel_count_estimate, basis, assumptions[]}` so the agent can state its reasoning
and, when the inputs are weak, decline to estimate.

## P8.5 Qualification questions

Order matters: cheap disqualifiers first so a dead call ends in under a minute.

```text
1. Consent + purpose         "Is now a good time? I'm calling from Arunodhaya about rooftop solar."
2. Ownership                 own or rent?                      → tenant ⇒ DISQUALIFY, politely
3. Property type             house / apartment / commercial     → apartment ⇒ branch
4. Location (pincode/village)                                   → outside service area ⇒ DISQUALIFY
5. Existing solar                                               → yes ⇒ branch to expansion/AMC
6. Monthly bill (₹ or units) — confirm the number back
7. Timeline                                                     → "exploring" ⇒ nurture, don't push
8. Decision maker                                               → no ⇒ ask for the right person
9. Interest + site-visit offer                                  → yes ⇒ book_appointment
```

One question per turn (the existing prompt doctrine, already correct). Never re-ask a filled slot
(the `booking-draft` invariant, generalized in Phase 2). Read numbers back for confirmation (the
existing voice-mode rule, already correct).

## P8.6 Objection handling

The mechanism exists: `prompt-builder.ts` already carries 7 situation playbooks plus per-industry
emergency and compliance rules. Solar objections use that **shape** — but as agent configuration
and knowledge, **not** as a fifteenth entry in `industry-playbooks.ts`, which leaves core in
Phase 1 (§2.4 rule 1).

Objections to cover (the list is verified as *typical*; **every answer is ⟨SUPPLIED⟩**):
too expensive · how long is payback · will it work in monsoon/cloudy weather · what about
maintenance · my neighbour's system failed · is the subsidy real and how much · what if I move
house · roof damage or leakage concerns · net-metering hassle with the DISCOM · I'll think about
it · send me details on WhatsApp instead.

**Guardrails (hard lines, enforced as guardrails, not suggestions):**
- Never quote a firm price or a firm subsidy amount — direct to a site visit for an exact quote.
- Never promise a payback period as a fact; state the basis and its assumptions.
- Never make claims about a competitor.
- Never claim a government approval, certification or scheme Arunodhaya does not hold ⟨SUPPLIED⟩.
- Never pressure. On a second refusal, close warmly and record `NOT_INTERESTED`.
- Honour `DO_NOT_CALL` immediately and permanently.

## P8.7 Tools

All from the platform registry; **one** is Arunodhaya-specific and is pure computation.

| Tool | Class | Source |
| --- | --- | --- |
| `search_knowledge` | read | Platform |
| `solar_sizing` | read | **Arunodhaya app** — deterministic, ⟨SUPPLIED⟩ rule. The LLM must never do this arithmetic |
| `check_service_area` | read | Arunodhaya app — pincode/mandal against the ⟨SUPPLIED⟩ list |
| `check_availability` | read | Platform (`BookingService`) |
| `book_appointment` | write-reversible | Platform — technicians are `staff_members` |
| `crm_upsert_customer` / `crm_record_timeline` | write-reversible | Platform |
| `send_whatsapp` | external-send | Platform — recipient from tenant/CRM data, approved template only |
| `schedule_followup` | write-reversible | Platform (workflow timer) |
| `transfer_to_human` | write-reversible | Platform (Phase 5) |
| `record_outcome` | write-reversible | Platform — writes `conversation_outcomes` |

Deliberately **not granted**: `call_webhook` (model-chosen URL), `crm_record_revenue`
(irreversible financial), `ops_create` (irreversible downstream).

## P8.8 Workflows

Existing engine, tenant-defined; no engine changes.

| Trigger | Steps |
| --- | --- |
| `agent.qualified` | `crm_upsert_customer` → `crm_record_timeline` → notify sales (`call_webhook` → Slack, **tenant-configured URL**) |
| `appointment.created` | Telugu confirmation (WhatsApp + SMS) → ICS to sales → technician assignment |
| `appointment.reminder` | existing reminder queue, Telugu copy, 24 h + 2 h |
| `agent.disqualified` | `crm_record_timeline` with the reason → suppression if `DO_NOT_CALL` |
| `call.no_answer` | `schedule_followup` per campaign retry policy, within call windows |
| `conversation.escalated` | notify sales immediately with transcript + summary |
| `appointment.no_show` | existing sweep → rebook journey (existing template) |

## P8.9 Escalation rules

Transfer or notify a human when: the prospect asks for a person · a commercial/industrial prospect
above a ⟨SUPPLIED⟩ threshold · two consecutive unanswered questions on the same topic · a
guardrail is triggered (price/subsidy pressure) · frustration or repeated interruption · any
complaint about an existing installation · a tool fails on an irreversible path.

Phone: warm transfer with whisper context (Phase 5). Web/WhatsApp: notify sales and capture a
callback window.

## P8.10 Appointment flow

Reuses the strongest existing asset with almost no change:

```text
check_availability(district/mandal, preferred window)
  → availability.ts slot generation over staff_members (= technicians), working hours,
    buffers, holidays, min notice, max advance, and real calendar free/busy
  → offer 2–3 slots in Telugu, spoken naturally
  → book_appointment → EXCLUDE USING gist constraint is the double-booking arbiter (unchanged)
  → SlotTakenError ⇒ typed failure with alternatives ⇒ the agent offers them (never invents one)
  → appointment.created → Telugu confirmation + ICS + manage_token self-service link
  → reminders → check-in → completion → feedback     (all existing lifecycle services)
```

Two additions needed: **travel-time buffers** between site visits (`scheduling_settings.buffer` is
per-business today — a per-service or per-staff buffer may be required) and **technician
geographic assignment**. Telugu confirmation copy is Phase 3's templating work.

## P8.11 Lead scoring

Reuses `lead-scorer.ts`'s architecture (0–100, hot/warm/cold, explainable signals) with a solar
signal set replacing the English receptionist phrase lists. Weighting **⟨SUPPLIED⟩ by
Arunodhaya's sales team** — they know which signal actually predicts a sale. Proposed inputs to
be ratified, not assumed: bill magnitude, ownership, property type, service-area fit, timeline
bucket, decision-maker status, existing-solar status, engagement depth, explicit site-visit
request.

## P8.12 CRM mapping

| Qualification field | Destination |
| --- | --- |
| name, phone | `customers` (dedupe by normalized phone — already implemented) |
| location | `customers` custom fields — **`customers` has no custom-field mechanism today**; either add a `custom jsonb` column (S) or store on `leads.qualification` |
| bill, capacity, property, ownership, timeline | `leads.qualification` jsonb + the new `conversation_outcomes` row |
| interest level | `leads.temperature` + `score` |
| stage | `customers.stage` — forward-only progression (existing) |
| every call | `customer_timeline` — **`syncCrm` handles 9 event types today, none call-related**; the new call events (§P7.2) must be added to the switch |

## P8.13 What must be requested from Arunodhaya before implementation

A single, explicit list. **Implementation of this phase does not start until these arrive.**

```text
1.  Company profile, certifications, references, service-area districts/mandals
2.  Product catalogue: panel types, capacities, inverters, batteries, mounting
3.  Indicative pricing bands and what drives them (NOT firm quotes)
4.  Subsidy schemes actually supported, with real terms and the claim process
5.  Net-metering process as experienced with the local DISCOM(s)
6.  Installation timeline and site prerequisites
7.  Warranty terms, AMC offering, service response commitments
8.  The sizing rule the sales team actually uses (bill/units → kW), with assumptions
9.  Approved answers to the objections in §P8.6, in Telugu
10. Hard compliance lines: what the agent must never say or promise
11. Escalation thresholds and the sales team's availability windows
12. Technician list, working hours, geographic coverage, travel-time expectations
13. Lead-scoring weights the sales team believes in
14. Recording-consent and AI-disclosure wording, in Telugu, approved by them
15. The contact list for the first campaign, with proof of consent/lawful basis
16. Brand voice: formal vs warm, honorific usage (గారు), preferred agent gender
```

## P8.14 Telugu conversation policy

- **Telugu-first.** Open in Telugu; switch fully to English only if the prospect does.
- **Mirror the mix.** Established technical terms stay in English ("net metering", "subsidy",
  "inverter", "kilowatt") — forcing pure Telugu for these sounds artificial to actual speakers.
- **Never switch scripts mid-word.** Either Telugu script or Roman, consistently, per term.
- **Numbers spoken naturally** in the Telugu convention; **always read back** bill amounts, phone
  numbers and appointment times for confirmation.
- **Honorifics** — గారు and formal address by default; **⟨SUPPLIED⟩** confirmation of register.
- **Short turns.** ≤ 2 sentences on the phone (the existing voice-mode rule, already correct).
- **Yield immediately on interruption** (existing rule; enforced by barge-in in Phase 5).
- **Recording consent and AI disclosure in Telugu**, before any personal data is collected.
- **Escalate on language failure.** If STT confidence is persistently low or the prospect speaks a
  language the agent does not support, hand off — do not persist and do not guess.

## P8.15 Acceptance criteria

```text
ZERO changes under packages/ were required to build this agent            ← the plan's own test
A native Telugu speaker completes a qualification call end to end
The qualification payload is fully populated and every number is correct  (verified against audio)
Ownership, service-area and existing-solar disqualifiers each fire correctly on scripted calls
A site visit is booked through the EXISTING BookingService and appears on the technician's calendar
A Telugu confirmation is delivered (WhatsApp/SMS) with the correct time and manage link
The sales team receives a structured outcome + transcript + recording for every call
No guardrail is violated across ≥20 scored calls (no firm price, no firm subsidy, no pressure)
DO_NOT_CALL suppression is immediate and permanent
Every business fact the agent states is traceable to a ⟨SUPPLIED⟩ knowledge source
```

**Rollback:** the agent is `agent_versions` rows plus knowledge content. Pausing the agent, or
rolling back to a prior version, is a control-plane action requiring no deploy.

---

# Phase 9 — Dashboard / Control Plane

**Goal:** the minimum UI that makes HALO operable without SQL. **Deliberately after Phase 8** —
building the agent builder before you know what an agent needs produces the wrong builder, and the
demo can run on seeded configuration.
**Branch prefix:** `halo-core/console-*`
**Depends on:** Phase 1 (agent model), Phase 5 (call data). Parallelizable with Phases 8, 10, 11.
**Effort:** **L** — 3–4 weeks, additive UI, low architectural risk.

## P9.1 What already exists

18 dashboard pages, 9 feature slices with Server Actions, all opening with `requireBusiness()`,
RLS-enforced reads, no client state library. The patterns are sound; every page assumes **one
receptionist per business**, which is the thing that changes.

## P9.2 Screens, prioritized for the Arunodhaya demo

| Screen | Status | Priority | Notes |
| --- | --- | --- | --- |
| **Calls** | NEW | **P0 — demo-critical** | List + filter by outcome/state/campaign; detail = recording player + Telugu transcript + qualification payload + latency trace. **This is what the sales team actually opens.** No equivalent exists |
| **Leads** | EXISTS | **P0** | Add solar qualification fields and the call link |
| **Agents** | NEW | **P0** | List, create, publish/rollback a version. Minimum viable: a config editor, not a visual builder |
| **Agent Configuration** | NEW (from `/dashboard/receptionist`) | **P0** | Identity, objective, instructions, language, voice, knowledge bindings, tool grants, guardrails. Version diff + rollback |
| **Dashboard (home)** | EXISTS | P1 | Add call/campaign counters |
| **Conversations** | EXISTS | P1 | Add agent-version column and Telugu rendering |
| **Knowledge** | EXISTS | P1 | Add collection + language + embedding-model selection; ingestion status |
| **Campaigns** | NEW | P1 | Upload a list, set the call window, start/pause, progress. Seedable by SQL for the demo if time is short |
| **Workflows** | EXISTS (`/dashboard/automations`) | P2 | Add the new agent/call triggers to the picker |
| **Integrations** | PARTIAL (Settings) | P2 | Per-tenant provider credentials; telephony number assignment |
| **Settings** | EXISTS | P2 | Tenant/agent switcher — **`requireBusiness()` currently hard-codes one business per user** |
| **Costs** | NEW | P2 | Phase 10 |
| **Audit log** | NEW | P3 | Phase 11 |
| **Evals** | NEW | P3 | Phase 12 |

**For the demo, only the P0 four are required.** Everything else can be seeded configuration and
SQL, and saying so explicitly is what prevents this phase from swallowing the schedule.

## P9.3 Explicitly out of scope

Visual drag-and-drop agent builder · A/B experiment UI · white-labelling · team/role management
beyond the existing three roles · billing UI · a marketplace. None is needed to run Arunodhaya,
and each is a multi-week detour.

## P9.4 Acceptance criteria

```text
An operator creates a second agent for a tenant, configures it, publishes it, and rolls it back —
  entirely in the UI, with no SQL and no deploy
The Calls screen plays a recording, shows the Telugu transcript aligned to turns, shows the
  qualification payload and the per-stage latency trace
A tenant with two agents can switch between them (requireBusiness's one-business assumption is gone)
Every mutating screen enforces the existing role checks and RLS
No screen queries a column absent from the schema         (the calendar_connections lesson)
```

---

# Phase 10 — Observability & Cost

**Goal:** know what every conversation, call and tenant costs, and see the system's behaviour.
**Branch prefix:** `hardening/observability-*`
**Depends on:** Phase 2 captures usage; this phase persists, aggregates and limits it.
**Effort:** **M** — 2 weeks.

> **Capture is Phase 2, not here.** `LLMResult.usage` is discarded today (verified §1.4). Waiting
> until Phase 10 to capture it means Phase 4's go/no-go and Phase 5's pricing are decided blind.

## P10.1 Attribution chain

```text
Agent → LLM → Usage → Tokens → Cost
   └────────────────────────────┴──▶ attributed to: Tenant · Agent · Agent Version ·
                                     Conversation · Call · Turn · Tool invocation
```

Every cost row carries the full chain, so any level is queryable without a join explosion.

## P10.2 What is tracked

```text
LLM        provider · model · input tokens · output tokens · cached tokens ·
           latency_ms · finish reason · retry count
STT        provider · audio seconds · streaming vs batch · language
TTS        provider · characters (or seconds) · voice · cancellations
Telephony  provider · direction · billable minutes · number · country
Tools      tool name · invocations · latency · failures
Knowledge  embedding calls · tokens · retrieval latency
Derived    cost per turn · cost per conversation · COST PER CALL · cost per qualified lead
```

**Cost per qualified lead is the number the business actually needs.** Everything else is an
input to it.

## P10.3 Schema (design only)

```text
0022_usage_cost.sql  (planned)

usage_records        id bigint identity · business_id · agent_id · agent_version_id ·
                     conversation_id · call_id · turn_index ·
                     kind ('llm'|'stt'|'tts'|'telephony'|'tool'|'embedding') ·
                     provider · model · quantity numeric · unit · latency_ms ·
                     cost_estimate numeric(12,6) · occurred_at
                     index (business_id, occurred_at desc), (call_id), (conversation_id)

provider_rates       provider · model · unit · rate numeric · effective_from · effective_to
                     -- rates are DATA, not code, so a price change is a row not a deploy

tenant_quotas        business_id pk · monthly_token_cap · monthly_minute_cap ·
                     monthly_cost_cap · concurrent_call_cap ·
                     action_on_breach ('warn'|'throttle'|'block') · alert_threshold_pct
```

`usage_events` (product telemetry) stays as it is. `usage_records` (operational/financial) is
separate on purpose — conflating them makes both harder to query and to retain.

## P10.4 Tenant limits

Enforced at three points: before a turn (token cap), before placing a call (minute cap and
concurrency), and before a campaign starts (projected spend). Breach behaviour is per-tenant and
explicit; the default is `warn` at 80% and `throttle` at 100% — **never a silent stop**, because a
silently stopped campaign looks like a product bug to the tenant.

## P10.5 Beyond cost

Structured logging already exists and is good (zero-dependency JSON, one object per line,
`logger.child({service})`). Gaps to close: a **request/trace id** threaded end to end
(`correlation_id` exists but only inside the workflow subsystem); metrics (turn latency, tool
latency, retrieval latency, call-stage latencies, error rates by provider); error aggregation;
and alerting on the Phase 4 latency SLO, dead-letter growth, queue depth, provider error rate,
and quota breaches.

One PII issue to fix here: `LogMessagingProvider` (the default) logs **full outbound message
bodies**, including visitor phone numbers and email addresses. Redact by field.

## P10.6 Acceptance criteria

```text
Every LLM, STT, TTS, telephony and tool call writes a usage_records row with a cost estimate
Cost per call, per conversation and per qualified lead are queryable per tenant and per agent
Provider rates are data; a price change requires no deploy
A tenant exceeding its cap is warned/throttled/blocked per its configured policy, never silently
A single trace id links a widget request or a call through every service and log line
Latency SLO breaches alert
No message body containing PII is written to logs
```

---

# Phase 11 — Security

**Goal:** close the audit's verified gaps and make the new voice/tool surfaces safe by
construction.
**Branch prefix:** `hardening/security-*`
**Depends on:** Phases 1, 5, 6. Some items are pulled into Phase 0 (§P0.1 #4, #9).
**Effort:** **M–L** — 3 weeks.

## P11.1 Tenant isolation and RLS — the highest-priority item

The structural risk is Regime B (§1.1): most of the interesting code runs on the service role with
tenancy enforced only in TypeScript, across ~15 id-keyed queries with no database backstop. The
audit found **no query that accepts a client-supplied identifier and reads cross-tenant** — the
discipline is genuinely good — but the pattern is one careless commit from a leak, and every new
HALO table inherits it unless the rule is enforced.

| Action | Detail |
| --- | --- |
| **Rule** | Every new table ships RLS policies in the same migration (§2.4 #3). Enforced by a CI check that fails if a `create table` appears without a matching `enable row level security` + policy in the same file |
| **Backstop the id-keyed writes** | Add `business_id` to the predicate of `updateAppointmentStatus`, `updateAppointmentTimes`, `setExternalEventId`, `updateRun`, `appendLog`, `markMerged`. `markMerged(loserId, keeperId)` takes two customer ids with **no business check** and is the sharpest edge |
| **DB-level tests** | `tests/db/` running against `supabase start`: every policy asserted, positive and negative, per role. **Zero such tests exist today** |
| **Keep the isolation test green** | `multi-tenant-isolation.test.ts` becomes a required CI gate (restored in Phase 0) |

## P11.2 The rest

| Area | Gap (verified) | Action |
| --- | --- | --- |
| API authorization | Sound. Capability tokens, timing-safe compares, cron fails closed | Extend the pattern to every new route; **no conditional-on-secret-presence verification anywhere** |
| Agent authorization | New surface | An agent may only act within its tenant and its granted tools; the agent version is pinned per conversation and cannot be swapped mid-conversation |
| Tool authorization | New surface | §P6.2 classes enforced in the runtime; `business_id` never model-supplied (CI lint) |
| Integration secrets | Resend key, WhatsApp token, LLM key are **deployment-global**; per-tenant sender identity is impossible | Per-tenant credential storage, encrypted (below) |
| **Credential encryption** | `calendar_connections.access_token`, `refresh_token`, `basic_password` are plaintext `text` (`0008:154-158`). Isolation is correct (RLS on, zero policies), confidentiality is not | Envelope encryption with a KMS-held key; decrypt only in the provider adapter. Same treatment for telephony credentials |
| Phone numbers | New | Per-tenant assignment, KYC records retained, caller-ID policy, no cross-tenant reuse |
| **Transcripts & recordings** | New — **the most sensitive data HALO will hold** | Private bucket only (never `business-assets`, which is public-read); signed URLs with short TTL; access audited; retention inherits `data_retention_days` and purges storage objects too; consent recorded before capture; a per-tenant "no recording" mode that still allows transcripts |
| Webhook signatures | Vapi check skipped when the secret is unset (fixed/removed in Phase 0) | `verifyWebhook` is on the `TelephonyProvider` interface (§P5.2) so no adapter can omit it; **fail closed** |
| Rate limiting | In-process; `N` instances = `N ×` the limit; resets on deploy | Redis/Upstash adapter behind the **unchanged async interface**. Add limits to the dashboard API and Server Actions (currently unprotected) and per-tenant call concurrency |
| CORS / allowed domains | `allowed_domains` **defaults to empty = allow any origin**; `widget_key` is a bearer credential with no rotation UI | Default new tenants to a required domain list; add key rotation to the console; keep the per-message origin re-check |
| Audit logging | No table, no `created_by` anywhere | `audit_log (business_id, actor_user_id, actor_kind, action, target_type, target_id, before, after, at)`. `agent_versions.created_by` (Phase 1) is the seed. Config changes, tool grants, campaign starts, recording access, credential changes |
| Data retention | Covers conversations and usage events; **not** workflow history, recordings, transcripts, calls | Extend `purge_expired_data()` and add storage-object purging |
| **PII** | Bill amounts, addresses, phone numbers, voice recordings — Indian personal data (DPDP Act) | Data map; per-field retention; export and deletion paths per data subject; redaction in logs and in `tool_invocations.args_redacted`; explicit lawful basis recorded for every campaign contact list |

## P11.3 Acceptance criteria

```text
Every table created after this plan has RLS policies in its own migration      (CI-enforced)
tests/db/ asserts every policy, positive and negative, per role
No repository write is keyed by id alone without a business_id predicate
No secret is stored in plaintext at rest
Recordings and transcripts live in a private bucket, are signed-URL only, and access is audited
Consent is recorded before any recording is captured; no consent ⇒ no recording
Rate limiting is shared across instances and covers dashboard routes and Server Actions
Every configuration change, tool grant, campaign start and recording access writes an audit_log row
A data-subject deletion request can be executed and evidenced
No webhook route verifies conditionally on a secret being configured
```

---

# Phase 12 — Testing Strategy

**Goal:** the safety net that makes everything above changeable. **Test work belongs inside each
phase**; this section defines the levels, the standard, and what is automated vs manual.
**Effort:** **M** — 2–3 weeks of dedicated work beyond per-phase testing.

## P12.1 Levels

```text
Unit          pure functions, adapters, state machines, schemas
  ↓
Integration   services against in-memory fakes that reproduce production semantics
  ↓
Agent         conversation-level evals: golden transcripts + LLM judge, keyed on agent version
  ↓
Workflow      idempotency, retry, resume, dead-letter, timers
  ↓
Voice         VAD, barge-in, endpointing, STT/TTS adapters against recorded audio
  ↓
Telephony     call state machine, campaign dialler, provider failure injection
  ↓
End-to-End    Playwright over the dashboard + widget; scripted calls against a fake provider
```

The existing harness is the right foundation and is kept: Vitest, explicit imports (no
`globals: true`), hand-written in-memory fakes that **reproduce production constraints** — the
workflow store fake reproduces `unique(workflow_id, event_id)`, which is why its idempotency tests
mean something.

## P12.2 Suites

| Suite | Level | Automated? | Asserts |
| --- | --- | --- | --- |
| **Agent correctness** | agent | ✅ CI (nightly for cost) | Golden transcripts per agent version: grounding (no claim outside retrieved sources), no action claimed without a tool result, slot-filling never re-asks, escalation triggers fire |
| **Telugu** | agent | ✅ retrieval, ⚠️ fluency manual | Retrieval metrics (§P3.5) in CI; **conversational fluency scored by native speakers** — an LLM judge cannot certify Telugu naturalness for a native audience |
| **Code switching** | agent | ✅ | Mixed-script queries retrieve correctly; the agent mirrors the mix; no mid-word script switching |
| **RAG** | integration | ✅ | RRF correctness (exists), budget truncation, ANN vs exact agreement, graceful degradation on vector failure (exists), per-collection config honoured |
| **Tool execution** | integration | ✅ | Schema validation, safety classes, idempotency, timeout, retry, typed failure, audit row, ungranted tool refused |
| **Multi-tenancy** | integration + **db** | ✅ **required gate** | `multi-tenant-isolation.test.ts` restored; plus `tests/db/` asserting every RLS policy positively and negatively |
| **Calendar double booking** | integration + db | ✅ | **Concurrent booking of the same slot against a real Postgres** — the `EXCLUDE USING gist` constraint must be the arbiter. The current suite tests this against fakes only |
| **Workflow retries** | integration | ✅ | Duplicate event ⇒ one run; step failure ⇒ backoff ⇒ resume from `current_step`; exhaustion ⇒ dead-letter; **retry uses the pinned version** (the Phase 7 fix) |
| **Voice interruptions** | unit + integration | ✅ | Barge-in cancels TTS ≤ 150 ms; TTS bleed does not false-trigger; partial utterance recorded as heard; the ported `voice-session` tests still pass |
| **Call failures** | integration | ✅ | No-answer, busy, mid-call disconnect, STT drop, TTS drop, LLM timeout, provider outage — **every one still produces a lead record and a terminal call row** |
| **Human handoff** | integration + manual | ⚠️ mixed | Trigger logic automated; warm transfer with whisper verified manually per release |
| **Security** | unit + db + manual | ✅ + annual manual | SSRF/crypto/CORS/oauth-state/safe-redirect (exist, passing); RLS db tests; webhook signature; cross-tenant forgery; **a manual penetration test before the first production tenant** |
| **Schema drift** | db | ✅ **required gate** | Migrations applied in CI; every column referenced by `.select()` exists. *This check would have caught `calendar_connections.status`* |
| **Latency** | perf | ✅ nightly | Turn latency and call-stage percentiles against the ratified Phase 4 budget |

## P12.3 Automated vs manual — and why the line is where it is

**Automated (CI, every push):** unit, integration, RLS/db, schema drift, tool safety, workflow
semantics, retrieval metrics, E2E, boundary and grep gates.

**Automated (nightly, cost-controlled):** LLM-judged agent evals, latency benchmarks.

**Manual, and honestly so:**
- **Telugu conversational quality** — native speakers, ≥ 20 scored calls per release. Neither an
  LLM judge nor a WER number can certify that an agent sounds like a person to a Telugu speaker.
- **TTS naturalness (MOS)** — blind scoring by native speakers.
- **Live call quality** over real Indian PSTN under real network conditions.
- **Warm transfer** end to end with a real human.
- **Penetration testing** before the first production tenant.

Manual tests get written protocols and recorded results in `docs/qa/`, so "we tested it" is a
document, not a memory.

## P12.4 Coverage targets

| Package | Target | Rationale |
| --- | --- | --- |
| `packages/core`, `ports`, `platform` | 90% | Pure, cheap, foundational |
| `packages/scheduling`, `workflows`, `crm`, `lifecycle` | 85% | Existing standard; do not regress it |
| `packages/agent-runtime`, `tools` | 85% | New and load-bearing |
| `packages/voice-runtime`, `services/voice-gateway` | 70% + integration | Media paths resist unit testing; compensate with failure-injection integration tests |
| `apps/*` | 50% + E2E | UI is better covered by E2E than by unit tests |

## P12.5 Acceptance criteria

```text
CI runs unit + integration + db + E2E on every push, and evals + latency nightly
tests/db/ exists and asserts every RLS policy (zero such tests exist today)
Concurrent double-booking is tested against a real Postgres
The Telugu retrieval eval set is in CI with published thresholds
Native-speaker call scoring is a documented, repeated release gate with recorded results
Schema drift is a required gate
No release proceeds with a red suite — and no test is skipped to make a release
```

---

# 20. Deployment Architecture

**Principle: keep it simple.** No Kubernetes, no Kafka, no service mesh, no Temporal cluster.
The current stack (Vercel + Supabase + Vercel Cron) is adequate for the first deployment; exactly
**one** component is added, and only because its runtime profile genuinely does not fit.

## 20.1 Environments

| | Development | Staging | Production |
| --- | --- | --- | --- |
| App | `next dev`, local widget build | Vercel preview (per-PR) + a stable staging deployment | Vercel production |
| Database | Local `supabase start` **(new — enables the db test suite)** | Separate Supabase project | Supabase production, PITR enabled |
| LLM | Ollama local (today's default) | The production provider, cheap model | Per-agent model config |
| STT/TTS | Vendor sandbox | Vendor sandbox | Vendor production |
| Telephony | Fake provider + recorded audio | Vendor sandbox + one test number | Provisioned Indian DIDs |
| voice-gateway | Local process | One small instance | ≥ 2 instances behind the provider's session affinity |
| Queue | In-process | Real queue, low concurrency | Real queue |
| Rate limiting | In-memory | Redis | Redis |

**Staging must be able to place a real call to a real test number.** A voice product that is only
ever tested against a fake provider is untested.

## 20.2 Secrets and environment variables

Today: `src/lib/env.ts` is a Zod-validated, memoized schema that fails fast with readable issue
paths, service-role access is guarded by `import "server-only"`, and no secret reaches the browser
(the widget holds only the public `widget_key`). **Keep all of it.**

Additions: `STT_PROVIDER`/`TTS_PROVIDER`/`TELEPHONY_PROVIDER` + credentials ·
`VOICE_GATEWAY_URL` + a shared internal auth secret · `REDIS_URL` · `QUEUE_*` ·
`EMBEDDING_PROVIDER` extended for the Phase 3 winner + `EMBEDDING_DIM` ·
`ENCRYPTION_KEY_ID` (KMS) · `RECORDINGS_BUCKET` · `ADMIN_PROBE_SECRET`.

Rule: **per-tenant credentials live encrypted in the database, not in env.** Env holds platform
credentials only. Today's deployment-global Resend sender and WhatsApp number are the anti-pattern
being fixed.

## 20.3 Database migrations

The current process is "apply the files by hand", which is how `calendar_connections.status` came
to be queried against a column that does not exist. Fix, in Phase 0:

```text
CI          apply all migrations to a throwaway Postgres → diff against a committed schema
            snapshot → fail on drift
Staging     migrations applied automatically on merge to main
Production  migrations applied as an explicit, logged deploy step, before the app deploy
Rules       forward-only · idempotent (if not exists / on conflict) · additive first,
            destructive only after a full release cycle with the old path unused ·
            every migration has a paired down-script (except deliberate one-way drops,
            which are called out in this plan: 0018 receptionists → view)
```

## 20.4 Storage, telephony, STT/TTS

**Storage** — the existing `business-assets` bucket is **public-read** and correct for logos.
Recordings and transcripts require a **new private bucket**, signed URLs with short TTL, audited
access, and retention purging of storage objects (not just rows).

**Telephony** — Indian DIDs with KYC, per-tenant assignment, DLT/TRAI registration, a documented
number-porting/replacement path, and a secondary provider configured before the first campaign.

**STT/TTS** — regional endpoint closest to the telephony PoP (latency is the product); a fallback
provider configured; per-call provider recorded in `usage_records` so a quality regression is
attributable.

## 20.5 Monitoring, logging, alerts

Reuse the existing structured JSON logger and health endpoints (with `?deep=1` authenticated per
Phase 0). Add: trace ids end to end; metrics (turn latency, call-stage latency percentiles, tool
latency, error rate by provider, queue depth, dead-letter count, cost per tenant); error
aggregation.

**Alert on:** latency SLO breach (Phase 4 budget) · call failure rate > threshold · provider error
rate · dead-letter growth · queue depth/age · quota breach · migration drift · **any cross-tenant
access denial**, which should never happen and is therefore high-signal.

## 20.6 Backups and rollback

Today backups are entirely delegated to Supabase with **no documented RPO/RTO and no restore
drill**. Define both, enable PITR, and **run a restore drill before the first production tenant** —
an untested backup is not a backup.

| Layer | Rollback |
| --- | --- |
| App | Vercel instant rollback to the previous deployment |
| voice-gateway | Independent deploy; roll back without touching the monolith |
| Migrations | Paired down-scripts; additive-first sequencing means most rollbacks are app-only |
| Agent behaviour | Repoint `agents.live_version_id` — **no deploy** |
| Tool grants | Revoke in `agent_tools` — no deploy |
| Runtime | Per-agent `runtime: legacy \| halo` flag (Phase 2) |
| Channel | Disable the phone channel without touching the runtime (Phase 5) |
| Campaign | Pause — contacts stay `pending`, nothing is lost |

Four of these are configuration changes rather than deploys. That is deliberate: during a live
demo period, the fastest safe rollback must not require a build.

---

# 21. Development Workflow — Claude Code + Codex

## 21.1 Roles

**Claude Code — primary implementation agent.** Implements one phase (or one sub-phase PR) at a
time; writes the tests **with** the code; updates the docs the change invalidates; performs
controlled, scoped refactors.

**Codex — senior reviewer / verification agent.** Architecture review against this plan; code
review; security review (tenant isolation, tool safety, secrets, PII); concurrency and real-time
review (the media loop, queue semantics, idempotency, race conditions); test verification (do the
tests assert the thing they claim?); regression detection; and — most valuable — **identifying
incorrect assumptions**, since the audit shows this codebase punishes assumptions (a mistyped
import path took down the build; a non-existent column silently returned `[]`).

**Neither agent may redesign the architecture.** A proposed architectural change goes back to a
human as a written decision record under `docs/decisions/`, and this plan is amended before code
is written.

Both agents follow, in precedence order:
```text
1. docs/HALO_IMPLEMENTATION_PLAN.md   (this document — the what and the order)
2. docs/CURRENT_STATE_AUDIT.md        (the verified baseline)
3. docs/ARCHITECTURE.md               (the existing conventions)
```

## 21.2 The loop

```text
PLAN            a phase (or sub-phase) is scoped from this document; acceptance criteria copied
                verbatim into the PR description
  ↓
Claude implements one phase       one focused branch; no scope creep; existing conventions
  ↓
Tests                             written with the code; CI green locally
  ↓
Codex reviews                     architecture · security · concurrency · tests · regressions ·
                                  assumptions. Output: findings, not patches
  ↓
Fix issues                        Claude addresses each finding or records why not
  ↓
Tests again                       full CI green
  ↓
Human approval                    a person merges. Always
  ↓
Commit / merge                    conventional commits, matching the existing history style
  ↓
Next phase
```

## 21.3 Rules that this specific repository earns

1. **Verify against source, never against docs.** `docs/TESTING.md` claims 229 tests; there are
   319. `docs/ROADMAP.md` lists shipped work as pending. Implementation wins (Critical Rule 6).
2. **Never claim something is implemented when it is planned** (Critical Rule 17). PR descriptions
   state what is done, what is stubbed, and what is deferred, explicitly.
3. **Never touch the two database invariants** (`EXCLUDE USING gist`, `unique(workflow_id,
   event_id)`) without a decision record and a dedicated concurrency review.
4. **One phase per branch, one concern per PR.** Phase 1a in particular is *file moves only*; a
   semantic change smuggled into a move PR is the failure mode that kills extractions.
5. **Every production change has tests** (Critical Rule 16). A PR with no test needs a written
   reason in its description.
6. **Codex reviews the tests, not only the code.** The 3 failing voice-webhook tests were failing
   because the *route* is untestable (it constructs concrete classes inline instead of accepting
   injected dependencies) — a review that only reads the source would call the tests wrong and
   miss the design defect.
7. **Escalate contradictions.** If a phase cannot be implemented as written, stop and amend this
   document. Do not improvise the architecture in a PR.

## 21.4 What each agent must NOT do

| | Must not |
| --- | --- |
| Claude Code | Change the architecture · add a dependency without a decision record · create a migration outside a phase that plans one · widen a phase's scope · mark work complete without green acceptance criteria · introduce a business fact not sourced from a ⟨SUPPLIED⟩ document |
| Codex | Rewrite code (it produces findings) · approve a merge (a human does) · relax an acceptance criterion · re-litigate a decision already recorded in `docs/decisions/` |

---

# 22. Git / Branch Strategy

## 22.1 Existing convention (verified)

`git branch -a` → `main` and `origin/main` only. No branch convention exists yet to preserve.
Commit messages already follow a conventional style: `feat(lifecycle): …`, `fix(security): …`,
`feat: …`. **Keep that** and adopt the branch prefixes below.

## 22.2 Branches

```text
main                    always green, always deployable, protected — no merge without green CI
 ├── stabilization/*     Phase 0
 ├── halo-core/*         Phases 1, 6, 7, 9  (halo-core/extract-*, halo-core/agents-*,
 │                                           halo-core/tools-*, halo-core/workflows-*,
 │                                           halo-core/multilingual-*, halo-core/console-*)
 ├── agent-runtime/*     Phase 2
 ├── voice/*             Phase 4 spike (THROWAWAY, never merged) and Phase 5 media work
 ├── telephony/*         Phase 5 provider, calls, campaigns
 ├── arunodhaya/*        Phase 8 (config, knowledge, prompts — should touch no packages/)
 └── hardening/*         Phases 10, 11, 12
```

Rules: branch from `main`, rebase before merge, squash-merge to keep history readable, delete after
merge. `voice/spike-*` is **deleted, not merged** — its output is a decision memo.

## 22.3 Per-phase contract

Every phase branch carries:

| | |
| --- | --- |
| **Scope** | A named section of this document. Anything outside it is a separate branch |
| **Tests** | Written with the code; the phase's test table (§P*.5) is the checklist |
| **Acceptance criteria** | Copied verbatim from this document into the PR description and ticked individually |
| **Rollback** | Stated in the PR: revert, down-script, config flag, or version repoint |

## 22.4 Release and tags

Tag each milestone (`m0-stable`, `m1-halo-core`, …). During the Arunodhaya demo period, keep a
`release/demo` branch pinned to a known-good commit so a `main` regression cannot break a live
demo. Feature flags (`agent_versions.config.runtime`, channel enablement, per-tenant queue flag)
are preferred over long-lived branches — long-lived branches are how the extraction fails.

---

# 23. Phase Dependency Graph

```text
                        ┌──────────────────────────────────┐
                        │  PHASE 0 — Stabilize             │  BLOCKING. Nothing starts before it.
                        │  build · CI · lint · tests · sec │
                        └──────────────┬───────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        ▼ (parallel, decisions)        ▼ (critical path)              ▼ (parallel, procurement)
┌───────────────────┐        ┌───────────────────────┐      ┌──────────────────────┐
│ Embedding bake-off│        │ PHASE 1 — HALO Core   │      │ Vendor accounts,     │
│ → decision memo   │        │ 1a moves · 1b agents  │      │ Indian number KYC,   │
└─────────┬─────────┘        └───────────┬───────────┘      │ DLT/TRAI paperwork   │
          │                              │                  └──────────┬───────────┘
          │                              ▼                             │
          │                  ┌───────────────────────┐                 │
          │                  │ PHASE 2 — Agent       │                 │
          │                  │ Runtime (stream+tools)│                 │
          │                  └───────────┬───────────┘                 │
          │                              │                             │
          └──────────────┬───────────────┼──────────────┬──────────────┘
                         ▼               ▼              ▼
              ┌──────────────────┐ ┌──────────┐ ┌────────────────────┐
              │ PHASE 3          │ │ PHASE 6  │ │ PHASE 4 — VOICE    │
              │ Multilingual     │ │ Tool     │ │ SPIKE  ⟨GO/NO-GO⟩  │
              │ (Telugu, RAG)    │ │ Runtime  │ │ throwaway branch   │
              └────────┬─────────┘ └────┬─────┘ └─────────┬──────────┘
                       │                │                 │
                       │                ▼                 │  GO ─────────┐
                       │      ┌──────────────────┐        │  NO-GO ──────┼──▶ skip Phase 5;
                       │      │ PHASE 7          │        │              │    Arunodhaya ships
                       │      │ Workflow integr. │        │              │    on WhatsApp/web
                       │      └────────┬─────────┘        │              │
                       │               │                  ▼              │
                       │               │       ┌──────────────────────┐  │
                       │               │       │ PHASE 5 — Telephony  │  │
                       │               │       │ voice-gateway, calls,│  │
                       │               │       │ campaigns, transfer  │  │
                       │               │       └──────────┬───────────┘  │
                       └───────────────┴──────────┬───────┴──────────────┘
                                                  ▼
                                    ┌──────────────────────────┐
                                    │ PHASE 8 — ARUNODHAYA     │
                                    │ config · knowledge ·     │
                                    │ prompts · qualification  │
                                    │ ⟨needs ZERO packages/    │
                                    │  changes — the plan's    │
                                    │  own acceptance test⟩    │
                                    └────────────┬─────────────┘
                                                 ▼
                                      ┌────────────────────┐
                                      │  LIVE DEMO (M7)    │
                                      └──────────┬─────────┘
                                                 ▼
                    ┌────────────────────────────────────────────────────┐
                    │ PHASE 9 Console · PHASE 10 Cost · PHASE 11 Security │
                    │ PHASE 12 Testing  — PRODUCTION HARDENING (M8)      │
                    └────────────────────────────────────────────────────┘
```

## 23.1 Parallelizable work

| Can run in parallel | With | Condition |
| --- | --- | --- |
| Embedding bake-off | Phases 0–2 | Evaluation, not integration. **Must** finish before Phase 3 |
| Vendor accounts + number KYC + DLT | Phases 0–3 | Pure procurement, 1–3 weeks of calendar time. **Start day 1** |
| Phase 4 voice spike | Phases 1–2 | Throwaway branch; needs no HALO code |
| Phase 3 (multilingual) | Phase 6 (tools) | Different subsystems, no shared files |
| Phase 6 (tools) | Phase 7 (workflows) | Phase 7 consumes the registry but can be developed against its interface |
| Phase 9 (console) | Phases 8, 10, 11 | Additive UI |
| Phase 10 (cost) | Phases 8, 9 | Capture already landed in Phase 2 |
| Arunodhaya knowledge authoring ⟨SUPPLIED⟩ | Phases 1–7 | **Not engineering.** The content request (§P8.13) goes out in week 1 |
| Telugu eval-set authoring | Phases 1–2 | Native speakers, not engineers |

## 23.2 Hard serializations (do not attempt to parallelize)

```text
Phase 0 → everything          A red build makes every other measurement meaningless
Phase 1 → Phase 2             The runtime needs the agent model to read its config from
Phase 2 → Phase 5             Streaming + tools are prerequisites; debugging tool calls over a
                              phone line is an order of magnitude harder than in a browser
Phase 3 → Phase 8             Telugu retrieval must be proven before the Telugu agent
Phase 4 → Phase 5             The gate exists precisely to prevent building the wrong stack
Phase 6 → Phase 8             The agent is tool grants; the tools must exist
Embedding decision → Phase 3  Implementing before deciding means migrating twice
```

## 23.3 Critical path

```text
Phase 0 → Phase 1 → Phase 2 → Phase 6 → Phase 5 → Phase 8 → Demo
                              (with Phase 3 alongside 6, and Phase 4 gating 5)
```
Phases 9–12 are **not** on the demo critical path — with the deliberate exceptions already pulled
earlier: cost capture into Phase 2, security fixes into Phase 0, compliance into Phase 5.

---

# 24. Effort Estimation

Sizes: **S** ≈ 1–3 days · **M** ≈ 1–2 weeks · **L** ≈ 3–5 weeks · **XL** ≈ 6+ weeks.
Engineering days are **one engineer's focused days**, excluding calendar delays for procurement,
native-speaker availability, and ⟨SUPPLIED⟩ content.

**These are not optimistic.** They assume the media loop is **bought**, not built; if built
in-house, Phase 5 roughly doubles (the audit's §5 verdict is "major rewrite"; a 3–6 month effort
with a real-time audio specialist).

| Phase | Size | Eng. days | Biggest driver | What could change it |
| --- | --- | --- | --- | --- |
| **0 — Stabilize** | S | **4–6** | CI + migration-drift check; the build fix is hours | Rewriting the Jest test file and typing away 31 `any`s can stretch. Removing the Vapi stack *reduces* it |
| **1a — Extract (moves)** | M | **8–12** | Review throughput, not invention | Scope creep is the whole risk. Path-alias churn across ~200 files can surprise |
| **1b — Agent model** | M | **10–15** | Threading `agent_id` through ~15 service call sites and 18 dashboard pages | If the receptionist→agents data migration hits edge cases, +3–5 days |
| **2 — Agent Runtime** | L | **20–28** | Streaming + tools across 4 adapters; rewriting the turn loop without regressing 316 tests | **Highest variance in the plan.** If tool-calling behaviour differs materially between Ollama/Anthropic/Gemini/OpenAI, +5–8 days of adapter work |
| **3 — Multilingual** | M–L | **15–22** | The eval set, the bake-off, the re-embedding migration, and rewriting ~20 English heuristics | Depends on native-speaker availability for the eval set. If the winning model needs self-hosting, +5 days of infra |
| **4 — Voice spike** | S–M | **6–10** eng. days, **2–4 weeks calendar** | Recording sessions and native-speaker MOS scoring | **Calendar-bound, not effort-bound.** Indian number KYC and DLT registration can take 1–3 weeks alone |
| **5 — Telephony** | L | **25–35** | voice-gateway, barge-in, call model, campaigns, compliance | **Doubles (50–70 days) if the media loop is built in-house.** Compliance (DNC/DLT/consent) is easily +5 days that teams forget to plan |
| **6 — Tool Runtime** | M | **10–15** | Safety classes and per-tool schemas for ~14 tools | Low variance. The registry shape already exists |
| **7 — Workflows** | M | **10–15** | Durable queue + shadow period; version-pinning fix | Queue vendor choice. Semantics are unchanged, which caps the risk |
| **8 — Arunodhaya** | M | **10–15** | Knowledge authoring, qualification schema, Telugu prompts, calibration | **Blocked on ⟨SUPPLIED⟩ content.** If PDFs arrive and ingestion must be built, +5–8 days. If it needs `packages/` changes, an earlier phase failed and the cost is that phase's rework |
| **9 — Console** | L | **15–20** (P0 screens: **8–10**) | Calls screen + agent config editor | Only the P0 four are demo-critical |
| **10 — Cost/Observability** | M | **8–12** | Rate tables, quotas, trace ids, dashboards | Capture already landed in Phase 2, which removes most of the risk |
| **11 — Security** | M–L | **15–20** | RLS db tests, credential encryption, recording security, audit log | A penetration test's findings are unbounded by definition |
| **12 — Testing** | M | **10–15** | db harness, E2E, eval harness | Beyond per-phase testing, which is already counted in each phase |

**Totals (bought media loop):**
- Demo critical path (0, 1, 2, 3, 4, 5, 6, 8): **108–158 engineering days**
- Full production HALO (all phases): **166–240 engineering days**

## 24.1 One developer

Sequential; no parallelism except during procurement waits. Assumes ~4.5 productive days/week.

| Milestone | Elapsed |
| --- | --- |
| M0 Stable | week 1–2 |
| M1 HALO Core | week 6–8 |
| M2 Agent Runtime | week 12–14 |
| M3 Telugu validated | week 16–19 |
| M4 Voice stack validated | week 18–21 *(spike overlaps the M3 procurement wait)* |
| M5 Phone calling | week 25–30 |
| M6 Arunodhaya agent | week 28–34 |
| **M7 Live demo** | **week 30–36  (≈ 7–8 months)** |
| M8 Production candidate | week 42–52 |

**One developer is not a realistic plan for M7.** Phases 3 and 4 need native Telugu speakers who
are not the developer, and Phase 5's real-time audio work is a distinct specialism.

## 24.2 Two developers

Dev A: core/runtime/tools/workflows. Dev B: voice/telephony/multilingual + procurement.

| Milestone | Elapsed |
| --- | --- |
| M0 | week 1 |
| M1 | week 4–5 |
| M2 | week 8–10 |
| M3 / M4 | week 11–13 *(B runs Phase 3 + Phase 4 while A does Phases 2, 6)* |
| M5 | week 17–21 |
| M6 | week 19–23 |
| **M7 Live demo** | **week 20–24  (≈ 5–6 months)** |
| M8 | week 28–34 |

This closely matches the audit's 2–3 engineer estimate of 13–17 weeks to the *critical path* — the
difference is that this table counts the Arunodhaya content wait, the procurement wait, and the
native-speaker evaluation cycles, which the audit's figure excluded.

## 24.3 Claude + Codex assisted (2 developers + AI)

Honest about where AI assistance actually helps and where it does not.

**Large speed-up (1.5–2×):** Phase 1a file moves and alias rewrites · adapter extension across 4
LLM providers · schema and migration drafting · test authoring · JSON Schemas for ~14 tools ·
dashboard CRUD screens · documentation.

**Moderate (1.2–1.4×):** Phase 2 runtime (the design is the hard part; the typing is not) ·
Phase 6 · Phase 7 · Phase 10.

**Little or none:** Phase 4 (recording sessions, native-speaker MOS, vendor procurement, number
KYC) · Phase 3's eval-set authoring and Telugu judgement · Phase 5's real-time audio debugging,
which is empirical and hardware/network-bound · Phase 8's ⟨SUPPLIED⟩ content · anything waiting on
a person.

| Milestone | Elapsed |
| --- | --- |
| M0 | week 1 |
| M1 | week 3–4 |
| M2 | week 6–8 |
| M3 / M4 | week 9–11 |
| M5 | week 14–17 |
| M6 | week 16–19 |
| **M7 Live demo** | **week 17–20  (≈ 4–5 months)** |
| M8 | week 23–28 |

**Roughly a 20–25% compression, not 2×.** The critical path is dominated by items AI does not
accelerate: procurement calendar time, native-speaker evaluation cycles, real-time audio
debugging, and waiting for business content. Claiming more than this would be exactly the
artificial optimism the brief warns against.

## 24.4 Dependencies that could change every estimate

| Dependency | Effect if it goes badly |
| --- | --- |
| **Phase 4 NO-GO** | Phase 5 (25–35 days) is deferred entirely; M7 becomes a WhatsApp/web demo, reachable **6–8 weeks earlier**. A NO-GO is *faster*, not slower — it is the risk being paid down |
| **⟨SUPPLIED⟩ content arrives late** | Phase 8 stalls with everything else complete. **Send the §P8.13 request in week 1.** This is the cheapest schedule insurance available |
| **Indian number KYC / DLT delay** | Phases 4 and 5 both slip. 1–3 weeks calendar. Start day 1 |
| **Native-speaker availability** | Phases 3, 4, 8 and every release gate slip. Secure 5–6 speakers up front |
| **Media loop built in-house** | Phase 5 doubles to 50–70 days; +6–8 weeks |
| **Embedding winner needs self-hosting** | +5 days infra and an ongoing operational burden |
| **Tool-calling differs materially across the 4 LLM providers** | +5–8 days in Phase 2 |
| **Phase 8 needs `packages/` changes** | Phase 1 or 6 was wrong; rework, and the abstraction is suspect |
| **The queue changes workflow behaviour under load** | Phase 7 shadow period extends; the fallback is today's inline execution |
| **Penetration-test findings** | Unbounded by definition; budget a buffer before the first production tenant |

---

# 25. Milestones

### M0 — Existing AI Receptionist Stable
- **Deliverables:** green build/lint/typecheck/tests; CI on every push; Vapi stack removed;
  `calendar_connections.status` fixed; deep health authenticated; preflight wired; migration-drift
  check; docs reconciled.
- **Tests:** all Phase 0 gates, including the **restored** multi-tenant isolation test.
- **Acceptance:** §P0.7 in full, green in CI.
- **Demo capability:** the existing chat receptionist, deployable, with regression protection.

### M1 — HALO Core Extracted
- **Deliverables:** npm workspaces; `packages/*` + `apps/receptionist`; `agents` +
  `agent_versions` + config resolver; `receptionists` data-migrated; conversations pinned to an
  agent version; prompt content in data; boundary lint.
- **Tests:** every pre-existing test passes unchanged; new agent-model tests; boundary check green.
- **Acceptance:** §P1.3.
- **Demo capability:** create a second agent of a different type for a tenant; publish v2 and roll
  back to v1 **without a deploy**.

### M2 — Agent Runtime Working
- **Deliverables:** streaming + tool-calling LLM port across 4 adapters; the agent loop; SSE to the
  widget; booking as a real tool; `messages.role='tool'`; per-turn usage capture; rolling summary.
- **Tests:** all pre-existing booking/chat integration tests pass **unchanged**; validator rejects
  unsupported action claims; phone-shaped `ChannelProfile` drives the loop in a harness.
- **Acceptance:** §P2.6.
- **Demo capability:** the live chat product, streaming, with tool-mediated booking.

### M3 — Telugu Intelligence Validated
- **Deliverables:** embedding decision memo; `knowledge_embeddings` + ANN index + per-collection
  FTS config; ≥ 200-query Telugu eval set; language packs replacing English-only heuristics;
  Telugu numeral/currency/capacity parsers; Telugu prompt templates and lifecycle copy.
- **Tests:** Recall@10 ≥ 0.85 and nDCG@5 ≥ 0.70 in **every** bucket; code-switch gap ≤ 0.10;
  retrieval p95 ≤ 250 ms; English tenants byte-identical.
- **Acceptance:** §P3.8.
- **Demo capability:** a **Telugu text** agent answering grounded solar questions with citations.

### M4 — Voice Stack Validated ⟨GO/NO-GO⟩
- **Deliverables:** `docs/decisions/0002-voice-stack.md` — per-vendor STT WER and field-level
  exact-match, blind native-speaker MOS, the measured latency table, the named stack, the ratified
  budget, and a written GO / CONDITIONAL GO / NO-GO.
- **Tests:** ≥ 60 phone-quality utterances from ≥ 6 speakers; ≥ 30 instrumented calls; MOS from
  ≥ 5 native speakers.
- **Acceptance:** §P4.8.
- **Demo capability:** one recorded Telugu call played to stakeholders **with its measured
  latency**, and an honest verdict.

### M5 — Phone Calling Working
- **Deliverables:** `services/voice-gateway`; telephony port + adapter; ported voice session; VAD +
  barge-in; streaming STT/TTS; `calls`/`call_events`/transcripts/outcomes; recordings with consent;
  campaigns with DNC and call windows; warm transfer.
- **Tests:** §P5.9, including failure injection and ≥ 20 native-scored live calls.
- **Acceptance:** §P5.10.
- **Demo capability:** an outbound Telugu call that qualifies a prospect and books a site visit.

### M6 — Arunodhaya Agent Working
- **Deliverables:** the agent version, ⟨SUPPLIED⟩ knowledge, qualification schema, objection
  handling, guardrails, `solar_sizing` + `check_service_area`, workflows, Telugu policy, CRM
  mapping.
- **Tests:** §P8.15, including the "zero `packages/` changes" test.
- **Acceptance:** §P8.15.
- **Demo capability:** end-to-end — call → qualify → book → confirm in Telugu → CRM → structured
  outcome to the sales team.

### M7 — Live Demo Ready
- **Deliverables:** P0 console screens (Calls, Leads, Agents, Agent Configuration); a seeded demo
  tenant; a `release/demo` pinned branch; a runbook; a rehearsed fallback (recorded call) if the
  network fails on the day.
- **Tests:** ≥ 20 scored live calls; a full dry run on production infrastructure; a restore drill.
- **Acceptance:** a stakeholder places or receives a real Telugu call and sees the outcome in the
  dashboard within one minute of hang-up.
- **Demo capability:** the pitch, live.

### M8 — Production Candidate
- **Deliverables:** Redis rate limiting; durable queue; credential encryption; audit log; RLS db
  tests; E2E suite; eval harness in CI; cost dashboards and quotas; retention covering recordings,
  transcripts and workflow history; alerting; backup/restore drill; penetration test complete.
- **Tests:** §P11.3, §P12.5; production readiness re-scored ≥ 8/10 against the audit's §11 rubric.
- **Acceptance:** multi-instance safe · observable · cost-attributed · audited · RLS and
  conversation quality under automated test · no critical penetration findings open.
- **Demo capability:** onboard a second real tenant without engineering involvement.

---

# 26. Definition of "Fully Functional HALO"

## 26.1 MVP — required for Arunodhaya to go live (M7)

```text
✓ Multi-tenant                    EXISTS — keep
✓ Multiple agents per business    Phase 1
✓ Agent configuration             Phase 1
✓ Agent versioning                Phase 1
✓ Knowledge / RAG                 EXISTS — refactor (Phase 3)
✓ Multilingual                    Phase 3
✓ Telugu                          Phase 3
✓ Chat                            EXISTS
✓ Phone calls (outbound-first)    Phase 5  ⟨gated by Phase 4⟩
✓ Streaming STT / TTS             Phase 5  ⟨gated by Phase 4⟩
✓ Barge-in                        Phase 5  ⟨gated by Phase 4⟩
✓ Inbound calls                   Phase 5
✓ Lead qualification              EXISTS — generalize (Phases 2, 8)
✓ CRM                             EXISTS
✓ Calendar                        EXISTS
✓ Workflows                       EXISTS
✓ Messaging (WhatsApp, email)     EXISTS — fix + Telugu templates
✓ Call recordings + transcripts   Phase 5
✓ Structured outcomes             Phase 5
✓ Usage / cost tracking           Phase 2 capture + Phase 10 aggregation
✓ Security (tenant isolation, consent, recording privacy)   Phases 0, 5, 11 (partial)
✓ Automated tests                 Phases 0, 12 (per-phase)
✓ Production deployment           Phases 0, 20
✓ Minimum control plane           Phase 9 P0 screens only
```

## 26.2 Production HALO — required before a second paying tenant (M8)

```text
+ Human handoff (warm transfer, availability model)     Phase 5 → hardened
+ Analytics (funnels, cohorts, charts, call metrics)    Phase 9/10
+ Full observability (traces, metrics, alerts)          Phase 10
+ Complete security posture (encryption at rest, audit log, RLS db tests,
  retention over recordings/transcripts/workflow history, pen test)   Phase 11
+ Redis rate limiting + durable queue                   Phases 7, 11
+ Full control plane (agent builder, campaigns, knowledge ingestion,
  integrations, tenant/agent switcher, cost dashboard)  Phase 9
+ Eval harness in CI (golden transcripts, LLM judge)    Phase 12
+ E2E + RLS db tests                                    Phase 12
+ Per-tenant provider credentials                       Phase 11
+ SMS adapter + WhatsApp templates                      Phase 6
+ Backup/restore drill with documented RPO/RTO          Phase 20
+ Tenant quotas and billing-grade cost attribution      Phase 10
```

## 26.3 Future HALO — deliberately deferred

```text
Agent marketplace / templates          Multi-agent collaboration (agent-to-agent handoff)
Visual agent builder                   A/B testing between agent versions in production
Branching / parallel workflow steps    Workflow cancellation + dead-letter replay UI
Native CRM adapters (HubSpot, SFDC)    Real OpsProvider adapter
Additional Indic languages             Voice cloning / custom brand voices
Payments and subscriptions             Self-serve tenant onboarding
Knowledge auto-refresh (URL crawl)     Sentiment and coaching analytics
Predictive lead scoring (ML)           Multi-region deployment
```

**Do not build any of §26.3 before Arunodhaya works** (Critical Rule 12). Each is defensible in
isolation and collectively they are how a platform never ships its first customer.

---

# 27. Final Recommended Build Order

> *"If we start Monday morning, what exactly do we build first, second, third, and why?"*

Week 1, in parallel, on day 1:
**(a)** an engineer starts item 01; **(b)** someone non-engineering sends the §P8.13 content
request to Arunodhaya and starts vendor accounts + Indian number KYC + DLT registration.
Both are on the critical path, and (b) is calendar-bound, not effort-bound.

| # | Build | Depends on | Why here |
| --- | --- | --- | --- |
| **01** | **Fix the two `@/lib/errors` imports** | — | Two lines. Restores `next build` and 13 test files, including the only tenant-isolation test. Highest ratio of value to effort in the entire plan |
| **02** | **Establish CI** (lint · tsc · vitest · build · preflight · **migration drift**) | 01 | Nothing gates merges today, which is *how* one typo took down the build and how a query against a non-existent column shipped. Every later phase is unsafe without this |
| **03** | **Green the suite** — Jest→Vitest rewrite, test type errors, 31 `any`s | 02 | The red is masking the tenant-isolation check. A red baseline makes every later measurement meaningless |
| **04** | **Close the security gaps and delete the Vapi stack** — fail-closed webhook, authenticate `?deep=1`, notification-factory fix, `calendar_connections.status` | 02 | One-liners with real exposure. Deleting Vapi removes a live unauthenticated booking surface *and* 3 failing tests |
| **05** | **Decide the multilingual embedding architecture** *(parallel, non-blocking)* | — | The `vector(768)` trap plus the deliberately-throwing OpenAI path means Telugu retrieval is blocked on a **schema decision**, not on a prompt. Deciding late means migrating twice. Output: a decision memo, not code |
| **06** | **Run the Telugu STT/TTS + telephony spike** ⟨GO/NO-GO⟩ *(parallel, throwaway)* | vendor accounts | The only genuine unknown in the plan. A bad answer changes the **architecture**, not the schedule. Running it early costs one engineer-week and can save six |
| **07** | **Extract HALO Core (1a)** — workspaces + file moves | 03 | Mechanical, reviewable, and the receptionist stays green as the regression harness. Do it before anything grows new coupling |
| **08** | **Introduce the agent model (1b)** — `agents`, `agent_versions`, prompt content to data | 07 | The one structural change that must precede everything multi-agent. `receptionists` is one flat row with no type, tools, model config or version, and `requireBusiness()` assumes one business per user |
| **09** | **Build the Agent Runtime** — streaming, tools, loop, cost capture | 08 | The largest new engineering, and it is proven on **text** first. Debugging tool calls in a browser is an order of magnitude cheaper than over a phone line |
| **10** | **Build the Tool Runtime** — one registry, schemas, safety classes, audit | 09 | The safety classification must land **before** the tools, because letting a model choose a webhook URL or a message recipient is the most dangerous change available in this codebase |
| **11** | **Build multilingual retrieval** — schema, ANN index, eval set, language packs *(parallel with 10)* | 05, 08 | Highest-risk **non-voice** item and routinely underestimated. English FTS over Telugu is near-noise, and ~20 English regexes silently no-op — which looks like working software |
| **12** | **Integrate workflows** — agent/call events, durable queue, version pinning | 09 | The engine is the strongest asset here (8/10) and needs no semantic change. Connecting agents to it costs days and unlocks the entire post-call journey |
| **13** | **Build the phone voice runtime** — voice-gateway, VAD, barge-in, streaming STT/TTS | 09, 11, **06 = GO** | Only now, and only with a measured latency budget and a validated Telugu stack |
| **14** | **Integrate telephony** — calls, campaigns, recordings, consent, transfer, DNC/DLT | 13 | Compliance is a Phase 5 requirement, not later polish; outbound calling in India carries real regulatory weight |
| **15** | **Build the Arunodhaya agent** — config, ⟨SUPPLIED⟩ knowledge, qualification, guardrails | 10, 11, 12, 14 | Should require **zero `packages/` changes**. If it does not, an earlier step was wrong — and finding that out here is exactly what this ordering is for |
| **16** | **Build the P0 console screens** — Calls, Leads, Agents, Agent Configuration | 08, 14 | Deliberately after 15. Building the agent builder before you know what an agent needs produces the wrong builder; the demo can run on seeded config |
| **17** | **Run live tests** — ≥ 20 scored Telugu calls, native speakers, real PSTN | 15, 16 | The only way to know. Automation cannot certify that an agent sounds like a person |
| **18** | **Production hardening** — Redis, encryption, audit log, RLS db tests, E2E, evals, cost dashboards, quotas, retention, pen test, restore drill | 15 | Everything the audit scored 5/10 against. Not before a working agent; not after a second tenant |

**Why this differs from a naive ordering:** the spike (06) and the embedding decision (05) run
*before* extraction rather than after, because they are the only decisions whose answers change the
architecture. The console (16) comes after the agent (15) rather than before. And cost capture,
security fixes and compliance are pulled into 04/09/14 rather than deferred to 18 — because you
cannot price a voice product blind, and you cannot legally place outbound calls in India after
the fact.

---

# 28. Final Decision

```text
HALO IMPLEMENTATION STRATEGY
============================

Starting Point:
AI Receptionist — multi-tenant Next.js 16 modular monolith on Supabase.
26 tables, 12 migrations, 48 test files, 18 dashboard pages.
Chat product with a browser-speech accessory. No telephony, no streaming,
no server-side speech, no tool calling, no agent model.
Working tree currently fails build, typecheck, lint and tests.

Strategy:
Extract into HALO Core (audit Strategy 4).
Lift core/ + ports/ + providers/ into workspace packages; keep the AI
Receptionist alive as HALO's first tenant application AND its regression
harness; build the agent runtime and voice runtime as new packages beside
them. Single monorepo, git history preserved via git mv. Exactly one
process separation: services/voice-gateway, justified by runtime profile
(stateful, minutes-long, latency-critical audio) and by nothing else.

Foundation Quality:
6.5 / 10
  Data layer, workflow engine and appointment engine:            8–9/10
  Provider abstraction, error handling, security primitives:     8/10
  AI runtime as an agent runtime (audit §4):                     6/10
  Voice/telephony:                                               1/10
  Production readiness (audit §11):                              5/10
  Current build/test state:                                      0/10 — all four gates red
The architecture is better than the operational state. The gaps are
infrastructural, not architectural — which is the cheap kind of problem.

Estimated Current HALO Completion:
~35%
  Weighted by value rather than line count. The ~45% "reusable foundation"
  from the audit is discounted here because a genuinely complete HALO must
  also be multi-agent, multilingual, streaming, tool-calling, voice-capable
  and cost-attributed — and it is 0% of those today. What exists is the
  expensive-to-get-right back half: tenancy, scheduling, workflows, CRM,
  lifecycle, knowledge structure, ports, and the conversational doctrine.

Estimated Remaining Work:
  Demo critical path (Phases 0–6, 8):     108–158 engineering days
  Full production HALO (all phases):      166–240 engineering days
  Two developers → live demo:             ~5–6 months
  Two developers + Claude/Codex:          ~4–5 months (a 20–25% compression,
    not 2× — the critical path is dominated by procurement calendar time,
    native-speaker evaluation cycles, real-time audio debugging, and waiting
    for Arunodhaya's business content, none of which AI accelerates)
  Add ~6–8 weeks if the media loop is built in-house rather than bought.

Highest Risk:
Telugu voice quality and end-to-end latency — the two things that decide
whether the Arunodhaya demo sounds like a person or a robot, and NEITHER HAS
BEEN MEASURED. Today the runtime makes up to three blocking LLM calls per
turn with no streaming; the first call alone can exceed the entire commonly
cited 800 ms budget, and that budget is itself a Western-datacenter,
English-model figure that should not be assumed for Telugu over Indian PSTN.
This is why Phase 4 is a gate and not a task.

  Runner-up: the service-role / RLS-bypass pattern. Most of the interesting
  code runs on the service role with tenancy enforced only in TypeScript,
  across ~15 id-keyed queries with no database backstop — and the single
  automated check of that property, multi-tenant-isolation.test.ts, does not
  currently compile. Every new HALO table inherits this pattern unless the
  "RLS policies in the same migration" rule is enforced from Phase 1.

Highest Technical Dependency:
Streaming + tool calling in the LLM port (Phase 2).
Everything downstream requires it: voice needs first-token latency, not
full-response latency; the tool runtime needs tool calls; the agent loop
needs both; barge-in needs a cancellable stream. The port has neither today
(verified — the complete interface is complete(), isHealthy()). It is on the
critical path, it touches all four adapters and every caller of
ChatService.respond, and it is deliberately proven on text chat before any
phone line exists.

First Go/No-Go Decision:
The Phase 4 Telugu voice spike — STT accuracy on numbers/names/code-switching,
TTS naturalness by blind native-speaker MOS over a phone line, and MEASURED
end-of-speech → first-audio latency, on a throwaway branch that is never
merged. Thresholds: mobile-number exact-match ≥95%, TTS MOS ≥3.8, p95 ≤2.0 s.
  NO-GO is a legitimate and cheap outcome: because the agent runtime is
  channel-independent by construction, removing the phone channel costs no
  rework, and Arunodhaya ships as a Telugu WhatsApp/web agent 6–8 weeks
  EARLIER. The gate exists to make that choice available, not to be passed.

  Second gate: the embedding-architecture decision, which must be made before
  Phase 3 because vector(768) is baked into the schema and the OpenAI path
  deliberately throws. Deciding late means migrating twice.

First Customer:
Arunodhaya Solar Systems.
NOTE: no Arunodhaya business document exists in this repository (verified).
Every product, price, subsidy, warranty, service-area, sizing-rule and
objection-response fact must be supplied by the business before Phase 8
begins. The request list is §P8.13 and should be sent in week 1 — it is the
cheapest schedule insurance in this plan.

First Agent:
Telugu Solar Sales & Qualification Agent.
Type 'sales'. Outbound-primary. Built entirely from agent configuration,
knowledge, prompts, a qualification schema, two computational tools and
workflow definitions. It should require ZERO changes under packages/ —
that is the acceptance test for the whole extraction.

Target MVP:
A Telugu-speaking agent that reaches a prospect, qualifies them against a
structured schema with verified numbers, handles objections within its
guardrails, books a site visit through the EXISTING appointment engine
(double-booking still arbitrated by the Postgres EXCLUDE constraint),
confirms in Telugu, updates the CRM, fires the follow-up workflow, and
delivers a structured outcome with transcript and recording to the sales
team — on phone if Phase 4 returns GO, on WhatsApp/web if it does not.
Plus four console screens: Calls, Leads, Agents, Agent Configuration.
  → Milestone M7. Two developers: ~5–6 months. With Claude+Codex: ~4–5 months.

Target Production:
Multi-instance safe (Redis rate limiting, durable queue), observable
(traces, metrics, alerts, per-tenant cost attribution and quotas), secure
(RLS policies tested against a real Postgres, credentials encrypted at rest,
recordings private and consented, audit log, retention covering recordings,
transcripts and workflow history, penetration test complete), and covered
(unit, integration, db, E2E and conversation evals in CI, plus a documented
native-speaker call-scoring gate per release). Production readiness re-scored
≥8/10 against the audit's rubric. A second tenant can be onboarded without
engineering involvement.
  → Milestone M8. Two developers: ~7–8 months. With Claude+Codex: ~6 months.
```

---

*Plan authored 2026-09-04 against commit `1cd187d` plus the uncommitted working tree.
All build, lint, typecheck and test results in §1.4 were **executed**, not inferred; the
verification log is §1.7 and the three discrepancies found against the audit are §1.8.
No application source was modified, no migration was created, no dependency was installed, and
nothing in this document is implemented.*
