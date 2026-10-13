# HALO Phase Beta readiness and evidence

**Recorded:** 2026-10-12  
**Status:** **PARTIAL — local preparation complete; staging verification BLOCKED**  
**Scope:** this record covers staging readiness only. It does not change the local Phase Alpha disposition, authorize provider calls, or close Charlie/final-release gates.

## Decision and safe execution boundary

No positively identified staging environment, project reference/region, deployed revision, staging owner, target-bound authorization, or staging credentials are present in the inspected records. Local configuration and `supabase/config.toml` do not identify a hosted staging target. Accordingly, no database connection, migration, deployment, provider request, webhook, or live call was attempted. Production and unidentified/shared databases are not valid substitutes.

The current repository candidate is dirty and contains extensive pre-existing changes. This Beta work preserves them. Local tests and a disposable database can establish candidate behavior, but cannot establish staging state or authorization.

## ENG-04 / ENG-12 naming decision

**Decision state: PENDING OWNER APPROVAL.** Evidence found:

- `docs/HALO_V1_ENGINEERING_BACKLOG.md` defines **ENG-04** as authorization and validation of the pilot voice/speech route.
- `docs/ENG_01_SECURITY_IDENTITY_REVIEW.md` preserves an earlier “ENG-04 Phase 2” label for the migration-ledger and conversation identity/linkage audit (SEC-04 scope).
- `docs/HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md`, `docs/HALO_V1_RELEASE_DECISIONS.md`, and the engineering backlog proposed **ENG-12** for that database audit. They also record ENG-11 as local Telugu speech review and say that no owner decision was found.
- Repository-wide references and searched Git history contain no owner-approved canonical renumbering. The historical “ENG-04 Phase 2” wording remains evidence of the conflict; it is not authority to reassign either workstream.

For clarity while approval is pending, use descriptive scope names: **pilot voice/speech route** and **database migration/linkage identity audit (SEC-04 scope)**. Do not represent ENG-12 as approved or silently rename existing records.

Owner decision required: confirm the canonical tracking identifier for each scope, whether either existing identifier must be retained for compatibility, and who owns the decision. After approval, update backlog headings/dependencies, security review references, release/preflight records, implementation plan and roadmap, preserving the old label in a short history/alias note. This record does not claim that an owner has responded.

## Staging readiness matrix

Statuses describe evidence available in this checkout on the recorded date. `BLOCKED` means required target evidence or authorization is absent. Secrets are named, never recorded here.

