# HALO Phase Beta discovery and solution design

**Discovery date:** 2026-10-12  
**Repository baseline:** `main`, `ddeda1b2a60107e7cfece7a15d22edc510f87e47`, 50 commits ahead of `halo/main`  
**Tree at discovery start:** clean; no staged, modified, or untracked paths  
**Disposition:** **NOT READY TO BEGIN STAGING** — the source/local preparation is substantial, but no staging target, named owner, target-bound authorization, or deployment candidate evidence was established.  
**Scope:** audit and solution design only. No code/config changes, tests, migrations, external calls, deployments, or environment mutations were performed.

## 1. Executive verdict and scope

Phase Alpha remains the local, pre-deployment engineering gate and is recorded complete in `docs/HALO_V1_STATUS.md` and `docs/HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md`. This discovery does not reopen Alpha. Phase Beta is controlled staging preparation, deployment verification, real integration contracts, and staging operational readiness. No evidence found in this checkout proves that a staging target exists or that anyone authorized this agent to access one. Consequently, staging verification is **BLOCKED**. This is an infrastructure/access and evidence blocker, not evidence of a staging code defect.

The repository contains an implemented Next.js control/application plane, tenant-scoped runtime, Supabase schema/migrations, widget and voice paths, Pipecat worker, and adapters for hosted LLMs, Sarvam, Twilio, Google Calendar, email, WhatsApp, and webhooks. Implementation and mock contract coverage do not establish deployed configuration or live-provider correctness. The existing documented local results are historical evidence from a prior candidate (HEAD `c5fd940…` with a dirty working tree), not results for this clean HEAD. No tests were run in this discovery.

Readiness definitions used here:

- **READY TO BEGIN STAGING:** owner names and target identity, authorization, candidate revision, deployment/access/recovery roles, and test scope are recorded; outbound effects are disabled by default; staging setup can be performed against a positively identified isolated target.
- **STAGING VERIFICATION IN PROGRESS:** the authorized pinned candidate is deployed to that target; each run has date, revision, environment identity, operator, and retained evidence. Local/mock evidence is not counted as staging evidence.
- **BETA COMPLETE:** all applicable Beta acceptance rows pass on the pinned staging candidate; staging migration/security/identity, application/worker/scheduler, recovery/monitoring, and selected provider contract checks have objective retained evidence and owner disposition. A mock-only provider test cannot close a real integration row.
- **BLOCKED:** an acceptance prerequisite is unknown, unauthorized, inaccessible, or failed without an approved safe recovery path. Current overall state is BLOCKED at the staging boundary.

The ten-criterion register is retained as recorded; its source document itself explains that the ten rows originated as an audit mapping, not a located canonical historical checklist. This report does not make it canonical by assertion. The mapping remains the controlling working register until a release owner confirms otherwise. Charlie remains the controlled Arunodaya pilot, real-world acceptance, and pilot-operations phase. Final release remains production-specific verification and explicit go/no-go approval.

## 2. Repository and environment baseline

Baseline inspection used `git status --short --branch`, `git status --porcelain=v2 --untracked-files=all`, branch/HEAD/upstream queries, diff stats, `git log -1`, and an `AGENTS.md` file search. Results: clean working tree, no staged diff, branch `main`, HEAD as above, upstream `halo/main`, branch reported 50 commits ahead. No repository `AGENTS.md` was found. No existing user changes were present to preserve at this baseline. Only this new report is created.

The status register and Beta readiness note describe a different, earlier candidate as dirty and report fresh local checks on 2026-10-12. Git history shows the status-register Alpha checkpoint at `c5fd940…`; current HEAD is later (`ddeda1b…`). Treat the prior pass results as historical and candidate-scoped. This discovery neither repeats nor independently validates them. No staging credentials/connection strings were read or printed. Repository `.env.example` contains placeholder values and variable names, not usable credentials. Its `LLM_PROVIDER=ollama` is a development default, not evidence of deploy suitability.

### Evidence classification

- **Confirmed:** directly present in source/config/docs or observed in the current repository state.
- **Historical evidence:** a dated prior report states a result on its candidate; not freshly verified here.
- **Inference:** operational consequence or likely interpretation derived from confirmed structure.
- **Unknown:** repository evidence does not settle the matter; requires owner or authorized environment evidence.

## 3. Current architecture and integration map

### Components and implementation locations

| Component | Current implementation and evidence | Beta implication |
|---|---|---|
| Web app/control plane | Next.js App Router, React; `src/app/dashboard/**`, `src/app/api/**`, `src/proxy.ts`, `src/app/login`, onboarding and settings routes. | Must validate deployment URL, auth callbacks, tenant roles, and deployed candidate. |
| Auth/tenant access | Supabase SSR/browser clients in `packages/tenancy/supabase/{server,client,admin}.ts`; auth helpers in `packages/tenancy/auth.ts`; middleware/proxy in `src/proxy.ts`; migrations `0001`, `0002` and later policies. | Admin/service-role operations bypass database RLS and rely on application scoping. Deployed grants/Auth settings need target-side review. |
| Agent resolution/runtime | `packages/agents/{agent-resolver,agent-versioning,agent-repository}.ts`; `packages/runtime/**`; bounded tool policy in `packages/runtime/tools/{boundary,registry}.ts`; app integration in `src/core/services/**`. | Persist and verify tenant, agent, immutable version, channel, and allowed tools across paths. |
| Data and identity | `supabase/migrations/0001–0031`; Supabase repositories under `src/core/repositories`, `src/core/services`, and package stores. Conversations have business/agent/version identity; widget conversations additionally use receptionist linkage; phone conversations allow nullable receptionist under explicit channel check. Voice/campaign identity guards in migrations include same-agent/version/business relationship. | Staging migration ledger, data census, and actual-role RLS remain unverified. Historical unprovable rows should remain unlinked rather than guessed. |
| Widget/public APIs | `public/widget.js`, `widget/src/**`; routes `src/app/api/v1/widget/**`; `packages/platform/{rate-limit,ssrf,crypto}.ts`; `packages/agents/agent-resolver.ts`. | Browser identity is resolved server-side from widget/receptionist configuration; request-provided agent/version must not become authority. Verify deployed CORS/origin/limits and RLS/service-role scoping. |
| Voice gateway | `services/voice-gateway/{server,config,webhook,stream-token,web-stt,web-tts}.ts`; domain logic `packages/voice/**`; Twilio adapter `packages/providers/telephony/twilio-media-stream-provider.ts`. | Separate service/configuration and public callback boundary. HTTP callbacks verify provider signatures; WebSocket media uses short-lived signed stream identity. Host URL/TLS, secret agreement, startup and health must be evidenced. |
| Pipecat worker | `services/pipecat-worker/{worker.py,halo_client.py,halo_codec.py,halo_serializer.py,media_gate.py}` and tests. `requirements.txt` pins Pipecat 0.0.108, websockets 15.0.1, sherpa-onnx and ONNX. | Separate Python process, control socket and media path; worker lifecycle, dependency environment, auth, drain/restart and health must be checked in staging. |
| STT/TTS | Sarvam and local adapters in `packages/providers/voice-vendors/**`; Pipecat speech adapters under `services/pipecat-worker`; browser provider `packages/providers/speech/browser-speech-provider.ts`. Fake providers are defaults in examples. | Sarvam and local configurations are distinct. Live provider contract and speech quality have no evidence here; Telugu human review belongs to Charlie. |
| LLM/knowledge | Provider factory and adapters in `packages/providers/llm/**`; runtime ports/contracts in `packages/ports`; knowledge retrieval in `packages/knowledge/**` and `packages/providers/knowledge/**`; embeddings optional. | Select a supported non-development provider, validate secrets/config presence, timeouts and failure modes; real calls need explicit authorization. |
| Scheduling/workflows/CRM | `packages/scheduling/**`, `packages/workflows/**`, `packages/crm/**`, `packages/lifecycle/**`, `packages/campaigns/**`; cron routes under `src/app/api/cron/**`. | DB state and retry/idempotency paths need staging exercise; cron requires configured `CRON_SECRET`; dispatch must remain disabled absent authorization. |
| External adapters | Twilio; Google Calendar OAuth/API; Resend/email; WhatsApp Cloud API; tenant webhooks; optional Microsoft/CalDAV adapters. Factories select integrations from environment/config. | Beta should exercise only integrations selected for the staging contract. Messaging defaults to `log`; no requirement to turn on all adapters. |
| Operations/health | `src/app/api/health/route.ts` (public liveness and CRON-secret protected deep probe), gateway `/health`, startup validation `src/lib/startup-check.ts`, structured logger `packages/platform/logger.ts`, analytics packages. | Endpoints exist, but no staging probes, metrics/alerts, incident response or outage/recovery evidence found. Endpoint presence is not an alerting system. |
| Deployment/CI | `vercel.json`, `.github/workflows/ci.yml`, `scripts/{preflight,check-migrations,check-rls,check-architecture,check-neutral}.mjs`, `docs/DEPLOYMENT.md`. CI runs test/build/preflight and disposable migration + real-role RLS harness; Pipecat is separate job. | GitHub CI is a verification pipeline, not evidence of staging deployment or protected staging environment. No deployment workflow/target is evidenced in inspected workflow. |

