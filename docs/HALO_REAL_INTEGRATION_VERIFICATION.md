# HALO integration verification — 2026-10-13

**Disposition: local integration fixes verified; real cloud inference and complete customer E2E BLOCKED; production NO-GO. Deployment excluded.**

Candidate: `ddeda1b2a60107e7cfece7a15d22edc510f87e47` plus preserved user work and this pass's uncommitted changes. No branch/index mutation, commit, push, hosted migration, deployment, billing change, customer data or outbound communication. Existing shared local Supabase was not queried or modified. No repository/parent `AGENTS.md` was found. Baseline status/diff and command logs are under `/tmp/halo-integrations-evidence` (ephemeral).

## Scope and required dependencies

POA's smallest proposed release is **web chat**, not the broader phone-first Arunodhaya pilot. This pass implements/tests that local scope; it does not approve a reduced pilot or close the unchanged ten-criterion register in `HALO_V1_STATUS.md` §C. Dashboard Auth remains a release prerequisite even though visitors use public widget controls rather than Supabase login.

Journey traced: widget key → active receptionist/business/origin policy → published agent/version → persisted conversation and visitor token → token/tenant/version validation and limits → ChatService → AgentRuntime → keyword knowledge retrieval + configured LLM → validated reply → transcript/state + usage events. Event-bus audit remains local; the synthetic tenants have no enabled workflows or scheduling, no lead capture and no voice. Explicit test settings: `HALO_OUTBOUND_ENABLED=false`, `MESSAGING_PROVIDER=log`, `EMBEDDING_PROVIDER=none`. No optional integration was activated or user `.env.local` modified. Existing local developer speech selections are not a release enablement decision.