| Area | Required configuration / source | Safe verification | Status | Blocks |
|---|---|---|---|---|
| Staging identity and DB access | Dedicated staging Supabase project, region, endpoint identity, app revision; least-privilege operators; no shared/dev target | Release/deployment owner supplies identity; compare sanitized session identity before any query | **BLOCKED** — no target or authorization identified | Staging deployment and DB gate |
| Migration permission, baseline, recovery | Staging migration role/procedure, migration ledger, backup/PITR or approved restore, rollback/recovery owner and RTO/RPO | Read-only baseline first; confirm backup/recovery plan; then approved migration window and post-migration assertions | **BLOCKED** — no target, approval, baseline, backup evidence, or recovery drill | Staging migration |
| Authentication, tenant isolation, RLS | Supabase Auth settings, service-role boundaries, RLS/grants, widget origins and published agent identity | Target-bound Auth/RLS review and two-tenant tests using supported roles; no superuser/service-role bypass as proof | **BLOCKED** — local disposable evidence only | Staging security |
| Application environment/secrets | `.env.example`, `packages/platform/env.ts`, host secret manager; Supabase URL/anon/service-role, `NEXT_PUBLIC_APP_URL`, chosen LLM settings | Secret-manager presence/format checks without printing values; authenticated deep health probe | **BLOCKED** — hosted configuration not accessible; Ollama is the template default and must not be assumed suitable | Staging readiness |
| Cron authentication and schedules | `CRON_SECRET`; `vercel.json` schedules retention, reminders, workflows, no-shows; campaigns route also requires it | Confirm secret injection and scheduler delivery; unauthenticated request rejected; authorized staging-only dry run | **BLOCKED** — no deployment/secret evidence | Scheduled work; outbound features additionally gated |
| Sarvam STT/TTS | Gateway `VOICE_STT_PROVIDER`/`VOICE_TTS_PROVIDER`, API keys (or `SARVAM_API_KEY` fallback), TTS default voice/model/mode; Pipecat worker shares approved settings | Validate startup schema with presence-only checks, then explicitly authorized bounded sandbox smoke; inspect safe error mapping | **BLOCKED** for real provider — no credential/access or request authorization; **mock tests only** locally | Voice staging; real voice is Charlie |
| LLM provider | `LLM_PROVIDER`, model, provider key(s), timeout and model routes in `packages/providers/llm/factory.ts` | Validate config presence, then bounded authorized staging probe; deterministic runtime remains orchestration authority | **BLOCKED** — no staging config/request evidence | Staging runtime |
| Other integrations | Twilio credentials/signing, Google OAuth if calendar selected, messaging provider (`log` default), WhatsApp/Resend secrets only if selected | Contract tests first; provider sandbox signatures/receipt/replay checks only with separate authorization | **BLOCKED** where required; optional messaging is **NOT APPLICABLE** until a pilot destination/channel is selected | Selected integration; not base staging if disabled |
| Webhooks/callbacks/allowlists | Twilio inbound/status URLs, HTTPS/WSS public gateway, webhook signature validation; widget `allowed_domains`; workflow tenant webhook secret | Compare exact callback URLs and origins; signed valid/invalid/replay test against staging | **BLOCKED** — no deployed URLs, allowlist, or provider sandbox | Voice/integration staging |
| Usage, limits, and failure behavior | Token/context/session limits, `VOICE_MAX_CONCURRENT_SESSIONS`, usage events, tenant quotas/policies | Mock fault tests and staging telemetry/failure injection; reconcile provider usage before enabling effects | **PARTIAL** — local bounds/failure tests reported; deployed usage/billing not verified | Operational Beta; charge reconciliation Charlie/final |
| Logs, metrics, health, alerting, redaction | Logger, `/api/health` liveness; authenticated `?deep=1` probes DB/LLM; gateway `/health`; host log/alert configuration | Verify safe redaction, liveness/readiness, alert delivery and outage response without exposing probe details | **PARTIAL** — endpoints/source exist; no staging monitoring or alert drill | Staging operations |
| Deployment/readiness/rollback | `.github/workflows/ci.yml`, `npm run build`, host deployment, pinned revision, migration compatibility and rollback runbook | Deploy only after target and release approval; verify exact revision, readiness, smoke scenarios, rollback/recovery | **BLOCKED** — no target or deployment evidence | Staging deployment |
| Worker lifecycle and queue recovery | Pipecat worker configuration/trust URL/signing, sticky media routing, SIGTERM drain; cron/workflow retry/idempotency | Local fake/synthetic tests then staging fault/restart/duplicate-delivery tests with outbound side effects disabled | **PARTIAL** locally; **BLOCKED** in staging | Voice and operational Beta |
| Consent, DNC, privacy, retention | Approved test data/policy, retention cron, DNC and outbound flag `HALO_OUTBOUND_ENABLED=false` until authorized | Inspect staging-safe fixtures, verify suppression and retention behavior; no real customer data | **PARTIAL** local guards; customer policy and staging evidence blocked | Staging scenario execution / Charlie policy |
| Optional messaging | `MESSAGING_PROVIDER=log` by default; provider-specific secrets only for chosen integration | Confirm log-only behavior; enable real delivery only after destination, consent, credentials and separate authorization | **NOT APPLICABLE** to base readiness pending owner selection; if selected, **BLOCKED** | Selected pilot feature only |