### Main runtime/data flows

1. **Dashboard:** browser session → Supabase SSR auth → tenant membership/role scoped application routes → tenant-owned config, knowledge, agents and immutable versions → persistence through server repositories. Service-role repositories must impose explicit tenant predicates; RLS is additional defense, not proof for service-role requests.
2. **Widget chat:** embed loads public config → server resolves widget/receptionist to tenant and published agent/version → visitor token maps to a scoped conversation → ChatService/runtime builds bounded context and calls selected LLM → allowed tools execute through server-bound ports → validated response and usage/conversation events persist. Tests include body-supplied identity ignored and foreign-tenant version rejection (`tests/integration/widget-messages-security.test.ts`).
3. **Phone voice:** provider webhook + signature validation → tenant phone-number/agent/version resolution → call/conversation state persisted → gateway handles media directly or delegates via Pipecat → STT → HALO control/runtime and LLM/tools → TTS → media response; provider call events/outcomes/usage persist. For Pipecat, gateway signs short-lived media/control parameters; worker authenticates and reports events. Source paths: `services/voice-gateway/**`, `packages/voice/**`, `packages/providers/telephony/**`, migrations `0020` onward.
4. **Browser speech/voice:** widget browser ↔ Next widget speech/call routes ↔ internal gateway endpoints; request body is signed with shared server-side secret. Streaming browser voice uses Pipecat worker and same runtime/session identity model.
5. **Booking/workflows:** runtime scheduling intent → deterministic booking orchestrator/service and availability repository → external calendar adapter if selected → persistent booking/provider IDs → reminder/workflow cron routes authenticated by CRON secret. Replays should be idempotent; mocks model selected failure/race semantics but do not prove provider behavior.
6. **Campaigns:** explicit `HALO_OUTBOUND_ENABLED=true` gate plus cron authentication and tenant/contact/consent/DNC eligibility → bounded fair dispatch through selected telephony adapter → callback/outcome reconciliation. `.env.example` defaults outbound off.

### Trust boundaries and sensitive operations

- Browser/public widget and appointment tokens are untrusted; server-side tenant, agent/version, channel and capability resolution must be authoritative.
- Supabase Auth user/tenant role boundary; service-role key has broad database privileges. Secret must stay server-only; service-role paths depend on correctly scoped application queries.
- Provider callback boundary: verify signatures against exact externally observed URL/body and reject invalid signatures; replay behavior and callback idempotency need deployed test evidence.
- Voice gateway ↔ Pipecat worker control/media trust boundary: shared signing material, short-lived stream tokens, authenticated control socket, tenant-bound session claims; secret agreement and network exposure need staging verification.
- LLM/provider boundary: prompts/context may contain customer data; provider selection, retention terms, request logs, timeout/retry and usage reporting require operator decisions and provider contract evidence.
- Database migrations and production data are high-impact operations; stage target and recovery approval must precede any migration.
- Cron/campaign routes can create persistent or external side effects; CRON secret, deduplication, consent and disabled-by-default outbound gate are safety controls.

### Documentation/code differences and limitations

- Some older overview docs (notably `docs/TESTING.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`) describe a smaller/earlier app or counts from earlier phases. Use current source, package scripts and current dated status reports for present implementation; preserve old evidence as historical.
- `docs/HALO_V1_STATUS.md` and `docs/HALO_PHASE_BETA_READINESS.md` are dated 2026-10-12 but describe a dirty `c5fd940…` candidate and claim current reruns. Current checkout is clean at later HEAD `ddeda1b…`. Thus those runs cannot be represented as this HEAD's checks.
- CI builds and verifies code and disposable DB behavior. The inspected workflow does not deploy to a protected staging environment or evidence staging approval gates.
- Local speech documents report poor/uncertain Telugu results (for example 67% WER and 20% CER for one 11-clip set) and missing human review/audio artifacts. This is a Charlie-quality question if that speech route is selected; not a Beta code defect.

## 4. Beta requirement inventory

Detailed prerequisite matrix and safe sequence are in `docs/HALO_PHASE_BETA_READINESS.md`; this section classifies those items and defines closure evidence. Secret values are deliberately excluded.

