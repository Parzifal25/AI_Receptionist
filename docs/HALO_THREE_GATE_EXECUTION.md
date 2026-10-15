# HALO three-gate execution — 2026-10-13

**Release recommendation: NO-GO. All three external gates remain BLOCKED.**
Local defects were reproduced and repaired. The owner explicitly confirmed during
this execution that no verified target-bound evidence is available and authorized
continued local remediation only. No deployment, hosted mutation, real inference,
real Auth login, paid request, commit, or push occurred.

## Evidence and baseline

Branch `main`, HEAD `ddeda1b2a60107e7cfece7a15d22edc510f87e47`, upstream
`halo/main`; index empty. Initial status had 21 modified paths and 13 untracked
entries, including POA and the integration/discovery reports. All were preserved.
Initial status, diff, and file hashes are in `/tmp/halo-gates-evidence/initial-*`.
No repository/ancestor AGENTS.md was found. No branch/index/history operation was
performed. This is a dirty local candidate, not an approved release artifact.

Reviewed POA, the real integration and Beta discovery/readiness records, v1 status,
backlog, decisions and release gaps, deployment/operations, architecture, security,
testing, environment schema, CI, migrations/RLS, and implementation/tests below.
Prior integration results and metadata remain **historical**, not fresh inference
or hosted evidence. The ten-criterion register and Alpha/Beta/Charlie boundaries
remain unchanged.

Local `.env.local` was inspected without printing values: app and Supabase URLs
are loopback; provider selector is `cloud`; both provider key names are present;
no route override, cron secret, synthetic Auth account, hosted target binding,
or operational secret-store reference was established. Messaging resolves to
`log`; outbound remains default-disabled; embeddings are `none`. No environment
file was changed. Optional developer speech/calendar credential presence does not
authorize those integrations. Docker inventory identifies an existing shared
local Supabase stack; it was not queried for users/data or modified. No Vercel
project binding was found. CI verifies code; it is not a deployment workflow.

## Gate disposition

| Gate | Status | Real evidence | Fresh local evidence | External blocker / owner |
|---|---|---|---|---|
| Groq/OpenRouter inference | **BLOCKED** | No inference this execution. Prior four metadata GETs were successful but are not quota or inference proof. | Existing wire/stream/fallback/runtime regressions pass; actual widget routes → runtime → Supabase SDK → PostgREST/Postgres journey passes 15 assertions with synthetic LLM, both before and after restore. | Provider/account owner: dated account tier, remaining model-specific allowance, billing/overage controls, approved data handling and a bounded single-provider $0 route; then real application-path response and usage evidence. |
| Dashboard Supabase Auth | **BLOCKED** | Connected Supabase integration identifies `AI_Receptionist` (`riwgdqogswoewfduajcl`, `ap-southeast-2`) and currently reports **ACTIVE_HEALTHY**. The integration exposes project metadata but no Auth-settings or Auth-user/session read operation. Local `.env.local` targets loopback (`127.0.0.1:55321`), not this hosted project. No real login, refresh, logout or hosted RLS test. | Auth actions/proxy/callback/server-authorization mocks and real Next cookie/redirect behavior pass; two-tenant disposable RLS and secure-cookie regressions are local evidence only. Focused Auth regression rerun: 27/27 tests. | Identity/security owner: read-only Auth-settings access, deployed app origin/revision, access to two already-existing authorized synthetic tenant accounts via an approved secret store or supervised browser session, and confirmation of the $0 test allowance and permitted operations. Then run browser and API acceptance below. |
| Monitoring, recovery, rollback | **BLOCKED** | No hosted signals/alerts, backup inventory, restore or app rollback. | Health/status/error privacy tests pass. A real disposable PostgreSQL dump/restore preserves 44 table fingerprints and passes six identity/tenant assertions; restored application-path test passes 15 assertions. | Operations/database/release owners: isolated authorized $0 target, backup/retention evidence, named responder, approved RPO/RTO, compatible prior artifact and recovery/rollback authority. |

Machine-readable results: [local evidence](HALO_THREE_GATE_LOCAL_EVIDENCE.json).
Raw local command logs live under `/tmp/halo-gates-evidence` and are ephemeral.

## Gate 1: source audit and cost boundary

`src/app/api/v1/widget/messages/route.ts` validates the body, rate-limits IP/token,
resolves the conversation/receptionist/business, checks origin and the pinned
tenant/agent/published-version tuple, then enforces the message ceiling. It passes
the request signal into `ChatService.respondForAgent` and `AgentRuntime`. Context,
knowledge, tool grants, turn deadline and token budgets are runtime-controlled.
Response validation precedes transcript/state persistence. `message_sent` records
tenant, turn, provider/model, usage and degradation. A provider outage deliberately
returns an honest degraded reply; it does not establish a successful inference.

Factory `packages/providers/llm/factory.ts` selects the shared OpenAI-compatible
adapter. `cloud` defaults to two Groq candidates then two priced OpenRouter
candidates. `HALO_MODEL_ROUTES` overrides all complexity routes. Groq uses
`https://api.groq.com/openai/v1`; OpenRouter uses `https://openrouter.ai/api/v1`;
completion requests use bearer authentication. JSON and SSE envelopes/usage are
validated; reader cleanup, split CRLF events, cancellation, late success and
deadline/fallback handling are covered by the preserved earlier regressions.
The router owns retries, suppresses retry after live output, and applies provider
cooldowns. Runtime token/context limits and per-instance request limits are not a
currency spending cap. Lead-capture/repair/tool rounds can add calls, so a single
visitor turn is not automatically a single provider request.

