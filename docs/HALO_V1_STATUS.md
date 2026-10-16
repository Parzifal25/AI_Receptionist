# HALO v1 status register

**Audit date:** 2026-10-09
**Phase Alpha checkpoint:** 2026-10-12
**Purpose:** authoritative repository-backed entry point for HALO v1. Specialist documents remain detailed subject records.
**Evidence boundary:** repository files, existing reports, and the current dirty candidate were inspected. Fresh full and focused tests, lint, type checking, production build, migration validation, and the disposable real-role RLS harness were run on 2026-10-12. No provider request, target-environment query, deployment check, inference, or live call was performed. The working tree had pre-existing changes and is treated as user-owned.

> **Consolidation note (2026-10-15).** This register remains the authority for the **current status of the ten release criteria** ([DECISIONS.md R2](DECISIONS.md#r-series--release-owner-decisions)). No criterion, status or evidence row was changed. Since this date:
>
> - **Architecture** lives in [HALO_Architecture.md](HALO_Architecture.md).
> - **Decisions** live in [DECISIONS.md](DECISIONS.md). The release decisions are now R1–R10.
> - **Gaps** live in [HALO_V1_GAP_ANALYSIS.md](HALO_V1_GAP_ANALYSIS.md).
> - **The plan of record** is [HALO_V1_IMPLEMENTATION_PLAN.md](HALO_V1_IMPLEMENTATION_PLAN.md). It supersedes §H below and the archived implementation plan and engineering backlog as plans; their IDs are mapped in its §9.
> - **Source correction:** the statements below that the "voice booking tool/action [is] not bound on the pilot path" (§B and §E, Google Calendar rows) are stale. `services/voice-gateway/index.ts` wires `visitBookingForCall` (`src/core/services/voice/visit-booking.ts`) into the sales-call assembly. That adapter uses the real `BookingService`. This is `source` evidence only: no real calendar booking exists. See [HALO_Architecture.md §7.4](HALO_Architecture.md#74-calendar-booking-rescheduling-and-cancellation).

Detailed references: [current-state audit](archive/CURRENT_STATE_AUDIT.md), [implementation plan](archive/HALO_IMPLEMENTATION_PLAN.md), [release-gap audit](HALO_V1_RELEASE_GAPS.md), [release-decision proposal](HALO_V1_RELEASE_DECISIONS.md), [engineering baseline and dependency-ordered backlog](archive/HALO_V1_ENGINEERING_BACKLOG.md), [implementation verification](HALO_IMPLEMENTATION_VERIFICATION.md), [local speech guide](LOCAL_SPEECH.md), [speech benchmark](LOCAL_SPEECH_BENCHMARK.md), and [Telugu human-review worksheet](LOCAL_TELUGU_STT_HUMAN_REVIEW.md).

Phase Alpha checkpoint: branch `main`, HEAD `c5fd940662fc497960e6c152614fa92cf0fa97ab`, initially 49 commits ahead of `halo/main`; the initial candidate already had 49 modified/untracked paths, all preserved. Remediation added the exact-receptionist legacy backfill, a database identity guard, and regressions without rewriting any existing database. On this final dirty candidate, 128 JavaScript test files passed (1,257 passed, 5 skipped), plus ESLint, typecheck, production build, config preflight, architecture check, and 54 worker tests (1 skipped). All 31 migrations and schema assertions passed on a disposable database, including two-receptionist and unmapped-legacy fixtures and idempotent backfill replay; the disposable real-role RLS/privilege harness passed 109 assertions; final `git diff --check` passed. No target environment, provider, deployment, inference, or live call was exercised. Local Phase Alpha is **COMPLETE** under the [preflight boundary](HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md). Staging, pilot, and production evidence remains deferred to Beta, Charlie, and final release. The former “ENG-04 Phase 2” database audit label is locally separated as proposed ENG-12; ENG-04 remains the voice/speech pilot item. ENG-12 is not owner-approved naming.

**Phase Beta checkpoint:** 2026-10-12. **PARTIAL — local preparation complete; staging verification BLOCKED.** No staging target, owner, target-bound authorization, or staging credentials were positively identified. No staging/production DB, provider, deployment, or live call was accessed. The [Beta readiness record](HALO_PHASE_BETA_READINESS.md) contains the matrix, safe verification sequence, and explicit remaining inputs. The ten criterion rows below remain unchanged; their Alpha evidence is scoped to local/disposable checks and does not close Beta/Charlie/final evidence. ENG-04/ENG-12 canonical ownership remains **PENDING OWNER APPROVAL**; descriptive workstream names are used pending a decision.

## A. Executive summary

HALO targets a reusable multi-tenant agent runtime and control plane, with the Arunodhaya Solar Systems Telugu-first lead qualification and appointment pilot as its first flagship use. The repository contains substantially more than the 2026-09-02 current-state audit describes: HALO runtime, tenant and immutable agent versioning, a voice gateway and Pipecat worker, tool/workflow paths, campaign controls, analytics, and local speech adapters are present. This register supersedes that audit only for present-day status; its history and detailed findings remain useful.

Confirmed strengths include tenant-scoped agent resolution, bounded tool execution, deterministic qualification/booking/lead lifecycle logic, migrations for agent versioning/voice/campaigns/learning, and provider-neutral voice/calendar/messaging/workflow contracts. docs/HALO_IMPLEMENTATION_VERIFICATION.md (verified October 1) records prior local test/build/security results. Those are implementation and test evidence, not production activation.

HALO is **not demonstrated production-ready or pilot-ready**. No repository evidence was found for a deployed HALO release, real carrier call, live calendar booking, provider-backed pilot integration, customer-approved Arunodhaya facts/policies, or customer/native-speaker sign-off. Voice and local-speech claims include synthetic/fake-backed evidence or small benchmark corpora. Local Telugu speech has material errors and unresolved licensing review. No overall completion percentage is assigned.

Highest-priority later-stage gates (not Alpha blockers): verify the pinned candidate in staging, obtain approved dated facts/contact/disclosure policy, configure an authorized provider route, record provider-backed scenarios, and close recovery/monitoring and owner-acceptance gates. The ten-item checklist below preserves the release-owner-directed register and the original source caveat: its wording was first found as an audit mapping, not as a historical canonical checklist.

### Status definitions

- **Verified:** a dated artifact/test report supports behavior at its stated verification level; this does not mean production/pilot verified.
- **Implemented but unverified:** source exists but no supporting test or operational result was found.
- **Partial:** some behavior is implemented/tested; a material capability or acceptance condition is absent.
- **Missing:** no implementation/evidence found.
- **Blocked:** closure needs an external decision, access, data or evidence currently absent.
- **Not applicable:** outside v1 scope; owner must confirm.

Verification levels: **source**, **automated test (reported)**, **mock**, **simulated**, **real provider**, **pilot**. Test definitions are not test results; fake-backed tests do not prove real-provider operation.

## B. Detailed capability status

| Workstream | Capability | Status | Evidence | Verification level | Known limitations | Remaining work | Dependencies | Acceptance criteria | Priority |
|---|---|---|---|---|---|---|---|---|---|
| Tenant/security | Membership, roles, tenant isolation | Verified (local); deployed: not verified | packages/tenancy/auth.ts; packages/tenancy/supabase/*; migrations 0001–0002, 0034 (D22, PENDING); scripts/check-rls.mjs Phase 2 section; tests/integration/tenant-isolation-{postgrest,routes}.test.ts, multi-tenant-isolation.test.ts, phase4-security.test.ts; [TENANT_ISOLATION_EVIDENCE.md](TENANT_ISOLATION_EVIDENCE.md) | Source; local test; disposable DB (649 real-role assertions, real PostgREST), 2026-10-15 | Public/service-role paths bypass RLS and depend on scoped queries; deployed Supabase Auth not tested per report | Reconfirm current boundary tests and deployed auth/RLS config | Release environment; DB/security owner | Cross-tenant attempts fail across public/dashboard/runtime/worker; deployed auth/grants recorded | P0 — data isolation |
| Tenant/security | Widget/session identity and authorization | Partial | src/app/api/v1/widget/*; src/core/services/widget-repository.ts; tests/integration/widget-messages-security.test.ts | Source; tests reported | Service-role public API; no production abuse/load evidence | Verify expiry, replay, tenant mismatch, limits and deployment settings | Deployed config; security review | Caller cannot select another tenant/agent; cases pass against deployed-like DB | P0 — public attack surface |
| Agent lifecycle | Config, publication, immutable versions and rollback | Verified | packages/agents/*; migrations 0013–0018, 0030; tests/unit/agent-config.test.ts, agent-resolver.test.ts, agent-versioning.test.ts; tests/integration/agent-linkage.test.ts | Source; prior tests reported | Rollback via immutable version selection; no production drill found | Capture deployed publish/rollback drill and verify channel binding | Tenant security; deployment | New sessions bind selected version; active call identity does not mutate; prior version restored | P1 — change control |
| Runtime/tools | Context, state, bounded turn loop, response validation, permissions | Verified | packages/runtime/{agent-runtime,context-builder,conversation-state,prompt-composer,response-validator,token-budget}.ts; runtime/tools/*; tests/integration/runtime-orchestration.test.ts, runtime-golden-transcripts.test.ts; tests/unit/runtime/tool-boundary.test.ts, response-validator.test.ts; docs/RUNTIME.md | Source; prior mock/golden tests reported | Golden corpus is not customer acceptance; context budget is not billing guarantee; production tool binding unproved | Run release CI and pilot corpus; review each tool scope/confirmation/failure | LLM; approved corpus/tool inventory | Bounded runtime passes scenarios; strict schemas, tenant-bound executors; false success rejected | P0 — business action safety |
| Voice | Gateway lifecycle, state, media and persistence | Partial | packages/voice/{gateway,call-state,call-store,media-session,voice-session}.ts; stores/supabase-call-store.ts; migration 0020; tests/integration/voice-gateway.test.ts, voice-runtime.test.ts | Source; simulated/mock tests reported | No live calls; real audio, callback integrity and recovery unverified | Authorized inbound/outbound acceptance and interruption/failure review | Carrier, deployment, speech, consent | Provider IDs, tenant/version, transcript/outcome and failure states reconcile | P0 — pilot path |
| Voice | Pipecat control/media bridge and worker | Partial | services/pipecat-worker/{worker.py,halo_client.py,halo_codec.py,halo_serializer.py,media_gate.py}; services/voice-gateway/*; packages/voice/pipecat/*; tests/integration/pipecat-gateway.test.ts; worker tests | Source; synthetic/mock tests reported | Fake media/services do not prove deployed worker | Deploy matching gateway/worker; test signed control, media, interruption, disconnect/recovery | Worker deployment, trusted URL/signing, carrier/speech | Deployed worker handles authorized session and failure cases | P0 — phone pilot |
| Speech | Sarvam STT/TTS | Implemented but unverified live | packages/providers/voice-vendors/{sarvam-stt-provider,sarvam-tts-provider,factory}.ts; tests/contracts/sarvam.contract.test.ts; tests/unit/voice/speech-vendor-config.test.ts; scripts/voice-provider-smoke.ts | Source; contract/mock tests | No live response/quality evidence found; credentials/voice absent from evidence | Controlled smoke and reviewed corpus | Credentials, consented audio, target line | Record config/provider responses and reviewed audio against agreed thresholds | P0 — pilot voice |
| Speech | Local STT/TTS and fallback | Partial | Pre-existing untracked packages/providers/voice-vendors/local-*; services/pipecat-worker/local_speech.py, speech_fallback.py; tests/unit/voice/*, tests/contracts/local.contract.test.ts, worker test_local_speech.py; docs/LOCAL_SPEECH*.md | Source; fake tests; prior local inference/browser reports, not rerun here | Omnilingual Telugu 8 kHz reports 67% WER/20% CER on 11 clips; no confidence; no human TTS audition; GPL eSpeak review; no phone/concurrency validation | Telugu audition; decide fallback scope; license review; target-host/load check | Speech owner; hardware; licensing | Human-reviewed corpus/TTS meets thresholds, with latency/load/license decision, or exclude | P0 if selected; otherwise P1 |
| Speech | Interruption, fallback and handoff | Partial | packages/voice/gateway.ts; providers/voice-vendors/fallback-*; worker speech_fallback.py; tests/unit/voice/fallback.test.ts; docs/VOICE_STATE_MACHINE.md | Source; fake/simulated tests | No real interruption, transfer or outage test | Test barge-in, recoverable/nonrecoverable failures and staffed escalation | Carrier/speech; handoff target | Interruption stops audio; fallback follows replay rules; only confirmed transfer is narrated | P0 — caller safety |
| Chat | Widget, sessions and shared runtime | Partial | src/app/api/v1/widget/*; widget/src; public/widget.js; src/core/services/chat-service.ts; tests/integration/chat-service.test.ts | Source; tests reported; simulated | No production/pilot evidence for current shared route | Verify deployed widget, CORS/domain, session persistence and runtime | Published agent; LLM; deployment | Approved response persists authorized conversation without cross-tenant access | P1 — pilot channel |
| Knowledge/config | Approved facts, retrieval, attribution | Partial | packages/knowledge/*; packages/providers/knowledge/supabase-knowledge-provider.ts; src/content/tenants/arunodhaya/*; migrations 0005, 0017, 0033 (D14 governance); tests/unit/retrieval-query.test.ts; tests/integration/knowledge-governance-db.test.ts; docs/ARUNODHAYA_AGENT.md | Source; fixture tests; disposable DB (approval, revisions, governed retrieval) | Customer facts/policies not confirmed approved; live corpus/multilingual quality unverified | Obtain dated facts, sources, owner/expiry; configure and review | Arunodhaya owner; language reviewer | Answers trace to approved facts or escalate; no invented claims | P0 — business risk |
| Workflows | Definitions, triggers, retries, idempotency, logs | Partial | packages/workflows/{engine,action-registry,supabase-workflow-store}.ts; migrations 0009, 0011; tests/integration/workflow-engine.test.ts; docs/WORKFLOWS.md | Source; fake/in-memory tests | No external delivery proof; production cron/secrets and pilot workflows unverified | Define pilot workflow; run authenticated cron and real destination | Outcome schema; integration; cron | Replay causes one effect; failures visible/retried; dead-letter recovery documented | P1 — follow-up |
| Integrations | Twilio inbound/outbound | Implemented but unverified live | packages/ports/{telephony-provider,outbound-dialer}.ts; packages/providers/telephony/twilio-*; packages/campaigns/dispatch.ts; tests/contracts/twilio-media-stream.contract.test.ts; tests/integration/voice-gateway.test.ts | Source; fake fetch/contract tests | No live call, authorized number, callback/media quality or cost evidence | Controlled account/number; validate signed callbacks and authorized call | Carrier; approved disclosure/contacts; deployment | Call has provider IDs, correct tenant/version, outcome and cost record | P0 — carrier prerequisite |
| Integrations | Google Calendar | Implemented but unverified live | packages/ports/calendar-provider.ts; packages/providers/calendar/{google-calendar-provider,factory,token-source}.ts; OAuth routes; tests/integration/booking-service.test.ts, booking-conversation.test.ts; tests/unit/oauth-state.test.ts | Source; fake/in-memory tests | No Google API booking/pilot account; gap report says voice booking tool not bound on pilot path | Confirm owner/rules; connect sandbox; wire booking action | OAuth; visit policy; runtime binding | Free/busy + one event + provider ID + reconciliation; failure/race never claims booked | P0 if booking in v1 |
| Integrations | WhatsApp/email/webhook | Partial | packages/providers/messaging/*; packages/workflows/action-registry.ts; packages/platform/ssrf.ts; tests/integration/whatsapp-delivery.test.ts, email-delivery.test.ts, outbound-webhook.test.ts | Source; fake fetch/in-memory | No live destination acknowledgement or customer CRM contract; consent/template unknown | Select destination/fields/credentials/consent; prove idempotency/retry | Sales owner; destination | Durable receiving ID; replay deduplicates; failures recorded minimally | P1 — pilot outcome |
| Integrations | Credentials, retries and idempotency | Partial | packages/platform/{crypto,oauth-state,retry,ssrf}.ts; OAuth token sources; workflow engine/store | Source; unit/mock tests | Deployed token refresh and external idempotency unproved | Review exposure, rotation, refresh, retry class and side effects | Selected integrations; security owner | No credentials in client/logs; retries safe or reconciled; rotation tested | P1 — side-effect safety |
| Administration | Dashboard configuration, operations and analytics | Partial | src/app/dashboard/*; src/features/*; packages/analytics/*; src/app/api/analytics/* | Source; local tests reported | HALO control-plane workflows/usability not established by pages alone; no operator sign-off | Map operator tasks; verify roles/audit in deployment | Tenant onboarding; agent; operator | Authorized operator configures approved agent/facts and inspects calls/outcomes/failures/version | P1 — pilot ops |
| CRM/campaigns | Qualification, lead outcomes, DNC, consent and dispatch | Partial | packages/crm/*; packages/campaigns/*; migrations 0024, 0025, 0028, 0029; tests/unit/lead-lifecycle.test.ts, campaign-engine.test.ts; tests/integration/campaign-api.test.ts | Source; mock tests reported | No production campaign/contact evidence; carrier/cron absent per gap report | Confirm contact provenance/consent/DNC; test suppression safely | Business policy; carrier; cron | DNC prevents attempts; consent/attempts auditable; outbound off absent authorization | P0 — safety |
| Operations/cost | Logs, call events, usage, latency, cost | Partial | packages/platform/logger.ts; packages/voice/stores/supabase-call-store.ts; migrations 0023, 0026; packages/runtime/token-budget.ts; packages/analytics/*; scripts/voice-latency-harness.ts; docs/VOICE_LATENCY_MODEL.md | Source; historical local reports; simulated | Usage may be estimated; no cumulative currency budget, invoice, deployed load/alerts evidence | Set targets; capture usage/cost; configure/test alerts and attribution | Provider metrics/pricing; ops owner | Per-call stages/outcome/usage reconcile; limits/alerts pass agreed load; no sensitive telemetry | P1 — cost control |
| Security/privacy | RLS, service-role boundary, validation, retention, rate/abuse | Partial | docs/SECURITY.md; packages/platform/{ssrf,crypto}.ts; migrations 0001–0031; retention route; security tests | Source; Oct 1 results reported, not rerun | In-memory limiter per instance; deployed Auth/RLS not tested; recording/transcript policy needs confirmation | Revalidate current RLS/deployment, retention/disclosure and abuse thresholds | Environment/data owner; security review | Deployed tests pass; deletion/rate limits/privacy approvals demonstrated | P0 — data |
| Deployment/recovery | Deploy, migrations, backup/restore, incident, rollback | Partial | .github/workflows/ci.yml; scripts/check-migrations.mjs, check-rls.mjs; docs/DEPLOYMENT.md, OPERATIONS.md, TROUBLESHOOTING.md; supabase/migrations/* | Source; local checks reported; no production run | No deployment/migration ledger, restore/incident/rollback drill evidence | Assign owners; deploy isolated pilot; prove restore and rollback | Cloud/secrets; release owner | Revision/migrations recorded; restore/rollback meets RTO/RPO; alert/escalation tested | P0 — activation |
| Testing/acceptance | Unit, integration, golden, worker, security, E2E, pilot | Partial | tests/unit, integration, contracts, golden; worker `test_*.py`; release/evidence records | Final 2026-10-12 check: 128 JS files / 1,257 passed / 5 skipped; worker 54 / 1 skipped; focused identity 3 files / 30 passed | Fakes are not provider tests; golden fixtures are not pilot acceptance; no customer record | Retain dated Alpha evidence; Beta/Charlie reviewers record staging/pilot scenarios separately | Candidate revision and authorized owners/setup | CI/local gates pass; later-phase scenarios have artifact/date/reviewer/result/defect disposition | Phase dependent |
| Speech evidence/licensing | Reproducibility, audio, human review, licenses | Partial | docs/LOCAL_SPEECH.md, LOCAL_SPEECH_BENCHMARK.md, LOCAL_TELUGU_STT_HUMAN_REVIEW.md; models/local-speech-benchmark/* | Prior benchmark/inference reports; not rerun | FLEURS audio absent and review fields blank; TTS files exist but no audition; GPL eSpeak review remains | Telugu listening review; preserve inputs; record provenance/licenses | Reviewer; license owner; target resources | Inputs/config/results and human decisions retained; distribution decision written | P0 if selected; otherwise P1 |
| Commercial readiness | Onboarding, support, service targets and ownership | Missing / blocked | docs/DEPLOYMENT.md, OPERATIONS.md, HALO_V1_RELEASE_GAPS.md; no sign-off found | Documentation only | No named owners or customer sign-off found | Assign business, technical, privacy, deployment and incident owners | Customer/release owner | Named escalation; repeatable onboarding; written pilot scope/sign-off | P0 — governance |

## C. Ten-criterion release checklist reconciliation

Source: docs/HALO_V1_RELEASE_GAPS.md (2026-10-09), which says these are an audit mapping, not a located canonical historical list. Later release decision records retain all ten criteria. The Alpha applicability column separates local acceptance from staging and pilot/final-release evidence without changing the ten criteria or claiming the mapping is a newly approved canonical checklist. Status terms retain this document's conventions: **Verified / COMPLETE** means only that the named local Alpha slice has reproducible evidence; **Partial** means an Alpha slice remains; **Blocked** requires a specific prerequisite for an Alpha obligation; **Deferred to Beta/Charlie/Final** means that phase owns the evidence. A locally complete slice never closes the same criterion's later-phase acceptance.

| # | Criterion from gap mapping | Source | Reported status | Alpha evidence/status | Beta current status and evidence | Remaining blocker / Charlie and final-release dependencies |
|---|---|---|---|---|---|
| 1 | Shared agent/runtime and bounded business tools work across channels | Gap row 1; implementation verification §A | Reported verified locally | **Alpha COMPLETE:** deterministic orchestration/tool and mock-backed channel tests pass | **BLOCKED:** no staging target/revision to verify channel wiring; local evidence [Beta record](HALO_PHASE_BETA_READINESS.md) | Release/deployment owner supplies staging target; Charlie/final needs approved pilot behavior and pinned candidate evidence |
| 2 | Tenant and published-agent identity are enforced | Row 2; verification §§B–C, G; `docs/ENG_01_SECURITY_IDENTITY_REVIEW.md` | Current rerun: focused 3 files/30 tests; full suite 128 files/1,257 passed/5 skipped; 31-migration disposable replay; disposable real-role RLS; lint/typecheck/build/architecture pass | **Alpha COMPLETE:** source review, widget/tenant regressions, exact-receptionist backfill, DB guard, nullable-history behavior and local RLS pass | **BLOCKED:** deployed Auth/RLS/grants, migration ledger and target linkage census unverified; disposable results are not staging evidence | Security/data and database owner supply authorized target; Charlie/final needs owner disposition and separately authorized production audit |
| 3 | Qualification, CRM outcomes, consent, DNC and campaign controls are deterministic | Row 3; verification §§B–C, K | Full suite current rerun passed; deterministic/mock regressions | **Alpha COMPLETE:** business rules, consent/DNC guards, idempotency and failure transitions tested locally | **BLOCKED:** staging dispatch-disabled and scheduler configuration not inspected | Release owner identifies target; Charlie/final needs approved policies and separately authorized dispatch/reconciliation |
| 4 | Voice control/media handle lifecycle and failures | Row 4; verification §H | Full JS suite passed; worker full suite could not run in this environment (Pipecat dependencies absent); mocks/synthetic only | **Alpha COMPLETE** within prior supported worker environment report and current JS rerun; no speech-quality claim | **BLOCKED:** no deployed gateway/worker or provider sandbox verification; current worker run blocked by missing `pipecat`/`websockets` | Platform/provider owner supplies staging service and credentials; Charlie needs authorized PSTN/Sarvam, Telugu, interruption and handoff acceptance |
| 5 | Controlled evaluation and learning cannot alter a live agent without review | Row 5; verification §L | Full suite and disposable migration/RLS checks pass | **Alpha COMPLETE** for local immutability/review gates | **BLOCKED:** staging audit trail and publish/rollback evidence unavailable | Release/deployment owner supplies staging; Charlie/final needs approved corpus/reviewer and attributable acceptance |
| 6 | Usage and context budgets are bounded and attributable | Row 6; verification §§I–J | Full suite current rerun passed; local limits and attribution only | **Alpha COMPLETE** for implemented local budgets/attribution | **BLOCKED:** staging telemetry and actual provider usage are unverified | Ops/provider owner supplies telemetry and usage receipts; Charlie/final reconciles provider charges and approved limits |
| 7 | Production campaign dispatch and scheduling have required operating configuration | Row 7; verification §K | Local safeguards and mock retry/idempotency pass | **Alpha COMPLETE** for local disabled-by-default safeguards and modeled workflow behavior | **BLOCKED:** no deployed cron/secret/sandbox configuration checked | Platform owner supplies scheduler config; Charlie requires separately authorized booking/dispatch and reconciliation |
| 8 | Release/operations evidence supports safe activation | Row 8; verification §§M–P | Current lint/typecheck/build/architecture pass; CI preflight pass with DB explicitly skipped; disposable DB checks pass | **Alpha COMPLETE** for pre-deployment local checks and runbook review | **BLOCKED:** no staging deploy, backup/restore, rollback, alert, or incident drill | Release/ops/database owners supply environment and recovery evidence; final needs production readiness and go/no-go |
| 9 | Two useful integrations supported, one exercised end-to-end in pilot | Row 9 | Full mock-backed adapter suite passed; no real provider request | **Alpha COMPLETE** for local contracts and safe mock failure/retry paths | **BLOCKED:** provider sandbox selection, credentials, callback URLs and authorization absent | Integration owner selects destination/provider; Charlie needs authorized provider-backed pilot transaction and support-scope disposition |
| 10 | Arunodhaya pilot scenarios pass documented criteria | Row 10 | Scripted local golden tests passed within full suite; not customer acceptance | **Alpha COMPLETE** for local scripted regression only | **BLOCKED:** no staging scenario run or approved test-data/acceptance owner | Pilot/business and Telugu reviewers must be identified; Charlie requires controlled authorization, reviewed outcomes, defect disposition and dated acceptance |

Beta status for criteria 1–10: **BLOCKED at staging boundary** pending target identity, authorization, deployed revision, required provider access, and evidence owners as documented in [HALO_PHASE_BETA_READINESS.md](HALO_PHASE_BETA_READINESS.md). This does not retroactively change Alpha results. Charlie and final-release dependencies remain open as stated in each row.

## D. Architecture and dependency map

### Implemented architecture (source-backed)

    Web visitor/operator
      widget/chat API -> Next.js app/API -> tenant + agent resolution -> shared runtime
      browser/phone voice -> voice gateway -> call/session state + media
                                      -> in-process path or signed bridge -> Pipecat worker -> STT/TTS
    Shared runtime -> context + approved knowledge + bounded tools
                    -> qualification / CRM / scheduling / workflows / integrations / LLM ports
    Persistence: Supabase Postgres/Auth/Storage; migrations, RLS and service-role repositories
    Operations: cron/API routes, structured logs, usage/latency events, CI, migration/security scripts
    Adapters: Twilio, Google/Outlook/CalDAV, WhatsApp/Resend, LLM/STT/TTS, workflow webhooks

Evidence: src/app/api/v1/widget/*; src/core/services/*; packages/runtime/*; packages/agents/*; packages/voice/*; services/voice-gateway/*; services/pipecat-worker/*; packages/workflows/*; packages/providers/*; supabase/migrations/*.

### Intended architecture (plan, not completion evidence)

docs/archive/HALO_IMPLEMENTATION_PLAN.md describes target customer-ready phone runtime, reviewed Arunodhaya agent, pilot integrations, control plane and production hardening. The plan is not implementation evidence. Current code and docs/HALO_IMPLEMENTATION_VERIFICATION.md show substantial phases landed, while deployment, real-provider, pilot and operations gates remain open.

Dependency order: approved facts/policies and identity -> published agent/runtime/tool grants -> persistence and tenant security -> provider credentials and gateway/worker deployment -> real calls/integration outcomes -> observability/recovery -> pilot review/sign-off -> commercial operations.

## E. Integration inventory

Credential names only; values are excluded. Confirm deployed names against .env.example and deployment configuration.

| Integration | Port/adapter | Status and mock evidence | Real-provider evidence | Credential names | Limitations | Next validation |
|---|---|---|---|---|---|---|
| Twilio voice/outbound | packages/ports/telephony-provider.ts, outbound-dialer.ts; packages/providers/telephony/twilio-* | Implemented; contract/gateway fake tests | None found | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, number/stream settings | No authorized call or signed callback round-trip | Controlled inbound/outbound test; record signatures/provider IDs |
| Google Calendar | packages/ports/calendar-provider.ts; packages/providers/calendar/google-calendar-provider.ts, token-source.ts; OAuth routes | Implemented; fake/in-memory booking tests; OAuth state test | None found | GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, tenant OAuth grant | No pilot calendar; voice booking action not bound per gap doc | Connect sandbox; prove availability/create/reconcile/race |
| Outlook/CalDAV/internal calendar | packages/providers/calendar/* | Adapters/factory implemented; no provider proof | None found | Microsoft OAuth and CalDAV names in .env.example | No customer validation | Validate if chosen; otherwise confirm out of scope |
| Sarvam STT/TTS | packages/providers/voice-vendors/sarvam-* | Implemented; contract/mock tests | No live request found | SARVAM_API_KEY or SARVAM_API; provider settings | No live quality, outage or cost result | Controlled smoke and reviewed call corpus |
| Local sherpa/Piper | packages/providers/voice-vendors/local-*; worker local_speech.py | Implemented in pre-existing untracked files; fixture tests; benchmark artifacts | Local inference reported, no caller/provider API | VOICE_LOCAL_MODEL_DIR, VOICE_LOCAL_THREADS | Telugu quality, no TTS review, host/load and GPL eSpeak review | Human audition and license decision; keep off pilot until accepted |
| WhatsApp Cloud API | Messaging port; packages/providers/messaging/whatsapp-messaging-provider.ts | Implemented; network stub test | None found | Provider token, phone-number ID, business account settings | No approved template/consent or receipt | If selected, send approved test and retain message ID |
| Resend email/notifications | packages/providers/messaging/resend-*; notification adapters | Implemented; fake/test evidence | None found | RESEND_API_KEY and sender settings | No delivered-message record | Verify sandbox delivery/retry if in scope |
| Workflow webhook | packages/workflows/action-registry.ts; packages/platform/ssrf.ts | Implemented; fake fetch and SSRF tests | None found | Tenant webhook secret/config | No Arunodhaya destination/idempotency contract | Sandbox receiver: auth, SSRF, acknowledgement, duplicate/retry |
| LLM providers | packages/ports/llm-provider.ts; packages/providers/llm/* | Multiple adapters; dated diagnostics/evaluation artifacts at mixed levels | No verified live HALO pilot call found | LLM_PROVIDER, LLM_API_KEY, provider config | Dated quality/availability is not production reliability | Pin route/model; factuality, latency and failure checks |

No adapter is represented as live without vendor-backed evidence. The gap report recommends Twilio and Google Calendar conditional on owner confirmation and access.

## F. Pilot readiness — Arunodhaya

No business details are invented. docs/ARUNODHAYA_AGENT.md, docs/ARUNODHAYA_NEGOTIATION_POLICY.md, docs/ARUNODHAYA_LEARNING_LOOP.md and src/content/tenants/arunodhaya/* contain proposed config, fixtures and policy structures. The release-gap report says verified commercial facts are absent and no real call has been placed.

| Needed input/evidence | Current status | Owner |
|---|---|---|
| Dated approved product, installation, service-area, pricing, subsidy, warranty, finance and eligibility facts with sources/expiry | Missing/blocked; proposed copy is not verified fact | Arunodhaya business/product owner; name unknown |
| Telugu/Tenglish language, pronunciation, greeting, AI/recording disclosure and consent wording | Approval not evidenced | Arunodhaya + native reviewer + privacy owner |
| Calling hours, contact provenance/consent, DNC, retry/callback policy | Approval and consented test list absent | Arunodhaya operations/privacy owner |
| Qualification fields, read-backs, escalation triggers, authorized promises/concessions | Structures exist; customer approval absent | Sales owner; name unknown |
| Human handoff destination, staffed hours, wording and fallback | No real recipient/transfer acceptance evidence | Arunodhaya operations owner |
| Visit rules, geography, travel buffer, staff calendar and booking authority | Unconfirmed; no pilot calendar proof | Scheduling owner |
| Carrier number, speech selection, endpoint/callback configuration | No live-call evidence; authorized line/credentials absent in reviewed evidence | HALO deployment/provider owner; name unknown |
| CRM/follow-up destination, field mapping, channel consent, duplicate policy | Destination unknown | Sales/CRM owner |
| Scenarios, call volume, thresholds, reviewer, issue severity and sign-off | Golden fixtures exist; pilot acceptance absent | Joint release/pilot owner |

Required scenarios: Telugu/Tenglish qualification; commercial questions and deferral; wrong number/DNC/consent/callback; objection/handoff; calendar availability and booking if in scope; interruption/provider failure; structured follow-up; duplicate/retry/reconciliation. Close with dated call/provider IDs, policy-permitted transcript/audio review, persisted outcomes, failure records, reviewer role, pass/fail and customer sign-off. No pilot owner names were found.

## G. Risk register

Priority labels below describe release/pilot risk. A P0 label is not an Alpha blocker when the local Alpha acceptance slice has passed and the remaining item is explicitly assigned to Beta, Charlie, or final release.

| Priority / risk | Evidence | Impact | Mitigation | Closure criteria |
|---|---|---|---|---|
| P0 Cross-tenant leakage | Service-role paths; packages/tenancy/* and scoped stores; tests/integration/multi-tenant-isolation.test.ts | Another tenant's calls, knowledge or leads exposed/mutated | Run current boundary suite and review service-role queries and worker identity | Adversarial tests pass deployed-like/deployed; access review signed |
| P0 Incorrect action/commercial claim | Runtime guards exist; approved facts absent per gap report | False booking, promise or financial representation | Approved facts; least-privilege tools; act-then-narrate validation and escalation | Fact pack/tool tests/reviewed high-risk scenarios; no false success |
| P0 Booking duplication/false booking | Scheduling service/exclusion migration; no Google live proof | Duplicate visit or false confirmation | Idempotency/reconciliation; real calendar race test; confirm only after provider success | Exactly one HALO/calendar booking under retry/race; failure never claims booked |
| P0 Provider/carrier failure | Provider ports/fallback and simulated tests; no live call | Dropped call, repeated action or false handoff | Controlled outage/interruption tests; staffed fallback; no replay after side effect | Real call records and accepted recovery runbook |
| P0 Voice quality/Telugu | Local benchmark poor Telugu metrics; no human TTS review; Sarvam live absent | Misheard names/numbers/cancellations; unsafe answer | Human-reviewed route; read back sensitive fields; native review; disable unsafe fallback | Agreed quality thresholds pass on target audio and reviewer approves |
| P0 Missing pilot evidence/approvals | Release criteria 9–10 open; no call, approved facts or sign-off | Mocks mistaken for customer readiness | Evidence matrix and named owners; freeze scope/criteria | In-scope scenarios have real dated evidence and customer sign-off |
| P0 Security/privacy/contact consent | SECURITY doc; production Auth/RLS not tested per report; consent list absent | Data exposure or unauthorized contact/recording/retention | Security review; approved disclosure/DNC/retention; scoped access | Deployed tests, deletion proof, privacy/customer approvals |
| P1 Same-tenant receptionist/agent identity mismatch | Reproduced in the legacy backfill with two receptionist identities; fixed by exact `receptionist_id` mapping, migration guard and runtime fail-closed validation (SEC-06) | Wrong receptionist profile/context could serve a conversation | New database guard; exact-mapping migration test; route regression; later aggregate target audit | Local regression passes; any historical target rows get evidence-based owner disposition, never guessed repair |
| P1 Integration side effects/retries | Adapters/fake tests; no vendor receipts | Duplicate booking/message or lost outcome | Per-provider retry/idempotency, durable receipt and reconciliation | Sandbox proves one effect under retry and visible failure |
| P1 Licensing/provenance | Speech doc flags eSpeak GPL-3.0 | Distribution obligations or release block | Inventory runtime/model/voice/phonemizer/conversion; legal review | Written distribution decision and obligations |
| P1 Costs/capacity | Token/latency instrumentation; no currency budget/load/live cost | Spend, latency, memory or overload | Per-tenant/call budgets; target-host load; alerts | Agreed volume/cost/latency pass; alert/kill switch tested |
| P1 Backup/rollback/incident ownership | Runbooks exist; no restore/deployment drill | Outage or unrecoverable change | Assign owners; restore/rollback/incident exercise | Drills recorded to agreed RTO/RPO; escalation tested |

## H. Dependency-ordered backlog

> **Superseded as the plan of record on 2026-10-15** by [HALO_V1_IMPLEMENTATION_PLAN.md](HALO_V1_IMPLEMENTATION_PLAN.md). The RB, BP, CL and PV IDs below are mapped in its §9. This section is kept as the 2026-10-09 record.

Priority labels describe work needed for safe pilot/release evidence, not changes made by this documentation task.

### Release blockers

| ID | Scope | Dependencies | Acceptance criteria | Closure evidence |
|---|---|---|---|---|
| RB-01 | Ratify canonical ten criteria, pilot scope and thresholds | Release owner | Approved checklist linked; each row has owner, environment and pass condition | Owner approval and versioned checklist |
| RB-02 | Approve Arunodhaya facts, disclosures, contact/DNC and escalation policy | Named customer business/privacy/sales owners | Dated sourced facts/policy; unknown answers defer; contact policy approved | Approval record, source refs, config review |
| RB-03 | Close current release security/deployment gates | RB-01; deployment/security owners; isolated environment | Current CI/security/migration/RLS checks pass; revision and migration set recorded | CI result, migration ledger, security review |
| RB-04 | Provision and exercise speech/carrier route with authorized calls | RB-02, RB-03; provider owner | Signed callbacks, media, transcript, interruption, outcome and cost captured | Redacted evidence index, provider IDs, reviewer |
| RB-05 | Select/prove pilot integrations (Twilio + calendar or approved alternative) | RB-01, RB-02, RB-04; destination owners | Two useful integrations selected; one verified end-to-end outcome; retries do not duplicate | Real receipt, correlated run/call IDs, reconciliation |
| RB-06 | Run acceptance matrix and obtain customer sign-off | RB-02–RB-05; native reviewer/customer owner | In-scope safety scenarios pass; defects rerun; no unresolved critical issue | Dated matrix, call evidence, customer sign-off |

### Required before pilot

| ID | Scope | Dependencies | Acceptance criteria | Closure evidence |
|---|---|---|---|---|
| BP-01 | Bind approved published agent, facts and least-privilege tools | RB-02; agent lifecycle | Every channel uses pinned version; no unapproved action path | Version tests and reviewed config |
| BP-02 | Connect appointment/outcome destination if in scope | RB-02; calendar/CRM owner; RB-05 | Outcome persists once; failure never claims success | Provider IDs and row reconciliation |
| BP-03 | Confirm handoff, support hours and staffed recipient | RB-02; recipient | Transfer result truthful; unavailable transfer uses approved alternative | Transfer/fallback record and owner acceptance |
| BP-04 | Approve language quality, read-back and audio retention | RB-02, RB-04; native reviewer | Telugu/Tenglish and sensitive fields reviewed on target audio; retention/deletion checked | Reviewer decisions and privacy sign-off |

### Required before commercial launch

| ID | Scope | Dependencies | Acceptance criteria | Closure evidence |
|---|---|---|---|---|
| CL-01 | Production security/resilience, cross-tenant, rate, abuse, restore and incident drills | RB-03; security/ops owners | Threat scenarios and restore/incident objectives pass | Security/exercise reports |
| CL-02 | Capacity, latency, quality and cost at target concurrency | RB-04; agreed traffic/provider pricing | Sustained load meets latency/error/memory/spend thresholds | Load report, cost reconciliation, alert test |
| CL-03 | Onboarding, support, service ownership and rollback | RB-06; business owner | Named support/escalation; repeatable onboarding/change/rollback | Signed runbooks/checklist |
| CL-04 | Real-provider regression and credential rotation | RB-05; integration owners | Rotation, expiration, retry and duplicate cases pass without secret leakage | Sandbox evidence/security sign-off |

### Post-v1 improvements

| ID | Scope | Dependencies | Acceptance criteria | Closure evidence |
|---|---|---|---|---|
| PV-01 | Improve local Telugu speech and assess alternatives | Human review/license decision; target hardware | Candidate meets corpus, latency, memory and language requirements | Reproducible benchmark and reviewer report |
| PV-02 | Distributed rate limits and broader cost controls | Commercial usage and hosting topology | Scale-out limits and spend controls tested | Load and billing/limit test |
| PV-03 | Expand multilingual evaluation and approved knowledge maintenance | Customer corpus/consent and reviewers | Versioned evaluations catch regressions/expired facts | Evaluation report and update workflow |
| PV-04 | Broaden integrations only where customer evidence requires | Customer demand and adapter owner | Contract tests, credential lifecycle and live sandbox validation | Adapter evidence and runbook |

## I. Source-of-truth and discrepancy register

> **Updated authority, 2026-10-15:** the architecture, decision, gap and plan roles described in this table moved to the canonical documents named at the top of this register. The archived [implementation plan](archive/HALO_IMPLEMENTATION_PLAN.md) is no longer the plan authority. The document-by-document map is in [HALO_Architecture.md §15](HALO_Architecture.md#15-document-map), and archived files are listed in [archive/README.md](archive/README.md). The rows below are kept as the 2026-10-09 record.

| Document | Role and authority | Relevant claim/discrepancy | Reconciliation |
|---|---|---|---|
| docs/archive/CURRENT_STATE_AUDIT.md (2026-09-02) | Historical architecture/current state for snapshot | Says no server speech/telephony or HALO runtime/tool calling; older paths | Retained as history. Current source and Oct 1 verification report supersede old status, not history. |
| docs/archive/HALO_IMPLEMENTATION_PLAN.md (2026-09-04) | Intended plan, dependencies and acceptance specs | Header says nothing is implemented, contradicted by source and verification report | Remains plan authority, not status. Header is historical; this register gives current status. |
| docs/HALO_V1_RELEASE_GAPS.md (2026-10-09) | Ten-item audit mapping and pilot matrix | Explicitly says mapping is not canonical; rows cite prior/mock evidence | Remains detailed pilot/integration analysis. Canonical checklist unknown pending owner. |
| docs/HALO_IMPLEMENTATION_VERIFICATION.md (2026-10-01) | Dated implementation/test evidence and limitations | Reports local checks but no production activation/real calls | Authoritative for checks it says ran on that date, not current uncommitted revision or production. |
| docs/LOCAL_SPEECH.md | Setup, wiring, limits, benchmark and audition runbook | Recommendation qualified by later benchmark reviews | Remains specialist reference; later benchmark sections supersede earlier recommendation where stated. |
| docs/LOCAL_SPEECH_BENCHMARK.md | Methods, raw results and dated candidate reviews | Phase B not complete; B.3 rejects automatic Telugu Whisper fallback | Remains benchmark authority, not production acceptance. |
| docs/LOCAL_TELUGU_STT_HUMAN_REVIEW.md | Review worksheet and transcript outputs | Review fields blank; FLEURS audio absent | Remains worksheet; review incomplete; synthetic clips are not human speech. |
| docs/ARUNODHAYA_AGENT.md, ARUNODHAYA_NEGOTIATION_POLICY.md, ARUNODHAYA_LEARNING_LOOP.md | Agent proposal, policy structure, learning design | Proposed config/fixtures do not prove customer-approved facts | Remain specialist detail; confirm approval with customer owner. |
| docs/ARCHITECTURE.md, VOICE_ARCHITECTURE.md, RUNTIME.md, VOICE_STATE_MACHINE.md, PIPECAT_INTEGRATION.md | Architecture/runtime/voice references | Mix intended/implemented details; may predate uncommitted worker changes | Remain subject references; use source and this register for status. |
| docs/SECURITY.md, DEPLOYMENT.md, OPERATIONS.md, TESTING.md, KNOWN_LIMITATIONS.md | Security/operations procedures and limitations | Procedures do not prove deployment, restore, integration or test execution | Remain procedure authorities; completion needs environment evidence. |
| README.md, ROADMAP.md, PHASE*_REPORT.md and sprint reports | Overview, roadmap and historical reports | README receptionist-first; reports include dated scripted results | README links here; reports remain historical, not release sign-off. |

## J. Evidence limitations

- This checkpoint ran local tests, lint, typecheck, build, migration replay, and a disposable real-role RLS harness as described above. It ran no inference, provider request, target-environment database check, deployment, or live call.
- The pre-existing tree was dirty, including runtime/config/package modifications and untracked speech code/tests/docs/scripts/model data. These are user-owned. This register describes this checkout; it does not imply uncommitted work is approved or a clean release revision.
- No real Twilio, Google Calendar, WhatsApp, CRM/webhook or live Sarvam pilot evidence was found. Adapters and fake-backed tests do not establish vendor operation.
- No evidence of deployed HALO, production migration, production Auth/RLS validation, backup restore, incident exercise, load test, real campaign or customer sign-off was found in inspected reports.
- No real Arunodhaya call, authorized number, approved facts/policies, consented pilot list, named operators or acceptance thresholds were found in release-gap/verification evidence. No names or facts are inferred.
- Golden pass rates are fixture evidence, not native Telugu review, real speech, calendar behavior or customer acceptance.
- Speech sets are small and mix synthetic/human-read subsets. docs/LOCAL_TELUGU_STT_HUMAN_REVIEW.md says FLEURS audio is absent and reviewer fields blank. TTS waveforms exist, but no human audition is recorded. No live microphone/phone, concurrency, other-host or production latency result is established here.
- Credential names came from repository examples only; no values or customer data are included.
- “No evidence found” describes repository inspection, not proof that external activity does not exist.

## Validation and update rule

Checks represented here: the original ten-row mapping is retained; local checks and their proof boundaries are dated; target-only evidence remains blocked/unverified; whitespace and diff checks passed. Update this register when evidence changes, preserving dated reports and source-of-truth boundaries.

## 2026-10-13 POA implementation checkpoint

Candidate: `main` at `ddeda1b2a60107e7cfece7a15d22edc510f87e47` plus uncommitted
POA changes. Starting tree had only user-owned untracked POA and Beta discovery
report; both preserved (POA appended, discovery unchanged). No commit or push.

The local implementation/check gate for this restricted pass **PASSED**: 130
application files, 1,273 passed / 0 failed / 5 existing real-model skips; focused
identity/widget/tenant tests 30/30; worker 54 run, 53 passed / 1 existing real-model
skip; lint/typecheck/architecture/neutrality, production build and configuration-only
preflight passed. Fresh disposable DB: 31 migrations/schema/identity/backfill checks
and 109 real-role assertions passed. Initial sandbox and concurrency failures,
exact commands, regression evidence and limitations are recorded in [POA](../POA).

Implemented: P0 disposable database targeting guard/CI alignment; P1 privacy-safe
log-only messaging; P1 workflow timeout cancellation and dead-letter quarantine
without automatic replay; P2 restricted release/incident/cost procedures. No
historical migration was rewritten. No real provider or hosted database was used.

The ten criterion rows above and historical Alpha/Beta records remain unchanged.
This new evidence proves local behavior only. Beta staging is still **BLOCKED**;
Charlie and final production gates remain open. Current approved external traffic
is zero. Even the proposed web-chat scope needs verified $0 hosting/Auth/DB/LLM,
authorized target/owner, recovery and operational evidence. Outbound stays false,
messaging log-only; voice, calendar, workflows/webhooks and real messaging are
excluded. **Production NO-GO.** ENG-04/ENG-12 is still pending owner decision.

## 2026-10-13 integration implementation checkpoint

[Real integration verification](HALO_REAL_INTEGRATION_VERIFICATION.md) records
current configuration/authentication versus contract/E2E states. Real local
PostgREST/Postgres chat persistence and tenant controls passed; configured cloud
credentials/models passed read-only metadata checks. Real cloud inference and
Supabase Auth login remain BLOCKED; no complete customer E2E or pilot acceptance.
Final local suite: 131 files, 1,287 passed/5 skipped, worker 53 passed/1 skipped,
31 disposable migrations, 109 RLS assertions, 15 disposable chat assertions,
static checks and build passed. Added regression-backed fixes for cloud wire
validation/cleanup, request cancellation and overall fallback deadlines.

This updates local evidence only. Section C's ten criteria remain intact; Beta
staging, Charlie pilot and final production approval remain open. No deployment,
hosted migration, paid provider operation, commit or push. Production **NO-GO**.


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

### Current-candidate verification refresh — 2026-10-13

Current candidate `cb6b75496755364cd288adb62b3492830b841288` passed the full local
JavaScript suite (139 files; 1,333 passed, 5 existing skips), lint, typecheck,
architecture/neutral checks, production build, configuration preflight, 31
disposable migration checks, and 109 real-role disposable RLS assertions. The
connected Supabase project is active, but hosted Auth lifecycle, provider
inference, alert delivery, hosted restore and artifact rollback remain unverified.
Section C's ten criteria and the Alpha/Beta/Charlie boundaries are unchanged;
this is not a release approval. See [the execution report](HALO_THREE_GATE_EXECUTION.md#current-candidate-refresh--2026-10-13)
for statuses, command results, and exact external owner actions.

### Full local verification addendum — 2026-10-13

Fresh verification also passed the synthetic local PostgREST journey before and
after restore (15 assertions each), a disposable 44-table restore with six
identity/tenant assertions, and the worker suite (54 run, 53 passed, one
skipped). One bounded OpenRouter free-model inference attempt failed without a
completion or usage. No real Auth lifecycle, alert delivery, hosted restore or
artifact rollback was performed. The three external gates remain
**BLOCKED**; the ten-criterion register and project phase boundaries are
unchanged. Exact evidence is in the
[execution report](HALO_THREE_GATE_EXECUTION.md#verification-addendum--2026-10-13-full-task-run).

Local Gate 3 follow-up: alert evaluator and in-memory delivery/discovery tests
pass; system status now fails visibly on missing counts/query errors and includes
observation freshness. No scheduler, persistent alert store or external
destination is connected. Hosted alert delivery and application artifact
rollback remain blocked; local restore evidence does not establish hosted
recovery. Ten release criteria and Alpha/Beta/Charlie boundaries remain intact.

## D10 repository baseline — 2026-10-15

Executed under the owner's D10 instruction ([DECISIONS.md D10](DECISIONS.md#d10--dirty-tree-commit-grouping-and-the-uncommitted-0001-edit)). The ten criterion rows above are unchanged. This is **local** evidence only: no deployment, push, hosted query, migration execution, credential change or paid call occurred.

**Candidate.** Branch `d10/baseline-candidate`, based on `cb6b75496755364cd288adb62b3492830b841288`. It has not been pushed.

| Commit | Content |
|---|---|
| `8ea9fb2053f316a25efb9a8c125e2d89d510c93f` | 118 previously uncommitted code, test and script paths, exactly as found, excluding the `0001` edit |
| `0dee257057cc43c04de9eddd795aeead096915bb` | 27 documentation and evidence paths as they stood before consolidation, reconstructed from SHA-256-verified copies |
| `ce5816e4cd0e2bb72143f9e819b2a9d451df5ebf` | Documentation consolidation |
| D10 record commit | This section and the D10/D21 entries in DECISIONS.md. Its SHA is reported with the candidate, because a commit cannot contain its own hash. |

**Migration integrity.**

- `supabase/migrations/0001_init.sql` was restored to its committed blob `a96bb646`.
- The local HALO database ledger (read-only query) shows `0001` applied in its original form, so the uncommitted `search_path` edit could not be kept.
- An additive migration cannot carry that edit's intent. The edit is preserved outside the repository and quoted in D10, and the open hosted question is [D21](DECISIONS.md#d21--running-migration-0001-on-hosted-supabase).
- All 31 migration files are contiguous (`0001`–`0031`), uniquely numbered and correctly named.
- The local ledger lists `0001`–`0030`, so `0031` is not applied locally. This was recorded and not acted on.

**Preservation.** A recovery record was written before any change to `~/halo-backups/d10-preflight-20261014T194816Z/`. It holds:

- the full working-tree patch;
- a tarball of all 183 changed or untracked files;
- a SHA-256 manifest.

Of the 183 recorded files, 182 are byte-identical in the candidate; the only difference is the intentional `0001` restore. The 12 paths deleted at the start (archived documents) are present under `docs/archive/`. The archive index's 14 original hashes match the pre-consolidation commit, and the blueprint is byte-identical.

**Checks on the candidate tree** (`ce5816e4`, before this record was added):

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test -- --maxWorkers=2` | 156 files; 1,602 passed, 5 skipped |
| `npm run check:architecture` | exit 0 |
| `npm run check:neutral` | exit 0 |
| `npm run preflight:ci` (synthetic CI values) | exit 0; warns that `CRON_SECRET` is missing and the database check was skipped |
| Worker `unittest` | 70 run, 1 skipped, OK |
| `npx tsx scripts/check-local-tts-text-parity.ts --lines 2000 --seed 20261015` | 0 mismatches, 0 crashes |
| `git diff --cached --check` per commit | Clean, except three intentional Markdown hard breaks in the byte-identical blueprint |
| Link check | 560 relative links; only the documented intentional exceptions |

**Not run:**

- `npm run build`, because it fetches Google Fonts over the network.
- `check:migrations` and `check:rls`, because they execute migrations, which this task does not permit.
- Any hosted, staging or provider check.

## D7 tool-execution audit — 2026-10-15

Implemented under the owner's D7 instruction ([DECISIONS.md D7](DECISIONS.md#d7--new-migrations-tool-executions-and-audit-logs)). Branch `d7/tool-execution-audit`, based on the D10 candidate `a1f2fd52ad6e5f5acd7c25aa047c7bc3802d9700`. It has not been pushed or merged. The ten criterion rows above are unchanged.

**Superseded on 2026-10-15:** the database verification below this section was completed; see [D7 and D14 database verification](#d7-and-d14-database-verification--2026-10-15). The original record follows unchanged.

**Status: LOCALLY IMPLEMENTED — INTEGRATION UNVERIFIED.** The runtime behaviour is verified by local tests. The migration was **not applied to any database**, so the database rules (RLS, triggers, constraints) are verified only by static checks. The real-role assertions added to `scripts/check-rls.mjs` have not been executed.

| Area | Evidence |
|---|---|
| Migration `0032_tool_executions.sql` | **Static only.** Filenames are contiguous (`0001`–`0032`); columns are allowlisted, with no payload-capable types; RLS read-only for members; no client write grant; revoked `SECURITY DEFINER` ownership and lifecycle triggers; partial unique index; cascades; the rejection-reason list equals the runtime's `ToolRejectionReason` type (`tests/unit/tool-executions-migration.test.ts`). `0001`–`0031` are unchanged. |
| Runtime audit at the tool boundary | `local test`: 19 cases in `tests/integration/tool-execution-audit.test.ts`. They cover success; executor failure and thrown errors without rewriting the original result; error-code sanitizing; denials, unknown tools, invalid arguments and budget rejections; tenant taken from trusted state, not arguments; tenant-separated records; no arguments, results or contact data stored; a missing correlation ID; duplicate intents (one execution); the fail-closed and best-effort failure policies; no retry after a failed finalize; cancellation writing nothing; and no self-auditing. |
| Postgres store | `local test` with a fake client (`tests/unit/tool-execution-audit-store.test.ts`): allowlisted columns, tenant-scoped finalize of `started` rows only, and failures thrown to the runtime. |
| Regression | `npm test -- --maxWorkers=2`: 159 files, 1,632 passed, 5 skipped. Typecheck, lint, `check:architecture`, `check:neutral`, `preflight:ci` and the worker suite (70 run, 1 skipped) all pass. `npm run perf:baseline` still executes its tool-round scenario. |
| Not run | `check:migrations` and `check:rls`, because they execute migrations, which this task does not permit. They need a fresh disposable `halo_check_<suffix>` database. `npm run build` was not run, because it fetches Google Fonts over the network. No hosted, staging or provider check. |

**Incident during implementation (local, no effect).** Before the test harnesses received in-memory audit stores, one intermediate local test run let `ChatService` fall back to the Postgres store. That store attempted writes to the test environment's configured URL `http://127.0.0.1:54321`, with the fake key `test-service-role-key`. Port 54321 is in the 5432x range that belongs to another project. Nothing was listening on any 5432x port (`ss -ltn`), so every attempt failed with connection refused and no data was reached.

The harnesses now inject in-memory stores. A structural check confirms that every test construction of `ChatService` passes one, and that no test imports the gateway composition root. The route test that builds `ChatService` with production defaults mocks the admin client.

**Remaining:**

- Apply `0032` only on a fresh disposable database for `check:migrations` and `check:rls`.
- Any staging or hosted application needs R8 and D19 (and D21 for `0001`).
- `audit_logs` stays PENDING (D7).
- Whether deterministic system actions become audited tools is part of D5.
- There is no operator UI; operators read the table through RLS.

## D7 and D14 database verification — 2026-10-15

Under the owner's instruction "HALO Autonomous Engineering Loop — Complete D7 + D14" ([DECISIONS.md D7](DECISIONS.md#d7--new-migrations-tool-executions-and-audit-logs), [D14](DECISIONS.md#d14--layer-1-activation-and-approved-knowledge)). Branch `halo/d7-d14-completion`, created from `d7/tool-execution-audit` at `0770c7239b12660f84da57e588ee60da928f1525` (verified clean and unchanged before work began). Commits: `93c0145f` (D7 database verification), `2765db0b` (D14 implementation), then this documentation commit. Not pushed or merged. The ten criterion rows above are unchanged.

**Status.** D7 `tool_executions`: **DONE locally** — implemented, and its database rules verified as real roles on a disposable database. D14: **DONE locally** — implemented and verified at the database, provider, action and runtime boundaries; its design defaults await owner ratification. Neither migration has been applied to any shared, developer or hosted database; that is not claimed.

**Test environment (`disposable DB`).** A new container `halo-check-d7d14-20261015`, started from the cached `pgvector/pgvector:pg16` image with `--pull=never` (PostgreSQL 16.14), bound to `127.0.0.1:55451` — not a Supabase CLI port, not 5432x. Fresh databases `halo_check_d7d14`, `halo_check_d7d14_m` and `halo_check_d7d14_final`, each confirmed empty of `auth`/`storage` before use, with `infrastructure/ci/supabase-stubs.sql`. The synthetic credential exists only inside that container. The local HALO Supabase database (55322) was never queried or migrated.

| Check | Result (final clean run on `halo_check_d7d14_final`) |
|---|---|
| `check:migrations` | Exit 0. `0001`–`0033` apply in order from a clean state; legacy identity and backfill fixtures pass; asserted columns exist, including the D14 tables; `0033`'s composite tenant FKs are validated on a clean database. |
| `check:rls` | Exit 0. 269 assertions, 0 failures, as `authenticated` (with and without a JWT subject), the real `anon` role, `service_role`, and the table owner where stated. D7 section: 32. D14 section: 128. |
| `knowledge-governance-db.test.ts` (opt-in) | 8 passed. `AgentRuntime` → `ProviderKnowledgeResolver` → `SupabaseKnowledgeProvider` → governed RPCs executed as `service_role`; editor and approver steps as `authenticated`. |
| `npm test` | Exit 0. 160 files; 1,659 passed, 13 skipped (5 pre-existing, plus the 8 opt-in database tests, which pass when pointed at the disposable database). |
| Typecheck, lint, `check:architecture`, `check:neutral` | Exit 0 each. |
| `preflight:ci` equivalent | Exit 0, run from a scratch directory with only placeholder variables (so `.env.local` was not loaded). Email/WhatsApp not configured; database check skipped. |
| Worker suite | Exit 0; 70 run, 1 skipped. |
| `git diff --check` | Clean. |

**D7 database evidence.** Ownership trigger (another tenant's conversation, agent or version, and a relabelled conversation, refused even for the service role); grants (no client write, `anon` none, no client privilege beyond SELECT, trigger functions not executable by clients, single SELECT policy); the exact column set; one execution per action and turn, with duplicate rejections still recorded; every runtime rejection reason accepted, unknown refused; lifecycle (insert as `started`/`rejected` only, one finalize, final rows immutable, no tenant move or tool rewrite on finalize, error codes identifier-shaped); retention purge cascade. Two harness defects were found and fixed; the migration needed no change ([D7](DECISIONS.md#d7--new-migrations-tool-executions-and-audit-logs)). The runtime failure policy (fail closed before a side-effecting tool; no re-run after a failed finalize) remains `local test` evidence.

**D14 evidence, by required property.**

| Property | Evidence |
|---|---|
| Tenant A cannot list, read, edit, approve, withdraw or delete tenant B's knowledge | `check:rls` as `authenticated`: RLS reads return 0; revise/approve/withdraw refused; delete affects 0 rows. |
| A caller-supplied tenant id cannot override trusted context | `check:rls`: naming a tenant the caller is not a member of is refused; actions take the tenant from `requireBusiness()` (`tests/unit/layer1-faq-lifecycle.test.ts` ignores a form `business_id`). |
| Unapproved content never reaches retrieval | `check:rls` (keyword and vector) and the runtime DB test (not in the model's system prompt; knowledge gap reported). |
| Only owner/admin approve or reject | `check:rls`: member, other tenant's owner and service role refused; app actions refuse members before the database. |
| Invalid transitions rejected | `check:rls` as the table owner: approved→draft, content change, approver change, pointer to a rejected revision, withdrawal without clearing the pointer (deferred check), chunks added after approval, approving withdrawn/rejected revisions. |
| History preserved; atomic switch; no old/new chunk mixing | `check:rls` and the runtime DB test: the superseded revision keeps its content, approver and chunks; after approval only the new revision is served on both paths. |
| Failed indexing never publishes | `check:rls`: a partial index is `failed`, cannot be submitted, shows `error`; provider unit tests: chunk-write failure, blank or empty chunk sets report `failed`. |
| Withdrawn and superseded content not served | `check:rls` and the runtime DB test (next turn). |
| Background jobs preserve tenant context | No background job reads or writes knowledge (searched). Indexing runs in the server action with the trusted tenant and is re-verified by the database (tenant, document and revision must agree; refused otherwise, as tested through the production provider). The backfill is a service-role operator function, one tenant per call. |
| Existing ingestion and retrieval behaviour | Full suite passes; approved content is served through the same resolver, budget and RRF fusion. |
| Legacy data deterministic, never implicitly approved | `check:rls` seeds legacy rows **before** `0033`: none served; census counts; mismatched rows leave the FKs NOT VALID while new mismatches are refused; backfill dry run writes nothing, apply quarantines and creates unapproved revisions only, and is idempotent. |
| Audit metadata without raw content in logs | Revision rows record actors and timestamps; actions and the provider log ids and bounded error text only. |
| RLS under realistic roles | All of the above run as real roles; RLS is enabled on both new tables. |
| Concurrent approvals and edits stay consistent | `check:rls` with parallel `psql` sessions: of two simultaneous approvals exactly one succeeds; a withdrawal and two edits serialize, with distinct revision numbers and one open revision; the pointer/approved invariant holds for every document. |

**Not run.** `npm run build`, because it fetches Google Fonts over the network (external contact). No hosted, staging, provider, PostgREST or Supabase Auth check. The Supabase store and dashboard actions were exercised with fakes (`local test`); the SQL they call was exercised directly.

**Remaining.**

- The owner ratifies or replaces the D14 defaults for items 1–6, especially no separation of duties, per-turn resolution instead of pinning, and FAQs being excluded from a nonempty collection scope.
- Applying `0032` and `0033` to any real database needs R8, D19 and D21. Before applying `0033`, run `knowledge_governance_census()` read-only on the target, and plan the legacy backfill, re-indexing and human approval: existing knowledge stops being served the moment `0033` lands.
- `audit_logs` stays PENDING (D7). Telugu text search (W2.5) and the language-configurable knowledge-gap gate (W2.1) are unchanged.
- Rollback: the migration is additive, but dropping its objects would discard approvals and revision history. Prefer a forward correction. An older application build still retrieves safely after `0033` (the old RPC names return governed content only), but it cannot edit knowledge, because members lost direct write access.

## Branch integration and Phase 2 tenant isolation — 2026-10-15

Under the owner's instruction "HALO — Branch Integration + Phase 2 Tenant-Isolation Hardening".

**Integration (`source`).**
- The D10 (`a1f2fd52`), D7 (`0770c723`) and D14 (`8fdaa12e`) work formed one linear chain on top of `main` (`cb6b7549`). No branch had diverged, and no commit needed merging twice.
- Before integration, the chain's tip passed every gate:
  - typecheck, lint, `npm test` (1,659 passed), `check:architecture`, `check:neutral`, `preflight:ci` and the worker suite;
  - `check:migrations` and `check:rls` (269 ok) on a fresh disposable database.
- `main` was then fast-forwarded to `8fdaa12e`, so every original SHA is preserved.
- Branches:
  - deleted: the local branches `d10/baseline-candidate`, `d7/tool-execution-audit` and `halo/d7-d14-completion`, all ancestors of `main`;
  - kept: `backup-before-secret-cleanup` (also an ancestor of `main`, but a deliberate backup);
  - remote branches were not touched, and nothing was pushed.
- A recovery bundle with a git bundle, patches, inventories and a SHA-256 manifest is in the operator's local folder `~/halo-backups/phase2-integration-20261015T031528Z/`.
- Work continues on `Phase-2-Security-Hardening`. Git rejects the requested name, which contains spaces.

**Workstream 1 status: PARTIALLY VERIFIED.** Every tenant-owned table and access path found has an explicit enforcement mechanism, and cross-tenant negative tests pass at every local boundary. No deployed environment was tested. Full evidence is in [TENANT_ISOLATION_EVIDENCE.md](TENANT_ISOLATION_EVIDENCE.md).

| Check | Result |
|---|---|
| `check:migrations` (fresh disposable DB, Supabase-faithful stubs) | Exit 0; `0001`–`0034` apply. |
| `check:rls` | Exit 0; 649 ok, 0 FAIL (269 existing plus 380 Phase 2). Before the fixes: 591 ok, 36 FAIL. |
| `tenant-isolation-postgrest.test.ts` plus `knowledge-governance-db.test.ts` (opt-in; disposable PostgREST v14.13) | 19 passed. |
| `npm test` | Exit 0; 1,689 passed, 24 skipped (the two opt-in DB suites above). |
| Typecheck, lint, `check:architecture`, `check:neutral`, `preflight:ci`, worker suite | Exit 0 each; worker suite 70 run, 1 skipped. |
| `npm run build` | Exit 0. It downloads the Geist font from Google's public CDN (`next/font/google`): external contact, recorded in the evidence. |

**Fixed (local).**
- Migration `0034` (D22, PENDING):
  - a same-tenant check on 19 references (16 tables; corrected 2026-10-15 from 18), including the agent-version squat and the appointment, lead and conversation relinks that clients could perform;
  - client TRUNCATE, REFERENCES, TRIGGER, MAINTAIN and sequence privileges revoked.
- Tenant-filtered history and lead queries in the web conversation store.
- Tenant-consistency guards in the workflow-retry and reminder jobs.
- Supabase-faithful CI stubs.

**Not done.**
- `0034` is not applied to any shared or hosted database.
- No staging or hosted verification.
- The findings in the evidence document's §8 are recorded, not fixed.

## Decision review — Phase 2 Workstream 2 — 2026-10-15

Under the owner's instruction "HALO Phase 2 — Workstream 2: Close Pending Decisions and Resolve Unknowns".

- **Starting point.** Branch `Phase-2-Security-Hardening` at `a4786683`, clean tree.
- **Recovery bundle.** In the operator's local folder `~/halo-backups/phase2-ws2-preflight-20261015T041922Z/`.
- **Unchanged.** The ten criterion rows, and every decision state.
- **Dispositions, gate matrix and owner actions:** [HALO_DECISION_REVIEW.md](HALO_DECISION_REVIEW.md).

**Status: review complete. Deployment NOT READY.** Every register entry has a disposition. First hosting remains blocked by owner approvals (R8, D19, D21, D22, and D14 if `0033` is included) and by environment evidence: the target's preflight, ledger and backup.

**New evidence (`disposable DB`).** All of it comes from fresh `--network none` containers of the cached `public.ecr.aws/supabase/postgres:17.6.1.155` image, removed after use.

- **D21.**
  - The committed `0001`–`0034` apply unedited as a plain `postgres` login, or with `search_path = public, extensions`.
  - `0001` fails without `extensions` on the path (line 151, `gen_random_bytes`).
  - It also fails when `vector` is already in `extensions` (line 273, `<=>`).
  - `npm run check:supabase-image-chain`: `ok A`, `ok P`, `ok C` (34 migrations, about 41 s).
- **Upgrade path.** `0032`–`0034` apply on top of `0001`–`0031` even with a planted cross-tenant calendar connection and knowledge collection. Both censuses report them.
- **Preflight.** `infrastructure/hosted/preflight-readonly.sql` (read-only transaction, rolled back) ran on fresh, pre-`0032` and full-chain databases. It found the planted mismatches. Client TRUNCATE/REFERENCES/TRIGGER grants were 72/144 before `0034` and 0/0 after.
- **Retention coverage (W2.2).** The purge reaches calls, conversations and their cascades, plus `usage_events`. CRM, appointment, campaign and workflow tables are not purged ([D23](DECISIONS.md#d23--retention-coverage-beyond-conversations-and-calls)).

**Fixed (documentation and configuration).**

- The `DEPLOYMENT.md` `psql -f` advice for hosted targets, which would leave the ledger without those versions.
- `0034` coverage counts: 19 columns on 16 tables, not 18.
- Six runtime variables missing from `.env.example`.
- A past disposable container password and an absolute home path in committed documents. Git history is unchanged.
- Stale migration counts and `piiRules` wording.
- The G2.2 traceability claim: an answer cannot be traced to a knowledge revision after the fact.

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test -- --maxWorkers=2` | exit 0; 163 files passed, 2 skipped; 1,689 tests passed, 24 skipped (the opt-in DB suites) |
| `npm run check:architecture` | exit 0 |
| `npm run check:neutral` | exit 0 |
| `preflight:ci` equivalent (scratch directory, CI placeholder values, `.env.local` not loaded) | exit 0; warnings: `CRON_SECRET` missing, DB check skipped |
| Worker `unittest` | exit 0; 70 run, 1 skipped |
| `npm run check:supabase-image-chain` | exit 0; A, P and C as expected |

**Not run.**

- `npm run build`: it fetches Google Fonts.
- `check:migrations` and `check:rls`: no migration changed, and the real-image runs above replace a chain replay for this review.
- The opt-in PostgREST suites.
- Any hosted, staging, shared-database or provider check.


## Phase 2 Workstream 3 — 2026-10-15

**COMPLETE — ROLLOUT PREPARED (local package). Deployment NOT READY / NOT AUTHORIZED.** [Evidence and exact checks](WORKSTREAM_3_REPORT.md), [dependency map](MIGRATION_DEPENDENCY_MAP.md), [target preflight](HOSTED_TARGET_PREFLIGHT.md), [knowledge inventory/backfill](KNOWLEDGE_ROLLOUT_RUNBOOK.md), [recovery](DATABASE_RECOVERY_RUNBOOK.md), [owner/readiness register](WS3_OWNER_ACTIONS.md). Final-closure authorization covers K1 implementation in additive 0035, preserving 0033. Disposable dry/apply boundary, atomicity, tenant, provenance, approval and recovery regressions pass. All nine scoped owner decision IDs and ten actual-target evidence groups remain outstanding; no decision states ratified and no hosted/shared SQL or deployment occurred.

## WS4 finalization — 2026-10-15

**Local implementation evidence:** D7 now has locally authorized additive `0036` authorization auditing alongside `0032` tool audit. D18 has signed service/worker and persisted job correlation; export stays disabled/opt-in stdout locally, with hosted selection still pending operations approval. Failure/retry, redaction, tenant isolation and ambiguous-action quarantine are covered by deterministic tests. See [WORKSTREAM_4_REPORT.md](WORKSTREAM_4_REPORT.md) for the final disposition, exact counts and accepted limits.

No hosted acceptance follows: target identity, real grants/Auth, backup/retention, provider idempotency, exporter/alerts and all WS3 T1–T10 evidence remain unverified. WS3's K1/recovery evidence stays local/disposable; `0035` and its recovery artifacts are unchanged. WS3 saved-ledger tests have one reviewed compatibility amendment so their 0001–0035 fixtures remain historical and current comparisons must account for 0036. No unrelated pending decision is ratified. New audit schema must precede matching code on a separately authorized target.

## Local release-readiness audit — 2026-10-15

Under the owner's "Autonomous Local Completion and Release-Readiness Audit" instruction. Branch `Phase-2-Security-Hardening`, HEAD `ad6a19d830633712b948ff5fc75972c2f61a17fa`, unchanged; nothing staged, committed, pushed or deployed. The ten criterion rows above are unchanged. **Disposition: PARTIALLY COMPLETE** — every locally completable, decision-free item that this run took on passes, but deferred local cards and owner/hosted gates remain. Full matrix, commands and results: [LOCAL_RELEASE_READINESS_REPORT.md](LOCAL_RELEASE_READINESS_REPORT.md); machine-readable status: [evidence/local-workstream-status.json](evidence/local-workstream-status.json).

- **Fixed (local test):** W1.2 stream-token replay takeover (gateway and Pipecat bridge); W2.1 Telugu knowledge-gap gate; W4.1 worker VAD and barge-in minimums; W4.6 voice cooldown wait; W7.1 router telemetry; W7.2 log-leak sweep and a Resend recipient/subject log leak; W2.3 `piiRules` documented as inert; W0.8 API reference.
- **Cross-workstream regressions fixed:** WS4's `0036` broke WS3's rollout rehearsal (67/70) and rollout-docs check. Both pass now (83/83 with a new post-0036 restore section; `disposable DB`). The hosted preflight collector now samples 0036.
- **Re-verified (`disposable DB`):** 0001–0036 chain, 669 real-role RLS assertions, 26 opt-in PostgREST/governance/K1 cases, WS4 audit 5 + HTTP 8, Supabase-image chain A/P/C.
- **Not done locally:** W4.3–W4.5, W4.7, W4.9 (deferred voice-latency cards), W4.8 (acceptance criteria need owner clarification), W4.2 (D17), W4.10 (D20), W0.2 (commit, not authorized here), W0.3 (Codex review), W1.3 (written write authorization).
- **Update 2026-10-16 (Phase 2 blocker loop; [PHASE2_COMPLETION_REVIEW.md](PHASE2_COMPLETION_REVIEW.md)):** W4.3–W4.5, W4.7 and W4.9 were completed locally by P2-LOOP. W4.2 is locally complete by owner decision (no built-in speech model; the pair stays D17). W4.8 is closed as deferred (D24). The calendar first-connect race is fixed locally with migration `0037` (D25, local and disposable use only). W0.2 commit remains unauthorized by the owner's 2026-10-16 decision, and W0.3 Codex review is still pending. No criterion row changes.