| Requirement | Beta classification / current state | Evidence, type, closure evidence and dependency/consequence |
|---|---|---|
| Named staging owner/contact | Required; **MISSING**; owner-dependent | No named operational owner in repository. Owner supplies name/role, escalation contact, access window and incident contact. Without it no one can authorize or own recovery. |
| Staging identity and isolated target | Required; **BLOCKED**; infrastructure/access-dependent | No project reference/region, endpoint identity, app URL, deployed revision or target-bound authorization in records. Hosting clues (`vercel.json`, Supabase local config) do not establish identity. Need owner-confirmed provider/project/region, environment label verified through authorized console/session, URL, revision and written access scope. |
| Candidate/revision and deployment platform | Required; **MISSING**; owner/infrastructure-dependent | Branch/HEAD are known; approval of this candidate for staging and hosting deployment target are not. Need release owner pin a commit/artifact and identify deployment source, approval gate and environment. CI alone is not deployment. |
| Staging database, read access and migration role | Required; **BLOCKED**; infrastructure/access-dependent | Supabase migrations and local scripts exist; target database identity/roles are unknown. Need target-bound least-privilege read role, migration operator role and approved migration invocation; show sanitized project/database identity before read. |
| Backup, restore, rollback and recovery owner | Required before migration; **MISSING**; owner/infrastructure-dependent | Runbook/docs exist but no staging backup/PITR status or restore drill. Need approved recovery point and restore/rollback procedure, owner, RTO/RPO and tested evidence. Schema changes may not be safely reversed with SQL rollback; forward fix/restore decision must be explicit. |
| Secret manager and required secret presence | Required; **BLOCKED**; configuration-dependent | `.env.example`, `packages/platform/env.ts`, gateway config, README indicate names; no secret manager/system or values/presence evidence is available. Owner provides secret store reference and presence-only review by authorized operator. Never place values in this report. |
| Auth, callback URLs, widget origins | Required; **BLOCKED**; config/infrastructure-dependent | Google OAuth routes and SSR auth exist; exact staging URL and provider callback/origin configuration unknown. Need approved auth provider settings, redirect/callback URLs, widget allowlist, TLS domains and test account/tenant. |
| CRON secret and scheduler | Required for enabled scheduled functionality; **BLOCKED**; config-dependent | `vercel.json` schedules retention/reminders/workflows/no-shows; routes require CRON secret; campaign route is separately gated. Need schedule inventory, injected secret presence and staging-only authenticated run/rejection evidence. If scheduled features out of scope, owner must explicitly disable them and account for consequences. |
| LLM provider/model | Required for runtime staging; **BLOCKED**; config/provider-dependent | Factory supports Ollama/OpenAI/Anthropic/Gemini/Groq/Mistral/cloud routes; template defaults Ollama. Need selected supported provider/model, secret presence, timeout and bounded authorized probe; record provider response metadata only. |
| Sarvam STT/TTS | Required only if staging voice contract selected; real provider evidence currently **BLOCKED** | Adapter/config and contract mocks exist. Need provider owner, sandbox/credential presence, model/voice/mode, callback/gateway config, bounded authorized smoke evidence. No live speech quality acceptance here. |
| Telephony | Conditional; **BLOCKED** if phone/webhook contract in Beta, otherwise disabled/NA | Twilio adapters/signature code exist; no staging number/account/callback signing configuration. Need explicit Beta scope, sandbox number and signed callback test; keep outbound campaign disabled unless separately authorized. |
| Calendar | Conditional; **BLOCKED** if booking integration selected | Google OAuth/calendar adapters exist and tests are mocked; no staging OAuth app/account/calendar. Need sandbox account, scopes/callbacks, conflict and provider-ID reconciliation; if no booking in Beta, label NA and keep tool disabled. |
| Messaging/webhooks | Optional pending scope; **NOT APPLICABLE** to base readiness; otherwise **BLOCKED** | Default messaging provider is `log`; Resend/WhatsApp/webhook adapters exist. Need selected channel, destination, consent, callback/signature, idempotency contract and separate authorization before real effects. Do not enable all integrations by default. |
| Worker deployment and health | Required for Pipecat/voice scope; **PARTIAL locally, BLOCKED in staging** | Worker and gateway exist; no deployment, endpoint identity, TLS/network policy, compatible revision, health/restart evidence. Need paired release/revision, shared secret configuration reviewed presence-only, health and drain/restart test. |
| Webhook signatures/replay/allowlists | Required for selected provider callbacks; **PARTIAL code, BLOCKED operationally** | Twilio signature verifier, stream token and widget HMAC source exist; deployed exact URL/allowlist and duplicate callback behavior have no evidence. Need accepted/rejected/replay tests on staging, receipts and no leaked payload data. |
| Usage limits/accounting | Required; **PARTIAL** | Context/token bounds and usage event paths/tests exist; deployed/provider billing attribution and alerts are unknown. Need set owner-approved limits, produce per-request/per-call usage attribution without fabricated values, and reconcile provider receipts. |
| Health/logging/monitoring/incident | Required; **PARTIAL code, BLOCKED operation** | Liveness/deep readiness, gateway health and structured logs exist; no staging alert route, dashboard, redaction review, incident owner or drill found. Need prove safe liveness/readiness, alert delivery, provider/DB outage detection, escalation and recovery. |
| DNS/TLS/network | Required for public app/provider callbacks and worker media; **UNKNOWN** | No staging host/domain found. Need validated DNS/TLS certificate, ingress/egress and allowlist evidence, wss/https callback reachability, least-exposure network rules. |
| Protected CI/environment approvals | Required release control; **MISSING/UNKNOWN** | `.github/workflows/ci.yml` gates tests/build/DB harness, but no deployment job or protected environment approval found. Owner identifies deployment pipeline and shows branch/artifact/environment restrictions. |

## 5. Ten-criterion Beta acceptance/evidence matrix

Criterion wording and order are retained from `docs/HALO_V1_STATUS.md` §C. Responsible people are not known; role labels below are suggested evidence custodians, not assigned owners.

| # / existing criterion | Beta pass rule | Current evidence and missing evidence | Procedure / prerequisite | Evidence artifact and likely custodian |
|---|---|---|---|---|
| 1. Shared agent/runtime and bounded business tools work across channels | On pinned staging revision, approved widget and (if in scope) voice channel resolve the same tenant/published version; unauthorized tools reject; no false success on failed action. | Historical local fake/golden tests only. No deployed channel wiring or staging traces. | Deploy approved tenant/version with outbound effects off; run scripted channel and tool allow/deny scenarios. Requires staging target, candidate, test tenant and selected channels. | Redacted request/session traces, version/tool IDs, scenario results; release/runtime owner. |
| 2. Tenant and published-agent identity are enforced | Real staging roles cannot read/write another tenant; identity tuple is consistent across receptionist/agent/version/conversation/call; anonymous or mismatched identity fails closed. | Historical disposable DB replay and real-role RLS tests; no target Auth/grants/identity census. | Confirm target identity, inspect grants/policies using correct roles, run two-tenant negative/positive probes and inspect historical linkage without guessing. | SQL/assertion report with IDs pseudonymized, grants/policies and negative results; security/database owner. |
| 3. Qualification, CRM outcomes, consent, DNC and campaign controls are deterministic | In staging fixtures, consent/DNC suppressions are enforced; rejected/failed operations do not create external effects; replay produces one outcome. | Source/tests/mock-only; no staged config, policy approvals or scheduler. | Test with synthetic contacts, dispatch disabled, duplicate event and boundary policies. Requires approved test fixtures and policy rules. | Scenario report, DB state delta, audit/outbox evidence; product/CRM owner. |
| 4. Voice control/media handle lifecycle and failures | If voice included: matched gateway/worker session starts, processes authorized control/media, cancels/cleans up on disconnect, rejects invalid signature/token, and recovers from timeout/restart without orphan calls or false success. | Historical JS tests; earlier report says worker dependencies unavailable in its local environment; no live provider/deployed worker. | Deploy worker/gateway pair; signed sandbox callback and controlled session; outage, cancellation, restart, drain. No production/customer call. | Redacted lifecycle log/metrics, worker revision, test cases, provider sandbox receipts; platform/voice owner. |
| 5. Controlled evaluation and learning cannot alter a live agent without review | Staging learning/evaluation outputs remain proposals until authorized review; active version stays immutable; publish/rollback is attributable and restricted. | Local version immutability/proposal tests historically reported. No staging roles/audit trail/publish drill. | Review role permissions; propose, reject, approve, publish new version, verify prior active sessions and rollback selection. | Version/audit event export and reviewer decision; agent/release owner. |
| 6. Usage and context budgets are bounded and attributable | Staging request/call limits reject or degrade safely at boundaries; usage is attributed to tenant/version/session; provider-reported usage is distinguished from estimates; limit alerts route. | Local bound/unit tests; no provider receipts, deployed telemetry or alerts. | Use bounded staging requests; exercise budget boundary and provider timeout; compare app counters with provider response/usage data. | Redacted usage reconciliation and alert event; operations/provider owner. |
| 7. Production campaign dispatch and scheduling have required operating configuration | For Beta only, schedules authenticate, reject unauthenticated access, and execute synthetic/disabled-action jobs once; outbound remains disabled unless explicit separate authorization. | `vercel.json`, CRON-auth route source and tests exist; no staging CRON secret/schedule run evidence. | Confirm schedule/secret injection; unauthenticated rejection; dry-run or synthetic job; duplicate event idempotency; verify outbound flag off. | Sanitized scheduler execution, rejection, dedupe and config-presence record; platform owner. |
| 8. Release/operations evidence supports safe activation | Pinned revision/build and migration set are known; health/worker readiness, restore/rollback, alert, incident and recovery exercises meet owner-approved criteria. | CI exists; historical local build/CI checks; no staging deploy, backup restore, rollback or incident evidence. | Deploy; verify revision; migration rehearsal/approved execution; restore/rollback rehearsal and alerts/outage response. Requires target, recovery and ops owners. | Deployment manifest, migration ledger, restore/rollback evidence, alert/incident record; release/DB/ops owners. |
| 9. Two useful integrations supported, one exercised end-to-end in pilot | Beta verifies the selected provider contracts in sandbox and records real sandbox acceptance distinctly from mocks; one end-to-end pilot exercise remains Charlie, not Beta. | Multiple adapters and mocked contract tests; no real provider request. | Owner selects integrations needed for Beta and supplies sandbox access/authorization; test request, callback, duplicate/retry and receipt. Keep any business/pilot transaction in Charlie. | Provider sandbox receipt with secrets/customer data redacted, callback/idempotency record; integration owner. |
| 10. Arunodhaya pilot scenarios pass documented criteria | Beta staging scenarios use approved synthetic/test data and pass objective technical checks; no customer acceptance is claimed. Actual business outcome and pilot acceptance are Charlie. | Local scripted golden tests only; no approved test fixture owner or staging scenarios. | Product owner maps scripts to approved facts/tools and synthetic test data; run in staging with outbound effects disabled. | Scenario matrix, redacted traces, defect disposition; product/pilot owner (unnamed). |