No new LLM runtime defect was confirmed in this execution. Existing user-owned
provider fixes were retained and freshly tested. No route/provider/model was
enabled or silently substituted. The configured default fallback is **not approved
for $0 inference**.

The prior metadata artifact reports OpenRouter `limit=null`, no purchased credits,
and nonzero prices for the selected models. It does not prove remaining free
capacity. Groq account tier/current remaining allowance/overage controls are unknown.
Public documentation was freshly checked: [Groq limits](https://console.groq.com/docs/rate-limits)
directs users to account-specific limits; [Groq spend controls](https://console.groq.com/docs/spend-limits)
describe capabilities, not this account's enabled controls;
[OpenRouter limits](https://openrouter.ai/docs/api_reference/limits) distinguishes
credit budgets from request rate limits. Model metadata availability is not a
free-inference authorization. Neither provider qualifies yet, so a comparative
selection between two verified free routes is not possible. Incremental service
spend here is **$0; zero inference tokens generated by this execution**. No invoice
reconciliation was performed.

### Exact future inference acceptance procedure (not executed)

1. Attach dated account/model/remaining-quota evidence, hard overage behavior,
   allowed data handling, and target-bound approval. Unknown cost stops the test.
2. On an authorized isolated app/data target, use one selected provider/model in
   **all** complexity routes, no alternative provider fallback. Do not use the
   four-candidate cloud default. Review the complete prompt/output cap against the
   verified allowance, including potential repair/tool/hook calls. Provisioning
   or hosted configuration changes require separate authorization.
3. Use an existing synthetic tenant with lead capture, booking, tool grants and
   workflows disabled. Establish widget conversation identity and send one short
   FAQ question through the actual messages route; do not bypass it with an
   isolated completion curl. Set a reviewed bounded output cap and deadline.
4. Retain only HTTP status, UTC time, latency, provider/model, turn/tenant fixture
   alias, response-validity result and usage totals. Verify one validated answer,
   transcript/state persistence, correct tenant usage and expected request count.
   Any extra call or missing usage is a failed acceptance case, not invented data.
5. Exercise cancellation, timeout, 401/402/429/5xx, malformed response and fallback
   with mocks. Confirm no further attempts after cancellation/deadline and no raw
   prompt/key in logs. Do not deliberately consume quota to trigger real failures.
6. Reconcile the request to provider usage and remaining allowance. PASS requires
   all original Gate 1 criteria; a successful metadata or isolated request is insufficient.

Safe disable: keep external chat ingress closed until this gate passes. Do not
start the current cloud route against real traffic. No provider rollback or billing
change was made; the preceding adapter fixes remain intact.

## Gate 2: confirmed Auth findings and remediation

### Connected project and real-verification access

The connected Supabase project list contains four projects; the repository-matching
project is `AI_Receptionist`, ref `riwgdqogswoewfduajcl`, region `ap-southeast-2`.
Its current connector detail reports **ACTIVE_HEALTHY**. This updates the earlier
inactive status recorded on 2026-10-13; no project was started or otherwise
changed. The integration exposes project metadata and database operations, but no
Auth configuration/settings read, Auth user/account lookup, or browser-session
operation. The repository's local `.env.local` Supabase URL resolves to loopback
`127.0.0.1:55321`, so it does not bind the app to the connected hosted project.
No authorized existing synthetic dashboard account or deployed app origin/revision
was identified in the available evidence. No credentials were printed or sought
in local secret files.

Hosted Auth settings (including expiry/provider/redirect configuration) and the
requested real dashboard login, refresh after reload, protected-route, logout,
session-expiry, and hosted tenant-isolation behaviors remain **UNVERIFIED / BLOCKED**.
The exact prerequisites are read-only Auth-settings access for the active intended
project; the deployed app origin and revision; access to two already-existing,
authorized synthetic tenant accounts through an approved secret store or supervised
browser session; and confirmation that the test window and planned Auth operations
fit the $0 boundary. Until those are available, only local/mock regression evidence
can be produced. No user creation, Auth-setting change, database-policy change,
project activation, or hosted login attempt was performed. Local/mock results below
do not close Gate 2.

| Root cause | Fix and regression evidence |
|---|---|
| **High:** `/\t/host`, `/\n/host`, `/\r/host` passed prefix validation but URL normalization made them external redirects. | Reject control/whitespace characters in `safeRedirectPath`; three exploit regressions and callback test. |
| Refreshed/deleted cookies were lost when the proxy constructed a new redirect. SDK anti-cache headers were ignored. | Preserve every cookie/options across response replacement and redirects; propagate anti-cache headers; strip unrelated query parameters when redirecting to login. Proxy tests cover rotation, deletion, refresh and restoration from request cookies. Cache exposure is a high-risk condition under a caching intermediary; no hosted leak is claimed. |
| Production cookie options did not explicitly require Secure. | Shared browser/server/proxy options: production Secure, SameSite=Lax, path `/`; local development HTTP remains usable. Browser SSR client intentionally needs non-HttpOnly cookie access; do not claim cookies are immune to XSS. |
| Config/transport exceptions escaped sign-in and callback; upstream registration/errors were exposed or logged verbatim. | Opaque retryable UI messages, safe callback failure redirect, no-cache callback, status-only Auth logging. |
| `signOut` ignored SDK errors, reporting success even when the SDK retained the session. | Redirect to login only after success; on failure show a dashboard message that the session may still be active and ask the user to retry. SDK's existing global logout scope is preserved. |
| Server helper trusted user data alongside an error; membership DB errors became onboarding. | Reject errored identity; distinguish membership outage with an opaque service-unavailable error. Tests enforce membership lookup from verified user ID. |
| **High:** tenant-admin system-status API used unscoped service-role queue/calendar queries. | Every operational query now filters verified `businessId`; ordinary members and unauthenticated calls are denied before probes. Regression models tenant A vs foreign aggregate data. |

Auth path: validated server action → request-scoped SSR client using public anon
key → Supabase password login → SDK cookies → proxy `getUser()` → dashboard
`requireBusiness()` → RLS-scoped membership. Protected server APIs call tenancy
helpers independently of proxy matching. Dashboard is force-dynamic. Service-role
client remains server-only and is not imported into the browser Auth client;
service-role operational queries now explicitly impose tenant predicates.
Supabase browser/SSR uses cookies, not a custom URL/session-token mechanism.
Server Actions retain Next's same-origin handling; no external callback allowlist
or hosted Auth setting was changed.

The installed SDK was inspected for cookie/header semantics and logout behavior,
alongside [Supabase SSR guidance](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs).
[Supabase sign-out guidance](https://supabase.com/docs/guides/auth/signout) states
that existing access JWTs can remain valid until expiry after refresh-token
revocation. Local logout tests therefore prove action/error handling, **not immediate
server revocation of a copied bearer token**. The intended target's expiry/revocation
behavior remains an explicit acceptance item, not a security guarantee inferred
from `getUser()` or cookie deletion.

### Exact future real Auth acceptance procedure (not executed)

1. Identity owner records intended project ID/origin, app revision, public-key
   project match, synthetic tenant A/B account aliases and approved secret-store
   references. Never paste passwords, keys, cookies or JWTs into chat/evidence.
   Confirm login/logout/refresh cost and permitted mutations. No sign-up/email,
   account creation, hosted redirect/policy change or revocation without approval.
2. In a fresh browser context, GET `/dashboard` and `/onboarding` signed out;
   expect same-origin login redirect and no protected data. Direct protected API
   access must not return data. An invalid password yields a safe error.
3. Sign in with synthetic A at `/login?next=/dashboard`. Record successful form
   transition and verified session presence as booleans only. Inspect cookie
   flags (Secure on HTTPS, SameSite=Lax, path `/`) and anti-cache headers without
   exporting their values. Confirm service-role key absence from browser assets.
4. Hard-refresh, open a new protected page, and make a dashboard server request.
   Verify restoration and tenant A-only data. Use B in a separate context and try
   A's resource IDs; expect denial/empty RLS results. A member cannot read admin
   status; A's admin counts must not include B's queues/calendars.
5. Wait for the existing configured access-token expiry (do not change hosted
   expiry); verify a valid refresh restores the session. For revoked/invalid
   refresh, use only an explicitly approved synthetic session or fixture; confirm
   protected access is denied after the applicable expiry boundary. If no safe
   target revocation case is authorized, record it BLOCKED rather than simulate
   success with mocks. Record the residual valid-JWT window explicitly.
6. Sign out, verify local session cookies are removed, reload/back-navigate, and
   verify protected requests cannot access data. Test provider outage with local
   interception/mocks; failed logout must not claim session invalidation.
7. Retain sanitized case IDs/status/timing/revision only. PASS requires every
   original Gate 2 acceptance condition on the intended target.

Current disposition: **BLOCKED before authenticated browser execution** because
the connector does not include Auth-settings or existing-user inspection, and no
authorized synthetic account was available. The identified project is currently
active, but the local app's configured Supabase endpoint is loopback and does not
match that hosted project. Even after access is supplied, tenant isolation requires
two authorized synthetic accounts and tenant-owned test resources; a single account
or the local disposable RLS suite is insufficient.

### Follow-up: user-provided local app at `http://localhost:3000`

On 2026-10-13 the running local app was reachable for read-only HTTP checks.
`/` and `/login` returned 200; unauthenticated `/dashboard` returned 307 to
`/login?next=%2Fdashboard` with `Cache-Control: private, no-store`; `/api/health`
returned 200 for public liveness. No sign-in was attempted because no authorized
synthetic account was available. These results verify the local signed-out route
boundary and process liveness only. They do not establish authenticated session
refresh/persistence, session expiry, hosted Auth configuration, or hosted tenant
isolation.

The three release gates remain blocked. No inference request was made because
account-specific free quota/overage behavior is unverified and the $0 budget rules
out an unbounded or potentially billable request. Public health is only a liveness
signal; no alert delivery was tested. Deep health remains disabled when
`CRON_SECRET` is absent, as implemented. Local recovery was not rerun because the
Docker API was inaccessible in this execution context; prior disposable restore
results remain historical local evidence and do not prove hosted recovery or app
artifact rollback.

## Gate 3: operational findings and local recovery

Public liveness makes no external calls. Authenticated deep health performs DB
and provider probes; model-list health is not inference or quota proof. The DB
signal previously depended on overall readiness: an unrelated config error made
it falsely disconnected. It now records `checked` and `connected` independently,
including explicit unchecked state for preflight. Provider construction/probe
failure no longer hides the DB result. Raw environment/DB errors are not returned.
System status includes LLM health in degradation, rejects failed monitoring
queries instead of reporting zero queues, and uses tenant filters. The dashboard
uses explicit DB state and current readiness instead of a constant uptime claim.

Shared JSON logging previously serialized raw error strings/objects/stacks, which
can contain provider text or database row values. Privacy regressions reproduced
this. The logger now redacts common credential/content/error fields recursively;
static event messages, route/category/code, tenant/turn/correlation IDs and numeric
usage remain. This is defense in depth, not permission to put secrets into a new
custom field. Review new log call sites and the actual hosted log sink before launch.

Existing capabilities: runtime provider route/latency/usage events; bounded
fallback and deadline handling; worker lifecycle tests; retry/dead-letter queues;
authenticated cron; migration/RLS checks; optional business monitoring views.
Absent external evidence: hosted availability/latency baselines, alert delivery,
coverage, log retention, backup schedules/retention, recovery storage, operator
identity, release artifact registry, application rollback and schema compatibility
on a deployed target. A local provider failure is not a hosted alert drill.

`npm run check:recovery:local` is **only** for the task-created disposable fixture.
It requires explicit opt-in, the task container naming pattern, fixture database
and marker, and a new `halo_check_restore_*` target. It rejects an existing target;
never invokes DROP, clean, source writes, hosted services or deployment commands.
It dumps with `pg_dump`, restores with `pg_restore --exit-on-error`, compares
44 table row fingerprints, and checks identity links and RLS under the authenticated
role. Source must be quiescent. Database roles are shared in this same disposable
instance; this does not prove cross-instance role/secret recovery or GoTrue recovery.

Measured backup-through-validation time **25.807 seconds**, zero fixture-row loss
at the snapshot; six identity/tenant assertions passed. A second PostgREST served
the restored DB on loopback port 55444, and the same real application-path harness
passed all 15 assertions, including persistence, knowledge, usage attribution,
tenant boundaries, provider outage/timeout/cancellation, and disabled side effects.
Auth issuer/users and LLM remain synthetic. No actual application-artifact rollback
was performed, and these durations are not hosted RTO/RPO commitments.

See [Operations](OPERATIONS.md#three-gate-recovery-and-incident-acceptance)
and [Deployment](DEPLOYMENT.md#three-gate-release-and-rollback-acceptance) for the
operator procedure and acceptance requirements. Owners must approve numerical
RPO/RTO before the hosted exercise; **currently undefined/unverified**, not silently
assigned from a small local fixture.

## Fresh verification commands

All logs under `/tmp/halo-gates-evidence`; no hosted tests or CI jobs were triggered.

| Command | Result / evidence class |
|---|---|
| `npm test -- tests/integration/dashboard-session.test.ts tests/unit/safe-redirect.test.ts tests/integration/health-route.test.ts` before fixes | 11 failed, 12 passed: reproducible Auth/redirect/health defects |
| `npm test -- tests/integration/auth-actions.test.ts` before fixes | 5 failed, 3 passed |
| `npm test -- tests/integration/system-status-security.test.ts` before fixes | 3 failed, 2 passed |
| `npm test -- tests/integration/dashboard-authorization.test.ts` before fixes | 2 failed, 3 passed |
| `npm test -- tests/unit/logger-privacy.test.ts` before fixes | 2 failed |
| Focused 11-file Auth/health/provider/recovery run | 82 passed before the final callback/log/cookie additions |
| `npm test -- --maxWorkers=2` final | **139 files passed; 1,333 passed, 5 existing skips, 0 failed**; mocks and local synthetic socket tests |
| `npm run lint`, `npm run typecheck`, `npm run check:architecture`, `npm run check:neutral` | **Passed** |
| `npm run build` | **Passed**, local production artifact only |
| `npm run preflight:ci` | Passed; DB explicitly skipped, cron-secret warning; no provider probe |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'` | 54 run, 53 passed, 1 existing skip |
| `HALO_DISPOSABLE_DATABASE=1 npm run check:migrations -- postgresql://postgres:postgres@127.0.0.1:55441/halo_check_integrations` | 31 migrations and schema/identity/backfill assertions passed |
| Same target with `npm run check:rls` | 109 real-role assertions passed |
| `HALO_DISPOSABLE_DATABASE=1 npm test -- --config scripts/vitest.local-integration.config.ts` | 1 test passed / 15 internal assertions; real local DB/HTTP, synthetic LLM/Auth |
| `HALO_DISPOSABLE_DATABASE=1 npm run check:recovery:local -- halo-gates-disposable-20261013 halo_check_integrations halo_check_restore_gates` | PASS: dump/restore, 44 table fingerprints, six assertions |
| `HALO_DISPOSABLE_DATABASE=1 HALO_LOCAL_RESTORED_DATABASE=halo_check_restore_gates npm test -- --config scripts/vitest.local-integration.config.ts` | 1 passed / 15 assertions on restored DB |
| `git diff --check` | **Passed** |

Initial restricted full test run: 6 files failed, 30 failures from blocked sockets,
1,288 passed, 5 skipped, two unhandled socket errors. It was rerun with authorized
local socket access. Restricted worker run stalled and was interrupted; the supported
unrestricted rerun passed. Restricted preflight failed on tsx IPC, DB checks on
blocked Docker/TCP access, and build on Google Fonts fetch; authorized reruns
passed. A new test's unused TypeScript suppression failed typecheck and was removed,
not hidden or weakened. No timeout was increased or assertion weakened to pass.

## Remaining risks and owner actions

No reproduced critical/high local defect from this execution is knowingly left
unfixed. Confirmed high risks repaired: cross-tenant operational counts and
control-character open redirect; cookie propagation/cache protection also repaired.
This is not a blanket claim that all repository/deployment security defects are absent.
The current cloud fallback lacks a verified $0 envelope, rate limiting is
per-instance, and copied JWT revocation/hosted secret and cache behavior are
unverified. Keep external traffic disabled.

Provider owner supplies quota/billing/overage/data-handling evidence. Identity
owner supplies the intended project and authorized synthetic accounts. Operations
and database owners supply target, backup/retention, responder and numerical RPO/RTO.
Release owner supplies current/prior artifact checksums, schema compatibility,
exact recovery authority and the later explicit go/no-go. No credentials in chat.
These are external evidence dependencies, not reasons to rerun mocks until green.

The remaining external gates cannot be closed under the current inputs. Phase Alpha
remains locally complete within its earlier scope; Beta real verification, Charlie
acceptance and final production approval remain open. No unauthorized hosted
operation, deployment, commit, push, billing change, communication or paid request occurred.


## Final verification and changed-file inventory

Final full suite: **139 files, 1,333 passed, 5 existing skips, zero failures**.
This execution adds **46 regression cases** relative to the preserved 1,287-pass
baseline. All eight new test files passed. Final lint, typecheck, architecture,
neutrality, production build, configuration-only preflight and `git diff --check`
passed. The final build completed after the shared secure-cookie change. Worker,
31-migration, 109-assertion RLS and both 15-assertion application-path results are
fresh as recorded above; no later changes affected their tested DB/worker paths.

Initial Git state: 21 modified + 13 untracked; final: **39 modified + 25 untracked**; nothing staged at either point. Branch, HEAD and upstream unchanged; 50 commits ahead / 0 behind `halo/main`. All 34 initial files still exist; **27 remain byte-for-byte identical**. Six existing documents/POA were appended and the existing chat harness received only the restored-fixture selector/marker extension. No user work was removed. The following **37 files** were changed or added by this execution (the other dirty paths predate it):

- `docs/DEPLOYMENT.md`
- `docs/HALO_PHASE_BETA_READINESS.md`
- `docs/HALO_V1_RELEASE_GAPS.md`
- `docs/HALO_V1_STATUS.md`
- `docs/OPERATIONS.md`
- `package.json`
- `packages/platform/logger.ts`
- `packages/platform/safe-redirect.ts`
- `packages/tenancy/auth.ts`
- `packages/tenancy/supabase/client.ts`
- `packages/tenancy/supabase/server.ts`
- `src/app/api/admin/system-status/route.ts`
- `src/app/api/health/route.ts`
- `src/app/auth/callback/route.ts`
- `src/app/dashboard/admin/page.tsx`
- `src/app/dashboard/page.tsx`
- `src/features/auth/actions.ts`
- `src/lib/startup-check.ts`
- `src/proxy.ts`
- `tests/integration/health-route.test.ts`
- `tests/unit/safe-redirect.test.ts`
- `tests/unit/startup-check.test.ts`
- `POA`
- `docs/HALO_REAL_INTEGRATION_VERIFICATION.md`
- `docs/HALO_THREE_GATE_EXECUTION.md`
- `docs/HALO_THREE_GATE_LOCAL_EVIDENCE.json`
- `packages/tenancy/supabase/cookie-options.ts`
- `scripts/chat-local-integration.ts`
- `scripts/recovery-local.mjs`
- `tests/integration/auth-actions.test.ts`
- `tests/integration/auth-callback.test.ts`
- `tests/integration/dashboard-authorization.test.ts`
- `tests/integration/dashboard-session.test.ts`
- `tests/integration/system-status-security.test.ts`
- `tests/unit/auth-cookie-options.test.ts`
- `tests/unit/logger-privacy.test.ts`
- `tests/unit/recovery-local.test.ts`


The task-created PostgreSQL and two PostgREST containers were stopped after
capturing evidence; the pre-existing shared Supabase stack was left running and
untouched. Synthetic dump bytes were held only in memory. No paid service,
provider inference, real Auth login, hosted recovery, application deployment,
commit, push, or outbound communication was performed. All three external gates
remain **BLOCKED**; production remains **NO-GO**.

## Current-candidate refresh — 2026-10-13

Candidate `cb6b75496755364cd288adb62b3492830b841288` (`main`, 51 commits ahead
of `halo/main`). At the first status snapshot, six tracked documentation files
were modified: `POA`, `docs/DEPLOYMENT.md`,
`docs/HALO_PHASE_BETA_READINESS.md`, this report, `docs/HALO_V1_STATUS.md`, and
`docs/OPERATIONS.md`. None were staged and there were no untracked paths. Those
pre-existing edits were preserved. No source files changed during that refresh. Results below supersede
older counts only for the commands rerun here; prior restore/chat evidence remains
local historical evidence, not a hosted exercise.

| Gate / item | Current status | Fresh evidence and exact limit |
|---|---|---|
| Real Groq/OpenRouter inference | **BLOCKED — acceptance not met** | At the first refresh no request had been made. A later metadata check established OpenRouter free-tier/zero-priced model access and one bounded request was attempted; it failed without status, completion or usage and was not retried. See the later verification addendum for exact evidence and remaining action. |
| Supabase Auth login/session | **BLOCKED — exact external prerequisite** | Read-only Supabase project metadata confirms `AI_Receptionist`, `riwgdqogswoewfduajcl`, region `ap-southeast-2`, status `ACTIVE_HEALTHY`. The connector did not provide Auth settings/users/session inspection; local `.env.local` targets loopback. No login, account, refresh, logout, hosted authorization or tenant test occurred. Identity owner must provide deployed origin/revision, settings visibility, two existing synthetic tenant accounts via approved secret handling, and $0/permitted-operation confirmation. |
| Monitoring, hosted recovery, rollback | **BLOCKED — exact external prerequisite** | No hosted alert, backup, restore or app artifact rollback was exercised. Ops/database/release owners must identify an isolated authorized $0 target, recovery authority and backup/retention evidence, named responder, numeric RPO/RTO, compatible current/prior artifact checksums, and approved rollback procedure. |
| Local application/regression evidence | **PASS — local evidence only** | `npm test -- --maxWorkers=2`: 139 files; 1,333 passed, 5 existing skips. `npm run lint`, `npm run typecheck`, `npm run check:architecture`, `npm run check:neutral`, `npm run preflight:ci`, and `npm run build` passed. Preflight skipped DB and warned `CRON_SECRET` absent. |
| Local schema/security/worker checks | **PASS — local evidence only** | Fresh disposable DB, not the existing shared stack: all 31 migration/identity checks, 109 real-role RLS assertions, and 54 worker tests (53 passed, 1 skipped) passed. |
| Other checks | **SKIPPED — no relevant source changes** | No hosted E2E, real LLM/Auth, alert delivery, hosted recovery/rollback, or restore run. No source files changed. |

Outstanding-item classification:

| Item | Classification |
|---|---|
| Provider free capacity, overage behavior and bounded zero-cost route | Cost/quota uncertainty; provider account evidence and owner authorization missing. |
| Intended hosted Auth configuration, two synthetic identities, deployed app origin/revision | Missing account/test identities, owner authorization and deployed target evidence. |
| Hosted alerts, backup inventory, isolated restore target and compatible artifact rollback | Missing infrastructure, owner authorization and recovery evidence. |
| Charlie pilot and final approval | Later-phase requirements; remain open regardless of local checks. |

Minimum owner actions: (1) the provider/account owner supplies dated model-tier,
remaining-quota and billing/overage evidence, approves synthetic data handling,
and authorizes one bounded single-provider request with a $0 cap; alternatively,
keep real inference blocked. (2) The identity owner supplies the deployed origin
and revision, read-only Auth-settings access, two existing synthetic tenant
accounts through an approved secret store or supervised browser, and confirms
the login/session checks are permitted at $0; alternatively, keep hosted Auth
blocked. (3) Operations/database/release owners name the isolated target and
responder, supply backup/retention and recovery authority, approve numeric
RPO/RTO and $0 use, and provide current/prior artifact checksums plus rollback
authorization; alternatively, keep hosted recovery/rollback blocked. No secrets
or account credentials should be sent in chat.

The only new service was a cached local disposable PostgreSQL container
(`halo-close-gates-20261013`, loopback port 55442); no cloud service or paid
operation was used. Incremental vendor/hosted cost: **$0**. This does not
establish any external provider account's cost. The container is stopped after
verification. Release recommendation remains **NO-GO**. The ten-criterion
register, Alpha boundary, Charlie pilot acceptance and final production approval
remain open and unchanged.

Exact refreshed commands and results:

- `npm test -- --maxWorkers=2` — 139 files passed; 1,333 passed, 5 existing
  skips; exit 0.
- `npm run lint`, `npm run typecheck`, `npm run check:architecture`,
  `npm run check:neutral` — exit 0.
- `npm run build` — exit 0; Next production compile, TypeScript, prerender and
  widget bundle completed. `.env.local` was loaded by Next; no value was printed.
- `npm run preflight:ci` — exit 0; configuration-only; DB check skipped and
  `CRON_SECRET` warning shown.
- `HALO_DISPOSABLE_DATABASE=1 npm run check:migrations -- postgresql://postgres:postgres@127.0.0.1:55442/halo_check_gates`
  — exit 0; 31 migrations and identity/backfill assertions passed.
- `HALO_DISPOSABLE_DATABASE=1 npm run check:rls -- postgresql://postgres:postgres@127.0.0.1:55442/halo_check_gates`
  — exit 0; real-role tenant isolation harness passed.
- `/bin/bash -lc ".venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py' > /tmp/halo-gates-evidence/worker-unrestricted.log 2>&1"`
  — exit 0; 54 tests ran, 53 passed, 1 skipped. The first sandboxed invocation
  stalled without output and was interrupted; the supported authorized rerun
  completed in 9.351 seconds.
- `git diff --check` — passed after the documentation updates.

The no-argument migration/RLS invocations were also attempted and safely refused
because no explicit disposable URL was supplied. No checks were aimed at the
existing shared Supabase containers. The prior hosted and real-inference gates
remain blocked; no source change was required by this refresh.

### Verification addendum — 2026-10-13, full task run

Evidence checklist prepared before this run's verification:

- Provider: identify effective route/models, inspect adapter and regressions, and
  verify zero-cost eligibility before any inference request.
- Auth: establish the configured target, inspect current server/browser handling,
  and use only an existing authorized synthetic identity.
- Operations: run local health/failure/security checks, disposable migration and
  real-role RLS checks, then backup/restore and post-restore application checks;
  record anything that still requires a hosted target.
- Finish: rerun repository suites/build/preflight, inspect the diff, and preserve
  branch, HEAD and all pre-existing worktree changes.

The checklist completed locally. Provider and Auth prerequisites remain as
recorded below. The continuation of this run found and fixed a local monitoring
coverage defect in the admin system-status endpoint. Fresh results below
supersede earlier candidate counts and the earlier statement that Docker was
unavailable for this execution.

| Area | Fresh result | Evidence boundary |
|---|---|---|
| Provider route/config | `LLM_PROVIDER=cloud`, `LLM_TIMEOUT_MS=25000`, `HALO_MODEL_ROUTES` unset. Factory order is Groq `openai/gpt-oss-120b`, Groq `qwen/qwen3.8-27b`, OpenRouter `anthropic/claude-sonnet-4.6`, OpenRouter `qwen/qwen3.8-27b`. Groq and OpenRouter key variables are present; no secret values were emitted. | Fresh read-only metadata confirmed both Groq models are available but carry positive listed token prices; Groq account tier/quota remains unknown. OpenRouter key reports free tier, zero purchased credits and 0 daily/monthly usage; catalog exposes 19 zero-priced models. One bounded OpenRouter `:free` inference attempt failed without an HTTP status, parsed response or usage. It was not retried. Gate 1 **BLOCKED**. |
| Supabase target/Auth | `.env.local` is ignored by Git and configures `NEXT_PUBLIC_SUPABASE_URL` to loopback `127.0.0.1:55321`; anon and service-role variables are present. `.env.example` is tracked as expected. | Local environment only; no hosted URL was substituted. Shared local Supabase/Auth was not queried or modified. No designated existing synthetic login account was identified, so no Auth login/session lifecycle was attempted. Gate 2 **BLOCKED**. |
| JavaScript tests | `npm test -- --maxWorkers=2`: exit 0; 139 files passed, 1,333 tests passed, 5 skipped. | Current candidate, local suite. |
| Lint/type/architecture | `npm run lint`, `npm run typecheck`, `npm run check:architecture`, `npm run check:neutral`: exit 0. | Current candidate. |
| Production build | `npm run build`: exit 0; widget and Next production build completed. | Local build only; no deploy/artifact registry identity. |
| Preflight | `npm run preflight:ci`: exit 0; explicitly configuration-only, DB connectivity skipped, warning that `CRON_SECRET` is absent/too short for production. | No readiness or hosted dependency proof. |
| Python worker | `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'`: exit 0; 54 run, 53 passed, 1 skipped. | Supported local Python environment; no vendor speech request. Initial sandboxed run stalled and was interrupted; authorized local-socket rerun completed in 9.312s. |
| Migration/RLS | `HALO_DISPOSABLE_DATABASE=1 npm run check:migrations -- postgresql://postgres:<redacted>@127.0.0.1:55443/halo_check_current`: exit 0, 31 migrations plus identity/backfill assertions. Same target with `npm run check:rls`: exit 0, 109 assertions under real `authenticated`/`service_role` roles. | Fresh task-owned PostgreSQL 16 disposable container, separate from shared Supabase. RLS harness rebuilt only that disposable DB. |
| Synthetic application path | `HALO_DISPOSABLE_DATABASE=1 npm test -- --config scripts/vitest.local-integration.config.ts`: exit 0, 1 test and 15 internal assertions. Repeated with `HALO_LOCAL_RESTORED_DATABASE=halo_check_restore_current`: exit 0, same 15 assertions. | Real local app routes/runtime/PostgREST/PostgreSQL, synthetic LLM/Auth identities. Not provider inference or Supabase Auth login. |
| Backup/restore | `HALO_DISPOSABLE_DATABASE=1 npm run check:recovery:local -- halo-gates-disposable-202610131 halo_check_integrations halo_check_restore_current`: exit 0. 44 table fingerprints matched; six identity/tenant assertions passed; source untouched; new restore target; backup SHA-256 `c600d9e3ec7c145b569bbe81758158deeec8c5495d9f6e7ba43a86a4fefeb6fc`; measured 17.175 seconds. | Synthetic local dump/restore only. Restored app journey passed. This does not test hosted backup, Auth issuer/users, separate-instance roles/secrets, or application artifact rollback; it is not an approved RPO/RTO. |
| Alerts/rollback | No alert was sent; no approved test sink or named destination was found. No immutable deployed artifact/digest or compatible prior deployment was available. | Gate 3 remains **BLOCKED** for hosted alert delivery and application rollback. Local restore is partial recovery evidence only. |
| Operational metric coverage | Updated tenant-scoped system-status API returns scheduled/overdue reminder counts and oldest overdue age, workflow pending/processing/failed/dead-letter counts, and p50/p95 successful-turn latency from at most 500 events over 24 hours. It marks status degraded for overdue reminders, failed runs, dead-letter runs, failed readiness, or unhealthy LLM. | Targeted tenant-isolation regression passes. Provider failure/timeout rate remains explicitly `null`/unavailable because the application has no durable aggregation sink; no durable metrics/alert sink or alert delivery drill was verified. |
| Diff | `git diff --check`: exit 0 after final source and evidence updates. | This continuation changes the status API and its integration test; other changes in the run remain documentation/evidence updates. |

Provider metadata and one-request record (2026-10-13): authenticated read-only
GETs to Groq model catalog and OpenRouter key/credits/model catalogs returned
200. The OpenRouter key reported `is_free_tier=true`, `total_credits=0`, and
`usage_daily=usage_monthly=0`; a free-model catalog query returned 19 models
with zero prompt/completion prices. Before and after the test, `total_usage`
remained `0.183508087` and daily/monthly usage remained zero. The one inference
used `nvidia/nemotron-3.5-lightning:free`, an eight-token output ceiling, a
15-second timeout, one fixed non-sensitive prompt, and no retry/fallback. The
real `OpenAICompatibleProvider.complete()` call failed in 971 ms; sanitized
result: no HTTP status, no parsed completion, no token usage, zero retries and
no fallback. The application adapter exposed no safe failure category in that
attempt. No prompt contents beyond the fixed test string or provider response
were recorded. The free model's zero listed price, free-tier key and unchanged
account counters support **$0 incremental provider cost** for this attempt;
the default configured cloud route still includes priced candidates and is not
cost-constrained to free models. Therefore inference acceptance is **not met**.
Public plan/model evidence is documented at [OpenRouter pricing](https://openrouter.ai/pricing),
[OpenRouter free models](https://openrouter.ai/collections/free-models), and
[Groq rate limits](https://console.groq.com/docs/rate-limits); account-level
Groq billing/quota remains unavailable from the model catalog.

The next Gate 1 action is to diagnose the adapter/provider failure from an
approved safe diagnostic path and obtain authorization for another single
bounded free-model attempt. Do not enable the normal cloud fallback chain under
the $0 cap until every candidate that can run is restricted to a verified
zero-cost route.

All four containers created for this verification were stopped; the five existing
shared `supabase_*_AI_Receptionist` containers were left running and untouched.
No provider request, hosted Auth operation, hosted database query/mutation,
deployment, outbound alert, commit or push occurred. Incremental service spend
was $0. External account billing/quota is **unverified**, not proven zero by
these local checks. Release recommendation remains **NO-GO**.

The owner action for Gate 3 is now limited to external proof: approve a safe
alert destination and responder, provide an isolated hosted recovery target and
backup facts, approve numeric RPO/RTO targets, and identify immutable current
and rollback artifact digests plus a compatible rollback procedure. Provider
failure/timeout-rate aggregation still requires an approved durable metrics
source; the endpoint reports it unavailable rather than implying zero. Local
system-status tests do not prove hosted alert delivery or multi-instance
monitoring.

### Continuation — local system-status coverage and final checks

Changed `src/app/api/admin/system-status/route.ts` to include tenant-scoped
queue/dead-letter and bounded latency telemetry, and degrade health when
overdue reminders, failed workflow runs, or dead-letter runs are present. The
provider failure-rate field remains unavailable because failures are not
persisted in a durable metric source. The regression in
`tests/integration/system-status-security.test.ts` checks tenant filtering,
queue values, age, latency percentiles, the explicit unavailable state, and
degraded status.

Final source check results after that change: targeted monitoring regression,
`npm test -- --run tests/integration/system-status-security.test.ts`, passed
(5 tests); full JavaScript suite `npm test -- --maxWorkers=2` passed (139 files,
1,333 passed, 5 skipped); production build, lint, and typecheck all exited 0 on
the final source. Architecture and neutrality checks exited 0 before the final
status threshold-only adjustment; `git diff --check` is run after evidence
updates. No hosted systems were involved.

### Gate 3 local alert and monitoring follow-up — 2026-10-13

Added a deterministic operational alert evaluator and an inspectable in-memory
local sink. It emits transition events for sustained provider failure (three
consecutive observations), database unready, failed-job backlog (5+), any
dead-letter work, overdue work, and stale/missing monitoring observations. Active
incidents deduplicate, recoveries emit resolution, and delivery retries cap at
three attempts. This is library/test infrastructure only: no scheduler,
durable incident store, operational endpoint, or external destination is wired;
those are not claimed as production alerting.

The system-status API now treats missing exact counts and failed queries as
unavailable (503), reports telemetry freshness separately from zero samples,
and keeps configuration details out of its response. Existing tenant filters,
provider check, and bounded 24-hour/500-row successful latency sample remain.
Targeted checks: 5 files, 38 tests passed (alert transitions, missing inputs,
local sink discovery, bounded delivery failure, monitoring tenant scope/query
failure/config redaction, health, provider fallback and stream behavior). The
separate full-repository results below apply to the prior candidate before this
follow-up and must be refreshed for this source revision.

Gate 3 local capability status: monitoring **PASS locally**; failure detection
and bounded fallback **PASS in deterministic local tests**; alert generation and
local discovery **PASS in deterministic local tests**; external alert delivery
**BLOCKED** (no approved destination); backup/restore **PASS locally** (44 table
fingerprints, six identity/tenant checks, checksum and post-restore app journey
recorded above); application artifact rollback **BLOCKED** (no two compatible
immutable artifacts). No production traffic, hosted mutation, external alert,
commit, push, or deployment was performed; incremental spend remains $0.
