# HALO v1 engineering baseline and release backlog

**Prepared:** 2026-10-11

**Phase Beta update:** 2026-10-12. Local preparation/evidence review is complete; staging verification is **BLOCKED** because no staging target, owner, target authorization, or verified access was supplied. See [Beta readiness and evidence](HALO_PHASE_BETA_READINESS.md). No staging/production operation or real provider request was made.

**Purpose:** evidence-backed baseline and dependency order for the ratified production-ready GA target and the Arunodaya pilot. This is an audit and planning artifact; it records no release approval and does not implement release gaps.

## 1. Executive summary and evidence limits

HALO has substantial implemented capability: tenant and published-agent identity, a shared runtime with bounded tools, deterministic lifecycle and campaign logic, versioned agents, workflow execution, provider adapters, voice gateway/Pipecat paths, and telemetry. The October 1 implementation report records successful local, mock, and disposable-database checks. Those results are dated evidence for the revision and environment described in that report, not fresh results for the current dirty worktree, provider-backed operation, or a deployed release.

The release owner has ratified production-ready GA as the target, the ten existing criteria, an Arunodaya pilot covering voice, chat, workflows, and integrations, Telugu-first operation (English/Tenglish only where validated), at least one authorized real provider-backed pilot integration, provisional numeric targets pending baseline and owner review, and mandatory security, recovery, and operational-readiness gates. This direction is not business, privacy, security, operations, pilot, or final GA approval. See [release decisions](HALO_V1_RELEASE_DECISIONS.md).

The repository does not establish a deployed HALO release, a real Arunodaya call or provider-backed pilot transaction, customer-approved facts/policies, Telugu native-speaker acceptance, recovery/incident drill results, or final GA approval. Adapter source and fake-backed contracts do not meet the provider-tested or pilot-validated levels. Existing local-speech artifacts report weak Telugu STT results and open human audition/licensing review; local speech is not assumed to be an accepted pilot route.

Audit boundary: the 2026-10-12 checkpoint inspected the requested release records plus current source, migrations, tests, architecture/security/integration/voice/workflow/operations/deployment docs, and recorded verification artifacts. Fresh local suites and disposable database checks are recorded in `HALO_V1_STATUS.md` and `ENG_01_SECURITY_IDENTITY_REVIEW.md`. No provider request, inference, deployment, hosted database change, or live call was performed. Pre-existing dirty and untracked work was preserved. Older `CURRENT_STATE_AUDIT.md` and `HALO_IMPLEMENTATION_PLAN.md` contain historical findings that are superseded on current implementation questions by source and `HALO_IMPLEMENTATION_VERIFICATION.md` (2026-10-01); they remain useful as design/debt references.

ENG-01's detailed read-only source-to-test security and identity review is recorded in [ENG-01 Security and Identity Boundary Review](ENG_01_SECURITY_IDENTITY_REVIEW.md).

### Evidence labels

Use these independently for every capability; one does not imply another:

- `IMPLEMENTED`: current source/configuration exists.
- `LOCALLY TESTED`: a dated automated/manual local result exists; record whether it used fakes, synthetic data, or disposable infrastructure.
- `PROVIDER-TESTED`: authorized real/sandbox provider transaction evidence exists.
- `PILOT-VALIDATED`: an agreed pilot scenario ran and was reviewed against its acceptance condition.
- `OWNER-APPROVED`: the accountable owner recorded dated approval.
- `GAP`: required capability or evidence is absent.
- `UNVERIFIED`: repository evidence is insufficient to determine behavior at the required level.

## 2. Ten-criterion evidence matrix