**Objective aggregate rule:** every applicable Beta row has a recorded pass on exact revision/environment, or a formally accepted NA with rationale and disabled feature. Any failed security/data-integrity/recovery assertion, unidentified environment, missing authorization, unresolved unsafe side effect, or absent required evidence keeps Beta blocked/incomplete. Provider mock success cannot pass row 9's real sandbox evidence. Rows 9–10 do not turn Beta into Charlie.

## 6. Findings and risk register

Effort estimates are implementation/verification ranges in engineer-days; setup/approval wait time is excluded. Confidence labels refer to the finding statement, not to presumed root cause.

### F-01 — No identified/authorized staging target (P1, blocker)

- **Requirement/phase:** all Beta staging evidence; Beta. **Class:** infrastructure/access blocker and missing evidence. **Severity:** P1, because no target-bound checks can run safely. **Confidence:** CONFIRMED for absence in inspected repository records; actual organization infrastructure existence is UNKNOWN.
- **Evidence/affected locations:** `docs/HALO_PHASE_BETA_READINESS.md`; `.env.example`; `supabase/config.toml`; `vercel.json`; `.github/workflows/ci.yml`. These do not identify a hosted staging project/revision or authorize access.
- **Root cause:** not established. Repository evidence has no owner-supplied target identity/authorization record.
- **Recommended solution:** owner supplies exact isolated environment/provider/project reference and region, application URL, expected DB identity, revision, named operator and written scope. Before any read, operator verifies environment identity through the authorized console/session; preserve sanitized proof. Never infer target from hostname/env label.
- **Alternative:** use an existing shared or production endpoint. Rejected because target isolation and authority are unproven and risk of unintended data access/mutation is high.
- **Trade-offs:** low implementation cost; owner coordination. Adds explicit environment verification but prevents mis-targeting.
- **Compatibility/migration:** none. **Regression/acceptance:** no mutation; target identity and access scope match owner record; read-only identity probe yields expected project/region/environment. **Prerequisites:** owner, target, access. **Localizable:** no. **Effort:** 0.5–1 day after inputs. **Order:** first.

### F-02 — No staging release/deployment, recovery or protected approval evidence (P1)

- **Requirement/phase:** deployment readiness, criterion 8; Beta. **Class:** infrastructure/configuration/owner gap. **Severity:** P1. **Confidence:** CONFIRMED for inspected repo evidence; external platform configuration UNKNOWN.
- **Evidence:** `.github/workflows/ci.yml` has quality and disposable database jobs, not deployment; `vercel.json` holds schedules, not a release workflow; `docs/DEPLOYMENT.md`/`docs/OPERATIONS.md` are procedural but no dated staging deployment/restore drill is present.
- **Root cause:** no target/release owner evidence or platform-specific run record in repository. Whether workflow is managed elsewhere is unknown.
- **Recommended solution:** pin a commit/artifact; document deployment method and protected environment approvers; rehearse deploy, schema compatibility, backup/restore or approved forward-recovery, rollback decision, and incident escalation before accepting migration risk.
- **Alternative:** treat successful CI as deployment/recovery acceptance. Rejected because CI has no target and no stateful recovery proof.
- **Trade-offs:** added owner time and an isolated restore cost; materially reduces unrecoverable schema/app mismatch risk. Avoid asserting down-migration safety where migrations are not reversible.
- **Compatibility/migration:** migration-first/expand-contract ordering may be needed depending on selected revision and existing target schema; inspect before action. **Acceptance:** exact revision deployed; backup recoverable; documented rollback/forward-fix authority; readiness and alert drill recorded. **Tests:** all CI gates plus target rehearsal. **Prerequisites:** F-01, DB/ops owner. **Localizable:** runbook refinement locally; execution external. **Effort:** 1–3 days. **Order:** after F-01, before staging migration.

### F-03 — Deployed tenant/RLS and identity linkage unverified (P1)

- **Requirement/phase:** criterion 2, security; Beta. **Class:** missing evidence, not confirmed defect. **Severity:** P1. **Confidence:** CONFIRMED that no staging evidence exists; deployed defect UNKNOWN.
- **Evidence:** `packages/tenancy/**`, `packages/agents/agent-resolver.ts`, `src/core/services/widget-repository.ts`, migrations `0001–0031`, `scripts/check-rls.mjs`, `tests/integration/{multi-tenant-isolation,widget-messages-security,agent-linkage}.test.ts`; historical local harness result in `docs/HALO_PHASE_BETA_READINESS.md`.
- **Root cause:** no target access. Broad service-role behavior is intentionally application-scoped and means RLS-only proof is inadequate for these paths.
- **Recommended solution:** in staging, inventory effective Auth/grants/policies and service-role query scope; execute least-privilege real-role two-tenant tests; verify complete business/receptionist/agent/version/conversation/call tuples and preserve null for unprovable historical linkage. Fix only a reproduced mismatch.
- **Alternative:** superuser or table-owner query as tenant-isolation proof. Rejected because it bypasses effective policies/roles.
- **Trade-offs:** carefully scoped read/test fixtures reduce exposure; tests must avoid real customer data and never “repair” ambiguous historical rows by guessing.
- **Compatibility/migration:** only if staging reveals schema drift or invalid historical tuples; plan reversible, exact-owner mapping remediation first. **Acceptance:** cross-tenant read/write probes denied in supported roles; valid tuples pass; legacy unknown remains safely unlinked; no production data access. **Regression:** current RLS suite + deployed role probes. **Prerequisites:** F-01/02, security+DB owner. **Localizable:** test design; proof external. **Effort:** 1–3 days, remediation TBD. **Order:** before staging feature scenarios.