## Evidence categories and current results

- **Local source/config review:** completed for app env validation, gateway configuration, provider adapters, cron routes, health endpoint, deployment/operations documentation, CI, worker, migrations and check scripts.
- **Current local rerun:** `npm test -- --reporter=dot` — **128 files passed; 1,257 passed, 5 skipped**. Focused widget/identity/tenant tests — **3 files, 30 passed**. `npm run lint`, `npm run typecheck`, `npm run check:architecture`, `npm run check:neutral`, and `npm run build` passed. `npm run preflight:ci` passed after rerunning outside the sandbox; it explicitly skipped DB connectivity and reported the optional email/WhatsApp providers unconfigured and `CRON_SECRET` missing/short for production. No secret values were printed.
- **Migration/disposable database:** `npm run check:migrations -- "$DISPOSABLE_DB_URL"` passed all **31 migrations**, schema assertions, two exact receptionist link fixtures, unprovable legacy row remaining unlinked, invalid new identity rejection, and backfill replay. `$DISPOSABLE_DB_URL` was scoped to the newly created disposable container `halo-beta-disposable-20261012`; the existing local Supabase database (port 55322) was not used. The disposable credential is intentionally omitted from this record.
- **Real-role RLS/disposable database:** `npm run check:rls -- "$DISPOSABLE_DB_URL"` passed; the harness reported `check-rls OK — tenant isolation holds as the real authenticated/service_role roles.` This reset only the newly created disposable database. Its result is local/disposable, not staging. The prior Alpha evidence record reports 109 assertions; the current script emits individual assertions without a numeric summary.
- **Python worker:** `python3 -m unittest test_halo_client -v` from `services/pipecat-worker` — **10 passed**. Full `python3 -m unittest discover -s services/pipecat-worker -p 'test_*.py' -v` — **10 passed, 5 test modules errored during import** because the supported `.venv` is absent and system Python lacks `pipecat` and `websockets`. No dependencies or local models were installed.
- **Provider contracts:** existing tests use mocks/fakes. No real provider request was made in this Beta pass. No real Sarvam, LLM, telephony, calendar, WhatsApp, email, or webhook destination is verified.
- **Staging DB:** no baseline, migration execution, assertion, RLS test, or rollback test was run. Staging migration status is **BLOCKED**, not passed.
- **Production:** no production operation was performed or authorized.

## Beta completion and required staging sequence

Beta may be called complete only after a named release/deployment owner identifies the isolated staging target and revision; target-bound access is authorized; configuration and secret presence are reviewed without disclosure; backup/recovery and migration procedure are approved; migrations and schema/identity assertions pass on staging; intended roles prove tenant A/B and fail-closed behavior; deployed health, worker, cron, monitoring, outage and rollback checks pass; and selected provider sandbox contracts pass with results labeled mock versus real. No live customer side effect is implied.

1. Record staging owner, project reference/region, endpoint identity, exact candidate revision, approved test window, and access scope.
2. Confirm migration operator permissions, backup/recovery plan, rollback authority, and the supported migration command. Capture a safe schema/ledger baseline before changing the target.
3. Deploy the pinned candidate with outbound actions disabled. Validate secret presence and environment without printing values.
4. Apply only approved migrations to the identified staging target; verify migration ledger, constraints, indexes, identity tuples, null-linked unprovable legacy rows, and idempotency/recovery procedure.
5. Run supported real-role RLS/authorization tests and widget identity/tenant A/B scenarios; verify no wrong-tenant model execution, data access, writes, or usage attribution on failures.
6. Exercise application/gateway/worker readiness, cron authorization, duplicate delivery, provider outage/timeouts, graceful shutdown/restart, monitoring/alerts and rollback/recovery.
7. Run mock-first integration contracts. Real provider sandbox calls require valid credentials and separate explicit authorization, with side effects bounded and receipts recorded.

### Required staging inputs to unblock