“Tests/evidence” describes what is present and what it proves. The October 1 verification report records previous execution of many local checks; it explicitly did not establish production activation, real telephony, pilot acceptance, or production migrations. Criteria and owners remain as recorded in [status register §C](HALO_V1_STATUS.md#c-ten-criterion-release-checklist-reconciliation); criterion wording is retained.

| # | Existing release criterion | Current implementation and evidence (paths) | Existing tests/reported evidence and proof boundary | Current labels | Missing evidence / blockers | Backlog |
|---|---|---|---|---|---|---|
| 1 | Shared agent/runtime and bounded business tools work across channels | `packages/runtime/`, `packages/runtime/tools/`, `packages/agents/`, `packages/voice/`; widget/chat routes in `src/app/api/v1/widget/`; `docs/RUNTIME.md` | `tests/integration/runtime-orchestration.test.ts`, `runtime-golden-transcripts.test.ts`, `agent-runtime.test.ts`; prior mock/golden runs establish local orchestration and fixtures, not deployed channel parity or real tool destinations | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `GAP` for release-candidate channel evidence | Candidate-pinned traces across voice/chat/workflow/integration; authorized tool side-effect and false-success evidence | ENG-01, ENG-05, ENG-09 |
| 2 | Tenant and published-agent identity are enforced | `packages/tenancy/`, `packages/agents/`, migrations `supabase/migrations/`; public widget and voice routes; service-role stores | Final 2026-10-12 candidate checks: focused identity suites (3 files / 30 tests), full suite (128 files / 1,257 passed / 5 skipped), ESLint, TypeScript, production build, architecture check, 31-migration validation including exact-receptionist/unmapped-history and idempotency fixtures, plus disposable real-role RLS harness (109 assertions). None establish deployed Auth/config or target identity | `IMPLEMENTED`, `LOCALLY VERIFIED` for selected widget and database identity boundaries, `UNVERIFIED` at deployment boundary | Verify the approved deployment's Auth, grants, service-role scope, existing rows, and effective audit-role permissions; no target-specific audit identity is evidenced | ENG-01, ENG-08 |
| 3 | Qualification, CRM outcomes, consent, DNC and campaign controls are deterministic | `packages/crm/`, `packages/campaigns/`, runtime qualification/tools; campaign and outcome migrations | `tests/unit/lead-lifecycle.test.ts`, `tests/unit/campaign-engine.test.ts`, `tests/integration/campaign-api.test.ts`; local/mock tests and reported implementation checks prove modeled state transitions, not lawful pilot contact or live dispatch | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `GAP` for approved policy and real outcome | Approved contact provenance, consent/disclosure/DNC/callback policy; any live dispatch must be explicitly authorized and reconciled | ENG-02, ENG-05, ENG-09 |
| 4 | Voice control and media paths handle call lifecycle and failures | `packages/voice/`, `services/voice-gateway/`, `services/pipecat-worker/`, `packages/providers/voice-vendors/`; speech source includes pre-existing untracked work | `tests/integration/voice-gateway.test.ts`, `voice-runtime.test.ts`, `pipecat-gateway.test.ts`, worker tests; synthetic audio, fakes and WebSocket harnesses prove local protocol/state behavior only | `IMPLEMENTED`, `LOCALLY TESTED` (reported, mock/synthetic), `GAP` for real PSTN/speech and pilot quality | Authorized carrier/number and speech route, deployed gateway/worker, real interruption/failure/handoff evidence, Telugu reviewer acceptance | ENG-02, ENG-03, ENG-04, ENG-05, ENG-09 |
| 5 | Controlled evaluation and learning cannot alter a live agent without review | `packages/agents/`, `packages/learning/`, agent publication/version migrations | `tests/unit/agent-versioning.test.ts`, learning/evaluation tests, generic golden tests; Oct 1 report records immutable proposal/review and unpublished draft behavior locally | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `GAP` for tenant-approved corpus and release-environment publish/rollback record | Owner-approved corpus/reviewer, attributable publication and rollback evidence on candidate/deployment | ENG-01, ENG-06, ENG-08 |
| 6 | Usage and context budgets are bounded and attributable | `packages/runtime/` budgets/telemetry; `packages/analytics/`; `packages/voice/` event/store paths; `scripts/voice-latency-harness.ts`, `docs/VOICE_LATENCY_MODEL.md` | Runtime/token and voice-latency tests plus Oct 1 local report support configured bounds/instrumentation; estimates do not prove invoice reconciliation, currency caps, production latency or cost | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `GAP` for charge reconciliation/GA baseline | Representative baseline, provider usage attribution/reconciliation, owner-reviewed limits and monitoring | ENG-07, ENG-08, ENG-10 |
| 7 | Production campaign dispatch and scheduling have required operating configuration | `packages/campaigns/`, `packages/scheduling/`, cron routes in `src/app/api/cron/`, `vercel.json`, calendar adapters | `tests/integration/booking-service.test.ts`, `booking-conversation.test.ts`, `campaign-api.test.ts`; fake/in-memory tests prove service logic, not production cron/carrier or real calendar booking. Oct 1 report records outbound gate and missing production config | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `GAP` for authorized configured execution | Business decision on booking/campaign scope; approved policy, cron/provider setup and receipt/reconciliation evidence | ENG-02, ENG-03, ENG-05, ENG-08 |
| 8 | Release and operations evidence supports safe production activation | CI/workflow files, `scripts/preflight.ts`, migration/RLS checks, `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`, recovery and voice persistence paths | Oct 1 report records local build/type/lint/security/migration/preflight checks on its revision and disposable DB; no deployment/migration, backup restore, rollback, incident or target-load drill is recorded | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `GAP` for GA operations; `UNVERIFIED` for target deployment | Release revision ledger, deployment security review, monitored backup/restore/rollback/incident and approved load/recovery baseline | ENG-01, ENG-08, ENG-10 |
| 9 | At least two useful integrations are supported, with one exercised end-to-end in the pilot | Ports/adapters under `packages/providers/` and `packages/ports/` for Twilio, calendar, WhatsApp/email and workflow webhooks | `tests/contracts/twilio-media-stream.contract.test.ts`, booking, messaging and webhook tests use fakes/in-memory services; prove contract handling, not external acceptance. No real provider receipt is recorded | `IMPLEMENTED`, `LOCALLY TESTED` (reported/mock), `GAP` for provider-backed pilot transaction and approved support scope | Owner selects supported integrations/destination; separate authorization, sandbox/real provider access, acknowledged transaction and safe retry evidence | ENG-02, ENG-03, ENG-04, ENG-05, ENG-09 |
| 10 | Arunodaya pilot scenarios pass with documented acceptance criteria | `src/content/tenants/arunodhaya/`, `docs/ARUNODHAYA_AGENT.md`, `docs/ARUNODHAYA_NEGOTIATION_POLICY.md`, `tests/golden/arunodhaya/` | `tests/integration/arunodhaya-golden.test.ts` and `docs/PHASE4_REPORT.md` report 50/50 scripted golden conversations; this proves fixture regression only, not natural speech, approved facts, provider operation or customer acceptance | `IMPLEMENTED`, `LOCALLY TESTED` (reported, scripted), `GAP` for pilot validation and approval | Approved facts/policies/disclosures; authorized routes and scenarios; native Telugu review, real integration evidence, defect disposition and dated pilot acceptance | ENG-02, ENG-03, ENG-04, ENG-05, ENG-06, ENG-09 |

## 3. Cross-workstream baseline

This matrix makes the requested non-criterion workstreams explicit. Dependencies refer to backlog IDs in §4. Approval roles are role-level; no names or approvals are inferred.

| Workstream | Current source/tests and what they establish | Status | Missing evidence/functionality, dependencies, next action and completion condition |
|---|---|---|---|
| Tenant isolation, authentication, authorization, secrets | `packages/tenancy/`, `src/lib/auth.ts`, public API routes, migrations; `tests/integration/{multi-tenant-isolation,phase4-security,widget-messages-security}.test.ts`, `tests/unit/crypto.test.ts`; Oct 1 disposable DB/RLS result | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `UNVERIFIED` in target deployment | Revalidate current candidate and service-role/public/worker boundaries; security/data owner review. Depends ENG-01. Done when adversarial cases pass against the agreed target boundary and access/secrets review is recorded. |
| Business/agent configuration, versioning, publish/rollback | `packages/agents/`, `src/content/tenants/arunodhaya/`, publication/version migrations; `tests/unit/agent-versioning.test.ts`, `tests/integration/agent-linkage.test.ts` | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `GAP` for approved tenant content and deployed drill | Business owner supplies dated facts and policies; runtime/release engineering pins published version and records rollback. Depends ENG-01, ENG-02. Done when every pilot channel uses approved version and immutable publish/rollback trail is retained. |
| Shared HALO runtime, tools, policies, knowledge | `packages/runtime/`, `packages/runtime/tools/`, `packages/knowledge/`, `docs/RUNTIME.md`; orchestration, validator, retrieval tests and golden fixtures | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `GAP` for approved factual corpus and release-candidate proof | Bind least-privilege tools to approved source facts; record expected/observed outcomes and denial behavior. Depends ENG-01, ENG-02, ENG-06. Done when approved corpus/tool matrix passes and unauthorized/failed actions have no false success or side effect. |
| Voice and chat parity | `packages/voice/`, `services/voice-gateway/`, `services/pipecat-worker/`, widget routes; voice/chat/runtime integration tests with fakes | `IMPLEMENTED`, `LOCALLY TESTED` (reported/mock), `GAP` for provider/deployed parity | Pin identity, language, safety and outcome cases across voice/chat; validate voice only after authorized route setup. Depends ENG-02–05. Done when the approved matrix passes for both channels with correlated records. |
| Reusable workflows and failure handling | `packages/workflows/`, cron routes, workflow migrations, `docs/WORKFLOWS.md`; `tests/integration/workflow-engine.test.ts`, workflow action tests | `IMPLEMENTED`, `LOCALLY TESTED` (reported/fakes), `UNVERIFIED` for destination/production cron | Verify pinned workflow behavior, idempotency, retry/dead-letter visibility and destination receipt with selected pilot workflow. Depends ENG-02, ENG-05, ENG-08. Done when one authorized workflow produces an acknowledged outcome and replay/failure recovery is evidenced. |
| External integration adapters and real provider validation | `packages/ports/`, `packages/providers/`, `packages/workflows/action-registry.ts`; adapter contracts and stubbed delivery tests | `IMPLEMENTED`, `LOCALLY TESTED` (reported/mock), `GAP` for provider-backed pilot | Pilot/integration owners select provider and destination, authorize access; run one real transaction with correlation and reconciliation. Depends ENG-02–05. Done when evidence has provider receipt/ID, workflow/call ID, safe replay result and business acceptance. |
| Human escalation and unauthorized-action handling | Runtime validators/tools, voice handoff and campaign guards; qualification confirmation/system-action, voice fallback and golden tests | `IMPLEMENTED`, `LOCALLY TESTED` (reported/mock), `GAP` for approved staff route and live transfer | Approve escalation triggers, staffing, wording and fallback; validate denial, ambiguous action, provider-confirmed transfer, and no false claim. Depends ENG-02–04. Done when reviewed scenarios record safe outcomes and transfer confirmation. |
| Latency, usage, cost, observability, failure measurement | `packages/analytics/`, runtime/voice events and token budget, `docs/VOICE_LATENCY_MODEL.md`, `docs/PERFORMANCE_BASELINE.md`; latency/telemetry tests and harness | `IMPLEMENTED`, `LOCALLY TESTED` (reported), `GAP` for representative deployed baseline and actual charge attribution | Measure agreed representative pilot profile before threshold approval; configure failure/usage alerts and reconcile provider records. Depends ENG-04, ENG-07, ENG-08; finance/ops approval. Done when measured report has sample/config/denominator and owners approve/revise thresholds. |
| Deployment, monitoring, backup/restore, rollback, incident response | `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`, `docs/TROUBLESHOOTING.md`, CI and check scripts, migrations | `IMPLEMENTED` as runbooks/check tooling, `LOCALLY TESTED` (reported), `GAP` for operational drills | Name service owners, choose isolated environment and recovery objectives; execute migration/deploy/rollback/restore/incident exercises. Depends ENG-01 and operations/security owner. Done when revision/migration and exercise evidence meet approved objectives. |
| Arunodaya scenarios, business approval and acceptance | Tenant fixtures and negotiation policy, golden corpus/runner, `docs/HALO_V1_RELEASE_GAPS.md` pilot matrix | `IMPLEMENTED`, `LOCALLY TESTED` (reported, scripted), `GAP` for owner-approved content and `PILOT-VALIDATED` record | Obtain business/privacy/language decisions and conduct only authorized scenarios after technical/environment gates. Depends ENG-02–06, ENG-08, ENG-09. Done when every in-scope case has evidence, disposition and separate pilot-owner acceptance. |

## 4. Dependency-ordered release backlog

The dependency graph records existing backlog identifiers pending owner resolution of the ENG-04 collision: **ENG-01 → ENG-02 → ENG-03 → pilot voice/speech route (currently ENG-04 in this backlog) → ENG-05 → ENG-06 → ENG-09** for pilot activation and acceptance. **ENG-01 → ENG-07 → ENG-08 → ENG-10** establishes GA evidence. ENG-02 is also a prerequisite for every customer-facing pilot action; ENG-08 pilot controls precede ENG-09 execution. ENG-10 and ENG-09 feed a separate final GA review and owner decision; neither grants approval. Canonical ENG-04/ENG-12 assignment is **PENDING OWNER APPROVAL**; the database migration/linkage identity audit (SEC-04 scope) is referred to descriptively in the Beta record. No existing tracking identifier is silently reassigned.

Priorities: P0 blocks safe validation or critical correctness/security; P1 is required for authorized Arunodaya pilot; P2 establishes GA readiness; P3 is evidence-supported post-v1 work. No calendar estimates are assigned. Numeric thresholds remain provisional as stated in the release decision document.

### P0 — critical correctness/security and pilot-entry gates

#### ENG-01 — Revalidate release-candidate security and identity boundaries

- **Why:** tenant identity and action authorization protect every later provider and pilot transaction.
- **Current state:** At inspection, the worktree was dirty on branch `main` at `c5fd940662fc497960e6c152614fa92cf0fa97ab`, 49 commits ahead of `halo/main`, with 49 pre-existing modified/untracked paths (including the conversation route, identity tests, and untracked review/backlog files). No reset, stash, clean, or overwrite was performed. Existing SEC-05 work removes the second widget-key lookup and adds explicit tenant/agent/version tuple checks. SEC-06 was reproduced and fixed: `0015` now joins each legacy conversation by its own receptionist ID; `0031` rejects new missing or inconsistent identity tuples; the widget message route also rejects old same-tenant mismatches before model execution. Fresh 2026-10-12 validation on this same dirty candidate passed the full suite (128 files; 1,257 passed, 5 skipped), full ESLint, `npm run typecheck`, `npm run build`, architecture/config checks, the focused identity suite (3 files / 30 tests), isolated migration validation (31 migrations plus schema and identity fixtures), the disposable real-role RLS harness (109 assertions), 54 worker tests (1 skipped), and final `git diff --check`. These are local results, not deployed Auth/RLS or provider evidence. The final migration replay used a separately named throwaway PostgreSQL container with CI Supabase stubs. The migration validator default, which targets the developer database, was not used for successful validation. No clean-checkout revalidation was performed. Deployed migration state, existing-row integrity, Auth/RLS/service-role configuration, effective audit-role permissions, and production behavior remain outstanding.
- **ENG-01A widget identity remediation:** local message handling rejects conversation/receptionist tenant mismatch, missing/partial/unresolved agent linkage, and tenant, agent-owner, or publication mismatches before runtime execution or turn writes. The previous implicit receptionist fallback is removed. Focused route tests passed 10/10. ENG-03 removes the obsolete create-time null-link exception and validates tenant-scoped pinned-agent creation. Deployment migration/data evidence remains open.
- **Widget start null-link remediation (ENG-03 follow-up):** the temporary `HALO_AGENT_RESOLUTION_COMPAT_FAIL_OPEN` behavior and schema setting are removed. Conversation creation now requires server-resolved published agent/version IDs; the repository API makes both required. Local migrations `0014`, `0021`, and `0022` establish receptionist-agent creation/backfill paths. The existing widget client's request and success envelope are unchanged. The combined creation/message suites passed 21/21, with targeted ESLint and `git diff --check`. Tests prove valid pinned identity, old-client compatibility, missing-agent rejection even with the retired env variable present, and foreign-tenant rejection. Legacy null-link rows remain representable by design; `0031` guards new identity-bearing writes. Existing rows were not repaired, because exact historical agent-version evidence is not established. Production migration ledger and row census require an authorized read-only audit (procedure in `docs/ENG_01_SECURITY_IDENTITY_REVIEW.md`, SEC-04).
- **Proposed ENG-12 target audit status (2026-10-12): DEFERRED beyond local Alpha.** The earlier label “ENG-04 Phase 2” referred to migration metadata and conversation agent/version linkage. ENG-04 remains the pilot voice/speech work item. ENG-11 is already assigned to local Telugu speech evaluation; ENG-12 was checked as unused in repository files and searched history. ENG-12 is a local engineering recommendation, not release-owner approval. Local Alpha completed migration/schema and real-role RLS checks on a disposable database; no deployment ledger or historical target rows were inspected, and those counts remain unknown, not zero. See [ENG-01 SEC-04](ENG_01_SECURITY_IDENTITY_REVIEW.md) and the [Phase Alpha boundary](HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md).
- **ENG-04 scope:** retain the backlog definition, authorization and validation of the pilot voice/speech route. The database identity audit is separately tracked as proposed ENG-12; see the preflight record. This is a local naming recommendation, not an owner-approved decision.
- **ENG-12 target identity/access preflight:** before any staging or production query, require the approved target/environment, exact project and region, deployed revision, audit window, dated authorization, dedicated least-privilege identity, target-specific effective grants/role-membership evidence, matching session identity, and read-only transaction confirmation. Stop on mismatch, excess/unverifiable privileges, missing authorization, unexpected RLS incompleteness, or out-of-scope data. Never use service-role access, attempt writes to test permissions, or bypass RLS. No target query is part of local Alpha.
- **Dependencies / approvals:** none to begin source/test review. Security and data-platform owner review required for target deployment closure.
- **Bounded scope / exclusions:** review tenant, agent-version, public-token, service-role and worker identity boundaries; run only the existing targeted checks later against an authorized isolated environment. No production mutation, broad suite, penetration test or secret-value capture in this backlog item.
- **Acceptance:** a candidate revision is identified; each public/service-role read/write is shown tenant-scoped or capability-authorized; wrong-tenant, wrong-version, expired/replayed identity and unauthorized mutation cases deny access; secrets remain server-side and redacted from evidence.
- **Verification/evidence:** revision, focused test names/results and environment boundary; query/store review; disposition of SEC-05 and other residuals; target-environment evidence by security/data owners.
- **Proceed now?** **Local Alpha work complete.** No application or schema deployment was performed. Staging/production migration integrity, Auth/RLS/service-role configuration, historical linkage counts, and deployed behavior remain unverified and belong to later phase gates; see proposed ENG-12 for safe prerequisites.

#### ENG-02 — Approve Arunodaya facts, language, consent and operating policy

- **Why:** voice/chat must not invent commercial claims, contact people without authorization, or promise unavailable actions.
- **Current state:** proposed tenant config, qualification, objections and negotiation artifacts exist in `src/content/tenants/arunodhaya/` and docs. Gap/status records say verified dated commercial fact sources, disclosures, contact list consent, DNC/callback policy, escalation contacts, visit rules and language approval are absent.
- **Dependencies / approvals:** Arunodaya business/sales/operations owner, privacy owner, native Telugu reviewer, and release owner for pilot scope. External authorization is required before contact or audio collection.
- **Bounded scope / exclusions:** prepare a dated source pack and explicit policy/config review for the approved pilot scenarios. Does not determine commercial policy, legal basis, consent, disclosure, language acceptance, or customer approval on their behalf.
- **Acceptance:** named owners approve sourced facts (with provenance and review/expiry), permitted claims and deferrals, Telugu-first language variants, disclosure/recording/retention wording, contact/DNC/callback rules, escalation and booking scope; unsupported answers defer safely.
- **Verification/evidence:** attributable approval records, source references, reviewed agent configuration and scenario policy matrix; no credential or personal contact values copied into this backlog.
- **Proceed now?** **Waits** for business/privacy/language owner decisions. Engineering may prepare the review template only.

### P1 — required for the authorized Arunodaya pilot

#### ENG-03 — Pin the pilot agent, runtime tools and channel contract

- **Why:** all pilot channels need the same tenant, approved published version, limited actions and truthful outcome narration.
- **Current state:** shared runtime, immutable versioning, validators, knowledge and tool registries exist; local/mocked tests and the 50/50 scripted golden result are reported. Approved Arunodaya facts and pilot version/channel traces are missing. Booking on the voice path is specifically reported unbound in the gap audit.
- **Dependencies / approvals:** ENG-01 and ENG-02; product/business owner approves enabled actions and whether booking is in pilot scope.
- **Bounded scope / exclusions:** map approved facts/tools and channel behavior; bind only authorized pilot actions and version. No new runtime capability is presumed necessary absent findings; no general redesign.
- **Acceptance:** voice and chat resolve the same approved tenant/version/policies; workflows invoke only granted tools; denial/failure produces no unauthorized side effect or false success; booking is enabled only if approved and connected to the agreed path.
- **Verification/evidence:** version IDs, tool allow/deny cases, channel traces and approved config review signed by runtime and business owners.
- **Proceed now?** **Waits** for ENG-02; source review can proceed after ENG-01.

#### ENG-04 — Authorize and validate the pilot voice/speech route

- **Why:** real voice is in pilot scope; synthetic media cannot prove call quality, interruption, transfer or recovery.
- **Current state:** gateway, Pipecat worker, Twilio and Sarvam adapters/contracts are present; fake/synthetic lifecycle tests and local speech source exist. The Oct 1 report says carrier/Sarvam credentials and authorized number/call were missing. Local speech documents flag weak Telugu metrics, unfinished human review and licensing questions.
- **Dependencies / approvals:** ENG-01–03; provider owner authorizes account/number and credentials; security/privacy/operations approve deployed route, disclosures, data handling and evidence capture.
- **Bounded scope / exclusions:** controlled, approved test calls only after authorization; capture only approved data. Does not authorize outbound customer calls, select a speech vendor without owner review, or treat local inference as provider acceptance.
- **Acceptance:** authorized inbound/outbound test path (as approved) pins tenant/version, verifies callbacks, records terminal state, tests Telugu-first speech, interruption and failure behavior, and has reviewed fallback/handoff outcomes without false success.
- **Verification/evidence:** redacted provider IDs/callback outcomes, gateway/worker correlation, reviewer-scored permitted audio/transcript, failure/interruption cases and measured stage data.
- **Proceed now?** **Waits** for ENG-02/03 plus provider/security/operations authorization and access.

#### ENG-05 — Select and prove pilot integration(s) with safe replay/reconciliation

- **Why:** criterion 9 requires two useful supported integrations and the ratified pilot requires at least one real provider-backed integration.
- **Current state:** Twilio, calendar, WhatsApp/email and webhook adapters/tests exist; referenced contract/delivery tests use fakes. No Arunodaya provider receipt is recorded; pilot destination and calendar choice are unresolved.
- **Dependencies / approvals:** ENG-02–04; integration and business owners choose use case/destination and authorize sandbox or real account; privacy/security approve payload and data scope.
- **Bounded scope / exclusions:** document supported integrations and validate only owner-selected pilot transaction(s). No real external call/message/booking occurs under this audit task; no speculative CRM or calendar selection.
- **Acceptance:** two integrations are explicitly selected as useful/supportable for v1; at least one authorized real provider transaction receives an acknowledged outcome with correlation, safe retry/idempotency, failure visibility and reconciliation. If transaction is a call, it counts only when provider-backed and pilot-authorized.
- **Verification/evidence:** owner-approved integration matrix; provider receipt/ID, workflow/call ID, redacted request/result, replay and failure evidence, destination owner acceptance.
- **Proceed now?** **Waits** for owner selection, external authorization and ENG-04 where voice-dependent.

#### ENG-06 — Execute Telugu-first Arunodaya acceptance matrix and record decision

- **Why:** golden fixtures are not customer or language acceptance; pilot acceptance must cover all ratified channels and safety scenarios.
- **Current state:** `tests/golden/arunodhaya/` and `tests/integration/arunodhaya-golden.test.ts` report 50/50 scripted cases. `docs/HALO_V1_RELEASE_GAPS.md` lists Telugu qualification, claims, consent/DNC, handoff, booking, interruption and follow-up scenarios. No reviewed real-call or pilot acceptance packet is found.
- **Dependencies / approvals:** ENG-02–05, ENG-08 pilot controls, named native Telugu reviewer and Arunodaya pilot owner.
- **Bounded scope / exclusions:** execute only approved scenarios and language variants; English/Tenglish only where validated. No inferred success from fixtures, unsanctioned contact or unapproved retention of audio/transcripts.
- **Acceptance:** each mandatory scenario records pass/fail, expected/observed result, evidence reference, reviewer/date and linked defect; safety-critical failures are corrected and rerun; business and language owners record separate pilot acceptance.
- **Verification/evidence:** signed scenario packet, provider/workflow IDs, permitted transcript/audio review, defect disposition and separate owner approvals.
- **Proceed now?** **Waits** for ENG-02–05, ENG-08 and pilot owner/reviewer availability.

### P2 — required to establish general-availability readiness

#### ENG-07 — Measure representative latency, usage, quality and cost baselines

- **Why:** release thresholds are explicitly provisional until representative baseline measurements and owner review.
- **Current state:** context/token bounds, usage/latency instrumentation, scripts and reports exist; Oct 1 report notes context estimates are not billing guarantees and currency budgets are absent. No representative deployed GA profile or charge reconciliation is found.
- **Dependencies / approvals:** stable candidate and provider route (ENG-04); representative scenario/traffic definition; operations and finance/provider owners review targets.
- **Bounded scope / exclusions:** collect baseline measurements with defined sample, denominator, configuration and failure cases; do not invent or ratify thresholds or run broad/resource-intensive load tests without an approved profile.
- **Acceptance:** report covers latency stages, errors, usage attribution and provider charge reconciliation where available; separates measured values from estimates; relevant owners approve or replace each proposed threshold in the decision record.
- **Verification/evidence:** reproducible baseline report, provider usage references, monitoring/alert traces and dated owner dispositions.
- **Proceed now?** **Partly:** inventory metrics and define measurement plan now; production measurements/threshold approval wait for ENG-04 and owner review.

#### ENG-08 — Close target-environment security, deployment, recovery and operations gates

- **Why:** security, recovery and operational readiness are mandatory before GA; local checks do not demonstrate deployment safety.
- **Current state:** deployment/operations docs, migrations, CI and RLS/preflight checks exist; Oct 1 verification records local checks and disposable DB migration/RLS results, but no production migration/deploy, restore, rollback, incident, monitored alert or target-load drill. Runbooks list expected configuration/monitoring work.
- **Dependencies / approvals:** ENG-01; release/deployment, security/privacy, database and operations owners; isolated target environment and approved recovery objectives.
- **Bounded scope / exclusions:** record release revision/migrations, validate security settings, execute authorized staging/pilot and GA recovery exercises. No production resource changes are authorized by this backlog or audit.
- **Acceptance:** candidate/migrations traceable; security review passes; deployment and rollback are repeatable; backup restore and incident/escalation exercises meet owner-approved recovery objectives; monitoring and alert paths are exercised; pilot outbound/contact controls remain closed unless authorized.
- **Verification/evidence:** revision/migration ledger, redacted configuration review, deployment/rollback/restore/incident results, alert records, approved RTO/RPO and owner sign-offs.
- **Proceed now?** **Partly:** inventory gates/runbooks now. Environment exercises wait for named owners, environment authorization and objective approval.

#### ENG-09 — Close pilot findings and prove scope-specific operational support

- **Why:** passing a bounded pilot does not by itself establish GA, but its defects, integration operations and support path feed GA acceptance.
- **Current state:** operational runbooks and adapters exist; no pilot outcome, destination receipt, named support owner, defect disposition or accepted service workflow is recorded.
- **Dependencies / approvals:** ENG-05–06 and ENG-08; Arunodaya business owner and service/operations owner.
- **Bounded scope / exclusions:** close or explicitly disposition pilot defects, reconcile provider side effects and record the agreed pilot support/escalation path. Does not convert pilot sign-off into GA authorization.
- **Acceptance:** pilot defects have owners and disposition; required safety fixes pass rerun; provider side effects reconcile; support hours/escalation and operating controls are accepted; pilot owner records dated acceptance.
- **Verification/evidence:** final pilot evidence index, issue disposition, reconciliation and separate business/operations acceptance.
- **Proceed now?** **Waits** for ENG-05/06 and owners.

#### ENG-10 — Assemble the ten-criterion GA evidence packet and hold separate go/no-go

- **Why:** GA requires all ten criteria plus mandatory security, recovery and operations gates, with separate approvals.
- **Current state:** criteria and proposed measurable conditions are recorded in `HALO_V1_STATUS.md` and `HALO_V1_RELEASE_DECISIONS.md`; multiple provider, production, pilot and owner evidence classes remain absent.
- **Dependencies / approvals:** ENG-01–09; all applicable accountable owners; release owner convenes final review only after evidence is complete.
- **Bounded scope / exclusions:** map candidate evidence to every retained criterion, state exceptions, and record decisions. Does not grant or presume business/privacy/security/operations/pilot/GA approval.
- **Acceptance:** all criteria have candidate-bound evidence and disposition; numeric targets have owner review; security, recovery, operational readiness pass; separate required approvals and final GA go/no-go are recorded with date and scope.
- **Verification/evidence:** versioned evidence packet, open-risk/exception register and attributable approval records.
- **Proceed now?** **Waits** for ENG-01–09 and owner approvals.

### P3 — evidence-supported post-v1 improvements

#### ENG-11 — Improve or retire local Telugu speech candidates based on human and license review

- **Why:** current local-speech artifacts show material Telugu recognition errors and open audition/licensing questions; candidate improvement is optional only if owners select local speech for supported scope.
- **Current state:** local STT/TTS adapter and worker paths/tests/docs exist in pre-existing worktree changes; benchmark reports 67% WER / 20% CER on 11 clips, no human TTS audition and unresolved GPL eSpeak review. No pilot acceptance is implied.
- **Dependencies / approvals:** speech owner chooses whether local route remains supported; native reviewer, license owner and target-host resources.
- **Bounded scope / exclusions:** reproducible comparative benchmark, Telugu human review, license/provenance decision, target-host latency/resource evaluation. No model downloads/inference in this task; no claim that a numerical acceptance threshold is approved.
- **Acceptance:** written keep/retire decision based on reviewed corpus, reproducible results, distribution-license disposition and host/resource evidence; if selected, owners approve threshold after baseline.
- **Verification/evidence:** benchmark provenance/config, reviewer worksheet, licensing disposition and owner decision.
- **Proceed now?** **Waits** for route-selection and review owners; existing evidence can be inventoried now.

#### ENG-12 — Execute the authorized migration and conversation identity audit (local naming recommendation)

- **Why:** establish migration-ledger state and historical conversation agent/version linkage integrity for a specifically authorized target without guessing or altering historical identities.
- **Naming:** the earlier request called this “ENG-04 Phase 2,” but ENG-04 is already the voice/speech route and ENG-11 is occupied. ENG-12 is unused in the repository and searched Git history. This is a local engineering recommendation, not owner-approved canonical naming.
- **Current state:** local Alpha validated all migrations and asserted schema columns on a disposable database, plus real-role RLS/privilege behavior. No staging or production target was accessed; migration state and row anomaly counts there remain unknown, not zero.
- **Dependencies / approvals:** target owner, security/data owner, database owner and named operator provide a specific environment/project/region/revision/window, dated authorization, effective grants/role membership, matching session identity, and read-only transaction evidence.
- **Bounded scope / exclusions:** approved migration version/name metadata and aggregate conversation/agent/version linkage fields only. No transcript/message/personal data, production mutation, guessed backfill, service-role access, RLS bypass, or write-based privilege test.
- **Acceptance:** preflight identity and privileges match and the approved migration/linkage checks run with aggregate-only evidence; anomalies receive owner-directed disposition before affected target acceptance closes.
- **Phase:** not a local Alpha blocker. Run against authorized staging in Beta if required; production execution belongs only to a separately authorized final-release process.
- **Proceed now?** Local schema/role portion complete; target portion waits for later-phase authorization and target evidence.

## 5. Highest-priority next engineering task

**Beta's highest-priority next action: provision an isolated staging target and record its exact identity/revision before running staging security and deployment checks.** The local Alpha source/test, fresh migration replay and real-role RLS work are complete on the dirty candidate. Beta should verify deployed Auth/RLS/service-role boundaries, migration ledger, widget and worker identity, health/configuration, recovery/rollback, and provider sandbox contracts. Any target audit must follow proposed ENG-12's specific authorization and read-only preflight. Do not use production as a disposable database.

## 6. Owner decisions that engineering cannot make

- Whether the ten-row audit mapping is the canonical retained checklist, if its source authority must be reconfirmed; the owner has ratified retention/direction, not historical provenance.
- Arunodaya pilot scope details, business facts and permitted claims, contact provenance/consent, AI/recording disclosure, DNC/callback/calling window, retention, escalation staffing, visit/booking rules and destination CRM/calendar/channel.
- Which two integrations are useful and supportable for GA, which provider/destination to exercise, and authorization for sandbox/real accounts, numbers, messages, bookings and evidence collection.
- Which Telugu/Tenglish variants are validated, who reviews language/audio, and whether local STT/TTS is acceptable and properly licensed.
- Privacy/security requirements and evidence handling; target environment, deployment owners, production access, restore/rollback/incident owners and recovery objectives.
- Representative GA traffic and quality profile; baseline sample and approval/replacement of provisional latency, cost, quality, reliability and recovery thresholds by relevant owners.
- Pilot acceptance and defect disposition by Arunodaya; separate business, privacy, security, operations, pilot and final GA approvals. Release-owner direction alone does not satisfy these gates.

## 7. Source references and validation boundary

Primary status/decision sources: [HALO v1 status](HALO_V1_STATUS.md), [release decisions](HALO_V1_RELEASE_DECISIONS.md), [release gaps and pilot matrix](HALO_V1_RELEASE_GAPS.md), [implementation plan](HALO_IMPLEMENTATION_PLAN.md), [historical current-state audit](CURRENT_STATE_AUDIT.md), and [implementation verification, dated 2026-10-01](HALO_IMPLEMENTATION_VERIFICATION.md). Additional sources: [security](SECURITY.md), [deployment](DEPLOYMENT.md), [operations](OPERATIONS.md), [workflows](WORKFLOWS.md), [voice latency model](VOICE_LATENCY_MODEL.md), [Arunodaya agent](ARUNODHAYA_AGENT.md), and [negotiation policy](ARUNODHAYA_NEGOTIATION_POLICY.md).

Validation for this checkpoint ran the full local JavaScript suite, ESLint, TypeScript check, production build, configuration preflight, Pipecat worker tests, migration replay/schema assertions, disposable real-role RLS/privilege harness, and `git diff --check`. It performed no provider calls, inference, deployment, hosted database query, or live calls. Before closing a later-phase item, capture its evidence against a pinned candidate revision and retain the relevant approval record.

### Current three-gate evidence refresh — 2026-10-13

Candidate `cb6b75496755364cd288adb62b3492830b841288` passed fresh local
application/build/worker checks, disposable migrations and real-role RLS, and a
synthetic chat journey before and after a 44-table local restore. Provider
inference, real Auth lifecycle, alert delivery and immutable application rollback
remain blocked by external evidence/authorization. This does not change backlog
dependencies or close Beta/Charlie acceptance; details and minimum owner actions
are in the [three-gate report](HALO_THREE_GATE_EXECUTION.md#verification-addendum--2026-10-13-full-task-run).