### F-04 — Runtime/provider environment and secret inventory not evidenced (P1)

- **Requirement/phase:** criteria 1, 4, 6, 9; Beta. **Class:** configuration/owner gap. **Severity:** P1. **Confidence:** CONFIRMED no evidence record; configuration state UNKNOWN.
- **Evidence:** `packages/platform/env.ts`, `src/lib/startup-check.ts`, `services/voice-gateway/config.ts`, `packages/providers/llm/factory.ts`, `.env.example`, gateway/worker READMEs. Example selects development Ollama, fake voice defaults, log messaging, and outbound off.
- **Root cause:** no staging configuration inventory or secret-manager access evidence. Names in templates only define interface, not provisioning.
- **Recommended solution:** select per-scope providers and feature flags; provision required secrets in approved manager; validate presence/format without outputting values; pin callback URLs/voice models/timeouts; keep nonselected providers absent and side effects disabled. Require boot/readiness checks to fail clearly on missing required configuration.
- **Alternative:** copy `.env.example` defaults to hosted staging. Rejected because fake providers/Ollama may be unsuitable and would misrepresent integration evidence.
- **Trade-offs:** provider selection incurs cost, data-processing and latency decisions; fake/log modes are cheap but cannot pass real contracts.
- **Compatibility/migration:** none. **Acceptance:** secret presence and config schema pass without values in logs; selected provider and model match owner decision; invalid required config fails closed; outbound disabled. **Tests:** env/startup/config tests plus staging configuration probe and authorized contract check. **Prerequisites:** F-01, provider/platform owners. **Localizable:** inventory; provisioning external. **Effort:** 0.5–2 days plus provider setup. **Order:** before deploy and provider probes.

### F-05 — Pipecat worker full test suite not established for current documented setup (P1 conditional voice)

- **Requirement/phase:** criterion 4, voice staging; Beta if worker is selected. **Class:** missing fresh evidence/environment, not known code defect. **Severity:** P1 conditional. **Confidence:** CONFIRMED historical report that full suite errored because supported venv/dependencies absent in that run; exact current HEAD result UNKNOWN.
- **Evidence:** `.github/workflows/ci.yml` Pipecat job sets Python 3.10 and installs `services/pipecat-worker/requirements.txt`; `services/pipecat-worker/README.md`; tests `services/pipecat-worker/test_*.py`. Earlier readiness record says focused `test_halo_client` passed 10, while full discovery had five import errors due absent Pipecat/websockets in system Python.
- **Root cause:** full suite was invoked with unsupported/incomplete system interpreter environment; documented CI setup is the supported path. Do not install in discovery.
- **Recommended solution:** later, run the existing CI worker job or a clean Python 3.10 venv created under the documented workflow, pin/install requirements from lock/requirements, then run complete unittest discovery. Keep install separate from this audit and use no live provider credentials.
- **Alternative:** infer full worker correctness from focused client test or JavaScript mocks. Rejected because it misses imports/media/gateway protocol modules.
- **Trade-offs:** CI dependency install time and binary package availability; local model weights are not needed for fake-backed worker tests and should not be provisioned for Beta unless local speech chosen.
- **Compatibility/migration:** none. **Acceptance:** all worker modules import; full suite passes on supported version; failures are triaged by reproducible test, not import omissions. **Prerequisites:** authorization for later test/install and Python setup. **Localizable:** yes, when separately authorized. **Effort:** 0.5–1 day. **Order:** prior to staging worker deploy.

### F-06 — No real integration contract evidence (P1 conditional; P2 where feature excluded)

- **Requirement/phase:** criteria 4, 7, 9; Beta selected real contracts. **Class:** missing evidence/configuration. **Severity:** P1 for selected integration; P2 if excluded from Beta. **Confidence:** CONFIRMED no real-provider request in reports inspected.
- **Evidence:** `tests/contracts/**` and `tests/integration/**` use mocks/fakes; adapters in `packages/providers/**`; earlier reports explicitly say no provider calls. Twilio/Sarvam/Google/Resend/WhatsApp implementations exist.
- **Root cause:** no selected staging provider scope, sandbox access or separate request authorization.
- **Recommended solution:** owner identifies minimum provider set tied to Beta acceptance (not every implemented adapter); first run deterministic contract tests; then authorized bounded sandbox smoke with synthetic data, signed callback/replay tests, idempotency and receipt. Record real-provider evidence separately from mock result.
- **Alternative:** run every integration or promote mocks to Beta pass. Rejected as unnecessary cost/surface area and insufficient evidence respectively.
- **Trade-offs:** real calls may incur cost and transmit data; synthetic-only bounded sandboxes and explicit side-effect control minimize risk. Provider results may differ from mocks in rate limits/latency.
- **Compatibility/migration:** none generally; selected webhook/schema contract may require small config/code fix only after failure demonstrated. **Acceptance:** selected request/callback succeeds, invalid signature/replay rejected or deduplicated, provider receipt correlated; no unintended customer side effect. **Tests:** adapter contract + staging sandbox. **Prerequisites:** F-01/04, provider owner and authorization. **Localizable:** mocks, not live pass. **Effort:** 0.5–2 days per selected provider. **Order:** after config/deploy.

### F-07 — Operational monitoring, alerts and recovery are source-only (P1)

- **Requirement/phase:** criteria 6 and 8; Beta. **Class:** missing operational evidence and owner decisions. **Severity:** P1. **Confidence:** CONFIRMED no staging alert/recovery evidence; implementation defect UNKNOWN.
- **Evidence:** `src/app/api/health/route.ts`, gateway `/health`, `packages/platform/logger.ts`, analytics and usage code; operational docs/runbooks. No alert destination, SLO, incident contact, recovery objective or drill artifact found.
- **Root cause:** no named ops owner/environment evidence. Liveness/readiness routes do not themselves alert or repair.
- **Recommended solution:** name incident responder; define minimal Beta signals (app/gateway/worker health, DB/provider outage, error rate, latency, usage/cost, scheduled task failures); redact secrets/PII; route and test an alert; conduct DB/provider outage and worker restart/drain drills; record recovery. Avoid premature broad observability rewrite.
- **Alternative:** infer readiness from endpoint existence or dashboard status. Rejected because no alert delivery/escalation proof.
- **Trade-offs:** modest monitoring/alert costs; high diagnostic value; use low-cardinality IDs and avoid transcripts/customer content.
- **Compatibility/migration:** none. **Acceptance:** liveness and authenticated deep readiness behave as designed; outage triggers alert within agreed window; recovery/restoration and escalation are recorded; logs contain no secret values or unnecessary customer data. **Prerequisites:** F-01/02 and ops contact. **Localizable:** procedure/test plan; actual proof external. **Effort:** 1–3 days. **Order:** before Beta completion.

### F-08 — Usage limits and provider charge reconciliation not proven in deployment (P2)