| Input | Responsible role (not named) | Gate |
|---|---|---|
| Staging target identity, exact revision, access window and deployment authorization | Release/deployment owner | All staging checks |
| Target-bound access, effective permissions, and safe evidence handling | Security/data owner and database owner | DB, RLS and identity audit |
| Backup/restore or approved recovery, migration window and rollback authority | Database and operations owners | Migration/deployment |
| Secret provisioning and provider sandbox credentials, without source/log disclosure | Platform/provider owners | Configuration and provider smoke |
| Approved test tenants/data, callback URLs, origins, and selected integration scope | Product/integration/security owners | Scenario and integration checks |
| Monitoring destinations, incident contact and recovery objectives | Operations owner | Operational readiness |

## Charlie and final-release gates remain open

Charlie still requires controlled Arunodaya pilot authorization and acceptance evidence; human-reviewed Telugu STT/TTS and end-to-end voice quality; real business workflow/outcome evidence; pilot monitoring, incident handling and recovery evidence; and dated disposition by the authorized pilot/business reviewers.

Final release still requires production-specific security/configuration verification; production database migration and recovery approval/evidence; production monitoring, alerting, rollback and incident-response readiness; all ten authoritative release criteria evidenced on the pinned candidate; and explicit final go/no-go approval. No pilot or production acceptance is claimed here. Role owners are not identified in the repository and are not invented in this record.

The existing ten-row register in [HALO_V1_STATUS.md §C](HALO_V1_STATUS.md#c-ten-criterion-release-checklist-reconciliation) is unchanged. Each row's Alpha local evidence remains valid within its stated boundary; every Beta target check is blocked pending staging access and authorization, while Charlie/final dependencies remain open.

## 2026-10-13 local POA update (staging still blocked)

Fresh local verification and root-cause fixes are recorded in [POA](../POA) and
[the status checkpoint](HALO_V1_STATUS.md#2026-10-13-poa-implementation-checkpoint).
On `ddeda1b2a60107e7cfece7a15d22edc510f87e47` plus this pass's uncommitted changes,
130 application files passed (1,273 passed, 5 existing skips), focused identity
30/30, Python worker 53 passed/1 existing skip, all 31 migrations/schema checks and
109 RLS assertions on a fresh disposable database. Lint, types, build, config-only
preflight and architecture/neutral checks passed. The supported Python 3.10 `.venv`
was available for this run; the earlier unavailable-environment report remains
historical. No worker dependencies or models were installed.

Release-safety DB targeting, log privacy and workflow timeout replay fixes are
locally verified. Updated deployment/operations procedures explicitly require
zero-cost evidence, target-bound authorization and recovery proof. They do not
close any staging row. No staging target/owner/cost/recovery evidence was supplied;
no provider/hosted DB action or deployment occurred. Beta is **BLOCKED**, production
**NO-GO**, and ENG-04/ENG-12 remains pending owner approval.

## 2026-10-13 real-integration checkpoint (no deployment)

[Current integration verification](HALO_REAL_INTEGRATION_VERIFICATION.md) adds
real disposable Postgres/PostgREST persistence and public-widget authorization
proof, plus four successful provider **metadata** GETs. Groq/OpenRouter credentials
and configured model listings are verified; inference remains **BLOCKED** by
unproven current $0 capacity (OpenRouter selected models are priced, credits zero).
Metadata authentication is not an inference contract or customer E2E pass.

Current local gate: 1,287 application tests passed/5 existing skips; worker 53
passed/1 skip; all 31 migrations and 109 RLS assertions; 15 route-to-database
assertions with synthetic LLM/Auth issuer; static checks/build/preflight passed.
SSE cleanup/parsing, payload validation, web cancellation and fallback deadline
fixes have regressions. Hosted Auth, migration compatibility, quotas, monitoring,
restore/rollback, Charlie and final owner approval remain open. No staging or
production mutation, paid operation or deployment occurred. The ten-row register
is unchanged.


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
