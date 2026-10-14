# HALO v1 release gap audit

> **Consolidation note (2026-10-15).** This dated audit is retained as evidence, and `POA` cites it. Current gaps and acceptance criteria are in [HALO_V1_GAP_ANALYSIS.md](HALO_V1_GAP_ANALYSIS.md), and decisions in [DECISIONS.md](DECISIONS.md).
>
> **Source correction:** the statements below that no booking tool or action is bound on the Arunodhaya voice path are stale. The gateway wires a deterministic visit-booking step to the real `BookingService` ([HALO_Architecture.md §7.4](HALO_Architecture.md#74-calendar-booking-rescheduling-and-cancellation)). No real calendar booking exists. The ten-row mapping is unchanged.

> **Phase Beta update (2026-10-12):** no staging target or target-bound authorization was available; staging verification is **BLOCKED**, not passed. Local/disposable results remain distinct from staging and real-provider evidence. See [HALO Phase Beta readiness](HALO_PHASE_BETA_READINESS.md). ENG-04/ENG-12 naming remains **PENDING OWNER APPROVAL**; prior ENG-12 wording is a proposal only. Charlie pilot acceptance and final production gates remain open.

**Audit date:** 2026-10-09
**Scope:** the two unchecked v1 release criteria named in the audit request.
**Source caveat:** no canonical ten-row v1 release checklist was found in the tracked repository. The ten rows below are an audit mapping of the documented v1 scope, not a claim that a canonical checklist was located. Criteria 9 and 10 reproduce the two unchecked criteria in the request. Ratify this mapping against the release owner's checklist before treating it as authoritative.

## Release criteria evidence

| # | Release criterion (audit mapping) | Evidence in repository | Status |
|---|---|---|---|
| 1 | Shared agent/runtime and bounded business tools work across channels | `docs/HALO_IMPLEMENTATION_VERIFICATION.md` §A reports bounded orchestration, closed tool registry, qualification, scheduling, and immutable versions as verified. `tests/integration/runtime-orchestration.test.ts` and `tests/integration/runtime-golden-transcripts.test.ts` exercise runtime behavior with fakes. | **VERIFIED locally**; not a live customer deployment. |
| 2 | Tenant and published-agent identity are enforced | Verification report §§B–C, G reports database-backed tenant ownership, RLS, publication and call identity checks. `tests/integration/phase4-security.test.ts`; disposable-database RLS results are recorded in the same report. | **VERIFIED locally**; deployed Supabase Auth was not tested per report. |
| 3 | Qualification, CRM outcomes, consent, DNC and campaign controls are deterministic | Verification report §§B–C, K reports campaign selection, consent, calling windows, retries, suppression and atomic outcome updates. `tests/unit/campaign-engine.test.ts`, `tests/integration/campaign-api.test.ts`, `packages/crm/lead-lifecycle.ts`. | **VERIFIED / MOCK-VERIFIED** as recorded; no production campaign executed. |
| 4 | Voice control and media paths handle call lifecycle and failures | `tests/integration/voice-gateway.test.ts`, `tests/integration/pipecat-gateway.test.ts`; verification report §H documents synthetic media, fake providers, interruption and failure handling. | **MOCK-VERIFIED**; real PSTN and speech acceptance is **BLOCKED** by missing carrier account/authorized number and speech credentials. |
| 5 | Controlled evaluation and learning cannot alter a live agent without review | Verification report §L documents immutable proposals, corpus evaluation, tenant-admin review and unpublished draft creation. Generic fixture coverage is described in §G. | **VERIFIED / MOCK-VERIFIED** for implementation; tenant-approved live business corpora and rollout acceptance remain external. |
| 6 | Usage and context budgets are bounded and attributable | Verification report §I–J documents context estimates, usage capture when supplied, per-tenant/agent/version instrumentation and configured turn/input/output limits. | **VERIFIED** as implemented; estimated context is not a billing guarantee, and cumulative currency budgeting is not implemented. |
| 7 | Production campaign dispatch and scheduling have required operating configuration | Verification report §K: bounded cron dispatcher requires explicit outbound flag; production cron secret and carrier configuration are absent. | **PARTIAL / BLOCKED** for production execution. |
| 8 | Release and operations evidence supports safe production activation | `docs/HALO_IMPLEMENTATION_VERIFICATION.md` records local test/build/security gates and explicitly says production deployment/migration was not performed. It also lists recovery and live-quality limitations in §M–P. | **PARTIAL**; no production activation, operational load test, or live call evidence. |
| 9 | At least two useful integrations are supported, with one exercised end-to-end in the pilot | Supported adapters are present: Twilio telephony (`packages/providers/telephony/twilio-media-stream-provider.ts`), Google Calendar (`packages/providers/calendar/google-calendar-provider.ts`), WhatsApp (`packages/providers/messaging/whatsapp-messaging-provider.ts`), and generic workflow webhooks (`packages/workflows/action-registry.ts`). Tests cover adapters with fakes (`tests/contracts/twilio-media-stream.contract.test.ts`, `tests/integration/whatsapp-delivery.test.ts`) and booking/workflow behavior with in-memory fakes. No repository record shows a vendor-backed integration exercised in an Arunodhaya pilot. | **UNCHECKED / NOT VERIFIED** for end-to-end pilot use. Adapter code exists; operational support and pilot exercise are not evidenced. |
| 10 | Arunodhaya pilot scenarios pass with documented acceptance criteria | `docs/ARUNODHAYA_AGENT.md` §6 and `docs/PHASE4_REPORT.md` §§1, 7 report 50/50 scripted golden conversations. The same docs state no real call was placed, speech quality is blocked, no verified commercial facts were supplied, and no booking tool is bound on the tenant voice path. | **UNCHECKED / BLOCKED** for pilot acceptance. Scripted regressions pass; customer acceptance has not been demonstrated. |

## Integrations: what exists and what is missing

| Capability | Existing support and evidence | Gap for a pilot |
|---|---|---|
| Telephony: Twilio | `TelephonyProvider` is the provider-neutral port (`packages/ports/telephony-provider.ts`). Twilio implements webhook verification, media serialization and call control. Contract tests use a fake `fetch` (`tests/contracts/twilio-media-stream.contract.test.ts`); verification report §H says provider behavior was mock-verified. Outbound dispatch also has `OutboundDialer` and a Twilio adapter. | No carrier credentials or authorized number; no real inbound/outbound call, callback signature, media quality, or call interruption evidence. Production cron/carrier settings are missing. |
| Calendar: Google Calendar | `CalendarProvider` supports free/busy and event create/update/delete (`packages/ports/calendar-provider.ts`); factory and OAuth-token source support Google. Booking service consumes the port. | No reviewed record of a Google account connection or real API booking. The Arunodhaya voice guide says no booking tool is bound on its call path. Site-visit scheduling rules, staff calendars and travel buffers require pilot-owner confirmation. |
| Follow-up: WhatsApp | `MessagingProvider` supports WhatsApp; `WhatsappMessagingProvider` sends Cloud API text, and booking/lifecycle/workflow paths consume the generic port. `tests/integration/whatsapp-delivery.test.ts` stubs network responses. | No provider-backed message evidence, approved templates/consent policy, or recorded pilot workflow showing a qualified outcome delivered to the sales team. |
| Generic CRM/automation webhook | Workflow action `call_webhook` posts a tenant-configured JSON, Slack, or Discord payload with SSRF checks; workflow engine retries and records results. Unit/integration tests use fake fetch/executors. | No named Arunodhaya CRM endpoint, field mapping, authentication contract, sandbox test, or accepted delivery record. |

### Recommended first two integrations

1. **Twilio telephony** — required to exercise the phone-first qualification pilot and its call disposition, transcript and handoff outcomes. Existing provider port, adapter, signed-webhook contract, gateway and outbound-dialer path give the shortest route to a controlled pilot. It is not pilot-ready until credentials, authorized numbers, speech providers, callback configuration and a real call record exist.
2. **Google Calendar** — directly supports the documented site-visit/appointment goal and checks availability before committing a time. The shared calendar port and Google adapter already exist; connect a designated pilot calendar and prove one booking lifecycle. This also exercises a useful business outcome beyond merely placing a call.

WhatsApp is a reasonable next integration for follow-up delivery, and may replace Google Calendar if Arunodhaya confirms that WhatsApp delivery is a more important v1 outcome than site-visit scheduling. No source located establishes that priority or confirms the pilot's preferred calendar, messaging channel, or CRM, so those choices remain **UNKNOWN pending pilot-owner confirmation**. Do not count an adapter's presence or a fake-backed test as an integration exercised in the pilot.

## Pilot acceptance matrix

Status has two parts: **automated evidence** describes repository tests; **pilot result** describes customer-facing acceptance. A passing mock is not a pilot pass.

| Scenario | Preconditions | Expected result | Evidence required | Automated evidence | Pilot status |
|---|---|---|---|---|---|
| Telugu qualification happy path and code switching | Approved greeting/disclosure; tenant qualification fields and permitted language policy confirmed; representative native speaker; configured STT/TTS and authorized test number | Collect name, location, property/ownership, bill or units, timeline and callback details without scrambling answers; repeat back only where configured; store one structured outcome | Call ID, consent/disclosure result, transcript/audio review, persisted qualification/disposition, reviewer score and date | **PASS (mock):** golden corpus and `tests/integration/arunodhaya-golden.test.ts`, reported 50/50 | **BLOCKED:** no real call or native-speaker acceptance record |
| Commercial questions (price, subsidy, payback, product facts) | Arunodhaya supplies dated, named-source facts and approves commercial policy in Telugu | Answer only supported facts; defer unknowns to a person; no invented price, subsidy, warranty, financing or installation promise | Approved source pack and policy; reviewed transcript for each configured high-risk prompt | **PASS (mock guard):** `te-08`/`te-09` and negotiation cases; tenant docs state supplied facts are absent | **BLOCKED:** content approval absent; real-language behavior unscored |
| DNC, wrong number, callback and consent | Approved AI/recording disclosure, lawful consented contact list, suppression policy and callback window supplied | Stop immediately on DNC; mark terminal suppression; end wrong-number calls politely; record callback request without unauthorized retry | Test call IDs and terminal outcomes; suppression query; consent source and callback record | **PASS (mock):** corpus has DNC, wrong-number and callback scenarios; campaign/lifecycle tests cover guards | **BLOCKED:** no consented pilot list or real callback execution evidence |
| Objection, negotiation and human handoff | Reviewed concessions/claims and escalation thresholds; reachable staff contact and approved transfer wording | Do not offer unauthorized concessions; escalate unresolved/unsafe questions; claim live connection only after provider confirms transfer | Tool/action audit, call transcript, transfer callback and recipient confirmation | **PASS (mock):** golden objection/negotiation/handoff cases and validator tests | **BLOCKED:** no approved commercial values or real warm-transfer evidence |
| Site-visit availability and booking | Arunodhaya confirms visit rules, service area, staff/technician hours, travel buffer, designated calendar and booking authority; booking tool wired for the pilot path | Offer only available slots; book exactly one confirmed slot; persist appointment and calendar event; say booked only after success; recover safely from a slot race | HALO appointment row, provider calendar event ID, calendar free/busy before/after, transcript and user confirmation | **PARTIAL:** generic booking conversations and fake-backed scheduling tests exist; guide says voice booking tool is not bound | **BLOCKED:** pilot rules/integration execution absent |
| Vendor-backed telephony and speech with interruption | Twilio credentials, authorized number, STT/TTS credentials and deployed gateway/worker configured; approved test caller | Complete a call in Telugu/Tenglish; caller barge-in stops playback and transcript records only delivered speech; disconnect/failure creates terminal outcome without false success | Provider IDs/callbacks, call events, audio/transcript, stage latency, interruption record, failure-injection records | **PASS (mock only):** gateway/Pipecat synthetic-media and fake-service coverage | **BLOCKED:** verification report §H and Phase 4 report §8 say no real call has been placed |
| Follow-up / sales-team handoff of structured outcome | Sales team selects endpoint (CRM/webhook/WhatsApp), required fields, credentials and consent policy | One idempotent delivery includes lead identity, disposition, qualification, callback or booked-visit details; failures are visible and retry safely | Receiving system record/message ID, workflow run and step logs, correlation/event ID, duplicate-delivery check | **PARTIAL:** generic CRM/workflow/messaging tests use fakes; no Arunodhaya target contract | **UNKNOWN:** receiving system and preferred channel not identified in source |

## Prioritized work to close the gaps

| Priority | Task | Dependencies | Acceptance criteria |
|---|---|---|---|
| P0 | Confirm the authoritative ten-item checklist and pilot scope with release owner | Release owner; this audit mapping | Store/link the approved checklist and map each canonical criterion to evidence and owner; replace inferred rows above where needed. |
| P0 | Obtain Arunodhaya's verified facts, commercial policy, language/disclosure approval, calling windows, contact consent, service area, visit rules and escalation contacts | Arunodhaya business/sales owner | Dated approved source pack and configuration review; no placeholder marked supplied without source; recording, AI disclosure and DNC rules are approved before live calls. |
| P0 | Provision controlled Twilio and speech test configuration | Approved contact/disclosure policy; carrier account/authorized number; STT/TTS credentials; gateway/worker deployment; outbound flag and cron secret as applicable | Place and record one authorized test call end-to-end; verify signed callbacks, pinned tenant/version, transcript, disposition, interruption, terminal outcome and measured stage timings. Record IDs/date/config and reviewer. |
| P1 | Decide and connect the site-visit calendar; wire booking into the Arunodhaya call path if site visits are in v1 scope | Confirmed P0 visit rules, calendar owner/OAuth consent, staff availability; implementation owner | Against the pilot calendar, show real free/busy, create one confirmed event with returned event ID, handle unavailable/racing slot without false booking, and reconcile HALO appointment to calendar. Existing generic fake-backed booking tests do not meet this. |
| P1 | Define sales outcome delivery (CRM/webhook or WhatsApp) | Sales-team destination, field mapping, credentials, lawful channel/consent choice | Deliver a real pilot outcome once; show destination acknowledgement, workflow correlation/logs, idempotent replay and safe failure/retry. Keep sensitive fields to approved payload. |
| P1 | Execute and document the pilot acceptance matrix with native Telugu reviewers | P0 approvals; vendor-backed path; representative pilot scenarios and reviewers | Each in-scope scenario has dated pass/fail, call/event identifiers, reviewer and evidence links; all safety-critical scenarios pass; failures have tracked remediation and rerun evidence. |
| P2 | Close deployment/operations gates that apply to the pilot environment | Deployment owner, secrets, database and monitoring access | Record deployed version and applied migrations; verify outbound gate, cron/auth, alerting, recovery/reconciliation runbook and load/latency target for the agreed pilot volume. Mark production-only gates separately if pilot is isolated. |

## Files and evidence inspected

- Release/status: `docs/HALO_IMPLEMENTATION_VERIFICATION.md`, `docs/archive/HALO_IMPLEMENTATION_PLAN.md` (especially P12), `docs/PHASE4_REPORT.md`, `docs/archive/PHASE3_PHASE4_EXECUTION_PLAN.md`.
- Pilot: `docs/ARUNODHAYA_AGENT.md`, `docs/ARUNODHAYA_NEGOTIATION_POLICY.md`, `tests/golden/arunodhaya/{conversations,runner,types}.ts`, `tests/integration/arunodhaya-golden.test.ts`, `tests/unit/tenants/arunodhaya-config.test.ts`.
- Integration contracts/adapters: `packages/ports/{telephony-provider,outbound-dialer,calendar-provider,messaging-provider}.ts`, `packages/providers/telephony/`, `packages/providers/calendar/`, `packages/providers/messaging/`, `packages/workflows/action-registry.ts`.
- Integration/workflow/voice evidence: `tests/contracts/twilio-media-stream.contract.test.ts`, `tests/integration/{whatsapp-delivery,booking-service,booking-conversation,workflow-engine,voice-gateway,pipecat-gateway}.test.ts`, `tests/unit/workflow-actions.test.ts`.
- Worktree was inspected with `git status --short`; numerous pre-existing modifications and untracked speech-related files were present and left untouched.

## Remaining blockers and validation

The earlier “ENG-04 Phase 2” label for the database migration/linkage audit is a naming collision with the backlog's ENG-04 voice/speech work item. No owner-approved resolution was found. Local recommendation: use proposed ENG-12 for the database audit (ENG-11 is occupied), retaining ENG-04 for voice/speech. Target-specific audit evidence is deferred to the applicable staging/final-release gate. The ten-row register above is unchanged; phase applicability is recorded in the [status register](HALO_V1_STATUS.md) and [preflight record](HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md).

- **Unknown:** the canonical ten-row release checklist, the pilot owner's integration priority, destination CRM/messaging system, chosen calendar, pilot volume and specific acceptance thresholds were not located.
- **Blocked:** authorized carrier setup and real calls; speech vendor credentials and native-speaker quality; supplied/approved business facts and policy; production cron/carrier configuration; real provider-backed calendar or follow-up delivery.
- **Validation:** the current dirty candidate passed the 2026-10-12 full application and worker suites, lint, typecheck, production build, config preflight, disposable migration replay, real-role RLS harness, and `git diff --check`. These checks do not establish external provider or pilot acceptance.
- **Preservation:** no existing runtime behavior or user changes were discarded. No production data, provider, deployment, or live call was touched.

### Current candidate gate recheck — 2026-10-13

Fresh local checks passed on `cb6b75496755364cd288adb62b3492830b841288`, including
the complete JS suite/build/worker suite, fresh disposable migration and real-role
RLS checks, and a synthetic local chat journey on source and restored databases.
This does not close provider inference, dashboard Auth, hosted monitoring/recovery/
rollback, pilot acceptance or final release approval. Remaining gates and concrete
owner prerequisites are in the [execution report](HALO_THREE_GATE_EXECUTION.md#verification-addendum--2026-10-13-full-task-run).

The local operations audit extended the system-status endpoint with tenant-
scoped oldest overdue reminder age and queue/dead-letter counts, plus bounded
successful-turn latency percentiles. Provider failure/timeout-rate aggregation
still lacks a durable metric source, so it is explicitly unavailable rather
than presented as zero; full monitoring coverage still requires that source and
hosted alert-delivery evidence.

The 2026-10-13 local follow-up adds testable alert transitions and local sink
delivery/discovery, and explicit unavailable status for failed or incomplete
operational queries. It does not wire a durable scheduler/store or external
destination. Hosted alert delivery and compatible app artifact rollback remain
open release gaps; prior disposable restore evidence is local only.


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