| Integration / implementation and configuration | Current verification state | Evidence and remaining requirement |
|---|---|---|
| Persistence: `WidgetRepository`, `SupabaseAgentRepository`, `SupabaseConversationStateStore`, `SupabaseKnowledgeProvider`; `NEXT_PUBLIC_SUPABASE_URL`, anon/service-role keys | **CONFIGURATION VERIFIED** (schema and secret presence); **REAL CONTRACT VERIFIED**, **END-TO-END VERIFIED for local persistence slice only** | Fresh cached Postgres 16 + PostgREST 14.13, real Supabase SDK, all 31 migrations, 109 real-role RLS assertions; real two-turn transcript/state/knowledge/usage. Auth/storage platform schemas are CI stubs. Configured shared local DB and hosted DB not verified. Need target identity, grants, real Auth, capacity and recovery proof. |
| Visitor access/authorization: widget routes, origin policy, token, pinned identity, PostgREST JWT validation and RLS | **END-TO-END VERIFIED locally** for public widget controls; **AUTHENTICATION VERIFIED locally** for synthetic signed JWTs | Invalid JWT rejected 401; invalid visitor token 404; denied origin 403; tenant B cannot read A via real PostgREST/RLS. JWT issuer and users are synthetic. Origin is a browser control, not protection against a non-browser caller forging its header. |
| Dashboard Supabase Auth: `packages/tenancy/supabase/{server,client}`, `src/proxy.ts`, auth actions; Supabase URL/anon key, app URL | **CONFIGURATION VERIFIED** for presence/schema; real sign-in/refresh/logout **BLOCKED** | No dedicated authorized GoTrue/Auth target was identified; existing shared instance untouched. CI `auth.uid()`/users are stubs, not Auth login. Need isolated Auth target and email-free synthetic login/session verification; no email sent. |
| Configured cloud LLM: factory → fallback router → OpenAI-compatible HTTP adapter; `LLM_PROVIDER=cloud`, `GROQ_LLM_API_KEY`, `OPENROUTER_LLM_API_KEY`, `LLM_TIMEOUT_MS=25000`; optional `HALO_MODEL_ROUTES` absent | **CONFIGURATION VERIFIED**, **AUTHENTICATION VERIFIED** for metadata endpoints; inference **MOCK-ONLY / BLOCKED** | Four real metadata GETs returned 200; all four configured IDs listed. No completion/stream inference request. Real contract verified only for metadata, not adapter inference. Need current Groq allowance/billing/overage evidence and an explicitly bounded free inference route; OpenRouter's selected models advertise nonzero prices and purchased credits are zero. |
| Knowledge/embeddings | Keyword retrieval **REAL CONTRACT VERIFIED locally**; embeddings **NOT REQUIRED FOR INITIAL SCOPE** | `EMBEDDING_PROVIDER=none`; synthetic FAQ retrieved through actual DB RPC and included in the runtime prompt. Document upload/Storage and vector ingestion excluded from this pre-provisioned chat slice; enable only after separate evidence. |
| Usage/operational controls: runtime budgets, provider timeout, fallback cooldown, widget limiter/message ceiling, usage events, health/cron | **END-TO-END VERIFIED locally** for synthetic usage attribution/limits; provider billing reconciliation **BLOCKED** | Synthetic 30 input + 10 output tokens recorded per successful turn, correct tenant; 200-row conversation ceiling blocks inference. In-memory per-instance limits are not a global spend cap. `CRON_SECRET` absent; cron/deep health not release-ready. Need target monitoring, global capacity/cost envelope and real usage receipts. |
| Sarvam STT/TTS and gateway/Pipecat worker | **NOT REQUIRED FOR INITIAL SCOPE**; **CONFIGURATION VERIFIED** for local gateway schema only; real speech **BLOCKED** if selected | `VOICE_STT_PROVIDER=VOICE_TTS_PROVIDER=sarvam`, recognized `SARVAM_API` compatibility key present, default voice configured; gateway endpoints loopback. No speech requests. Mock contracts and worker synthetic socket/audio suite pass. Need current quota/authorization and human Telugu review. |
| Telephony/Twilio, signing/callbacks | **NOT REQUIRED FOR INITIAL SCOPE**; **MOCK-ONLY** | Local telephony selection is `fake`; Twilio adapter/webhook signature/replay tests exist. No real call, carrier number, public callback or free call allowance verified. Keep gateway/phone ingress disabled for chat release. |
| Calendar/scheduling, messaging, workflow webhook destinations | **NOT REQUIRED FOR INITIAL SCOPE**; **MOCK-ONLY** for external contracts | Calendar factory/OAuth (`GOOGLE_CLIENT_ID/SECRET`, optional Microsoft/CalDAV); messaging factory (`MESSAGING_PROVIDER`, Resend/WhatsApp keys); per-tenant webhook secrets and configured workflow URLs. Google credential presence does not authorize calendar operations. Booking remains off, no calendar connection/workflow for the test tenants, messaging log-only, outbound off. Existing signature, retry, duplicate-event, timeout and privacy regressions pass. No callback/destination delivery verified. |

## Real provider metadata and cost boundary

Sanitized actual responses: [provider metadata](HALO_INTEGRATION_PROVIDER_METADATA.json), timestamp `2026-10-13T03:44:03.168Z`. Existing credential values were used only in Authorization headers to fixed provider endpoints, never printed. Four GETs, 10-second timeout each, no retry/redirect, no prompt or customer input:

- Groq `/openai/v1/models`: 200; `openai/gpt-oss-120b` and `qwen/qwen3.8-27b` present.
- OpenRouter `/api/v1/key`: 200; `is_free_tier=true`, `limit=null`, `limit_remaining=null`, daily/monthly usage 0. Null is **not** proof of a zero-cost cap or remaining free allowance.
- OpenRouter `/api/v1/credits`: 200; purchased credits 0, historical total usage `0.183508087`. This pre-existing usage is not a charge from this task.
- OpenRouter `/api/v1/models`: 200; `anthropic/claude-sonnet-4.6` and `qwen/qwen3.8-27b` present, with nonzero advertised prompt/completion prices (raw fields preserved in the artifact).