- **Requirement/phase:** criterion 6; Beta instrumentation, charge reconciliation belongs later as stated by existing register. **Class:** missing operational evidence. **Severity:** P2 unless the provider contract requires a hard prelaunch spend cap, then P1 owner decision. **Confidence:** CONFIRMED no deployed/receipt evidence.
- **Evidence:** runtime token/context budgets and event stores; `docs/VOICE_TOKEN_BUDGET.md`, usage analytics; historical status says no cumulative currency budget or deployed load/alerts evidence.
- **Root cause:** no chosen provider/limits/telemetry receipts.
- **Recommended solution:** set small staging caps and concurrency/request limits; show known vs estimated provider usage separately; alert on budget thresholds; do not claim currency accuracy absent billing source. Full finance reconciliation is Charlie/final scope.
- **Alternative:** implement a billing rewrite before staging. Rejected without evidence that existing event attribution is defective or Beta requires invoices.
- **Trade-offs:** conservative limits may constrain load tests but prevent surprise spend; telemetry adds privacy and retention choices.
- **Compatibility/migration:** none expected. **Acceptance:** boundary overrun is safely refused/degraded; per tenant/session attribution reconciles to provider response metadata where available; threshold alert arrives. **Prerequisites:** selected provider/ops owner. **Localizable:** tests and small caps; provider evidence external. **Effort:** 0.5–2 days. **Order:** before real-provider use.

### F-09 — ENG-04 naming collision and ENG-12 approval unresolved (P2 governance)

- **Requirement/phase:** backlog/release tracking across Beta and Charlie. **Class:** documentation inconsistency and owner decision. **Severity:** P2; can be isolated from technical execution with descriptive scope names. **Confidence:** CONFIRMED conflict; no approval found in searched records/history.
- **Evidence:** backlog defines ENG-04 as pilot voice/speech route; `docs/ENG_01_SECURITY_IDENTITY_REVIEW.md` uses historical “ENG-04 Phase 2” for database linkage audit; `docs/HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md`, release decisions/backlog propose ENG-12; ENG-11 is local Telugu review. Search `git log --all --grep='ENG-04|ENG-12|staging|Beta' -i` produced no matching commit subject proving approval (search is not proof of an absent external decision).
- **Root cause:** legacy label reused for distinct scope; owner decision not recorded in repo.
- **Recommended solution:** until owner decides, track by descriptive scopes: “pilot voice/speech route” and “database migration/linkage identity audit (SEC-04 scope).” Ask owner to confirm canonical ID for each and compatibility alias policy; then narrowly update cross references with a history note.
- **Alternative:** silently rename historical references to ENG-12. Rejected because it fabricates approval and obscures history.
- **Trade-offs:** temporary descriptive labels reduce exact ID continuity but prevent workstream collision. No technical effect.
- **Compatibility/migration:** documentation-only. **Acceptance:** dated owner decision names both scopes/IDs/aliases; references reconciled while preserving historical mention. **Prerequisites:** release owner. **Localizable:** yes after decision. **Effort:** 0.5–1 day. **Order:** before backlog ownership assignment; does not block technical staging steps.

### F-10 — Human Telugu and business outcome evidence absent (P3 for Beta; Charlie gate)

- **Requirement/phase:** speech quality and real pilot acceptance; Charlie. **Class:** later-phase evidence, not Beta defect. **Severity:** P3 for Beta; critical Charlie entry gate. **Confidence:** CONFIRMED in speech/pilot records.
- **Evidence:** `docs/LOCAL_SPEECH_BENCHMARK.md`, `docs/LOCAL_TELUGU_STT_HUMAN_REVIEW.md`, `docs/ARUNODHAYA_AGENT.md`, status/gap records. Review worksheet fields remain blank; audio clips unavailable in workspace; benchmark is small and includes synthetic audio.
- **Root cause:** native-speaker review and authorized real-business scenarios have not been completed; local quality/evaluation is not deployment acceptance.
- **Recommended solution:** keep human-reviewed Telugu STT/TTS, approved Arunodaya facts/disclosures, actual lead/booking outcome and pilot monitoring as explicit Charlie gates; agree thresholds and reviewers before any customer calls. No model/vendor should be declared accepted on WER alone.
- **Alternative:** force speech-quality sign-off in Beta. Rejected because phase boundary assigns real-world quality and customer acceptance to Charlie; Beta can validate technical sandbox contracts only.
- **Trade-offs:** deferral prevents premature quality claims; means a staging technical pass is not pilot authorization.
- **Compatibility/migration:** none. **Acceptance:** later signed human review on retained consented audio, approved business scenarios and monitoring/recovery outcomes; explicit pilot authorization. **Prerequisites:** named pilot/business/native Telugu reviewers and consent. **Localizable:** preparation only. **Effort:** 2–5+ days plus reviewer/pilot time. **Order:** Charlie, after Beta.

## 7. Root-cause synthesis

1. **Primary Beta block is governance/target identification, not a discovered runtime defect.** No target/project/revision/owner record permits safe read-only identity confirmation, so staging properties remain unknown by design.
2. **Prior local success is being carried between candidates in documentation.** Current HEAD differs from the candidate associated with the 2026-10-12 run summaries; current tree is clean. Reproducible CI/local evidence for the current pinned candidate should precede a staging deployment decision.
3. **The application has broad service-role paths.** The code and security documents recognize that table-owner/superuser tests are inadequate; staging proof must exercise effective roles and inspect explicit application query predicates.
4. **Provider interfaces intentionally enable mock-first work.** This improves deterministic local tests but makes evidence labeling essential; no source inspection can establish production credentials, provider SLA, callback reachability, or customer experience.
5. **Operations are mostly represented as code endpoints and runbooks.** Health routes/config schemas exist, but owners, deployed alert destinations, restore drills and incident artifacts are external operational state.
6. **The worker limitation is environmental in the historical record.** The CI workflow already documents Python 3.10 and installs pinned requirements; the full suite should be rerun under that supported setup rather than treated as a proven code failure.
7. **Identifier collision is documentary.** It has no technical dependency if descriptive scopes are used, but owner approval is required before canonical backlog renumbering.

## 8. Prioritized solution backlog and execution order

### A. Local code/documentation work

1. **L1 (P1, 0.5–1 day):** on the exact release candidate, rerun canonical CI/local gates including full Python worker suite (using documented Python 3.10 workflow), then retain revision-bound logs. No code fix is presumed; address only reproduced failures.
2. **L2 (P1, 0.5–1 day):** assemble staging runbook checklist from existing `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`, readiness record and this report; include evidence fields and redaction rules. No runtime change until a concrete gap appears.
3. **L3 (P2, 0.5–1 day after owner decision):** reconcile ENG labels in references with history note; no renumbering before approval.
4. **L4 (P2, 0.5–2 days):** if owner-set usage caps or redaction checks reveal gaps, make narrow instrumentation/limit fixes with tests. This is conditional, not a confirmed defect.

### B. Owner decisions

1. Name release/deployment, database/security, platform/provider, and operations contacts and escalation contact.
2. Confirm minimum Beta integration scope: chat/runtime only, or selected voice/Sarvam/Twilio/calendar/scheduler contracts. Mark unselected features not applicable and keep disabled.
3. Pin candidate commit/artifact and approve staging deployment/access window; confirm whether ten-row mapping is the intended release register.
4. Confirm migration/recovery authority, backup/restore path, RTO/RPO, alert thresholds and incident response.
5. Resolve canonical ENG-04/ENG-12 mapping; until then use descriptive scope names.

### C. Infrastructure and staging setup

