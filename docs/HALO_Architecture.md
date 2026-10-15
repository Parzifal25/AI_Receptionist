# HALO Architecture

**Version:** 1.0 (consolidated) · **Date:** 2026-10-15 · **Authority:** the single authoritative architecture ([DECISIONS.md G4](DECISIONS.md#g4--documentation-authority)).

This document replaces blueprint v0.1 as the architecture of record. The blueprint is preserved unchanged at [archive/HALO_BLUEPRINT_v0.1.md](archive/HALO_BLUEPRINT_v0.1.md), its principles remain in force ([G1](DECISIONS.md#g1--target-design-and-engineering-principles)), and "blueprint §N" citations throughout the repository refer to that archived copy.

> This document separates what HALO **is** (verified), what the owner **approved**, what is **proposed**, and what is **unknown or blocked**. It is not a status report ([HALO_V1_STATUS.md](HALO_V1_STATUS.md)) and not a plan ([HALO_V1_IMPLEMENTATION_PLAN.md](HALO_V1_IMPLEMENTATION_PLAN.md)), and it grants no approval. Nothing in it is evidence that HALO is pilot-ready or production-ready.

---

## 1. How to read this document

### 1.1 Authority and related documents

| Question | Authoritative source |
|---|---|
| What the architecture is and must become | this document |
| What has been decided, and what is pending | [DECISIONS.md](DECISIONS.md) |
| Current status of the ten release criteria | [HALO_V1_STATUS.md](HALO_V1_STATUS.md) (ratified as status authority, R2) |
| What is missing for V1, with acceptance criteria | [HALO_V1_GAP_ANALYSIS.md](HALO_V1_GAP_ANALYSIS.md) |
| The order in which to close gaps | [HALO_V1_IMPLEMENTATION_PLAN.md](HALO_V1_IMPLEMENTATION_PLAN.md) |
| Subject detail, runbooks, evidence, experiments | the document map in [§15](#15-document-map) |

**Conflict rule:** source code and [DECISIONS.md](DECISIONS.md) outrank any prose. When a retained subject document disagrees with this one, this document and the code win, and the disagreement is listed in [§13](#13-known-limitations) or [§15](#15-document-map). Under `AGENTS.md`, a gap between code and target is recorded for the owner to decide; it is never silently "fixed" in either direction.

### 1.2 Classification labels

| Label | Meaning |
|---|---|
| **VERIFIED** | Exists, supported by inspected source or reproducible test evidence. Always paired with an evidence level from §1.3. VERIFIED does not mean "works in production". |
| **APPROVED** | Target explicitly approved in [DECISIONS.md](DECISIONS.md): a G-entry, an R-entry, or an APPROVED D-entry. |
| **PROPOSED** | Recommended but **not** approved. Always cites the PENDING decision or plan task. |
| **UNKNOWN** / **BLOCKED** | Insufficient evidence, or waiting on a missing decision, authorization, environment or external input. |

### 1.3 Evidence levels

| Level | Meaning | Most recent instance |
|---|---|---|
| `source` | Code, configuration or a migration was inspected | Consolidation inspection, 2026-10-14/15 |
| `local test` | Automated tests on local infrastructure using fakes, mocks, scripted models or synthetic media. These results are reported by dated records, not re-run here. | Full TypeScript suite: 156 files, 1,602 passed, 5 skipped. Worker: 70 tests, 1 skipped. Both 2026-10-14 ([HALO_LAYER_1_REVIEW.md](HALO_LAYER_1_REVIEW.md)). |
| `disposable DB` | Migrations, real-role RLS checks or a restore on a throwaway PostgreSQL instance | 31 migrations, 109 RLS assertions, 44-table restore (41 `public` tables plus CI-stub `auth`/`storage` tables) plus a 15-assertion chat journey, 2026-10-13 ([HALO_THREE_GATE_EXECUTION.md](HALO_THREE_GATE_EXECUTION.md)) |
| `provider` | A real provider request with a recorded outcome | LLM metadata GETs (2026-10-13); LLM completions (2026-09-24, 2026-10-01); one failed free-model inference (2026-10-13) |
| `browser-live` | A real browser microphone through the Pipecat worker to live Sarvam STT/TTS | 2026-10-06, self-reported in the `services/pipecat-worker/worker.py` docstring; no evidence artifact retained |
| `staging`, `production`, `pilot` | Deployed or customer evidence | **None exists** |

A mock is not proof of provider behaviour. A passing build is not proof of deployment. `browser-live` is not telephony.

---

## 2. Purpose and V1 scope

### 2.1 What HALO is

- **APPROVED ([G1](DECISIONS.md#g1--target-design-and-engineering-principles)):** HALO is a multi-tenant **AI employee execution platform**.
  - One shared runtime executes many agents.
  - Each tenant gets agents defined by configuration: identity, objective, policies, knowledge, tools, workflows and voice. A tenant never gets its own codebase.
  - Business-specific behaviour belongs in tenant configuration and adapters.
  - Providers are replaceable, and HALO is independent of OpsCorp.
  - The language model decides; deterministic tools act.
  - The first use case is a Telugu/Tenglish voice sales agent for Arunodhaya Solar Systems ([R3](DECISIONS.md#r-series--release-owner-decisions), R4).
- **VERIFIED (`source`):** HALO grew out of a multi-tenant "AI Receptionist" SaaS: an embeddable web widget, a dashboard, booking, workflows, a built-in CRM and customer lifecycle features.
  - The HALO core was extracted into `packages/*`.
  - The receptionist survives as a compatibility mapping: widget key → receptionist → agent → published version.

### 2.2 V1 outcomes

The owner stated the following V1 outcomes in the consolidation request of 2026-10-14. Release direction is ratified in R1–R7: production-ready GA as the target, the ten release criteria retained, pilot channels of voice, chat, workflows and integrations, Telugu first, at least one real provider-backed integration, provisional numeric targets, and mandatory security, recovery and operations gates.

| # | V1 outcome | Architecture | Gap analysis |
|---|---|---|---|
| 1 | Tenant isolation | [§4](#4-platform-and-tenancy), [§8.3](#83-tenant-scoped-access-rls-and-server-side-authorization) | [Outcome 1](HALO_V1_GAP_ANALYSIS.md#outcome-1--tenant-isolation) |
| 2 | Secure data, privacy and reliable database access | [§8](#8-data-and-security) | [Outcome 2](HALO_V1_GAP_ANALYSIS.md#outcome-2--secure-data-privacy-and-reliable-database-access) |
| 3 | Telemetry and operational observability | [§9](#9-telemetry-and-operations) | [Outcome 3](HALO_V1_GAP_ANALYSIS.md#outcome-3--telemetry-and-operational-observability) |
| 4 | Calendar integration | [§7.4](#74-calendar-booking-rescheduling-and-cancellation) | [Outcome 4](HALO_V1_GAP_ANALYSIS.md#outcome-4--calendar-integration) |
| 5 | Effective sales intelligence and tactics | [§7.1–7.3](#71-lead-lifecycle-and-qualification) | [Outcome 5](HALO_V1_GAP_ANALYSIS.md#outcome-5--sales-intelligence-and-tactics) |
| 6 | Natural, accurate, low-latency Telugu voice | [§6](#6-conversation-and-voice-pipeline) | [Outcome 6](HALO_V1_GAP_ANALYSIS.md#outcome-6--natural-accurate-low-latency-telugu-voice) |
| 7 | End-to-end sales execution: authorized outreach, inbound calls, qualification, follow-ups, appointments, handoffs, conversion measurement | [§7.5–7.6](#75-authorized-outreach-inbound-calls-and-follow-ups) | [Outcome 7](HALO_V1_GAP_ANALYSIS.md#outcome-7--end-to-end-sales-execution) |

### 2.3 Operating constraints

**APPROVED ([G2](DECISIONS.md#g2--operating-safety-constraints)).** These constraints hold until the owner decides otherwise.

- $0 spend is a hard limit.
- No paid provider call, live call, outbound activation, deployment or production/shared-database write happens without a named owner, a target and written authorization.
- `HALO_OUTBOUND_ENABLED=false`, and messaging stays in `log` mode.
- The local stack uses ports 5532x.
- Destructive checks run only against a fresh `halo_check_<suffix>` database.
- A pending decision is not an approval.

### 2.4 Release stages

| Stage | Meaning | State | Source |
|---|---|---|---|
| Alpha | Local engineering gate (source, mocks, disposable database) | **Complete** locally (2026-10-12) | [HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md](HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md) |
| Beta | Staging deployment and verification | **BLOCKED**: no identified or authorized staging target | [HALO_PHASE_BETA_READINESS.md](HALO_PHASE_BETA_READINESS.md) |
| Charlie | Controlled Arunodhaya pilot | Not started; needs D3, D4, D8, D11, R8 | [HALO_V1_RELEASE_DECISIONS.md](HALO_V1_RELEASE_DECISIONS.md) |
| Final | Production GA go/no-go | **NO-GO**, with three external gates (inference, Auth, operations) BLOCKED | [HALO_THREE_GATE_EXECUTION.md](HALO_THREE_GATE_EXECUTION.md), `POA` |

---

## 3. System context

### 3.1 Context diagram

All of the following is **VERIFIED (`source`)** unless marked otherwise. No component is deployed.

```text
 Website visitor ── widget.js (closed shadow DOM) ──┐            Business operator (browser)
                                                    │                  │ Supabase Auth session
                                                    ▼                  ▼
 ┌──────────────────────── Next.js application (src/app; Vercel is the reference host) ──────────────┐
 │ Public widget API /api/v1/widget/*   Dashboard (server components/actions, RLS as the signed-in  │
 │ Appointment self-service /api/v1/appointments/[token]           user)                            │
 │ Cron /api/cron/*  Ops/admin /api/admin, /api/analytics  Workflows/campaigns/learning APIs         │
 │ OAuth /api/oauth/google-calendar/*   Inbound workflow hooks /api/hooks/[businessId]              │
 │        ChatService ─────────────▶ HALO Agent Runtime (packages/runtime)                          │
 └──────┬───────────────────────────────────────┬────────────────────────────────────────────────────┘
        │ service role + tenant-scoped code     │ POST /web/call · /web/stt · /web/tts (signed offers)
        │                                       ▼
        │          ┌──────────── Voice gateway (services/voice-gateway, long-lived Node) ─────────────┐
 Caller ── PSTN ── Carrier ─ signed webhook ─▶ route DID → tenant/agent/version · call state machine │
 (Twilio adapter only;      │ RemoteVoiceSession / in-process VoiceSession · PhoneTurnHandler ──▶    │
  has never carried a call) │ HALO Agent Runtime · transcripts · outcomes · usage · transfer authority│
        │          └──────────────┬───────────────────────────────────▲─────────────────────────────┘
        │                         │ media stream (μ-law 8 kHz)         │ WSS /pipecat/control (JSON only)
        │                         ▼                                    │
        │          ┌── Pipecat worker (services/pipecat-worker, Python) ──────────────────────────────┐
        │          │ /media  ◀── carrier media stream, or browser microphone (widget live call)      │
        │          │ Silero VAD · STT · TTS (Sarvam / local / fake) · media gate · pacer              │
        │          └────────────────────────────────────────────────────────────────────────────────────┘
        ▼
 Supabase: PostgreSQL + pgvector, Auth, Storage (41 tables, RLS on every migrated table)

 External providers, behind ports: LLM (Groq, OpenRouter, OpenAI-compatible, Anthropic, Gemini, Ollama) ·
 Sarvam STT/TTS · Twilio · Google / Outlook / CalDAV calendars · Resend · WhatsApp Cloud API ·
 tenant webhooks · OpsProvider (log adapter only)
```

### 3.2 Component map

| Component | Location | Responsibility | Classification |
|---|---|---|---|
| Web app and APIs | `src/app`, `src/features`, `src/components`, `src/proxy.ts`, `src/lib` | Dashboard, onboarding, public widget API, appointment self-service, cron, OAuth, ops/admin and analytics APIs | VERIFIED (`source`, `local test`); hosted: BLOCKED |
| Widget | `widget/src` → `public/widget.js` | Chat, browser live call, push-to-talk speech | VERIFIED (`source`, `local test`); live call is `browser-live` (self-reported) |
| Agent runtime | `packages/runtime` | Channel-independent turn orchestration, context, prompt composition, tool boundary, validation, memory, escalation, events | VERIFIED (`source`, `local test`) |
| Agents | `packages/agents`, `packages/core/domain/agents.ts` | Versioned agent configuration, publish and rollback, tenant-scoped resolution, activation readiness | VERIFIED (`source`, `local test`, `disposable DB`) |
| Tenancy | `packages/tenancy` | Membership and role resolution, Supabase clients (user, server, admin) | VERIFIED (`source`, `local test`) |
| Knowledge | `packages/knowledge`, `packages/providers/knowledge` | Chunking, retrieval query preparation, playbooks, governed full-text and vector retrieval, revision indexing | VERIFIED (`source`, `local test`, `disposable DB`); D14 governance implemented locally 2026-10-15, design defaults await owner ratification ([D14](DECISIONS.md#d14--layer-1-activation-and-approved-knowledge)) |
| Language | `packages/language` | Script and language detection, response-language choice, Telugu confirmation lexicon, parsers, token estimates | VERIFIED (`source`, `local test`) |
| Qualification | `packages/qualification` | Schema-driven questions, required fields, read-back confirmation, disposition, voice visit-booking step | VERIFIED (`source`, `local test`); Arunodhaya criteria unapproved ([D11](DECISIONS.md#d11--arunodhaya-facts-disclosures-consent-and-escalation-contacts)) |
| Negotiation | `packages/negotiation` | Commercial policy with no defaults, objections, concession authorization, `offer_concession` tool | VERIFIED mechanism; every value UNSET (D11) |
| Scheduling | `packages/scheduling` | Availability, booking service and orchestrator, drafts, reminders, timezones | VERIFIED (`source`, `local test` with fakes) |
| CRM | `packages/crm` | Customers, dedupe and merge, timeline, 13-state lead lifecycle | VERIFIED (`source`, `local test`) |
| Campaigns | `packages/campaigns` | Eligibility, consent, calling windows, attempts, suppression, guarded dispatch | VERIFIED (`source`, `local test`); dispatch disabled (G2) |
| Workflows | `packages/workflows` | Event bus, engine, actions, timers, retries, dead letter | VERIFIED (`source`, `local test`); external delivery unproven |
| Lifecycle | `packages/lifecycle` | Confirmations, reminders, self-service, feedback, intake, no-show sweep | VERIFIED (`source`, `local test`); messaging is log-only |
| Learning | `packages/learning` | Proposals, corpus evaluation, review into an unpublished draft | VERIFIED (`source`, `local test`) |
| Analytics | `packages/analytics` | Lifecycle and operations analytics | VERIFIED (`source`) |
| Voice core | `packages/voice` | Call lifecycle gateway, call-state machine and stores, in-process `VoiceSession`, Pipecat bridge, protocol and `RemoteVoiceSession`, phone channel adapter, voice telemetry | VERIFIED (`source`, `local test` with synthetic media); no carrier call |
| Voice gateway process | `services/voice-gateway` | HTTP/WS server, fail-closed config, stream tokens, web call, STT and TTS endpoints | VERIFIED (`source`, `local test`) |
| Pipecat worker | `services/pipecat-worker` | Media loop: VAD, STT, TTS, media gate, pacer, speech fallback, local speech | VERIFIED (`source`, `local test`); `browser-live` self-reported |
| Ports | `packages/ports` | 13 ports: LLM, embedding, knowledge, calendar, messaging, notification, ops, outbound dialer, speech, storage, streaming STT, streaming TTS, telephony | VERIFIED (`source`) |
| Provider adapters | `packages/providers/*` | Vendor adapters behind ports (§5.5) | VERIFIED (`source`, contract tests with fakes); only the LLM has `provider` evidence |
| Platform | `packages/platform` | Environment, logger, telemetry, alerts, retry, rate limit, SSRF guard, crypto, calendar-credential encryption, OAuth state, safe redirect | VERIFIED (`source`, `local test`) |
| Database | `supabase/migrations/0001`–`0031` | 41 tables, RLS, ownership triggers, RPCs | VERIFIED (`source`, `disposable DB`) |
| Tenant content | `src/content/tenants/arunodhaya`, `src/core/services/voice/*` | Arunodhaya agent bundle; sales-call assembly and visit-booking adapter | VERIFIED (`source`); business approval PENDING (D11); imported by the gateway ([D2](DECISIONS.md#d2--repository-layout)) |
| Gates and CI | `.github/workflows/ci.yml`, `scripts/check-*.mjs`, `scripts/preflight.ts`, `scripts/disposable-database.mjs` | Typecheck, lint, tests, build, architecture and neutrality gates, disposable migration/RLS checks, preflight | VERIFIED (`source`; local runs reported); no hosted CI run evidenced |

### 3.3 Repository layout and dependency rules

- **VERIFIED (`source`, `local test`); APPROVED rules (`AGENTS.md`, G1):**
  - `packages/*` is industry-neutral and never imports the app (`src/`, `@/*`), enforced by `npm run check:neutral`.
  - `npm run check:architecture` enforces:
    - dependency direction: the runtime depends only on core, ports, platform, knowledge and language, and providers never import the runtime;
    - no `eval`, `Function`, `child_process`, `vm`, `fetch` or `process.env` in the reasoning core;
    - the reasoning core never depends on the voice media loop;
    - a closed, schema-validated tool registry;
    - RLS on every migrated table.
- **VERIFIED deviation (`source`):** `services/voice-gateway/index.ts` imports `@/core/services/voice/{sales-call,sales-config,visit-booking}` from the application layer.
  - The proposed fix is in [D2](DECISIONS.md#d2--repository-layout).
  - The current layout itself (versus blueprint §28) is PENDING (D2).
- **PENDING ([D1](DECISIONS.md#d1--backend-stack)):** the stack is TypeScript/Node plus a Python worker rather than blueprint §27's Python/FastAPI. `AGENTS.md` forbids starting a rewrite or restructure while D1/D2 are open.

---

## 4. Platform and tenancy

### 4.1 Tenant model and isolation boundaries

- **VERIFIED (`source`):**
  - The tenant root is `businesses`. `business_members` links Supabase Auth users to a tenant with role `owner`, `admin` or `member`.
  - Every tenant-owned row carries `business_id`.
  - RLS is enabled on every migrated table. Policies use the `SECURITY DEFINER` helpers `is_business_member()` and `is_business_admin()` (migration `0001`).
  - Isolation was verified by 109 real-role RLS assertions on a disposable database (`disposable DB`, 2026-10-13). Phase 2 Workstream 1 (2026-10-15) extended this to every table, through a catalog-driven sweep (`check:rls`, 649 assertions) and a real PostgREST API test. Its status is **PARTIALLY VERIFIED**: locally proven, deployed environments unverified ([TENANT_ISOLATION_EVIDENCE.md](TENANT_ISOLATION_EVIDENCE.md)).
- **APPROVED (G1, blueprint §3):** no tenant may access another tenant's leads, calls, recordings, transcripts, knowledge, tools, credentials, agent configuration, analytics or customer data.

**Access domains**

| Domain | Identity | Enforcement | Classification |
|---|---|---|---|
| Dashboard | Signed-in Supabase user (anon key) | Postgres RLS, plus explicit `business_id` filters in server actions | VERIFIED (`source`, `disposable DB`); hosted Auth: BLOCKED |
| Public widget | Public widget key and per-conversation visitor token | Service role confined to tenant-scoped repositories; pinned tenant/agent/version tuple checked before any model call; origin allowlist; rate limits | VERIFIED (`source`, `local test`, `disposable DB` 15-assertion journey) |
| Voice | Signed carrier webhook, dialled number, HMAC stream token | Tenant derived from `phone_numbers`, never from a payload; service-role stores plus ownership triggers (`0020`); production guards (`0030`, `0031`) | VERIFIED (`source`, `local test`) |
| Pipecat worker | None; holds no tenant identity or database credentials | Identity flows HALO → worker in `ready` only; an inbound frame cannot carry identity | VERIFIED (`source`, `local test`) |
| Cron, webhooks, OAuth | `CRON_SECRET`, per-tenant webhook secret, signed OAuth state | Bearer or timing-safe comparison; admin-only OAuth | VERIFIED (`source`, `local test`) |

**Known isolation risks**

- Service-role paths bypass RLS, so their correctness depends on code (STATUS risk register, P0). The inventory is in [TENANT_ISOLATION_EVIDENCE.md §5](TENANT_ISOLATION_EVIDENCE.md#5-access-path-inventory). Some repository methods address rows by id and rely on their callers, which were reviewed (§7 of that document).
- Same-tenant references: before `0034` (D22, PENDING), RLS and plain foreign keys let a tenant point its rows at another tenant's agent, staff member, conversation or lead. `0034` checks every tenant-to-tenant reference in the database; it is verified on disposable databases only.
- Knowledge parent/child foreign keys are tenant-composite since `0033` (D14). On a database with legacy tenant mismatches the two composite keys on pre-existing tables stay NOT VALID: new rows are checked, mismatched old rows are quarantined (never served) and reported by `knowledge_governance_census()`.
- The widget origin allowlist protects browsers only.
- Rate limits are in memory and per instance.
- The deployed boundary is unverified: there is no staging target, and hosted Auth is BLOCKED (Gate 2).

### 4.2 Agent identity, configuration, objectives, policies and versioning

- **APPROVED (G1, blueprint §4, §23):** an agent is configuration plus capabilities, and production configuration is never changed without versioning.
- **VERIFIED (`source`, `local test`, `disposable DB`):**
  - **Storage:** `agents` and `agent_versions` (`0013`). Published versions are immutable, and the lifecycle is draft → publish → rollback (`packages/agents/agent-versioning.ts`).
  - **Live-version ownership:** enforced by `0018`. Calls and conversations cannot bind draft versions (`0030`), and new conversations must carry a valid tenant/agent/version tuple (`0031`).
  - **Configuration schema** (`packages/core/domain/agents.ts`):
    - `identity`, `objective`
    - `instructions`: a versioned `promptTemplate` and `customInstructions`
    - `language`: primary, fallbacks and `codeSwitchPolicy`
    - `voice`: six deterministic prompts plus endpointing and barge-in parameters
    - budgets and model-routing tiers
    - `knowledge`: `collectionIds` and `retrievalPolicy`
    - `tools`: `grantedToolIds` and policy
    - `workflows`: `allowedTriggers`
    - `guardrails`: refusals, escalation triggers, human-request phrases, claim phrases, safe fallback reply and `piiRules`
    - `activationBlockers`
  - **Activation readiness** (Layer 1, 2026-10-14):
    - Publication, rollback and runtime resolution require a non-blank identity name, an objective, an effective versioned prompt and explicit, valid language tags.
    - Phone agents also need all six prompts.
    - Unresolved `activationBlockers` deny activation.
    - Nothing falls back to mutable receptionist settings.
  - **Pinning:** conversations and calls pin `agent_id` and `agent_version_id`, and an existing conversation keeps its pinned version.
- **Gaps:**
  - Legacy published versions without an objective now refuse to serve, and their rollout is PENDING (D14, item 6).
  - Knowledge is **not** pinned per conversation: each turn uses the currently published revision, so a withdrawal or replacement takes effect on the next turn (D14 item 5 default, implemented 2026-10-15; awaits owner ratification).
  - **VERIFIED (`source`):** the LLM provider is a process-global singleton (`getLLMProvider()` in `ChatService` and the gateway). An agent version therefore cannot choose its own model or provider.

### 4.3 Tenant-specific knowledge, tools, integrations and workflows

| Capability | How it is tenant-specific | Classification |
|---|---|---|
| Knowledge | Per-tenant documents, chunks, FAQs and collections (`0001`, `0017`), with immutable approved revisions (`0033`). Approval rules are in §8.2. | VERIFIED (`source`, `local test`, `disposable DB`); D14 implemented locally, not applied to a real database |
| Tools | Closed code registry. Each agent version grants tools through `grantedToolIds`; there are no tenant-defined, HTTP or custom-code tools. | VERIFIED (`source`); blueprint §11 "tenant custom tools" not implemented and not proposed |
| Phone numbers | `phone_numbers` maps a dialled number to tenant and agent, plus an E.164 `handoff_number` | VERIFIED (`source`) |
| Calendars | `staff_members.calendar_provider` and `calendar_connections`, with credentials encrypted with AES-256-GCM in the application | VERIFIED (`source`, `local test`); the local backfill write is awaiting authorization ([CALENDAR_CREDENTIALS_RUNBOOK.md](CALENDAR_CREDENTIALS_RUNBOOK.md)) |
| Messaging and notification | Provider selected per process by `MESSAGING_PROVIDER`; per-tenant sender configuration not verified | VERIFIED (`source`); `log` mode (G2) |
| Workflows | Tenant-defined `workflows`, triggered by business events and per-tenant inbound webhooks | VERIFIED (`source`, `local test`) |
| Business-specific code | Arunodhaya bundle in `src/content/tenants/arunodhaya`; sales-call assembly in `src/core/services/voice` (application layer) | VERIFIED (`source`); gateway import leak (D2) |

### 4.4 Authentication, authorization and data ownership

- **Dashboard (VERIFIED: `source`, `local test`):**
  - `src/proxy.ts` refreshes Supabase sessions.
  - Auth fails closed on configuration errors and outages, preserves refresh cookies and anti-cache headers on redirect, and uses a production cookie scope (fixed 2026-10-13).
  - `requireBusiness` resolves membership and role; admin-only operations include the OAuth connect flow and learning review.
  - **BLOCKED:** real hosted sign-in, refresh and logout (Gate 2).
- **Widget visitors (VERIFIED):**
  - The widget key grants only branding reads and conversation start.
  - Each conversation gets an unguessable visitor token.
  - Rate limits apply per IP and per token.
  - The message route rejects tenant, agent or version mismatches before the runtime runs (SEC-01/05/06 fixes, [ENG_01_SECURITY_IDENTITY_REVIEW.md](ENG_01_SECURITY_IDENTITY_REVIEW.md)).
- **Voice (VERIFIED: `source`, `local test`):**
  - Webhook verification fails closed.
  - The stream token is an HMAC-SHA256 over the provider call ID, both numbers and an expiry (default TTL 120 s), verified on media `start` or `hello`.
  - **Known deferred issue:** a valid token replayed within its TTL can re-attach a session ([PIPECAT_INTEGRATION.md](PIPECAT_INTEGRATION.md) §6).
  - **Fixed locally (W1.2, local release-readiness audit, 2026-10-15; [report](LOCAL_RELEASE_READINESS_REPORT.md)):** a second media or control socket now re-attaches only while the live session is waiting in its reconnect window; otherwise it is refused as `session_active` and the live socket keeps the call (`local test`, including a real local WebSocket replay test). Real carrier reconnect behaviour remains unverified (D3, D8).
- **Data ownership:**
  - A tenant owns its rows.
  - `calendar_connections` has no RLS policies and is reachable by the service role only.
  - Platform operators hold the service role.
  - **UNKNOWN:** export and deletion on request (§8.5).

---

## 5. Application and runtime boundaries

### 5.1 Frontend and API responsibilities

| Surface | Routes | Authorization | Classification |
|---|---|---|---|
| Public widget | `/api/v1/widget/{config,conversations,messages,leads,speech,synthesis,voice-call}` | Widget key or visitor token; origin allowlist; rate limits | VERIFIED (`source`, `local test`) |
| Appointment self-service | `/api/v1/appointments/[token]` (with `feedback` and `intake`) | Manage token | VERIFIED (`source`) |
| Dashboard | `src/app/dashboard/*`, `src/features/*` (server components and actions) | Supabase session plus RLS | VERIFIED (`source`) |
| Operations | `/api/health` (liveness; `?deep=1` authenticated readiness), `/api/admin/system-status`, `/api/analytics/{lifecycle,operations}` | Authenticated, tenant-scoped | VERIFIED (`source`, `local test`) |
| Automation | `/api/workflows/*`, `/api/hooks/[businessId]`, `/api/campaigns`, `/api/learning` | Membership and role; per-tenant webhook secret | VERIFIED (`source`, `local test`) |
| Cron | `/api/cron/{retention,reminders,workflows,no-shows,campaigns}` | `CRON_SECRET` bearer token | VERIFIED (`source`). Scheduled in `vercel.json`: retention daily 03:00, reminders and workflows every 5 minutes, no-shows every 15 minutes. **campaigns is not scheduled.** |
| OAuth | `/api/oauth/google-calendar/{start,callback}` | Admin; HMAC state plus CSRF nonce | VERIFIED (`source`, `local test`) |

Errors use one envelope: `AppError` maps to `{ "error": { "code", "message" } }`. An LLM provider failure in chat returns an honest canned reply, never a raw 502 (`source`).

### 5.2 Voice gateway and media worker

**VERIFIED (`source`, `local test`)**, documented in [PIPECAT_INTEGRATION.md](PIPECAT_INTEGRATION.md):

| The Pipecat worker owns | HALO (gateway and runtime) owns |
|---|---|
| Audio transport, framing and pacing | Tenant, agent and version resolution; call rows; the call-state machine |
| VAD, STT and TTS streaming | Conversation state, qualification and business state |
| Cutting playback on caller speech (cut first, report after) | Turn serialization and delivery truth (`complete` / `interrupted` / `not_delivered`) |
| Reporting what was heard and what played | Silence, failure and handoff policy; transfer authority |
| Provider-specific media behaviour | Every word the caller hears: tenant-authored lines and validated replies |

- **Two media engines sit behind the `VoiceMediaSession` seam:**
  - `pipecat`: the path that was exercised `browser-live`.
  - `in_process`: the Phase 3 engine and the **default when `VOICE_MEDIA_ENGINE` is unset**.
- **Gateway configuration fails closed:** the gateway does not start without a stream-token secret and a provider signing secret.
- **Voice prompts are required:** an agent without tenant-authored voice prompts, including the AI disclosure in its greeting, is never answered.
- **There is no `transfer` command on the wire.** Transfers are executed by the gateway through the carrier to the tenant's configured number.

### 5.3 Agent orchestration and tool execution

**VERIFIED (`source`, `local test`)**, documented in [RUNTIME.md](RUNTIME.md). The turn pipeline in `packages/runtime/agent-runtime.ts` runs in this order:

1. Check the trusted context (tenant, agent and version must agree).
2. Load conversation state and history.
3. Resolve the response language.
4. Retrieve knowledge. This runs on **every** turn with a non-empty query.
5. Run system actions: qualification, negotiation, visit booking, suppression and pending-fact guidance.
6. Select tools.
7. Build the bounded context.
8. Compose the prompt (`PROMPT_COMPOSER_VERSION`).
9. Run the bounded model/tool loop.
10. Validate the reply (act-then-narrate), with one repair attempt and then an honest fallback.
11. Decide escalation.
12. Update memory.
13. Persist.
14. Run post-turn hooks.

**Tool execution** has four separated stages:

1. **Validate:** the tool name must be in the closed registry, and the arguments are checked by a strict zod schema that drops unknown keys.
2. **Authorize:** the tool must be granted, bound, allowed on the channel, have its precondition met and match the provider's capability. Confirmation is checked, and duplicate intents are rejected.
3. **Execute once:** an application-bound executor runs with the trusted context.
4. **Record:** a `ToolResult` or `ActionRecord`, a `messages.role='tool'` row, and `tool.outcome` telemetry.

The three built-in tools are `offer_concession`, `request_human_handoff` and `save_contact_details`. None is granted by default.

| Bound | Web chat | Phone |
|---|---|---|
| Tool rounds per turn | 2 | 1 |
| Model turn deadline | 120 s | 12 s (plus a 15 s session turn timeout) |
| Max output tokens | 400 (runtime default) | 900 |
| Context limits | `DEFAULT_CONTEXT_LIMITS` (32,000 chars; 12,000 estimated tokens) | `VOICE_CONTEXT_LIMITS` (9,000 chars; 6,000 estimated tokens) |
| Corrective regenerations | 1 | 1 |

**Gaps against blueprint §11/§12 (PROPOSED, [D5](DECISIONS.md#d5--tool-invocation-model) and [D7](DECISIONS.md#d7--new-migrations-tool-executions-and-audit-logs)):**

- No tool has its own output schema, timeout or retry policy.
- Whether `offer_concession` should stay callable by the model is open.

**Tool-execution audit (D7; VERIFIED `local test`, `disposable DB`).** Every model tool call that reaches the loop gets one `tool_executions` row. The audit is written in the loop itself, so no tool can opt out.

- **Rejections:** an unknown tool, invalid arguments, the budget limit or an authorization denial is recorded as a final `rejected` row.
- **Executions:** a `started` row is written **before** the executor runs, then finalized once as `succeeded` or `failed`, with a bounded error code.
- **What a row holds:** tenant, conversation, agent and version (from trusted state), channel, turn and correlation ID, round, intent ID, a registry tool name, the idempotency key and timestamps. It never holds arguments, results, messages or contact data.
- **Failure policy:**
  - **Side-effecting tools** do not run without their `started` row, and report `AUDIT_UNAVAILABLE`.
  - **The handoff tool** runs regardless.
  - **Rejections** are recorded best-effort.
  - **A failed finalize** leaves `started` for an operator to reconcile. The action is never retried.
  - Every audit failure emits `tool.audit_failed`.
- **Database rules verified on a disposable database (2026-10-15):** ownership, privileges, the members-read policy, the lifecycle, uniqueness, rejection reasons, the column set and retention cascade, as real `authenticated`, `anon` and `service_role` roles. Migration `0032` has not been applied to any shared, developer or hosted database ([HALO_V1_STATUS.md](HALO_V1_STATUS.md#d7-and-d14-database-verification--2026-10-15)).

### 5.4 Workflow and campaign integration

- **Workflows (VERIFIED: `source`, `local test`):**
  - Business events go through a fire-and-forget event bus. Each event is written to `workflow_events` (the audit trail), synced to the CRM, and dispatched to tenant workflows.
  - **Engine guarantees:**
    - one run per (workflow, event), enforced by a unique constraint;
    - per-step timeouts;
    - an uncertain timeout outcome aborts the step and goes to `dead_letter`, **with no automatic replay** (POA-WF-01);
    - backoff retries for definite failures;
    - timers fired by cron.
- **Campaigns (VERIFIED: `source`, `local test`):**
  - The engine handles eligibility, consent, calling windows, attempt limits, bounded retries, suppression, callback binding (RPC `bind_campaign_callback`), and leaves uncertain attempts unretried.
  - Dispatch throws unless `HALO_OUTBOUND_ENABLED === "true"`, and the cron route is not scheduled.
- **Lead lifecycle (VERIFIED):** transitions go through the `transition_lead()` database function, with an audit trail in `lead_state_events`. They are driven only by dispositions and verified actions.
- **PROPOSED ([D13](DECISIONS.md#d13--business-process-workflow-engine)):** build the blueprint §17 sales process ("Solar Lead Qualification") as workflow definitions on these engines, not as a new engine. Today the process is implicit in the call assembly, campaign engine and lead lifecycle; it is not a declared workflow.

### 5.5 Provider adapters

| Port | Adapters (`packages/providers/*`) | Selected by | Evidence |
|---|---|---|---|
| LLM | `openai-compatible` (OpenAI, Groq, OpenRouter, Mistral), `anthropic`, `gemini`, `ollama`; `fallback-router`; `complexity-router` | `LLM_PROVIDER` (process-global); `HALO_MODEL_ROUTES` is optional and unset | `provider`: completions on 2026-09-24 and 2026-10-01; metadata on 2026-10-13; Groq 429 and OpenRouter 402 on current accounts |
| Streaming STT/TTS | `sarvam-stt`/`sarvam-tts` (TypeScript, gateway); Pipecat Sarvam services (worker); `local` (sherpa-onnx); fakes; fallback wrappers; `provider-circuit` | `VOICE_STT_PROVIDER` / `VOICE_TTS_PROVIDER` and fallbacks; `VOICE_PROFILES_JSON` | Sarvam: `browser-live` (self-reported) plus benchmark clips; local: `local test` and local inference |
| Telephony | `twilio-media-stream`, `twilio-outbound-dialer`; `fake` | `TELEPHONY_PROVIDER` | Contract tests with fakes only; **no Exotel adapter** ([D3](DECISIONS.md#d3--pilot-carrier)) |
| Calendar | `internal`, `google` (OAuth, token source), `outlook`, `caldav` | Staff row or `calendar_connections` | `local test` with fakes; no real calendar write |
| Messaging and notification | `log` (default), `resend`, `whatsapp`, `composite` | `MESSAGING_PROVIDER` | Stubbed network tests; `log` mode (G2) |
| Knowledge and embedding | Supabase full-text plus pgvector; Ollama embeddings (`openai` guarded until a dimension migration exists) | `EMBEDDING_PROVIDER` (default `none`) | `local test`, `disposable DB` |
| Ops | `log` (`OpsProvider`, OpsCorp-ready) | Factory | `source`; no OpsCorp adapter (G1: HALO is independent of OpsCorp) |
| Storage | Supabase Storage | — | `source` |

**APPROVED (G1, blueprint §26):** vendor code stays behind ports. **VERIFIED:** the runtime and voice packages import no vendor SDK (`check:architecture`).

### 5.6 Service contracts, errors, timeouts and retries

**Contracts (VERIFIED: `source`)**

- `packages/runtime/contracts.ts`: `TrustedRequestContext`, `RuntimeInput` / `RuntimeOutput`, tool stages, `UsageMetadata`, `RuntimeEvent`.
- `packages/voice/pipecat/protocol.ts`: every frame is zod-validated, binary frames are ignored, there is a 32 KB cap, and the protocol major version is checked at `hello`.
- `packages/ports/*`: streaming STT/TTS must support cancellation, and `verifyWebhook` is part of the telephony interface.

**Timeouts and bounds (VERIFIED: `source`)**

| Where | Value |
|---|---|
| LLM call | `LLM_TIMEOUT_MS` (default 60 s). The router splits the remaining turn budget across candidates and waits at most 2 s for a cooldown. A billing-limit cooldown lasts 300 s. |
| Runtime state load/save | 2 s each; on timeout the turn degrades rather than fails |
| Voice session | Turn timeout 15 s; `finalWaitMs` 1.5 s; `finalCommitGraceMs` 0.4 s; silence 8 s with 2 reprompts; maximum call length 15 min; abandon grace 1 s; playback watchdog 60 s |
| Pipecat worker | Ready 15 s; start 30 s; chunk start 15 s; playout mark wait 45 s |
| Speech circuit (gateway) | After 2 recoverable failures, skip the provider for 30 s; each failed probe doubles the wait, up to 5 min. State is per process. |
| Stream token | 120 s TTL (default) |

**Retry policy (VERIFIED: `source`)**

- **Model:** no retry by default. Transient provider errors are retried only under an explicit policy; timeouts never are.
- **Tool executors:** never retried.
- **Calendar and messaging:** `withRetry` (`packages/platform/retry.ts`).
- **Workflow steps:** retried on definite failure; dead-lettered when the outcome is uncertain.
- **Voice:** one STT reconnect and one TTS retry before the first byte.
- **Outbound:** an uncertain call attempt is never blindly redialled.

**Failure semantics: APPROVED (G1, blueprint §33) and VERIFIED (`source`, `local test`)**

- An unconfirmed action is never narrated.
- Knowledge, state and system-action failures degrade the turn.
- A dropped call still produces a terminal call row, a transcript and an outcome.
- Process loss marks calls `recovery_required`.
- **Not implemented:** recovering a voice session in another process.

---

## 6. Conversation and voice pipeline

### 6.1 Channels and audio paths

| Path | Ingress and egress | Engine | Classification |
|---|---|---|---|
| Web chat | Widget → `/api/v1/widget/messages` → `ChatService.respondForAgent` → JSON reply (no streaming) | Runtime (web-chat profile) | VERIFIED (`source`, `local test`, `disposable DB` journey); hosted: BLOCKED |
| Browser live call | Widget `live-call.ts`: microphone → 8 kHz μ-law → WebSocket to worker `/media`. The offer is minted by `/api/v1/widget/voice-call` → gateway `/web/call`. | `pipecat` | VERIFIED (`source`, `local test`); `browser-live` 2026-10-06 (self-reported) |
| Browser push-to-talk | `/api/v1/widget/speech` → gateway `/web/stt`; `/api/v1/widget/synthesis` → `/web/tts` | Gateway speech adapters | VERIFIED (`source`, `local test`) |
| Carrier call (inbound or outbound) | Twilio webhook → gateway → TwiML `<Connect><Stream>` → worker `/media` (`pipecat`) or gateway `/media` (`in_process`) | Either engine | VERIFIED (`source`, contract tests); **never carried a call**; BLOCKED (D3, D8) |
| Local voice loop | `scripts/local-call.ts` → gateway `/media` over the fake-carrier protocol | `in_process` | Development harness only ([LOCAL_VOICE_LOOP.md](LOCAL_VOICE_LOOP.md)) |

### 6.2 Turn pipeline on the Pipecat path

The diagram is **VERIFIED (`source`)** and reproduced from [VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md) §2.1. The stage annotations are summarized.

```text
Caller audio (μ-law 8 kHz, 60 ms frames)
  → worker: decode to PCM16 (pure-Python codec)
  → Silero VAD (8 kHz) ──speech_started──▶ HALO (a barge-in if playing; aborts an uncommitted turn if thinking)
  → Sarvam STT over WebSocket (streams all inbound audio); on VAD stop: flush → final transcript
  → media gate holds finals until VAD stop → control WS `transcript{final}`
  → gateway RemoteVoiceSession: one serialized turn → PhoneTurnHandler → AgentRuntime.run
        state + history load → language → knowledge (full-text) → system actions (qualification,
        negotiation, visit booking, suppression) → prompt (~3K est. tokens) → LLM (streamed, buffered)
        → [tool round → 2nd LLM call] → validate (→ repair LLM call) → persist (awaited)
  → chunkForSpeech (sentence chunks ≤ 220 chars) → control WS `speak{chunks}`
  → worker: one TTSSpeakFrame per chunk → Sarvam TTS → PCM16 → μ-law → paced 480-byte frames
  → carrier `mark` echo → `chunk_played` → next chunk is synthesized
```

### 6.3 Turn detection, endpointing and interruption

**Endpointing (VERIFIED: `source`)**

- Silero VAD runs in the worker. Its `stop_secs` comes from the agent's `endOfSpeechMs`: default 700 ms, Arunodhaya 900 ms. The 900 ms value is a hypothesis tuned on mock audio ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).
- VAD start sensitivity uses Pipecat defaults (0.2 s, confidence 0.7). The worker parses `vad.minSpeechMs` and `bargeIn.minSpeechMs` but **does not apply them**.
- **Updated by W4.1 (local release-readiness audit, 2026-10-15; [report](LOCAL_RELEASE_READINESS_REPORT.md)):** the worker now sets Silero `start_secs` from `vad.minSpeechMs` and cuts playback only after `bargeIn.minSpeechMs` of caller audio, or at once when a transcript arrives mid-speech, matching the in-process session (`local test`). Confidence stays at the Pipecat default. HALO's own interruption of a *thinking* turn on `speech_started` is unchanged (W4.7).
- There is no semantic or "smart-turn" model.

**Turn commit (VERIFIED: `source`, `local test`)**

- HALO commits exactly one turn per utterance.
- Finals are deduplicated by `utteranceId`, then committed after a VAD stop, or after 400 ms grace if VAD missed the stop. If VAD stops with no final, HALO waits up to 1.5 s.

**Interruption (VERIFIED: `source`, `local test`)**

- **While the agent speaks:** the worker cuts playback locally and reports how many milliseconds were heard. HALO records the reply as `interrupted` with the heard prefix, and tells the model on the next turn.
- **While the agent thinks:** an uncommitted turn is aborted and its utterance merged with the next one. A turn whose action already committed runs to completion, and its reply is recorded as `not_delivered`.
- Greeting, handoff and goodbye lines cannot be interrupted.

**Invariants:** serialized turns, single playback, handoff ownership (the `transferring` state) and commit-point cancellation are VERIFIED (`local test`). Each needs a test whenever a change touches it (`AGENTS.md`).

### 6.4 Streaming and latency measurement

- **No LLM-to-TTS streaming on the phone path (VERIFIED: `source`):**
  - `SafeSpeechStream` exists in the runtime, but `PhoneTurnHandler` passes no speech sink, so the full reply is generated and validated before the first chunk is synthesized.
  - TTS chunks are synthesized one after another, each only after the previous chunk was played (VERIFIED: `source`).
- **Measurement marks (VERIFIED: `source`):**
  - Timing points T0–T7 are defined in [VOICE_LATENCY_MODEL.md](VOICE_LATENCY_MODEL.md).
  - `context_ready` and `llm_first_token` are persisted to `call_events` (`0023`).
  - Voice telemetry covers `voice.stt`, `voice.tts`, `voice.audio`, `voice.processing` and `voice.fallback` ([TELEMETRY.md](TELEMETRY.md)).
- **What has been measured:**

  | Measure | Value | Evidence |
  |---|---|---|
  | HALO coordination overhead | About 1 ms | `local test`, mock vendors |
  | Runtime overhead | Under 5 ms | [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md) |
  | LLM model call (synthetic phone turns) | 713–916 ms | `provider`, 2026-09-24 |
  | Real end-to-end latency | **Not measured** | — |
  | Current Pipecat path, end-to-end | 2.0–3.5 s | Estimate only ([VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md) §2.2) |

- **Targets:** PENDING ([D9](DECISIONS.md#d9--numeric-pilot-targets)); the existing candidates conflict.
- **PROPOSED latency and cost levers** (from [VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md) §5.5; none approved):
  - Wire `SafeSpeechStream` into phone turns. This reverses the documented whole-reply design and needs [D20](DECISIONS.md#d20--validated-speech-streaming-on-the-phone-path).
  - Synthesize the next TTS chunk while the current one plays.
  - Retune endpointing on real speech.
  - Move post-reply persistence off the critical path.
  - Run pre-LLM reads in parallel.
  - Lower reasoning effort, or route simple turns to a smaller model.
  - Put the stable prompt prefix first.
  - Pre-connect speech sockets and cache audio for fixed lines.
  - Use μ-law output from TTS.
  - Gate barge-in during thinking.
  - Stop the router from sleeping on cooldowns in voice turns.

  Each is a plan task. Any prompt-order change requires bumping `PROMPT_COMPOSER_VERSION`.

### 6.5 Provider fallback and recovery

- **LLM (VERIFIED: `source`, `local test`):**
  - A fixed fallback chain with cooldowns. An optional complexity router exists but is unconfigured.
  - When every provider fails, the caller gets an honest canned reply.
  - **The chain is not pilot-capable on current accounts:** Groq 8,000 tokens/minute (429) and OpenRouter 402 (D8, D17).
- **Speech (VERIFIED: `source`, `local test`):**
  - **Worker:** Pipecat's `ServiceSwitcher` switches once per call, and only on a recoverable failure. The failed utterance is not replayed.
  - **Gateway:** `FallbackSttProvider` / `FallbackTtsProvider` plus the provider circuit.
  - Fallback is never taken for a missing credential, a 401/403, an unsupported language or voice, or an unclassified error.
  - A local Telugu fallback is **not accepted** for the pilot ([D17](DECISIONS.md#d17--pilot-speech-and-llm-provider-route)).
- **Calls (VERIFIED: `source`):**
  - Terminal states are reconciled.
  - A non-retryable STT or TTS error ends the call politely with the tenant's goodbye.
  - Process loss leads to `recovery_required`; there is no mid-call migration.

### 6.6 Browser and carrier integration boundaries

- **Browser path:** proves the speech vendors, the model, Telugu handling and part of the latency. It proves nothing about telephony: no PSTN, no jitter, no codec negotiation. PROPOSED (D4): treat it as **harness evidence only**.
- **Carrier path (VERIFIED: `source`):**
  - Twilio TwiML `<Connect><Stream>`, with stream parameters carrying the token and control URL.
  - `mark` acknowledges playout, and `clear` flushes audio on barge-in.
  - A transfer is a TwiML `<Dial>` to `phone_numbers.handoff_number`.
- **UNKNOWN:** Indian carrier regulation (DLT/KYC), number availability and per-minute cost ([D3](DECISIONS.md#d3--pilot-carrier)).
- **Speech-model defaults differ between paths (VERIFIED: `source`):** the worker defaults to `saarika:v2.5`/`bulbul:v2`, the gateway to `saaras:v3-realtime`/`bulbul:v3`. A deployment must pin both (D17).

---

## 7. Business execution

### 7.1 Lead lifecycle and qualification

- **Lead lifecycle (VERIFIED: `source`, `local test`):**
  - Thirteen lead states: `NEW` … `CONVERTED`, `LOST`, `DO_NOT_CONTACT`.
  - Transitions are audited and idempotent; DNC is terminal.
- **Qualification (VERIFIED: `source`, `local test`):**
  - Schema-driven, with required fields, retries, skips and disqualifiers.
  - The system tells the model the exact next question to ask.
  - Read-back confirmation applies to `confirm: true` fields; for Arunodhaya these are `monthly_bill` and `phone`.
  - The configuration was integrity-checked on 2026-10-14: malformed rules are rejected, and unresolved required answers cannot produce a "qualified" outcome.
- **APPROVED (G1, blueprint §19):** qualification is structured data, stored separately from the transcript.
- **Business outcome (VERIFIED):** the disposition (`conversation_outcomes`) is computed deterministically and kept separate from the technical call state (blueprint §18).
- **Gaps:**
  - No speech provider reports confidence, so confidence-gated read-back never fires on a real call (VERIFIED: `source`).
  - Arunodhaya's qualification criteria are unapproved (D11).

### 7.2 Sales playbook, objections and negotiation

- **VERIFIED mechanism (`source`, `local test`):**
  - The commercial policy has **no default values**.
  - Objection detection comes with tenant-authored Telugu acknowledgement lines.
  - Concession authorization is re-checked at execution time.
  - The prompt carries "never say" lists.
  - Unverified questions are listed in the prompt so the model defers instead of answering (blueprint §16 KNOWN/UNKNOWN).
  - Details: [ARUNODHAYA_NEGOTIATION_POLICY.md](ARUNODHAYA_NEGOTIATION_POLICY.md).
- **Arunodhaya state (VERIFIED: `source`):** every commercial value is UNSET and no fact is verified, so the agent can authorize nothing involving money (D11).
- **Evidence of sales quality:**
  - 50 of 50 scripted golden conversations pass (`local test`, scripted model). This is a regression check, not a quality measure.
  - There was a limited live Telugu/Tenglish smoke test (`provider`, 2026-09-24), which found and closed one factuality violation.
  - **UNKNOWN:** real conversion effectiveness and the quality of objection handling. No approved metric exists (D9).

### 7.3 Deterministic actions versus LLM-assisted decisions

**APPROVED (G1, principle 4):** the LLM decides and deterministic tools act. The current split is **VERIFIED (`source`)**:

| Concern | Decided by | Executed by | Note |
|---|---|---|---|
| Next qualification question | Deterministic engine | — | The model is told exactly which question to ask |
| Qualification answers | Deterministic parsers (`packages/language/parsers`) plus model phrasing | Qualification state | Read-back for confirm fields |
| Visit booking | Deterministic step; offered slots never come from the model | `BookingService` | Exact read-back and clear confirmation before booking |
| Concession | Model may propose `offer_concession` | Deterministic policy authorization | Placement is PENDING (D5) |
| Human handoff | Model tool or deterministic escalation triggers | Gateway transfer to the tenant number, or a recorded callback | "Connected" is said only after the carrier confirms |
| Contact capture | Model tool `save_contact_details` (must be granted); web path also uses regex plus an LLM JSON pass | Lead path | Regex wins on conflict |
| Disposition and outcome | Deterministic | Gateway finalization | — |
| DNC and suppression | Deterministic | `phone_suppressions`, lead state | Terminal |
| Response language | Deterministic `resolveResponseLanguage` | Prompt line plus TTS language | — |

### 7.4 Calendar booking, rescheduling and cancellation

- **Booking engine (VERIFIED: `source`, `local test` with fakes):**
  - Availability engine, `BookingService` (book, reschedule, cancel), booking drafts (`0012`) and reminders.
  - A GiST exclusion constraint prevents double booking (`0008`).
  - Self-service manage links and ICS confirmations.
  - Detail: [SCHEDULING.md](SCHEDULING.md).
- **Voice path (VERIFIED: `source`):**
  - `VisitBookingStepProvider` runs once qualification is complete. Its adapter is `src/core/services/voice/visit-booking.ts`, which uses the real `BookingService` and is idempotent per conversation.
  - This **corrects** older claims that no booking tool is bound on the voice path; see [§13](#13-known-limitations).
  - The gateway imports this adapter from the application layer (D2).
- **Calendar providers (VERIFIED: `source`):**
  - Internal (the default), Google (OAuth, token source, encrypted credentials), Outlook and CalDAV.
  - The database is authoritative; a successful booking does not prove the calendar synced.
- **BLOCKED / UNKNOWN:**
  - No real calendar booking has been made (`provider` evidence: none).
  - Arunodhaya's visit rules (service area, travel buffer, staff calendar, booking authority) are UNSET (D11).
  - Credential backfill writes await authorization.

### 7.5 Authorized outreach, inbound calls and follow-ups

- **Inbound (VERIFIED: `source`, `local test`):**
  - A verified webhook is routed by dialled number.
  - The call is answered only if the agent is published and voice-configured; otherwise it is politely rejected.
- **Outbound (VERIFIED: `source`, `local test`; disabled):**
  - The campaign engine and dialer exist, with consent, calling windows, attempt limits, suppression and signed callback binding.
  - **APPROVED (G2):** outbound stays off. The pilot direction is PENDING ([D4](DECISIONS.md#d4--pilot-call-direction-and-pre-carrier-harness)).
- **Follow-ups (VERIFIED: `source`, `local test`):**
  - Deterministic follow-up due times, workflow timers and reminder cron.
  - **Under G2 messaging is in `log` mode, so no customer receives a message.** `delivery=simulated` is not a receipt.
- **Consent and lawful contact:** PENDING (D11, R8). Contact provenance, DNC policy, calling windows and AI/recording disclosure wording are all unapproved.

### 7.6 Idempotency, audit records, escalation and conversion tracking

- **Idempotency (VERIFIED: `source`, `local test`):**
  - Workflow runs are unique per (workflow, event).
  - Duplicate tool intents are rejected.
  - Call/session admission is atomic, and outcome and suppression updates are atomic.
  - Campaigns are protected against concurrent claims.
  - Bookings are protected by the exclusion constraint and are idempotent per conversation on voice.
  - Calendar-credential updates use compare-and-swap.
  - A workflow timeout is quarantined rather than replayed.
- **Audit (VERIFIED, partial):** `lead_state_events`, `campaign_events`, `call_events`, `workflow_events` and `workflow_run_logs`, `usage_events`, `learning_proposals`, and `messages.role='tool'`. Since 2026-10-15, model tool calls are audited in `tool_executions` (§5.3; migration `0032`, verified on a disposable database only). Knowledge approval, rejection, publication, supersession and withdrawal are recorded on the revision rows themselves (§8.2; `0033`). WS4 adds append-only `audit_logs` in additive `0036`, locally authorized under D7 and verified on a disposable database; no shared/hosted application is authorized.
- **Escalation (VERIFIED: `source`, `local test`):**
  - Escalations are typed: explicit human request, repeated misunderstanding, unsupported request, sensitive situation, action failed, low confidence. Each is recorded once per conversation.
  - On the phone, a live transfer is offered only when one is available; otherwise a callback is recorded.
  - Staffed contacts and hours are UNSET (D11).
- **Conversion:**
  - The lead states include `CONVERTED`, and outcomes and lifecycle analytics exist (VERIFIED: `source`).
  - Pilot conversion definitions and targets are UNKNOWN (D9).

---

## 8. Data and security

### 8.1 Data entities and ownership

**VERIFIED (`source`, `disposable DB`).** All tables carry `business_id` and have RLS enabled.

| Group | Tables (migration) | Write path |
|---|---|---|
| Tenancy and configuration | `businesses`, `business_members`, `business_settings`, `receptionists` (0001); `agents`, `agent_versions` (0013) | Dashboard (RLS); service role for runtime reads |
| Knowledge | `knowledge_documents`, `knowledge_chunks`, `faqs` (0001); `knowledge_collections` (0017); `knowledge_document_revisions`, `faq_revisions` (0033) | Editor/review RPCs as the signed-in member (owner/admin approve); chunks by the service-role indexer only |
| Conversations | `conversations`, `messages` (0001; `tool` role added in 0016); `conversation_state` (0019) | Service role, tenant-scoped |
| Leads and CRM | `leads` (0001); `customers`, `customer_timeline` (0009); `lead_state_events` (0024) | Service role; `transition_lead()` |
| Scheduling | `staff_members`, `scheduling_settings`, `appointments`, `appointment_reminders`, `calendar_connections` (0008); `booking_drafts` (0012); `appointment_feedback`, `intake_responses` (0010) | Service role; dashboard for settings |
| Workflows | `workflows`, `workflow_events`, `workflow_runs`, `workflow_run_logs`, `workflow_timers` (0009) | Service role; dashboard read |
| Voice | `phone_numbers`, `calls`, `call_events`, `call_transcript_turns`, `conversation_outcomes`, `phone_suppressions` (0020) | Gateway service role, with ownership and state triggers |
| Campaigns | `campaigns`, `campaign_contacts`, `campaign_events` (0025) | Service role |
| Learning | `learning_proposals` (0027) | Tenant-admin review |
| Usage | `usage_events` (0001) | Service role |
| Tool audit | `tool_executions` (0032; verified on a disposable database, **not applied to any shared or hosted database**) | Runtime on the service role; members read through RLS; one-way lifecycle trigger |

**Compared with blueprint §22:**

- `tenants` is `businesses` and `call_outcomes` is `conversation_outcomes`.
- `analytics_events` is approximated by `usage_events` plus `call_events`.
- `tool_executions` exists as migration `0032` (D7; disposable-DB verified, not applied to a real database). WS4 adds `audit_logs` in local-only `0036` (D7); generic `integrations` and `billing` remain absent.
- `campaigns`, `knowledge_documents` and `knowledge_chunks` already exist.

### 8.2 Knowledge retrieval and approval

**D14 governance (migration `0033`; implemented 2026-10-15 under owner instruction; VERIFIED `source`, `local test`, `disposable DB`; not applied to any shared or hosted database).** The design choices for D14 items 1–6 were made under the instruction's default rule and await owner ratification ([D14](DECISIONS.md#d14--layer-1-activation-and-approved-knowledge)).

- **Model:** a document or FAQ row is the tenant-owned container and the editor's working copy. Content is served **only** from an immutable revision (`knowledge_document_revisions`, `faq_revisions`) that a tenant owner or admin approved, and only while the container's `published_revision_id` points at it.
- **Lifecycle:**
  - Document revision: `draft` → `pending_review` → `approved` → `superseded` or `withdrawn`; `pending_review` → `rejected`; an open `draft`/`pending_review` becomes `withdrawn` when a newer edit replaces it.
  - FAQ revision: starts in `pending_review` (there is no indexing step).
  - Indexing state (`pending`/`ready`/`failed`) is separate from review state. A document revision can be submitted and approved only when every chunk landed; its chunks are frozen once it leaves `draft`.
- **Publication:** approval locks the container, refuses a revision older than the published one, supersedes the current revision and moves the pointer in one transaction. A deferred trigger guarantees at commit that "approved" and "pointed to" agree, for every role including the table owner.
- **Provenance and audit:** each revision records its content hash, source type and reference, origin (`editor` or `legacy_backfill`), and who created, submitted, reviewed and retired it, with timestamps. The lifecycle is linear, so these columns are the complete transition record; no `audit_logs` table was added (D7 keeps it PENDING). Logs carry ids only, never content.
- **Authorization:**
  - Editing (create a revision, submit) needs membership of the row's tenant; approve, reject and withdraw need owner/admin. Authority comes from `auth.uid()` in the database and from `requireBusiness()` in the app; a caller-supplied tenant id is accepted only when the caller is a member of it.
  - Members have no direct insert/update on documents, FAQs or revisions, and no chunk writes. Owners/admins may delete only unpublished containers.
  - Indexing and retrieval RPCs are service-role only; every indexing call names the tenant, document and revision, and all three must agree.
- **Retrieval:** `search_governed_knowledge` (full text, `english` dictionary) and `match_governed_knowledge_chunks` (pgvector `vector(768)`) return approved, published, fully indexed, tenant-consistent content only. The collection scope is applied inside the query, before ranking, on both paths. With embeddings enabled the two lists are merged with Reciprocal Rank Fusion; an embedding failure falls back to full text. The pre-D14 `search_knowledge`/`match_knowledge_chunks` keep their signatures but now return governed content only.
- **Agent collection scope:** `knowledge.collectionIds` empty = all of the tenant's approved content (bound and unbound documents, and FAQs); nonempty = only documents bound to those collections, so FAQs and unbound documents are excluded. An unknown or foreign collection id denies retrieval (the turn degrades, `knowledge.retrieved.degraded = true`); it never widens. Activation accepts only well-formed collection ids.
- **Pinning:** knowledge is resolved per turn against the current publication, not pinned per conversation, so withdrawal is immediate (D14 item 5 default).
- **Legacy data:** documents, chunks and FAQs that existed before `0033` have no revision and are **not served**, whatever their `status` or `is_published`. Nothing is approved automatically. `knowledge_governance_census()` reports ungoverned, orphaned and tenant-mismatched rows. `knowledge_backfill_legacy(business, apply)` (service role, dry run by default, one tenant per call, idempotent) creates unapproved revisions for human review and quarantines empty, foreign-collection or source-less documents.
- **APPROVED (G1, blueprint §16; principle 7):** facts are approved before use. Unknown questions are deferred, never improvised. Restricted questions escalate. Actions go through tools.
- **Gaps (VERIFIED: `source`):**
  - Full-text search with the English dictionary is weak for Telugu (W2.5).
  - `isSubstantiveQuestion` matches English only, so knowledge gaps are never recorded on Telugu turns. This conflicts with the `AGENTS.md` rule that safety checks must be language-configurable (W2.1).
  - **Fixed locally (W2.1, local release-readiness audit, 2026-10-15; [report](LOCAL_RELEASE_READINESS_REPORT.md)):** the gate's cues are now per-language data in `packages/language/question-cues.ts`; Telugu-script, romanized and Tenglish questions are recorded as gaps, and English behaviour is pinned identical to the old regex by an oracle test (`local test`). Cue lists are curated, not exhaustive.
  - The `openai` embedding provider needs a new dimension migration, which requires owner approval.
  - Approval has no separation of duties: an owner/admin may approve a revision they wrote (D14 item 3 default).

### 8.3 Tenant-scoped access, RLS and server-side authorization

- **VERIFIED (`source`, `disposable DB`):** RLS covers every migrated table. Helper functions check membership and admin role. The tenant ownership triggers from `0020` re-check agent, version, conversation, phone number and call tenancy. Production guards (`0030`, `0031`) reject draft-version bindings and invalid identity tuples.
- **Phase 2, Workstream 1 (VERIFIED: `disposable DB`, `local test`; PROPOSED for real databases: [D22](DECISIONS.md#d22--migration-0034-tenant-reference-integrity)):**
  - `0034` adds a same-tenant check on every remaining tenant-to-tenant reference. A catalog gate in `check:rls` keeps all 43 references ownership-checked.
  - `0034` revokes TRUNCATE, REFERENCES, TRIGGER, MAINTAIN and sequence privileges from client roles. Supabase grants them by default, and TRUNCATE ignores RLS.
  - The CI stubs now reproduce Supabase's default privileges and the PostgREST JWT claim, so the disposable database grants what a hosted project grants.
  - Evidence: [TENANT_ISOLATION_EVIDENCE.md](TENANT_ISOLATION_EVIDENCE.md).
- **Server-side authorization (VERIFIED: `source`, `local test`):**
  - Service-role list and search queries filter by `business_id`. Some by-id repository methods (scheduling, CRM) rely on callers that load ids from a tenant-checked source. All callers were reviewed, and `0034` makes the database refuse cross-tenant references among those rows. The web conversation store now filters history and leads by the trusted tenant, as the voice store does.
  - Background jobs never combine rows of two tenants: a mismatched workflow run is dead-lettered, and a mismatched reminder is not sent.
  - Mutating routes check membership and role.
  - Tool authorization is application policy, not model output.
  - Tenant-admin operational counts were fixed on 2026-10-13 so they no longer leak across tenants.
- **BLOCKED:** verification in a deployed environment (hosted Auth, grants, the service-role inventory, the migration ledger, historical linkage counts). This is the database migration/linkage identity audit (SEC-04 scope; [D15](DECISIONS.md#d15--canonical-tracking-ids-eng-04-versus-eng-12)).

### 8.4 Secrets and integration credentials

- **VERIFIED (`source`):**
  - Secrets come only from the environment and are validated by `packages/platform/env.ts`. `.env.example` lists names only.
  - The service-role client is `server-only`.
  - Provider credentials live in the app and gateway processes only. The worker's `ready` frame is asserted free of secrets.
  - Calendar credentials are encrypted with AES-256-GCM in a `v1.` envelope, with active and previous keys for rotation ([CALENDAR_CREDENTIALS_RUNBOOK.md](CALENDAR_CREDENTIALS_RUNBOOK.md)).
  - The logger redacts common sensitive fields. Telemetry is allowlist-only. The log messaging provider omits recipient and content.
- **BLOCKED / UNKNOWN:**
  - The encryption backfill of the one local plaintext row awaits write authorization.
  - The deployment secret manager is unknown because there is no target.
  - Legacy plaintext reads must be removed once every database and backup has been migrated.

### 8.5 Consent, retention, deletion and sensitive data

- **Retention (VERIFIED: `source`):** each tenant sets `data_retention_days` (30–3650), and a daily cron purges conversations and analytics. Whether that covers the call and transcript tables, backups or provider copies is **UNKNOWN**.
- **Recording:** not implemented. A consent CHECK exists on `calls` (PENDING, [D6](DECISIONS.md#d6--call-recording-in-the-pilot)).
- **Outreach consent (VERIFIED: `source`):** consent lives on campaign contacts, suppression in `phone_suppressions`, and DNC is terminal.
  - **PENDING (D11, R8):** the lawful basis, contact provenance and disclosure wording.
- **AI disclosure (VERIFIED: `source`):** the greeting must carry the disclosure, and the platform never invents or translates one. Approved Arunodhaya wording is PENDING (D11).
- **Sensitive data:** transcripts are stored in Postgres, and telemetry excludes text. A `piiRules` configuration field exists, but nothing in `packages/` or `src/` reads it (`source`), so it enforces nothing (G2.10, W2.3).
- **Retention coverage (VERIFIED: `disposable DB`, 2026-10-15):** the purge reaches calls, conversations and their cascades, and usage events. CRM, appointment, campaign and workflow tables are not purged (PENDING, [D23](DECISIONS.md#d23--retention-coverage-beyond-conversations-and-calls)).
- **UNKNOWN:**
  - an export and deletion-on-request procedure;
  - Indian data-protection obligations;
  - data residency, given that the existing hosted project is in Sydney ([D19](DECISIONS.md#d19--hosting-topology-and-region)).

### 8.6 Migrations, backups and recovery

- **Migrations (APPROVED: `AGENTS.md`, G1):** migrations are additive and numbered (`0001`–`0034`). A migration that may have been applied is never edited, and a new one needs owner approval.
- **`0001`:** restored to its committed version on 2026-10-15, because it is applied locally ([D10](DECISIONS.md#d10--dirty-tree-commit-grouping-and-the-uncommitted-0001-edit)). How to run it on hosted Supabase is PENDING ([D21](DECISIONS.md#d21--running-migration-0001-on-hosted-supabase)). On the real Supabase image, the unedited chain applies when the session has `extensions` on its `search_path` and `vector` is absent or in `public` (`disposable DB`, 2026-10-15). The procedure is [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md).
- **Validation (VERIFIED: `source`, `disposable DB`):** `check:migrations` and `check:rls` refuse non-disposable targets, through guards in `scripts/disposable-database.mjs`.
- **Backups and recovery:**
  - A local synthetic dump and restore was VERIFIED (`disposable DB`): 44 table fingerprints across the `public` schema (41 tables) plus the CI-stub `auth` and `storage` schemas, and 6 identity checks, taking 17–26 s on a fixture.
  - Hosted backups and point-in-time recovery: **UNKNOWN**.
  - RPO and RTO: unapproved.
  - Application artifact rollback: **BLOCKED**, because no immutable artifacts exist ([DEPLOYMENT.md](DEPLOYMENT.md), [OPERATIONS.md](OPERATIONS.md)).

---

## 9. Telemetry and operations

| Concern | Current design | Classification |
|---|---|---|
| Correlation | One ID per Node HTTP request (AsyncLocalStorage, `x-request-id`) and one per voice session, shared with that session's runtime turns. The Pipecat `ready` frame carries a per-call `correlationId`. WS4 now authenticates correlation in signed Next→gateway bodies and stream tokens, persists call context and includes canonical worker ContextVars; workflow event/timer UUID columns restore jobs independently of cron context. | VERIFIED (`source`, `local test`); local propagation implemented; hosted export PENDING ([D18](DECISIONS.md#d18--telemetry-export-backend-and-cross-process-correlation)) |
| Structured telemetry | `HALO_TELEMETRY=stdout` emits allowlisted JSON observations: `http.request`, `voice.*`, `runtime.outcome`, `tool.outcome`, `booking.outcome`, `dependency.attempt` and `dependency.retry`. No payloads, transcripts, identities or IDs are used as labels. | VERIFIED (`source`, `local test`) |
| Call and stage latency | `call_events` with per-stage latency, `call_transcript_turns`, `context_ready` and `llm_first_token` marks | VERIFIED (`source`, `local test`) |
| Runtime events and usage | Runtime events (counts, codes, durations); `usage_events` with token usage when the provider reports it (never estimated) | VERIFIED (`source`, `local test`) |
| Outcomes | `conversation_outcomes`, lead states, campaign events, lifecycle and operations analytics APIs | VERIFIED (`source`) |
| Health and readiness | `/api/health` liveness; `?deep=1` is authenticated, checks the database and providers, and **costs money**, so never poll it unattended; gateway `/health` reports the session count and drains with 503 | VERIFIED (`source`, `local test`) |
| System status | Tenant-scoped reminder and workflow queues, dead letters, oldest overdue item, successful-turn latency percentiles. A failed query is reported as unavailable, never as empty. | VERIFIED (`source`, `local test`); provider failure rate unavailable (no durable source) |
| Alerts | Deterministic evaluator with deduplicated transitions and resolution, and a bounded in-process sink. No scheduler, store or destination. | VERIFIED (`local test`); hosted delivery BLOCKED |
| Redaction and access | Logger redaction, telemetry allowlists, log-mode messaging without content; system status is tenant-scoped and authenticated | VERIFIED (`source`, `local test`) |
| Dashboards and export backend | None. Log query recipes are in [TELEMETRY.md](TELEMETRY.md). | PENDING (D18, D12) |
| Python worker metrics | Not instrumented | UNKNOWN; PROPOSED under D18 |
| Cost per call | Token usage when reported; no currency budget, no invoice reconciliation | Gap (R6, criterion 6) |

Runbooks: [OPERATIONS.md](OPERATIONS.md), [DEPLOYMENT.md](DEPLOYMENT.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md), [CALENDAR_CREDENTIALS_RUNBOOK.md](CALENDAR_CREDENTIALS_RUNBOOK.md) and [HOSTED_SUPABASE_SETUP.md](HOSTED_SUPABASE_SETUP.md).

---

## 10. Deployment and extensibility

### 10.1 Local development (VERIFIED: `source`)

- **App:** `npm run dev`, with the local Supabase stack on ports **5532x** (G2).
- **Voice:** `npm run voice-gateway` plus the worker, run from `.venv`. Speech is fake, Sarvam or local: models are optional and downloaded by `setup_local_speech.py`. The carrier is `fake`.
- **Defaults:** `HALO_OUTBOUND_ENABLED=false`, `MESSAGING_PROVIDER=log`.
- **Hosted overlay:** `.env.hosted.local` points at the hosted Supabase project ([HOSTED_SUPABASE_SETUP.md](HOSTED_SUPABASE_SETUP.md)).

### 10.2 Deployment boundaries

| Unit | Shape | State |
|---|---|---|
| Next.js app, widget and cron | Serverless-friendly; Vercel is the reference host (`vercel.json` crons) | No deployment exists; the launch envelope is **zero tenants and zero requests** ([DEPLOYMENT.md](DEPLOYMENT.md)) |
| Voice gateway | A long-lived, stateful Node process, **not** a serverless function. Sessions are in memory, so it runs as a single instance or with sticky routing. | Not deployed; topology PENDING ([D19](DECISIONS.md#d19--hosting-topology-and-region)) |
| Pipecat worker | A long-lived Python process; CPU-bound μ-law conversion runs in Python | Not deployed; no load test |
| Database | Supabase (Postgres, Auth, Storage) | A hosted project exists in Sydney. Hosted Auth and isolation are unverified, and it is **not** an authorized staging target. |

### 10.3 Configuration and secrets (VERIFIED: `source`)

- Validated environment (`packages/platform/env.ts`), startup checks (`src/lib/startup-check.ts`) and `npm run preflight` / `preflight:ci`.
- Gateway configuration fails closed (`services/voice-gateway/config.ts`). Voice and speech variables are documented there and in the service READMEs; they are not in `.env.example`.
- **UNKNOWN:** the secret manager for the deployment target.

### 10.4 Scaling assumptions and resource constraints

| Constraint | Status |
|---|---|
| One gateway instance, or sticky routing; no shared session store | VERIFIED; Redis is PENDING (D12) |
| Rate limiter in memory and per instance | VERIFIED; not a global quota or spending cap |
| Python μ-law codec on the event loop shared with Silero | VERIFIED (`source`); CPU limit unknown, no load test |
| Local speech on a 4-core laptop: 3–15 s per turn (median 7.5 s), against about 1 s with Sarvam | `local test` ([LOCAL_SPEECH.md](LOCAL_SPEECH.md)) |
| Groq rate limit of 8,000 tokens per minute on the current account | `provider` (2026-09-24) |

### 10.5 Additional tenants and channels

- **APPROVED (G1):** a new tenant needs configuration and content, never a code fork. VERIFIED: `check:neutral` keeps industry content out of `packages/*`. Generic demo tenants (education, professional services, support) pass golden fixtures (`local test`, scripted).
- **New channel:** add a `ChannelProfile` and an adapter; the runtime does not branch on channel (VERIFIED: `source`).
- **WhatsApp as a conversational channel:** not implemented. WhatsApp exists only as an outbound messaging adapter.
- **OpsCorp:** an `OpsProvider` port exists with only a log adapter. The direction is APPROVED (blueprint §13/§14 via G1); the implementation is out of V1 scope.

### 10.6 External dependencies and operational limits

Every external service is unverified at $0 for hosting: hosting, database and Auth, LLM, Sarvam, Twilio, calendars, Resend, WhatsApp, monitoring and CI. Each requires the owner's account evidence of cost, quota and suspension behaviour before use ([DEPLOYMENT.md](DEPLOYMENT.md), "External dependency inventory"). Unknown cost is a release blocker (G2).

---

## 11. Trust boundaries

```text
 [Untrusted]                 [Boundary check]                                     [Trusted core]
 Website visitor  ── widget key / visitor token, origin, rate limit, tuple check ─▶ widget routes ─▶ runtime
 Operator browser ── Supabase session (proxy), membership+role, RLS ─────────────▶ dashboard / APIs
 Carrier          ── webhook signature (fail closed), DID → tenant, HMAC stream token ─▶ gateway
 Pipecat worker   ── control protocol: zod schema, 32 KB cap, version check, no identity upward ─▶ gateway
 LLM output       ── closed tool registry, strict args, authorization, act-then-narrate validator ─▶ actions
 Retrieved text / recap ── labelled as data, sanitized, never instructions ─▶ prompt
 Tenant webhooks  ── per-tenant secret (in); SSRF guard, HTTPS only, no redirects (out) ─▶ workflows
 Cron callers     ── CRON_SECRET bearer ─▶ cron routes
 Service role     ── server-only client; explicit business_id filters; DB ownership triggers ─▶ Postgres
```

Every boundary above is VERIFIED (`source`, `local test`). None is verified in a deployed environment.

**Residual risks (VERIFIED: `source`)**

- Stream-token replay within its TTL (fix deferred). **Fixed locally by W1.2** (local release-readiness audit, 2026-10-15; [report](LOCAL_RELEASE_READINESS_REPORT.md)); no carrier evidence.
- DNS rebinding between the SSRF check and the fetch (documented residual).
- The origin allowlist is a browser-only control.
- Service-role correctness depends on code.

---

## 12. Decisions, proposals and open questions

The authoritative list, with options, trade-offs, recommendations and required approvers, is [DECISIONS.md](DECISIONS.md). In summary:

- **Approved (standing):**
  - G1: blueprint principles.
  - G2: $0 limit, outbound off, log-mode messaging.
  - G3: agent roles.
  - G4: documentation authority.
  - R1–R7: release-owner direction.
- **Pending, and blocking the pilot:**
  - D3 carrier, D4 call direction, D6 recording, D8 spend, D11 business facts and policy, D17 provider route.
  - R8 pilot environment and data handling.
- **Pending architecture choices:**
  - D1 stack and D2 layout. The recommendation is to keep both and fix the gateway import leak.
  - D5 tool model, and the `audit_logs` part of D7. The `tool_executions` part was implemented and verified on a disposable database on 2026-10-15.
  - D9 targets.
  - D12 optional infrastructure, D13 workflow engine, D18 telemetry backend, D19 hosting, D20 phone speech streaming.
  - D14: implemented locally on 2026-10-15; its design defaults (items 1–6) await owner ratification, and applying `0033` to a real database awaits R8, D19 and D21.
- **Pending governance:** D15 tracking IDs; D16 the "Astra" role. D10 (commit grouping) was executed on 2026-10-15.
- **Pending database operations:** D21, running `0001` on hosted Supabase (method evidenced; see [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md)); D22, adopting `0034`; D23, retention coverage.
- **Review dispositions (2026-10-15):** every entry was reviewed; see [HALO_DECISION_REVIEW.md](HALO_DECISION_REVIEW.md). Nothing was approved.

---

## 13. Known limitations

Each item is VERIFIED unless stated otherwise. The full list of gaps is in [HALO_V1_GAP_ANALYSIS.md](HALO_V1_GAP_ANALYSIS.md).

1. **No deployment, staging target, real carrier call, real calendar booking, real message delivery, approved business facts or pilot sign-off exists.**
2. Real LLM inference for the pilot is blocked by spend (D8). The current accounts hit 429 (Groq) and 402 (OpenRouter).
3. The phone path does not stream from the LLM to TTS, and TTS chunks are synthesized one after another. End-to-end latency is unmeasured and estimated at 2.0–3.5 s.
4. Telugu weaknesses:
   - no STT confidence, so confidence-gated read-back never fires;
   - full-text retrieval uses the English dictionary;
   - `isSubstantiveQuestion` matches English only (fixed locally by W2.1, local release-readiness audit, 2026-10-15; [report](LOCAL_RELEASE_READINESS_REPORT.md));
   - local Telugu STT runs at 67% WER;
   - no human has reviewed the TTS output.
5. The LLM provider is process-global, so an agent cannot pin a model.
6. Voice sessions live in one process, with no failover. The rate limiter is per instance.
7. Tool-call audit (`0032`) is verified on a disposable database only; it has not been applied to any shared or hosted database. `audit_logs` is added by local-only WS4 migration `0036`; tools still have no per-tool timeout or retry policy.
8. Knowledge governance (`0033`) is verified on a disposable database only. Existing knowledge is not served until it is re-indexed and approved through the backfill, and approval has no separation of duties.
9. No alert delivery, hosted backup, approved RPO/RTO or artifact rollback exists.
10. Worker and gateway use different default speech models, and the worker ignores the minimum-speech settings for VAD and barge-in.
11. The gateway imports application-layer code (D2).
12. **Documentation drift corrected by this consolidation:**
    - **Booking on the voice path is wired** (`source`). Earlier records said otherwise: [ARUNODHAYA_AGENT.md](ARUNODHAYA_AGENT.md) (2026-09-21), [HALO_V1_RELEASE_GAPS.md](HALO_V1_RELEASE_GAPS.md) and [HALO_V1_STATUS.md](HALO_V1_STATUS.md).
    - **The Pipecat worker is runnable** and ran `browser-live`. [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) and [PIPECAT_INTEGRATION.md](PIPECAT_INTEGRATION.md) said it was never run.
    - **Retrieval is not skipped on non-substantive turns.** [VOICE_TOKEN_BUDGET.md](VOICE_TOKEN_BUDGET.md) said it was.
    - **`collectionIds` now fail closed** rather than being ignored.
    - **There are three built-in tools, not two.** [RUNTIME.md](RUNTIME.md) and [SECURITY.md](SECURITY.md) said two.

    The affected documents now carry dated correction notes.

---

## 14. Blueprint v0.1 traceability

| Blueprint § | Topic | Where covered | Position |
|---|---|---|---|
| 1–3 | Executive model, product concept, multi-tenant model | §2.1, §4.1 | Aligned (G1); VERIFIED |
| 4–5 | Agent architecture; Arunodhaya example | §4.2, §7 | Aligned; the example's tools differ (no `get_lead`/`update_lead` tools; actions are deterministic) — D5 |
| 6–7 | High-level system; call lifecycle | §3, §6 | Single process plus gateway and worker, not separate services — D1 |
| 8 | Real-time voice loop | §6 | Aligned; LLM→TTS streaming not on the phone path |
| 9–10, 35 | Agent runtime; context and token architecture | §5.3, §6.4 | Aligned; prompt caching not implemented |
| 11–12 | Tool architecture and execution | §5.3 | Partial: no per-tool timeout, retry or output schema (D5). Audit implemented and disposable-DB verified (D7, `tool_executions`). |
| 13–14, 40 | Business adapter layer; OpsCorp | §10.5 | `OpsProvider` port, log adapter only; out of V1 scope |
| 15–16, 30 | Knowledge architecture, guardrails, Arunodhaya knowledge | §8.2 | Approval, revisions and governed retrieval implemented locally (D14, `0033`); facts D11 |
| 17 | Workflow engine | §5.4 | PENDING D13 |
| 18 | Call state machine | §6, §7.1 | Aligned (two machines plus a separate outcome) |
| 19 | Lead qualification | §7.1 | Aligned; criteria D11 |
| 20 | Recording and transcript | §8.5 | Transcripts yes; recording PENDING D6 |
| 21, 34 | Analytics; cost architecture | §9 | Partial: no currency cost, no invoice reconciliation |
| 22 | Data architecture | §8.1 | Partial (see the table there) — D7 |
| 23 | Agent versioning | §4.2 | Aligned; VERIFIED |
| 24 | Security architecture | §4.4, §8.3–8.4, §11 | Aligned locally; deployed boundary BLOCKED |
| 25–26 | External integrations; provider abstraction | §5.5 | Ports aligned; Exotel absent — D3 |
| 27 | Technology stack | §3.3 | Deviation PENDING D1; Redis, Sentry and object storage D12 |
| 28 | Repository structure | §3.3 | Deviation PENDING D2 |
| 29 | Arunodhaya MVP | §2, §7 | Recording D6; dashboard exists (receptionist-era plus HALO pages) |
| 31 | Telugu-first voice requirements | §6, gap analysis | Partial; human review pending (R4) |
| 32 | Human handoff | §7.6 | Mechanism aligned; staffing D11 |
| 33 | Reliability | §5.6 | Aligned (no false success) |
| 36–37 | Development workflow; agent documentation | `AGENTS.md`, G3 | Aligned; "Astra" D16 |
| 38 | Deployment evolution | §10 | Not deployed; D19 |
| 39 | Product evolution (v0.1 outbound, recording) | §2.2, §7.5 | Direction D4; recording D6 |
| 41–43 | Principles, mental model, final decision | §2.1 | Aligned (G1) |

---

## 15. Document map

The archive index lists every superseded document and where its content now lives: [archive/README.md](archive/README.md).

### Canonical

| Document | Role |
|---|---|
| [HALO_Architecture.md](HALO_Architecture.md) | Authoritative architecture (this document) |
| [DECISIONS.md](DECISIONS.md) | Authoritative decision register |
| [HALO_V1_GAP_ANALYSIS.md](HALO_V1_GAP_ANALYSIS.md) | V1 outcomes and requirements mapped to gaps and acceptance criteria |
| [HALO_V1_IMPLEMENTATION_PLAN.md](HALO_V1_IMPLEMENTATION_PLAN.md) | Dependency-ordered plan (not a completion claim) |

### Status, release and evidence records (dated; retained)

| Document | Role |
|---|---|
| [HALO_V1_STATUS.md](HALO_V1_STATUS.md) | Status register for the ten release criteria (R2) |
| [HALO_V1_RELEASE_DECISIONS.md](HALO_V1_RELEASE_DECISIONS.md) | Release ratification text, GA acceptance conditions, threshold candidates, pilot plan P1–P8 |
| [HALO_V1_RELEASE_GAPS.md](HALO_V1_RELEASE_GAPS.md) | Ten-row audit mapping; integration and pilot acceptance matrix (2026-10-09) |
| [HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md](HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md) | Phase boundaries; Alpha acceptance |
| [HALO_PHASE_BETA_READINESS.md](HALO_PHASE_BETA_READINESS.md) | Staging readiness matrix (BLOCKED) |
| [HALO_PHASE_BETA_DISCOVERY_REPORT.md](HALO_PHASE_BETA_DISCOVERY_REPORT.md) | Beta discovery (user-owned; preserved unchanged) |
| [HALO_IMPLEMENTATION_VERIFICATION.md](HALO_IMPLEMENTATION_VERIFICATION.md) | 2026-10-01 implementation and verification evidence |
| [ENG_01_SECURITY_IDENTITY_REVIEW.md](ENG_01_SECURITY_IDENTITY_REVIEW.md) | Security and identity review (SEC-01–06) |
| [HALO_REAL_INTEGRATION_VERIFICATION.md](HALO_REAL_INTEGRATION_VERIFICATION.md) | Integration verification and provider metadata (2026-10-13) |
| [HALO_THREE_GATE_EXECUTION.md](HALO_THREE_GATE_EXECUTION.md) | Inference, Auth and operations gates (2026-10-13) |
| [HALO_LAYER_1_REVIEW.md](HALO_LAYER_1_REVIEW.md) | Layer 1 review and closure; D14 migration proposal |
| [HALO_DECISION_REVIEW.md](HALO_DECISION_REVIEW.md) | Decision review dispositions, release-gate matrix, unknowns and owner actions (2026-10-15) |
| [TENANT_ISOLATION_EVIDENCE.md](TENANT_ISOLATION_EVIDENCE.md) | Phase 2 tenant-isolation evidence and `0034` findings (2026-10-15) |
| [VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md) | Voice pipeline latency and cost audit (2026-10-14) |
| JSON evidence | [HALO_THREE_GATE_LOCAL_EVIDENCE.json](HALO_THREE_GATE_LOCAL_EVIDENCE.json), [HALO_LOCAL_CHAT_INTEGRATION_RESULT.json](HALO_LOCAL_CHAT_INTEGRATION_RESULT.json), [HALO_INTEGRATION_PROVIDER_METADATA.json](HALO_INTEGRATION_PROVIDER_METADATA.json) |
| [PHASE4_REPORT.md](PHASE4_REPORT.md) | Historical Phase 4 report; kept in place because code and tests cite it |

### Runbooks (current)

| Document | Role |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deployment and zero-cost release procedure (no deployment authorized) |
| [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md) | First-hosting migration and database rollout (D21, D22, D14); read-only preflight; not an authorization |
| [OPERATIONS.md](OPERATIONS.md) | Day-2 operations, incidents, restore procedure |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Symptom-first diagnosis |
| [INSTALLATION.md](INSTALLATION.md) | Local setup. Its migration range is out of date; apply all files in `supabase/migrations/`. |
| [TESTING.md](TESTING.md) | Test commands and manual checklist. Its test counts are historical. |
| [CALENDAR_CREDENTIALS_RUNBOOK.md](CALENDAR_CREDENTIALS_RUNBOOK.md) | Calendar credential encryption, rotation and rollback |
| [HOSTED_SUPABASE_SETUP.md](HOSTED_SUPABASE_SETUP.md) | Hosted Supabase overlay |
| [LOCAL_VOICE_LOOP.md](LOCAL_VOICE_LOOP.md) | Local microphone/speaker harness |
| [TELEMETRY.md](TELEMETRY.md) | Telemetry configuration, coverage and queries |

### Subject references (retained; code is the source of truth)

| Document | Role |
|---|---|
| [RUNTIME.md](RUNTIME.md) | Agent runtime detail |
| [VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md) | Voice boundary and gateway (Phase 3) |
| [PIPECAT_INTEGRATION.md](PIPECAT_INTEGRATION.md) | HALO ⇄ Pipecat contract |
| [VOICE_STATE_MACHINE.md](VOICE_STATE_MACHINE.md) | Call and session state machines |
| [VOICE_LATENCY_MODEL.md](VOICE_LATENCY_MODEL.md) | Timing marks and mock latency |
| [VOICE_TOKEN_BUDGET.md](VOICE_TOKEN_BUDGET.md) | Voice context budget |
| [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) | Claims not yet earned (cited from code) |
| [SECURITY.md](SECURITY.md) | Security model detail |
| [API.md](API.md) | Public widget API (does not cover routes added later) |
| [SCHEDULING.md](SCHEDULING.md) | Booking engine |
| [WORKFLOWS.md](WORKFLOWS.md) | Workflow engine and CRM |
| [LIFECYCLE.md](LIFECYCLE.md) | Customer lifecycle |
| [AI.md](AI.md) | Receptionist intelligence |
| [COMPONENTS.md](COMPONENTS.md) | UI components |
| [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md) | Runtime overhead baseline |
| [WEB_MIC_STT_DIAGNOSIS.md](WEB_MIC_STT_DIAGNOSIS.md) | 2026-10-01 browser microphone diagnosis |
| [CHANGELOG.md](CHANGELOG.md) | Release history (not updated after 2026-09-22) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Pointer stub; original archived |

Where these documents cite paths under `src/core/*`, `src/providers/*` or `src/lib/*` that moved into `packages/*`, they carry a path note.

### Pilot tenant (Arunodhaya)

| Document | Role |
|---|---|
| [ARUNODHAYA_AGENT.md](ARUNODHAYA_AGENT.md) | Agent configuration (2026-09-21; voice booking statement corrected, §13) |
| [ARUNODHAYA_NEGOTIATION_POLICY.md](ARUNODHAYA_NEGOTIATION_POLICY.md) | Commercial policy mechanism; every value UNSET |
| [ARUNODHAYA_LEARNING_LOOP.md](ARUNODHAYA_LEARNING_LOOP.md) | Controlled learning loop design |

### Speech and LLM experiments (evidence)

| Document | Role |
|---|---|
| [LOCAL_SPEECH.md](LOCAL_SPEECH.md), [LOCAL_SPEECH_BENCHMARK.md](LOCAL_SPEECH_BENCHMARK.md) | Local speech setup and benchmarks |
| [LOCAL_TELUGU_STT_HUMAN_REVIEW.md](LOCAL_TELUGU_STT_HUMAN_REVIEW.md), [LOCAL_TELUGU_HUMAN_REVIEW_PACKET.md](LOCAL_TELUGU_HUMAN_REVIEW_PACKET.md), [LOCAL_TELUGU_REVIEWER_FORM.md](LOCAL_TELUGU_REVIEWER_FORM.md), [LOCAL_TELUGU_TTS_BLIND_REVIEW.md](LOCAL_TELUGU_TTS_BLIND_REVIEW.md), [LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md](LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md), [LOCAL_TELUGU_CONSENT_LOG_TEMPLATE.csv](LOCAL_TELUGU_CONSENT_LOG_TEMPLATE.csv), [LOCAL_TELUGU_RECORDING_MANIFEST.csv](LOCAL_TELUGU_RECORDING_MANIFEST.csv) | Telugu human-review instruments. All reviews are **pending**. |
| [CLOUD_LLM_REPORT.md](CLOUD_LLM_REPORT.md), [CLOUD_LLM_RELIABILITY_REPORT.md](CLOUD_LLM_RELIABILITY_REPORT.md), `CLOUD_LLM_*.json` | Cloud LLM routing and reliability evidence (2026-09-24); the JSON is written by scripts |

## WS4 local architecture amendment — 2026-10-15

The current owner instruction explicitly authorizes this local D7/D18 implementation and additive `0036`, following unchanged `0035`. Earlier historical references to deferred general auditing/propagation are superseded by this amendment. No unrelated decision, deployment, provider action or target authorization changes.

- Security boundary wrappers write minimal append-only `audit_logs`; verified membership/resource resolution supplies identity. Protected action admission requires a durable attempt, with best-effort terminal records and explicit unknown outcomes after ambiguous errors. Authentication/denial/read records are best effort on outage and sign-out remains possible. Existing specialized tool/domain audit trails remain authoritative for their own actions.
- Service roles append/select audit; members SELECT through tenant RLS. No client writes or service UPDATE/DELETE/TRUNCATE. Owner administration and tenant deletion cascades are exceptions; retention duration for real data remains a release decision, not an invented default.
- `correlationId` is the logical-operation ID; HTTP request, job/event/run/step and security operation IDs retain distinct roles. Signed handoffs, persisted workflow/timer UUIDs, per-job derived legacy roots and Python session context link the actual local service/job paths. IDs do not authorize anything. There is no hosted tracing backend, alert destination or provider propagation proof.
- Unknown workflow/reminder outcomes and post-action evidence failures do not automatically replay. Safe workflow retry requires explicit internal proof (`RetrySafeWorkflowError`). Unkeyed calendar/WhatsApp creates run once per invocation; keyed Resend remains conditional on provider behavior. Manual independent invocations and process/remote commit gaps still rule out exactly-once guarantees.

Details, rejected alternatives and scope limits: [DECISIONS D7/D18](DECISIONS.md), [TELEMETRY](TELEMETRY.md), [WS4 evidence](WORKSTREAM_4_REPORT.md). These statements carry source/local-test/disposable-DB evidence only.