The request boundary was established from documented read-only metadata operations, not a generic free-tier claim: [Groq model listing](https://console.groq.com/docs/models), [OpenRouter key limits](https://openrouter.ai/docs/api_reference/limits), [credit lookup](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits). These retrieve configuration/account information and generate no inference tokens. Initial sandbox attempts failed with network restrictions; the authorized network rerun succeeded. No inference, credit purchase, billing activation, top-up or outbound delivery endpoint was called.

**Incremental provider/service spend: $0 for this work's operations** (local cached containers and synthetic services, metadata reads only; zero generated provider tokens). No separate invoice reconciliation was performed. Groq remaining token/request quota, current billing tier and overage protection are unknown; OpenRouter metadata does not establish a usable free allowance for the selected priced models. Hence **zero authorized inference capacity** for this pass. Prior September diagnostics are historical, not current quota proof. No new provider/model was substituted. Hosting/Auth/DB free capacity, backup retention and recovery remain unverified for any hosted release.

## Confirmed defects fixed

| Defect/root cause | Changes | Reproduction/regression |
|---|---|---|
| HTTP SSE CRLF delimiter split over chunks merged separate events | Normalize CRLF after joining chunks in `packages/providers/llm/sse.ts` | Chunk-split reader test failed before, passed after |
| Early SSE/NDJSON consumer exit only released the reader lock, leaving upstream open | Cancel upstream in `finally`, preserve original error and release lock | Two cancellation/cleanup regressions failed before |
| Provider payloads were only TypeScript-cast; wrong content/usage types or invalid JSON escaped classification or could corrupt attribution | Zod completion/stream/error envelope validation using existing dependency; safe `invalid_response` errors; signal check before accepting result | Null/wrong shapes, negative/string usage, invalid JSON, malformed stream, late cancellation; no raw provider payload exposed |
| Web route dropped request cancellation before ChatService/runtime | Thread `request.signal` to runtime; return opaque 499 cancellation response; preserve runtime's committed-action semantics | Pre-aborted request previously returned 200 and wrote a turn. Regression now proves no model/transcript/state/usage; local HTTP test also cancels in-flight and verifies no late write |
| Fallback router forced a minimum 1ms timeout even when total budget was exhausted and accepted late results | Guard deadline/cancellation before attempts, after cooldown, after completion and at stream deltas/end | Three deterministic clock tests failed before: no next provider after deadline, no late completion, no late live-stream delta |

No retry limit was increased, tests weakened, new paid dependency introduced, migrations changed, or unrelated work replaced. Disable/rollback boundary: leave external traffic/providers disabled while reviewing these localized changes; no data migration is needed. No claim of finding every possible defect in optional adapters.

## Local route-to-database journey

[Sanitized result](HALO_LOCAL_CHAT_INTEGRATION_RESULT.json): **15/15 assertions passed** in one opt-in integration test. This uses real routes, runtime, Supabase clients, PostgREST HTTP/JWT checks, PostgreSQL functions/triggers and RLS. Only the LLM endpoint, Auth issuer/users and CI Auth/storage schema are synthetic. It is not browser UI testing, hosted availability, actual Auth login, or complete provider-backed customer E2E.

Assertions cover invalid JWT, allowed/denied origin, conversation creation and pinned identity, unknown token/input rejection before inference, two turns with real keyword knowledge/history/state/transcript, correctly attributed usage, two-tenant RLS, HTTP provider outage with bounded retry, database lookup outage, transcript write failure, real HTTP timeout without late success, pre-abort and in-flight cancellation, conversation ceiling, and no optional external effects. The harness rejects non-loopback destinations and observed **zero external attempts**; no appointment, workflow run, call or lead was created for the synthetic tenant. Separate canonical tests cover wrong tenant/agent identity, throttling, missing credentials, duplicate events/retries, and disabled outbound behavior.

Harness files: `scripts/chat-local-integration.ts`, `.test.ts`, `scripts/vitest.local-integration.config.ts`, and `scripts/fixtures/chat-integration.sql`. It never loads `.env.local`, overrides provider selection with synthetic values, and checks the disposable DB marker before touching test data. Fixture-only `auth.uid()` adaptation models PostgREST's JWT GUC; it is not a production migration.

## Commands and actual results

Commands ran on this candidate. Logs are `/tmp/halo-integrations-evidence/*.log`; durable sanitized result artifacts are linked above.

| Command | Result |
|---|---|
| Baseline `npm test -- --maxWorkers=2` | Authorized local-socket run: **130 files passed, 1,273 passed, 5 skipped, 0 failed**. Initial restricted run: 6 files failed, 30 tests failed, 1,243 passed, 5 skipped, 2 unhandled errors from blocked sockets; not a product regression. |
| Baseline `npm run lint`, `npm run typecheck`, `npm run check:architecture`, `npm run check:neutral` | All passed before product edits |
| Baseline `npm run build` | Passed after authorized public Google-font fetch; initial sandbox font-fetch failure recorded |
| Baseline/final `npm run preflight:ci` | Passed with DB check explicitly skipped; missing production cron secret and optional messaging warnings. No provider probe |
| `npm test -- tests/unit/llm-wire-safety.test.ts` before fixes | **10 failed** (expected reproductions) |
| `npm test -- tests/integration/widget-messages-security.test.ts` before cancellation fix | **11 passed, 1 failed** (expected new reproduction) |
| `npm test -- tests/unit/llm-fallback-router.test.ts` before deadline fix | **8 passed, 3 failed** (expected new reproductions) |
| Focused wire/streaming/fallback rerun | **3 files, 30 passed, 0 failed/skipped** |
| Focused widget/chat/runtime rerun | **3 files, 40 passed, 0 failed/skipped** |
| Final `npm test -- --maxWorkers=2` | **131 files passed, 1,287 passed, 5 existing local-model skips, 0 failed** |
| `HALO_DISPOSABLE_DATABASE=1 npm test -- --config scripts/vitest.local-integration.config.ts` | **1 passed, 0 failed/skipped; 15 internal assertions passed** |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'` | Supported Python environment with local socket access: **54 run, 53 passed, 1 existing skip, 0 failed** |
| `HALO_DISPOSABLE_DATABASE=1 npm run check:migrations -- postgresql://postgres:postgres@127.0.0.1:55441/halo_check_integrations` | **31 migrations + schema/identity/backfill replay assertions passed**, disposable only |
| Same target with `npm run check:rls` | **109 assertions passed**, real authenticated/service_role roles |
| Final lint/typecheck/architecture/neutral/build, `git diff --check` | Passed |
| Local env schema + provider construction + gateway schema (no methods called) | Passed; cloud/25,000ms, log messaging, embeddings none, DB/app/gateway loopback, speech keys present, fake telephony, no cron secret |
| `node /tmp/halo-provider-metadata.mjs` | **4/4 metadata GETs 200**; no inference or mutation |

Harness development failures were retained in session evidence: standalone `react-server` loader cannot import Next navigation (`createContext`); changed to an isolated Vitest loader. First HTTP proxy omitted PostgREST's single-row `Accept` header; corrected the fixture proxy, not application code. The final opt-in config executes only the disposable test and does not add a DB dependency to normal `npm test`.

### Reproduce only on a fresh local disposable instance

Cached image requirement: `pgvector/pgvector:pg16`, `public.ecr.aws/supabase/postgrest:v14.13`. `--pull=never` prohibits image downloads. These names/ports must be unused; do not substitute an existing/shared database. Password/JWT secret below are disposable fixture values, never deployment credentials.

```bash
docker run --pull=never --rm -d --name halo-integrations-disposable-20261013 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=halo_check_integrations -p 127.0.0.1:55441:5432 pgvector/pgvector:pg16
docker exec -i halo-integrations-disposable-20261013 psql -U postgres -d halo_check_integrations --set ON_ERROR_STOP=1 < infrastructure/ci/supabase-stubs.sql
HALO_DISPOSABLE_DATABASE=1 npm run check:migrations -- postgresql://postgres:postgres@127.0.0.1:55441/halo_check_integrations
HALO_DISPOSABLE_DATABASE=1 npm run check:rls -- postgresql://postgres:postgres@127.0.0.1:55441/halo_check_integrations
docker exec -i halo-integrations-disposable-20261013 psql -U postgres -d halo_check_integrations --set ON_ERROR_STOP=1 < scripts/fixtures/chat-integration.sql
docker run --pull=never --rm -d --name halo-integrations-rest-20261013 --network host -e PGRST_DB_URI=postgresql://postgres:postgres@127.0.0.1:55441/halo_check_integrations -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET=halo-disposable-synthetic-jwt-secret-20261013 -e PGRST_SERVER_HOST=127.0.0.1 -e PGRST_SERVER_PORT=55442 public.ecr.aws/supabase/postgrest:v14.13
HALO_DISPOSABLE_DATABASE=1 npm test -- --config scripts/vitest.local-integration.config.ts
docker stop halo-integrations-rest-20261013 halo-integrations-disposable-20261013
```

Wait for PostgreSQL/PostgREST readiness between startup and dependent commands. No npm install/model download/hosted migration is required. The fixture seed is for one fresh database; rerun from a fresh container if reseeding.

## Remaining release matrix — all target gates open

| Gate | Prerequisite and later evidence |
|---|---|
| Inference contract and complete customer E2E | Current account billing/remaining quotas/overage controls; approve a bounded $0 route including every possible fallback and hook request; synthetic real prompt/response + persistence/usage/failure evidence. Metadata authentication is insufficient. |
| Auth and security | Dedicated authorized Auth/DB target; sign-in/session refresh/logout, callback/redirect policy, roles/grants/RLS, origin/ingress controls, secrets and tenant isolation on deployed revision. No shared service-role or superuser result substitutes. |
| Migration compatibility | Owner-identified staging target, ledger and schema baseline, restore plan and scoped migration authorization; run target assertions and rollback compatibility. Disposable replay is not staging evidence. |
| Configuration/capacity | Pinned revision; approved tenant/feature scope; no booking, enabled workflows, speech, email, messaging or cron effects without separate proof. Current developer env is not launch-safe merely because it parses. Verify hosting/DB/Auth/LLM $0 quota and global abuse controls. |
| Worker health | Only required if voice selected: target gateway/control trust, health, media routing, drain/restart cleanup, real speech contract and human Telugu acceptance. |
| Monitoring and recovery | Named responder, authenticated health/cron config, alert delivery, retention/deletion, backup/restore and failure/reconciliation drills with measured RTO/RPO; all currently unavailable for staging/production. |
| Rollback | Pinned app/schema compatibility, tested safe disable, recoverable data baseline and authorized owner; no deployment or rollback drill performed here. |
| Charlie and final production approval | Pilot facts/policies, selected useful integrations, real pilot E2E and customer/native-speaker acceptance; preserve criteria 1–10, ENG-04/ENG-12 decision pending, explicit final owner go/no-go. |

All reproduced in-scope local defects above are fixed and regressions pass. Remaining external tests are explicit blockers, not mock-derived passes. Production remains **NO-GO**.

## Final preservation and cleanup

Final HEAD unchanged: `ddeda1b2a60107e7cfece7a15d22edc510f87e47`. Git status:
**21 modified tracked files, 13 untracked files, 0 staged** (includes all prior
user changes). Exact status saved at `/tmp/halo-integrations-evidence/final.status`.
Compared every unrelated pre-existing tracked diff byte-for-byte with the initial
binary diff: unchanged. Readiness/status and POA received appended entries only.
Discovery report SHA-256 remains
`e4418428d3caaf54425d0f0c15ed1b2a23ac95cb8fdf2f30db985da04e5b7227`.
Both task-created disposable containers were stopped/removed after verification;
existing shared Supabase containers were left intact. No commits/push/deployment.

Exact focused post-fix commands:

```bash
npm test -- tests/unit/llm-fallback-router.test.ts tests/unit/llm-wire-safety.test.ts tests/unit/llm-provider-streaming.test.ts
npm test -- tests/integration/widget-messages-security.test.ts tests/integration/chat-service.test.ts tests/integration/runtime-orchestration.test.ts
```

## Current candidate refresh — 2026-10-13

On `main` at `cb6b75496755364cd288adb62b3492830b841288`, `.env.local` is ignored
and selects the local Supabase API at `127.0.0.1:55321`; local anon and
service-role variables are present. The LLM route is `cloud`, timeout 25,000 ms,
with two Groq candidates followed by two OpenRouter candidates. This refresh made
no provider request. Public Groq docs describe free-plan model/rate limits, but
this account's plan, remaining quota and overage controls are unknown. The
configured OpenRouter model IDs are not an explicit `:free` route. No zero-cost
inference path is established, so Gate 1 remains **BLOCKED**.

Fresh local verification: 139 JS files passed (1,333 tests passed, 5 skipped);
lint, typecheck, architecture, neutrality, production build and
configuration-only preflight passed. The worker suite ran 54 tests (53 passed,
1 skipped). A fresh PostgreSQL 16 disposable target passed all 31 migrations,
109 real-role RLS assertions, and a 15-assertion local chat/PostgREST journey.
A synthetic dump/restore matched 44 table fingerprints and passed six
identity/tenant assertions; the restored database passed the same 15 application
assertions. No Auth login, hosted target, provider call, alert delivery or app
artifact rollback occurred. Exact commands and owner actions are in the
[three-gate report](HALO_THREE_GATE_EXECUTION.md#verification-addendum--2026-10-13-full-task-run).

### Provider verification correction — 2026-10-13

After the read-only metadata checks established the free OpenRouter account and
zero-priced model catalog, one bounded `nvidia/nemotron-3.5-lightning:free`
request was attempted through HALO's real OpenAI-compatible adapter (8 output
tokens maximum, 15-second timeout, no retry/fallback). It failed in 971 ms with
no HTTP status, parsed completion or usage; it was not retried. Read-only account
metadata before/after showed zero daily/monthly usage and unchanged total usage.
This is a failed real attempt, not provider success; Gate 1 remains blocked. The
configured cloud fallback still contains priced model candidates. See the
[sanitized provider record](HALO_THREE_GATE_EXECUTION.md#verification-addendum--2026-10-13-full-task-run).


## Three production-readiness gates — 2026-10-13 execution

**NO-GO: inference BLOCKED; real dashboard Auth BLOCKED; hosted monitoring,
recovery and rollback BLOCKED.** The owner confirmed no verified target-bound
quota/Auth/recovery evidence is available and authorized local work only.
[Execution report](HALO_THREE_GATE_EXECUTION.md) records fresh reproductions,
fixes, commands, owner dependencies and exact future acceptance procedures;
[local evidence](HALO_THREE_GATE_LOCAL_EVIDENCE.json) records the disposable restore
and post-restore application-path results. Local tests do not close external gates.

This execution fixed tenant-admin cross-tenant operational counts, unsafe redirect
normalization, lost Auth refresh/deletion cookies and cache headers, Auth outage
and logout failure handling, production cookie scope, misleading readiness/queue
signals, and raw exception logging. It added a guarded synthetic dump/restore
exercise: 44 table fingerprints and six identity/tenant checks passed, followed
by 15 restored application-path assertions. No hosted Auth login, inference,
alert delivery or artifact rollback was performed. Preserve the existing ten
criteria and Alpha/Beta/Charlie boundaries. External traffic stays disabled;
no deployment, hosted mutation, commit, push or paid operation was authorized.