1. Provision/identify an isolated staging application and database. Record nonsecret provider/project reference, region, app URL, DB identity, owner and network/TLS evidence.
2. Configure protected deployment approvals and pinned artifact; provide target-bound least privilege access. Do not use an unidentified shared or production environment.
3. Establish secret manager references/presence for selected services; auth callbacks, widget origins, CRON, LLM, voice/gateway/worker, provider callback settings. Values remain outside report and logs.
4. Keep outbound campaigns, real messaging and customer notifications disabled. Use synthetic tenants/contact fixtures. Configure only selected sandbox providers.
5. Confirm database backup/recovery and migration operator/roles before migration.

### D. Staging verification

1. Verify app/database/provider/environment identity read-only and record sanitized proof; stop if identity mismatches.
2. Verify deployed SHA/artifact and startup configuration; health/liveness/deep readiness; no secret output.
3. Review schema/migration ledger and historical identity data read-only. Compare target schema; confirm backup and owner approval before any separately authorized migration. Run appropriate-role RLS/tenant tests after change.
4. Exercise widget/runtime, auth and tool boundaries with synthetic tenants. Verify no cross-tenant access, wrong version binding or false business-action claim.
5. Verify scheduler auth/rejection, duplicate event and disabled side-effect behavior; gateway/worker startup, signatures, cancellation, drain/restart and outage behavior if in scope.
6. Exercise alert delivery, provider/DB outage detection, restore/rollback or approved forward recovery, and incident escalation. Retain records per acceptance matrix.

### E. Real-provider verification

1. Complete mock/contract checks first.
2. For each explicitly selected integration, obtain provider sandbox credentials through approved secret manager and a separate bounded-call authorization; use synthetic data only.
3. Validate request/response shape, timeout/rate limit/failure mapping, signed callback, replay/dedupe, provider receipt and usage metadata. Separate real sandbox results from mocks. Do not call real business destinations in Beta.
4. Sarvam/LLM technical contract evidence can close selected Beta integration checks; speech quality, human Telugu review and carrier/customer conversation acceptance remain Charlie.

### F. Explicitly deferred Charlie / final-release backlog

- Controlled Arunodaya pilot authorization and customer/business owner acceptance.
- Human-reviewed Telugu STT/TTS and end-to-end speech quality; consented audio and agreed thresholds.
- Real business workflow/outcome evidence (lead qualification, booking, follow-up, cancellation) and provider reconciliation.
- Pilot monitoring, on-call/incident handling and recovery evidence under real operating conditions.
- Production-specific security/Auth/RLS and migration/recovery verification.
- Production operational readiness, support ownership, production cost limits, rollback/restore and incident response.
- All ten criteria evidenced at final-release scope and explicit final go/no-go decision.

## 9. Verification strategy and canonical suite

No command below was run during this discovery. “Latest result” refers only to the dated historical report when one is stated. Fresh current-candidate execution must be revision-bound. Do not run DB scripts against a real or unidentified target; inspect exact connection identity and use newly disposable DB/CI service only under separately authorized verification.

| Exact command | What it checks / dependencies | Latest known evidence | Safe now? / Beta evidence needed |
|---|---|---|---|
| `npm test` (or `npm test -- --reporter=dot`) | Full Vitest JS/TS suite; installed npm dependencies; fakes/mocks and unit/integration contracts. | Historical 2026-10-12 report: 128 files, 1,257 passed, 5 skipped on `c5fd940…` dirty candidate. | Safe read-only in workspace but not run here. Retain current SHA and output; still not staging proof. |
| `npm run lint` | ESLint; npm dependencies. | Historical report says pass. | Safe; no fresh result here. Required CI gate. |
| `npm run typecheck` | `tsc --noEmit`; TS dependencies. | Historical report says pass. | Safe; no fresh result here. |
| `npm run build` | Widget bundle and production Next build; configuration may be read at build, no remote target required by workflow. | Historical report says pass. | Safe locally; no fresh result here. Record build artifact/SHA. |
| `npm run preflight:ci` | Production config validation while explicitly skipping DB connectivity. | Historical report says pass and separately noted CRON/provider configuration warnings. | Safe local; no target check. For staging, run authenticated target health/config review separately. |
| `npm run check:neutral` | Package boundary/industry neutrality static check. | Historical report says pass. | Safe local; no fresh result. |
| `npm run check:architecture` | Runtime/tool/repository architecture invariants and RLS table coverage source checks. | Historical report says pass. | Safe local; source-level only. |
| `npm run check:migrations -- "$DISPOSABLE_DB_URL"` | Applies ordered migrations and schema assertions; requires psql/Postgres and may DROP/recreate/reset DB objects as script implements. | Historical pass: all 31 migrations, schema assertions, identity fixtures/backfill replay on named disposable container 2026-10-12. | Do not run without proving URL is a newly disposable database and inspecting script; never target staging during audit. Beta requires approved target migration + ledger/schema evidence, separate authorization. |
| `npm run check:rls -- "$DISPOSABLE_DB_URL"` | Replays schema then exercises effective authenticated/service-role behavior; destructive/reset behavior per script. | Historical disposable real-role pass; earlier record says 109 assertions; later record says OK without count. | Same safety restriction as migration script. Beta requires target-role evidence; never table owner only. |
| `python -m unittest discover -s services/pipecat-worker -p 'test_*.py'` | Full Python worker unit/protocol/audio/security tests; Python 3.10 + pinned `requirements.txt` per CI; no provider request needed by test design. | Historical system Python run had 10 focused `test_halo_client` passes and five modules errored at import due missing `pipecat`/`websockets`; not a full pass. CI workflow defines supported setup. | Not run here. Later safe in CI or isolated venv after install authorization; do not install during discovery. Beta needs full suite result plus deployed worker checks. |
| `pytest` | Not canonical: repository worker tests use stdlib `unittest`, no pytest setup found. | None. | Do not substitute; use command from CI. |
| `npx vitest run --config vitest.security.config.ts ...` | No such security config was identified in current package/workflow inventory; use actual Vitest config/tests listed by repository. | None in canonical CI. | Do not invent command. Focus test file paths can be passed to `npm test -- <paths>` if needed; Beta requires full suite plus real-role DB check. |
| GitHub Actions `CI` workflow | npm install; lint/typecheck/test/build/preflight, neutrality/architecture, disposable migrations/RLS, Python 3.10 install and worker suite. | Workflow source exists; no current run status queried. | Run on pinned candidate through CI. This is code gate, not deployment gate. |
| Provider contract tests under `tests/contracts/**` and integration suites | Fake fetch/sockets/in-memory stores; no external credentials unless test explicitly shows otherwise. | Historical suites reported passed as part of full test run. | Safe only after inspecting a given test for network/write behavior. Mock result is not real-provider Beta evidence. |
| `npm run voice:latency`, `npm run perf:baseline`, `npm run eval:arunodhaya` | Benchmarks/evaluation; inspect script and environment before running; may call configured model/provider or consume local audio/model assets. | Historical reports are in specialized docs; no current run. | Not automatically safe: inspect first, disable remote providers and ensure no side effects. Not required to unblock target identity. |

**Canonical Beta minimum:** all CI jobs on pinned revision; disposable migration/schema + real-role RLS checks; selected focused security/identity/widget tests; complete worker suite if Pipecat included; staging identity/startup/health/auth/RLS; deployed worker and scheduler checks if selected; provider sandbox contract for selected real integrations; operational recovery/alert evidence. Tests requiring DB mutation run only on disposable CI/test setup or separately authorized staging window after approval.

## 10. ENG-04 / ENG-12 decision record

- **Authoritative current backlog reference:** `docs/HALO_V1_ENGINEERING_BACKLOG.md` assigns ENG-04 to authorization/validation of the pilot voice/speech route.
- **Historical security record:** `docs/ENG_01_SECURITY_IDENTITY_REVIEW.md` calls the read-only migration-ledger/conversation identity-linkage audit “ENG-04 Phase 2” / SEC-04 scope.
- **Proposed local reconciliation:** `docs/HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md`, `docs/HALO_V1_RELEASE_DECISIONS.md` and backlog material propose ENG-12 for the database audit; ENG-11 is occupied by local Telugu review. They explicitly state this is not owner-approved.
- **Git-history search:** searched commit subjects for ENG-04/ENG-12/staging/Beta; no approval-bearing commit was identified. This does not establish that no external decision exists.
- **Conflict impact:** tracking ambiguity only; no technical coupling. Until owner decision, use the descriptive scope labels and continue technical work without canonical ID assumptions.
- **Exact decision required:** release owner confirms owner/approver, canonical ID for pilot voice/speech, canonical ID for database migration/linkage identity audit, whether ENG-12 is accepted, and how to retain the historical ENG-04 Phase 2 alias. Then update references narrowly and preserve the prior wording in a history note.

## 11. Exact owner inputs/access required to unblock

No credentials should be sent in chat or placed in this report. The smallest useful owner response is one secured operational record containing:

1. **Accountability:** named release/deployment owner; database/security owner; platform/provider owner; operations/incident contact.
2. **Target:** explicit isolated staging platform/project reference and region; application URL; database/project identity; worker/gateway target; how operator can verify identity. This is identity metadata, not a secret.
3. **Authority:** written target-bound read/deploy/migration scope, named operator(s), permitted actions, approved access window and approval path for sandbox requests. Read-only access does not imply write/deploy authorization.
4. **Candidate:** exact commit/artifact SHA and approval to deploy; protected-environment process.
5. **Recovery:** migration role/procedure, backup/restore or forward-recovery plan, rollback authority, RTO/RPO and responsible owner.
6. **Scope/config:** selected LLM and integrations; whether voice/worker, telephony, calendar, cron, messaging are part of Beta; callback URLs/origins; test tenants and synthetic fixtures. Secret names/presence can be handled in the secret manager; do not reveal values.
7. **Operations:** alert destinations, incident escalation, retention/redaction policy and usage/concurrency caps for the test window.
8. **Tracking:** decision on the ten-row register's authority and ENG-04/ENG-12 naming.

If no authorized staging environment exists, the exact unblock is an owner-created isolated staging target plus the above target identity, access, candidate, recovery and owner record. Do not use production or infer identity from a hostname or environment variable.

## 12. Charlie and final-release gates remain deferred

### Charlie — controlled pilot

- Explicit Arunodaya pilot authorization, named business/customer and technical owners.
- Approved, dated facts, disclosures, consent/contact policy, test-to-live transition and authorized contacts.
- Human-reviewed Telugu speech acceptance and end-to-end voice quality with consented evidence and agreed thresholds.
- Real workflow/outcome evidence (lead qualification, booking, reminder, cancellation, handoff) with provider IDs and reconciliation.
- Pilot monitoring, incident handling, operational recovery, support and cost evidence.
- Dated reviewer acceptance and defect disposition. Beta staging pass is not pilot approval.

### Final release — production

- Production-specific tenant/auth/RLS/service-role and security review under separately authorized access.
- Production migration compatibility, backup/restore and recovery verification.
- Production DNS/TLS, secrets, provider configuration, limits, monitoring, alerts, incident/rollback readiness.
- All ten release criteria accepted against the production candidate and named evidence owners.
- Explicit final release go/no-go approval. No production authorization or readiness is implied here.

## 13. Evidence sources, files inspected, and checks performed

### Authoritative and specialist records

Inspected: `docs/HALO_V1_STATUS.md`, `docs/HALO_V1_ENGINEERING_BACKLOG.md`, `docs/HALO_V1_RELEASE_DECISIONS.md`, `docs/ENG_01_SECURITY_IDENTITY_REVIEW.md`, `docs/HALO_IMPLEMENTATION_PLAN.md`, `docs/ROADMAP.md`, `docs/HALO_V1_RELEASE_GAPS.md`, `docs/HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md`, `docs/HALO_PHASE_BETA_READINESS.md`, `docs/LOCAL_SPEECH.md`, `docs/LOCAL_SPEECH_BENCHMARK.md`, `docs/LOCAL_TELUGU_STT_HUMAN_REVIEW.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `docs/INSTALLATION.md`, `docs/PIPECAT_INTEGRATION.md`, `docs/VOICE_ARCHITECTURE.md`, `docs/VOICE_STATE_MACHINE.md`, `docs/WORKFLOWS.md`, `docs/SCHEDULING.md`, `docs/RUNTIME.md`, `docs/KNOWN_LIMITATIONS.md` and related release/phase reports.

### Source and configuration inspected

`package.json`, `.env.example`, `vercel.json`, `.github/workflows/ci.yml`, `services/pipecat-worker/requirements.txt`; `src/app/api/**`, `src/proxy.ts`, `src/lib/startup-check.ts`; `packages/tenancy/**`, `packages/agents/**`, `packages/runtime/**`, `packages/voice/**`, `packages/ports/**`, `packages/providers/**`, `packages/scheduling/**`, `packages/workflows/**`, `packages/campaigns/**`, `packages/crm/**`, `packages/platform/**`; `services/voice-gateway/**`, `services/pipecat-worker/**`; `supabase/migrations/**`, `scripts/preflight.ts`, `scripts/check-migrations.mjs`, `scripts/check-rls.mjs`, `scripts/check-architecture.mjs`, `scripts/check-neutral.mjs`; representative unit/integration/contract/security tests and their paths cited above.

### Commands/checks actually performed in this discovery

- Repository baseline: `pwd`, `git status --short --branch`, `git status --porcelain=v2 --untracked-files=all`, `git branch --show-current`, `git rev-parse HEAD`, upstream query, diff stats, `git log -1`, file listing and `AGENTS.md` search.
- Documentation/source reads with `sed`, `cat`, `rg --files`, `rg -n`, `find` and a Git history search for ENG/Beta subjects.
- **Not performed:** tests, lint, typecheck, build, preflight, migration/RLS scripts, external network/provider calls, database queries, deployment or infrastructure access.

## 14. Unknowns and limitations

- Whether staging infrastructure exists outside this repository, and who owns it.
- Actual staging platform, project/region, database identity, URL, revision, Auth settings, grants/RLS, secrets, callbacks, scheduler and monitoring configuration.
- Whether a separate deployment pipeline/protected environment is managed outside checked-in GitHub Actions.
- Which real integrations are in Beta scope and whether sandbox accounts/permissions exist.
- Current HEAD test results; prior documented checks apply to an earlier dirty candidate.
- Actual staging history/data and migration baseline. Local disposable results cannot answer these.
- Provider-specific terms, account usage/cost, callback reachability, and production behavior.
- Canonical status of the ten-row release checklist and ENG-04/ENG-12 owner decision.
- Actual Telugu human acceptance, authorized Arunodaya workflows, and pilot support/incident capacity.

These unknowns are reported as unknown rather than inferred from hostnames, environment variable names, provider adapters, or prior local test success.
