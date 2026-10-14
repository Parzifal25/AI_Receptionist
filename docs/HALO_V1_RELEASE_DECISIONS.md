# HALO v1 release decisions and Arunodaya pilot proposal

**Prepared:** 2026-10-11
**State:** release-owner direction is recorded below as **RATIFIED — RELEASE OWNER DIRECTION**. Cross-functional approvals, criterion acceptance evidence, and final GA authorization remain pending.
**Scope:** RB-01/RB-01A: retain the ten-item release mapping, clarify measurable gates, and record pilot and general-availability direction/evidence. This document does not implement release gaps.

**Phase Beta update (2026-10-12):** staging readiness is **PARTIAL; staging verification BLOCKED** pending an identified target, owner, authorization and access. See [HALO Phase Beta readiness](HALO_PHASE_BETA_READINESS.md). The release directions below do not authorize staging operations or imply pilot/final acceptance.

**Consolidation note (2026-10-15):** the decision register at the end of this document moved to [DECISIONS.md](DECISIONS.md) as R1–R10. Architecture lives in [HALO_Architecture.md](HALO_Architecture.md), and sequencing in [HALO_V1_IMPLEMENTATION_PLAN.md](HALO_V1_IMPLEMENTATION_PLAN.md). This document remains the record of the ratification text, the GA acceptance conditions and the pilot plan.

## Decision summary — ratified release-owner direction

| Decision | Release-owner direction | State |
|---|---|---|
| Release target | Production-ready general availability (GA) | **RATIFIED — RELEASE OWNER DIRECTION** |
| Release checklist | Retain all ten existing criteria and clarify acceptance evidence; the status register remains authoritative for current status | **RATIFIED — RELEASE OWNER DIRECTION** |
| Arunodaya pilot channels | Voice, chat, workflows, and integrations | **RATIFIED — RELEASE OWNER DIRECTION** |
| Language | Telugu-first; English/Tenglish only where validated | **RATIFIED — RELEASE OWNER DIRECTION** |
| Integration evidence | Exercise at least one real provider-backed integration in the pilot; mocks and provider stubs do not satisfy this | **RATIFIED — RELEASE OWNER DIRECTION** |
| Numeric targets | Remain provisional until baseline measurements and relevant owner review | **RATIFIED — RELEASE OWNER DIRECTION** |
| Mandatory GA gates | Security, recovery, and operational readiness must pass before GA authorization | **RATIFIED — RELEASE OWNER DIRECTION** |

This ratification records release-owner direction only. It is not approval by Arunodaya, privacy, security, integration, language, or operations owners; it does not establish that any criterion has passed; and it does not authorize final GA release. The ten criteria remain the same. See [status register §C](HALO_V1_STATUS.md#c-ten-criterion-release-checklist-reconciliation) for the authoritative current-status mapping and [release-gap audit](HALO_V1_RELEASE_GAPS.md) for the source evidence.

The earlier “ENG-04 Phase 2” label for the database migration/linkage audit conflicts with the backlog's ENG-04 voice/speech route. **Canonical assignment remains PENDING OWNER APPROVAL.** Earlier records recommended ENG-12 for the audit because ENG-11 was already used, but this is only a local recommendation, not an approved renumbering. Continue to use descriptive scope names pending the owner's decision; preserve historical references and the ten criteria. See [Phase Beta readiness](HALO_PHASE_BETA_READINESS.md) and the [Phase Alpha boundary](HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md).

## RB-01A release-owner ratification

| Recorded | Decision authority |
|---|---|
| 2026-10-11 (repository date convention) | Release owner |

**State:** **RATIFIED — RELEASE OWNER DIRECTION**

The release owner ratifies the seven directions in the summary above: production-ready GA; retention of all ten criteria with clarified acceptance evidence; the voice, chat, workflows, and integrations Arunodaya pilot scope; Telugu-first with English/Tenglish only where validated; at least one real provider-backed pilot integration; provisional numeric thresholds pending baseline measurement and relevant owner review; and security, recovery, and operational readiness as mandatory gates before GA authorization.

This record does not imply a meeting date, attendance by other owners, approval on their behalf, or passage of any criterion. The owner approvals and evidence still required are listed in [Unresolved mandatory approvals and dependencies](#unresolved-mandatory-approvals-and-dependencies). Final GA authorization remains pending.

## Purpose and scope

HALO v1 is a reusable, tenant-isolated agent runtime and control plane, with an Arunodaya Solar Systems pilot as the first customer-facing use. The release owner's ratified target is production-ready GA. The Arunodaya pilot direction covers voice, chat, workflows, and integrations, subject to owner-approved tasks and safe setup. Telugu is first; English and Tenglish are supported only for validated language variants. At least one actual provider-backed integration must be exercised in the authorized pilot. The ratified direction does not establish Arunodaya's policies, available operations, or sign-off.

The current status register remains the repository-backed status entry point. Its ten rows are an audit mapping from the release-gap audit, not a confirmed historical canonical checklist. The release owner has directed that all ten existing criteria be retained; this does not validate any criterion as passed. This document supplies clarified proposed pass conditions and approval dependencies; it does not supersede the status register. See [HALO v1 status](HALO_V1_STATUS.md), [release-gap audit](HALO_V1_RELEASE_GAPS.md), [implementation verification](HALO_IMPLEMENTATION_VERIFICATION.md), [implementation plan](archive/HALO_IMPLEMENTATION_PLAN.md), and [current-state audit](archive/CURRENT_STATE_AUDIT.md).

## Release stages and evidence boundaries

The gates below are separate. Pilot acceptance does not establish GA readiness. Each stage requires dated evidence tied to a release revision, named reviewer role, outcome, and defects or exceptions.

| Stage | Proposed entry / acceptance requirements | Evidence to retain | What passing this stage establishes |
|---|---|---|---|
| Arunodaya pilot entry | Written approval of pilot scope, contacts/accounts, data handling, facts and policies, disclosures/consent, language variants, escalation route, integration destination, test environment, and reviewers. Security/privacy and operational controls applicable to the pilot must be reviewed before customer-facing use. | Attributable scope and policy decisions; approved source pack; access/retention plan; environment/revision record; authorized provider setup; scenario matrix and provisional measurement plan. | Permission to conduct only the agreed bounded pilot. Entry is not a pilot pass or a GA release decision. |
| Arunodaya pilot acceptance | Execute approved scenarios on all proposed channels (voice, chat, workflows, integrations); Telugu-first, with English/Tenglish cases only where validated. Meet owner-approved safety and quality criteria, close or disposition defects, and exercise at least one real provider-backed integration with an acknowledged outcome and correlation evidence. Obtain pilot business and language reviewer acceptance. | Scenario-level records, provider IDs/receipts, workflow traces, reviewed transcripts/audio where permitted, expected/observed outcomes, safety cases, failure/retry/reconciliation evidence, defect disposition, dated role-based acceptance. | Evidence that the scoped Arunodaya pilot worked under its stated conditions. It does not prove GA scale, general customer readiness, or production operations. |
| Progression from pilot to GA | Close pilot findings; validate all ten criteria on the GA candidate; demonstrate multi-tenant/security and privacy controls, supported channel behavior, provider-backed integration operations, deployment/upgrade/rollback/recovery, observability/support ownership, and representative reliability, latency, quality, and cost against approved targets. Obtain all mandatory approvals listed below. | Release-candidate CI/security/deployment records; provider-backed pilot receipts plus repeatable operational evidence; representative baseline report with sample/denominator and configuration; recovery/incident exercises; operational and privacy/security reviews; final attributable approvals. | Evidence for a separate GA decision. No pilot result alone closes this gate. |

The required threshold values remain **PROVISIONAL**. First capture representative baseline measurements; then the relevant business, language, security, operations, and finance/provider owners review and approve or replace each target. Until then, a numeric proposal is not an acceptance threshold and cannot be reported as passed.

## Evidence levels and decision rule

Use these labels independently; evidence at one level does not imply the next:

- **Implemented:** relevant source/configuration exists. This alone proves no operating behavior.
- **Locally tested:** dated automated or manual checks ran against local/test infrastructure. Record mocks, fakes, synthetic media and disposable databases explicitly.
- **Provider-tested:** an authorized sandbox or real provider interaction has identifiers and outcome evidence. A stubbed network response is not provider-tested.
- **Pilot-validated:** an in-scope scenario ran in the agreed pilot environment, was reviewed against its acceptance condition, and has a retained record.
- **Owner-approved:** the named accountable owner accepted the scope/policy/result in a dated record. Approval is separate from a passing technical test.

This RB-01 decision review did not itself perform provider calls, deployment checks, inference or live calls. The separate 2026-10-12 Phase Alpha checkpoint freshly ran the full local suite, lint, typecheck, production build, config preflight, worker suite, disposable migration replay and real-role RLS harness. Statements here distinguish local results from staging, provider, pilot and owner-approval evidence. No item is marked owner-approved without an approval record.

## Ten release criteria: proposed acceptance and current evidence

The criterion wording below preserves the ten rows in `HALO_V1_STATUS.md` §C and `HALO_V1_RELEASE_GAPS.md`. Conditions, evidence, blockers and accountable roles are proposals. The acceptance conditions describe evidence needed for production-ready GA; pilot evidence is an intermediate input and does not by itself pass them. “Current” describes evidence found, not a release verdict.

| # | Existing criterion | Proposed measurable GA acceptance condition | Required evidence | Current repository evidence/status | Blocking gaps | Responsible role |
|---|---|---|---|---|---|---|
| 1 | Shared agent/runtime and bounded business tools work across channels | On the pinned release candidate, every in-scope channel resolves the same approved tenant and published agent version; all in-scope golden cases pass; unauthorized/unbound tools produce no side effect; false action claims = 0 in the acceptance corpus. | Dated CI report on release revision; channel/version traces; corpus scorecard; tool audit for allowed, denied and failed actions. | **Implemented; locally tested (reported):** runtime orchestration and golden tests use fakes; closed tool registry and bounds documented. No pilot deployment evidence. | Run checks on candidate revision; demonstrate actual in-scope channels and bound executors in target environment. | Runtime/release engineering owner |
| 2 | Tenant and published-agent identity are enforced | 100% of defined cross-tenant, wrong-agent/version, expired/replayed identity cases denied; 0 cross-tenant reads or writes in release security suite and target-environment review. | Dated adversarial suite output; tenant-scoped query/access review; deployed-like Auth/RLS and worker identity evidence. | **Implemented; locally tested (reported):** tenant, RLS and identity checks are documented; deployed Supabase Auth is not evidenced. | Validate current release code and target deployment boundary; review service-role paths. | Security and data-platform owner |
| 3 | Qualification, CRM outcomes, consent, DNC and campaign controls are deterministic | 100% of approved deterministic outcome cases produce the expected single state transition; DNC prevents all subsequent attempts; missing consent/authorization prevents dispatch; duplicate event replay creates at most one effect. | Case matrix and results; suppression/consent records; event IDs and destination receipts for any authorized end-to-end dispatch. | **Implemented; locally/mock tested (reported):** deterministic CRM/campaign paths and tests exist. No production campaign or consented pilot list evidenced. | Business/privacy policy and contact provenance approval; real dispatch evidence if campaigns are in scope. | CRM/campaign owner plus business/privacy owner |
| 4 | Voice control and media paths handle call lifecycle and failures | In the agreed call matrix, every start/answer/end/failure has a reconciled terminal state; interruption stops playback before another turn; provider-confirmed transfer is required before saying connected; no failure is narrated as success. | Provider call/event IDs, gateway/worker logs, reviewed interruption/handoff cases, failure injection and recovery records. | **Implemented; locally/mock tested (reported):** synthetic media and fake provider lifecycle tests. No real PSTN/speech acceptance. | Authorized carrier/line, speech route, deployed gateway/worker, live interruption and recovery evidence. | Voice/provider and operations owners |
| 5 | Controlled evaluation and learning cannot alter a live agent without review | 100% of proposal/evaluation cases leave the published version unchanged until an authorized reviewer approves publication; every approved change is attributable and rollback to prior version is demonstrated. | Evaluation inputs/results; reviewer identity and decision; immutable version diff; publish/rollback trace. | **Implemented; locally/mock tested (reported):** controlled proposals and unpublished drafts documented; no tenant-approved corpus or rollout record. | Approved corpus, named reviewer/authority, release-environment publish/rollback evidence. | Agent lifecycle/product owner |
| 6 | Usage and context budgets are bounded and attributable | Every accepted turn stays within configured context, tool-round and time bounds; 100% of pilot turns are attributable to tenant, agent/version and provider/model where available; measured provider charges reconcile to provider records within an owner-approved tolerance. | Release tests; per-turn usage/latency records; provider usage/invoice reconciliation and agreed tolerance. | **Implemented; locally tested (reported):** bounds/instrumentation documented. Context estimates are not billing guarantees; cumulative currency budget is absent per gap audit. | Set currency/spend limits and reconciliation tolerance; verify actual provider usage capture. | Runtime and finance/operations owner |
| 7 | Production campaign dispatch and scheduling have required operating configuration | Dispatch remains disabled by default; when explicitly authorized, only approved contact/time/consent cases execute; scheduling commits only after provider confirmation; retries/races yield one booking or a visible failure, never a false confirmation. | Deployment configuration review; cron/dispatch run record; consent/DNC test; provider booking ID and reconciliation or explicit out-of-scope decision. | **Partial/blocked:** explicit outbound gate is reported; production cron/carrier config absent. Booking adapter exists, but Arunodhaya voice booking is not bound. | Decide whether campaign dispatch and booking are in scope; configure and exercise only approved paths. | Release operations plus business scheduling owner |
| 8 | Release and operations evidence supports safe production activation | Candidate revision and migrations are recorded; release security/deployment gates pass; restore and rollback meet owner-approved RTO/RPO; incident escalation and alert path are exercised; the approved GA load profile and recovery targets pass. | Revision/migration ledger; security and deployment results; restore/rollback/incident exercise; monitored load/recovery report against approved GA profile. | **Partial:** dated local checks are reported; verification says no production deployment/migration. No restore, activation, load or live-call evidence found. | Name operational owners; select target environment and RTO/RPO; execute applicable release exercises. | Release/deployment and incident commander roles |
| 9 | At least two useful integrations are supported, with one exercised end-to-end in the pilot | Release owner identifies at least two useful GA integrations and their support boundaries; at least one selected integration completes a real authorized pilot transaction with acknowledged result, correlation ID, safe retry/replay behavior and reconciliation. | Approved integration/support matrix; provider/environment IDs; request/result or receipt; idempotency/retry and failure evidence; business owner acceptance. | **Implemented; locally/mock tested:** Twilio, Google Calendar, WhatsApp and webhook adapters/tests exist. No Arunodhaya provider-backed integration is evidenced. | Select integrations and destination; provide sandbox/credentials under separate authorization; capture real transaction. | Integration owner plus pilot business owner |
| 10 | Arunodhaya pilot scenarios pass with documented acceptance criteria | Every mandatory scenario in the owner-approved pilot matrix passes its safety-critical assertions; quality metrics meet approved thresholds; all failures are tracked and rerun; business owner and Telugu reviewer sign off. Separately, GA requires an approved tenant-neutral regression/acceptance corpus across supported channels. | Completed pilot scenario records, call/chat/workflow/integration IDs, reviewed transcript/audio where authorized, defect links, threshold scorecard and dated sign-offs; separate GA corpus and release-candidate report. | **Implemented; locally/mock tested (reported):** 50/50 scripted golden conversations. No approved facts, real call, native-speaker result, booking path or pilot sign-off found. | Business facts/policies, language/disclosure approval, operational contacts, provider setup and agreed thresholds are absent; no GA corpus result is evidenced. | Arunodaya pilot owner and joint release owner |

### Measurability gaps for GA

Several inherited criteria do not define a reproducible GA pass boundary. The following conditions are proposed to make those rows auditable; none is claimed to have passed. The numeric thresholds and sample sizes in the next section remain provisional until baseline measurement and owner review.

| Criterion | Why the existing wording is insufficiently measurable for GA | Proposed measurable condition and evidence (pending approval) |
|---|---|---|
| 1 | “Across channels” does not enumerate supported channels, representative cases, or a passing rule. | Maintain an owner-approved GA channel/capability matrix for voice, chat, workflows, and integrations; run each applicable golden and failure case on the pinned candidate. Report pass/total by channel, agent/version identity, unauthorized side effects, and false action claims. Require 100% of safety-critical cases to pass and all other failures to be dispositioned under approved quality criteria. |
| 4 | “Handle call lifecycle and failures” lacks a defined event/failure matrix and reconciliation rule. | For every lifecycle/failure case in an approved matrix, retain provider and HALO event IDs, terminal state, playback/interruption result, and recovery outcome; require no unreconciled terminal calls or false transfer/success claim in the reviewed release sample. Define sample and noncritical error tolerance after baseline review. |
| 5 | “Cannot alter a live agent without review” does not state which mutations are covered or how auditability is demonstrated. | Enumerate evaluation, draft, publish, rollback, and learning paths; prove with release tests and audit records that each live version change is attributable to an authorized reviewer, and that evaluation alone causes zero live-version changes. |
| 6 | “Bounded and attributable” does not set a measurable charge-reconciliation tolerance or define missing provider usage. | Record configured bounds and tenant/agent/version/provider attribution for every GA sampled turn; reconcile provider-reported usage/charges over a defined period to an owner-approved tolerance, identifying estimates and missing records. Finance/operations owner sets tolerance after baseline and provider evidence. |
| 7 | “Required operating configuration” leaves supported dispatch/scheduling modes and their safe failure behavior undefined. | Publish an approved feature matrix marking campaign dispatch and booking enabled or out of scope per channel. For enabled paths, test authorization, consent/DNC, provider confirmation, retry/replay, race and recovery cases with durable event/receipt IDs; disabled paths must reject execution. |
| 8 | “Safe production activation” does not specify target load, recovery objectives, availability window, or incident success criteria. | Approve a target deployment/load profile, measurement window, RTO/RPO, alert/incident exercise and rollback criteria; retain results against those values on the GA candidate. Values remain TBD until baseline and operations review. |
| 9 | “Useful” integrations and “supported” lack a defined support boundary; the inherited one-in-pilot condition is not a GA operational support test. | Name the integrations and supported operations in an approved matrix. For each GA-supported provider path, retain contract, authorization, retry/idempotency, failure and reconciliation evidence; separately retain at least one real provider-backed pilot transaction as pilot evidence. The owner must decide whether the existing “two useful integrations” wording means two GA-supported providers. |
| 10 | Pilot scenarios are customer-specific and cannot establish general GA readiness or cross-customer quality. | Preserve the Arunodaya pilot acceptance requirement, then additionally run an approved, tenant-neutral GA regression/acceptance corpus across all supported channels and safety classes on the release candidate. Report counts, reviewer rubric, results and defects; pilot sign-off remains necessary for the pilot only, not sufficient for GA. |

These clarifications preserve the ten criteria rather than adding criteria. Criterion 2 and 3 also require their existing adversarial/deterministic case sets to be versioned and run against the GA candidate; the current evidence is local/mock and does not demonstrate a production boundary or actual campaign operation.

## Proposed pilot-entry blockers and GA blockers

The following blockers are proposed and require owner confirmation. Close the pilot-entry blockers before Arunodaya customer-facing pilot activity:

1. Ratify the checklist mapping; approve bounded pilot scope across voice, chat, workflows, and integrations, and name accountable roles.
2. Approve dated business facts/policies, Telugu-first wording, validated English/Tenglish variants, disclosures, consent/contact rules, hours, supported tasks, forbidden actions, data use, and escalation.
3. Review pilot security/privacy controls; establish an authorized, monitored pilot environment with access, retention, rollback, and incident ownership.
4. Exercise at least one selected real provider-backed integration end-to-end in the authorized pilot, with acknowledgement, correlation, safe retry/replay and reconciliation evidence. Mocks do not close this gate.
5. Complete the approved pilot matrix across the proposed channels with language-capable reviewers; retain results, defects and dated role-based acceptance.

Progression to GA additionally requires: close or explicitly accept pilot findings; pass all ten criteria on the GA candidate with the evidence described above; establish repeatable deployment, upgrade, rollback, backup/restore, monitoring, incident response and support ownership; validate security/privacy and tenant boundaries in the target deployment; review representative quality, latency, reliability, load and cost baselines against owner-approved thresholds; and record final release approval. Pilot success alone does not meet these conditions. Security, consent, DNC, safe failure, truthful action reporting and human escalation remain mandatory wherever their behavior is in scope.

## Unresolved mandatory approvals and dependencies

No approval below is recorded. Until each applicable approval is attributable and supported, the dependent work remains blocked. Role labels intentionally avoid inventing people or claiming existing sign-offs.

| Approval needed (state) | Responsible owner role(s) | Required evidence for decision | Downstream work blocked |
|---|---|---|---|
| Confirm criterion owners and evidence acceptance for the ratified ten-criterion mapping (**PENDING — CROSS-FUNCTIONAL**) | Criterion owners and release owner | Canonical checklist linkage; evidence owner and acceptance record for each criterion | Final GA checklist closure; ratification does not establish criterion passage |
| Approve product/pilot scope and channel capability matrix (**PROPOSED — PENDING**) | Product/release owner and Arunodaya business owner | Supported tasks, channels (voice/chat/workflows/integrations), exclusions, booking/campaign decisions, pilot volume/duration and acceptance matrix | Pilot configuration and execution; channel acceptance; GA support boundary |
| Approve business facts, workflows, action authority and customer policies (**PROPOSED — PENDING**) | Arunodaya business owner; workflow/integration owner | Dated sourced fact pack and expiry; pilot tasks; permitted fields/actions/side effects and forbidden actions; operating hours; staffed escalation contacts; booking/contact rules; workflow outcomes and destination mapping | Safe prompts/configuration; workflow and integration execution; factual acceptance and safe escalation |
| Approve privacy/data handling and contact/disclosure policy (**PROPOSED — PENDING**) | Privacy/data-protection owner and Arunodaya business owner | Recording/AI disclosure, consent and contact provenance, DNC, retention/deletion/access, approved test contacts, data minimization and evidence storage | Any customer-facing voice/contact or personal-data pilot; transcript/audio retention; GA privacy gate |
| Approve language variants and review rubric (**PROPOSED — PENDING**) | Telugu language/native-speaker reviewer with business owner | Telugu-first terminology/disclosures and reviewed scripts; explicit English/Tenglish cases marked validated; rubric and dated sample review | Language-enabled pilot acceptance; any unvalidated English/Tenglish flow; GA language quality claim |
| Approve pilot integration/provider and authorize its use (**PROPOSED — PENDING**) | Integration/provider owner and Arunodaya business owner; security owner for access | Chosen integration/destination and operations; account/environment authorization; credentials/access controls; test transaction plan and evidence retention | Provider setup and real provider-backed pilot transaction; integration acceptance |
| Approve security and release-boundary evidence (**PROPOSED — PENDING**) | Security owner and data-platform owner | Versioned threat/adversarial suite; target-environment tenant isolation, authentication/authorization, Auth/RLS, service-role and secrets review; severity rubric; findings and dispositions | Pilot environment approval where applicable; GA security criterion and production access |
| Approve operational readiness and recovery targets (**PROPOSED — PENDING**) | Deployment/operations owner and incident-response owner | Target environment, deployment/migration record, support/escalation ownership, monitoring, backup/restore, rollback/incident exercise, RTO/RPO and load profile | Production-like pilot deployment; GA deployment/recovery/operational acceptance |
| Review baselines and approve numeric thresholds/budget (**PENDING — CROSS-FUNCTIONAL**) | Engineering and relevant product/business, language, security, operations, and finance/provider owners | Representative baseline with sample counts, denominators, configurations, p50/p95 and failure data; proposed thresholds, rationale and recorded owner review | Declaring numeric quality, latency, reliability, security, cost or scale criteria passed; GA release decision |
| Accept pilot outcomes (**PENDING — PILOT OWNER**) | Arunodaya pilot/business owner | Completed evidence packet, defect dispositions, explicit dated acceptance against approved scenarios | Pilot closure and any decision to progress toward GA |
| Authorize final GA go/no-go (**PENDING — RELEASE OWNER AND ACCOUNTABLE OWNERS**) | Release owner and relevant accountable owners | Separate dated GA review against all ten criteria; evidence that security, recovery and operational readiness gates passed; all applicable owner approvals and blocker dispositions | Production-ready GA authorization |

An owner may mark a proposal approved only by updating this record with the decision, approver role, date, scope/revision, and linked evidence. This proposal itself does not grant authorization to contact people, configure providers, deploy, or release.

## Provisional threshold candidates — no results implied

The repository does not establish representative live baselines or customer-approved service levels. The numbers below are **PROVISIONAL CANDIDATES — NOT ACCEPTANCE THRESHOLDS**. First measure a representative baseline on the selected deployment/provider and consented corpus; report sample counts, denominators, p50/p95, failures and configuration. Then the responsible owners review the baseline and either approve a target or replace it. No candidate threshold is passed or approved by appearing here.

| Measure | Proposed initial gate | Rationale and evidence needed |
|---|---|---|
| Voice latency | Candidate only: for 30+ representative turns, p95 end-of-user-speech to first audible response ≤ 3.0 s; p95 speech-to-text finalization ≤ 1.5 s; p95 tool completion ≤ 2.0 s excluding external provider wait, reported separately. **PROVISIONAL; baseline review first.** | No representative PSTN baseline exists; existing harness/model reports are not deployed provider measurements. |
| Chat latency | Candidate only: for 30+ representative turns, p95 response ≤ 5.0 s excluding separately reported external integration wait. **PROVISIONAL; baseline review first.** | No current customer deployment baseline; this is not an SLA. |
| Task completion | Candidate only: ≥ 90% routine task completion and 100% correct terminal handling for defined safety-critical cases. **PROVISIONAL; baseline and rubric review first.** | A 50/50 scripted corpus is not an observed task completion rate; define denominator and case labels before scoring. |
| Factual correctness | Candidate only: 100% of material claims in the reviewed sample trace to a current owner-approved source; zero unsupported high-impact promises. **PROVISIONAL; owner rubric/source review first.** | No verified commercial facts supplied. Set source freshness/expiry and reviewer rubric. |
| Tool/integration success | Candidate only: ≥ 98% successful eligible operations over at least 50 authorized attempts per provider, no duplicate side effect under replay, and honest failure reporting. **PROVISIONAL; baseline and feasibility review first.** | No provider-backed sample exists; sample size may not be feasible. Mocks do not count toward provider operation rates. |
| Escalation | Candidate only: all explicit human requests and defined high-risk cases create an approved handoff/escalation outcome; zero false live-transfer claims. **PROVISIONAL; baseline/rubric review first.** | No live escalation evidence or staffing schedule exists. Confirm staffed hours and response target. |
| Security | Candidate only: all cases in the owner-approved release adversarial suite pass, with zero severity-1/2 open findings under an approved severity rubric. **PROVISIONAL; suite and severity review first.** | Exact suite and severity definitions need security-owner ratification; deployed boundary must be included. |
| Reliability/recovery | Candidate only: ≥ 99% of eligible sessions reach a reconciled terminal state, zero lost/duplicate confirmed side effects, and all injected failures produce visible recoverable failure/escalation; restore/rollback meet agreed RTO/RPO. **PROVISIONAL; baseline and operations review first.** | No deployed load, recovery or provider availability evidence exists. Define denominator, profile and recovery objectives. |

## Arunodaya pilot acceptance plan (proposal)

### Preconditions and scope

Run only after approvals and controlled environment setup. Use approved test contacts and the owner-authorized channel. Keep outbound campaigns disabled unless separately approved. Capture only data permitted by the privacy/retention decision. A real provider sandbox/call is a provider test; a fake response or synthetic audio remains mock/local evidence.

### Telugu-first scenarios

For each applicable scenario, exercise Telugu script and spoken Telugu; include natural English/Tenglish code switching where likely. The owner/native reviewer must approve language variants, names, number and unit read-backs, AI/recording disclosures, and fallback wording. Do not infer translations or policies from current fixtures.

| ID / scenario | Expected acceptance behavior | Channel / integration evidence |
|---|---|---|
| P1 Qualification happy path | Telugu-first greeting/disclosure; collect only approved fields; preserve answer-to-field mapping; clarify ambiguous number/unit; repeat sensitive values only as approved; save one outcome. Repeat with Tenglish and English terms/code switching. | Voice and chat; compare structured facts, disposition and policy decisions. Voice requires authorized provider call and reviewed transcript/audio; chat requires deployed session record. |
| P2 Unknown/high-risk business question | Ask about price, subsidy, financing, warranty, eligibility, installation or other owner-designated high-risk facts. Answer only from dated approved facts; otherwise state limitation and escalate/callback without guessing. | Voice and chat; fact source ID/revision and reviewer verdict for every material claim. |
| P3 Consent, wrong number and DNC | Denied/missing consent blocks contact/action; wrong number ends politely; DNC stops immediately and suppresses later attempts; callback request follows approved window and channel. | Voice/chat as relevant; campaign path only in authorized test setup; verify persisted terminal/suppression state. |
| P4 Human request and handoff failure | Explicit human request triggers configured live transfer only if available; say connected only after provider confirmation. Otherwise record callback/escalation and give approved expectation. Simulate unreachable recipient and provider failure. | Voice transfer provider events or chat escalation record; reviewer verifies no false transfer claim. |
| P5 Unsupported/unauthorized action | Ask to discount, promise a visit, make a booking, disclose another customer's data, alter policy or run an unapproved action. No side effect; explain/hand off according to approved policy. | Voice and chat; tool decision/audit plus persistence diff proving no unauthorized effect. |
| P6 Booking/site visit (conditional) | Only run if booking is approved and wired on the chosen channel. Offer confirmed available slots under owner rules; confirm exactly once after provider success; stale/racing slot or provider failure must not be described as booked. | Google Calendar sandbox/authorized account plus HALO appointment record and provider event ID; mock booking separately labelled. |
| P7 Outcome delivery (conditional) | Deliver one approved structured outcome to the selected CRM/webhook/WhatsApp destination; replay does not duplicate; failed destination is visible and recoverable. | Real provider/sandbox receipt and correlation ID. Mock receiver cases test failure branches but do not close provider criterion. |
| P8 Recovery and privacy | Inject speech/provider disconnect, timeout, malformed/ambiguous reply, repeated request, prompt injection, cross-tenant identifier and authorized deletion/retention case. Recover safely or escalate; no secret or other-tenant content leaks. | Separate mock failure injection from authorized deployed boundary checks; retain event/log IDs and deletion verification without unnecessary sensitive payload. |

Voice and chat must agree on approved facts, policies, eligibility, consent/DNC, permitted tools, escalation triggers and action claims. Channel-specific wording may differ only where owner-approved. Compare a paired voice/chat case set against the same source pack and expected structured result. A channel that cannot safely support an action must not imply that it can.

### Three reusable end-to-end workflow candidates

These are **proposals only**, not verified HALO workflows, not confirmed business policy and not approved scope. Select at most those the owner wants and confirm each has an implemented, authorized path before pilot execution.

1. **Inbound inquiry → qualification → authorized follow-up:** accept an inbound Telugu/Tenglish inquiry, collect approved fields, persist lead/disposition, then deliver one summary to the owner-selected sales destination. Verify consent, idempotency, receipt and human callback fallback.
2. **Eligible inquiry → site-visit scheduling → confirmation:** only if visit rules, staff/calendar and booking authority are approved and the channel is wired. Check availability, create one provider event and HALO appointment, then send approved confirmation. Reconcile event IDs; race/failure must not claim a booking.
3. **High-risk/unknown request → human escalation → outcome closure:** detect explicit human request or unsupported/high-risk question, create escalation, attempt only an authorized live handoff or recorded callback, then attach the human disposition to the case. Verify unreachable-contact recovery and no false transfer claim.

### Integration evidence tiers

- **Mock/local:** fake fetch, in-memory provider, synthetic media, contract fixture. Use for deterministic failures, authorization boundaries and replay behavior; label results “mock/local”.
- **Provider sandbox/test:** provider-issued request/event IDs and sandbox acknowledgements; validates credentials/protocol but not necessarily production delivery, audio quality, consent, or customer acceptance.
- **Authorized real pilot:** owner-approved test contact/account, actual provider transaction and retained receipt/event IDs, reviewed outcome and failure/recovery evidence. No real call or integration was made for this proposal.

Potential candidates in repository are Twilio voice, Google Calendar, WhatsApp and workflow webhook. The gap audit reports adapter and fake-backed test evidence, but no provider-backed Arunodaya transaction. Business owner must choose which are useful; the suggested two-integration condition is not met merely by adapter presence.

### Scenario evidence record template

Copy one record per run; link artifacts in the approved access-controlled location. Avoid storing unnecessary personal data.

```text
Scenario ID / version:
Date/time and timezone:
Environment and release revision:
Tenant / published agent version:
Channel and language (Telugu / Tenglish / English):
Provider tier (mock / sandbox / authorized pilot):
Provider, model/config revision, call/session/event/correlation IDs:
Preconditions and approved fact/policy pack revision:
Expected outcome and measurable threshold:
Observed outcome; task complete? (yes/no/partial):
Latency (stage timings; p50/p95 sample context where applicable):
Facts checked and source IDs; unsupported claims (count/details):
Tool/integration requests, authorization result, side effects and receipt IDs:
Escalation/consent/DNC/failure/recovery result:
Security/privacy observations; redacted artifact links:
Reviewer role, language capability, review date and verdict:
Defect/incident link and severity; rerun reference:
Business-owner acceptance (pending / pass / fail; approver and date):
```

### Required business-owner inputs and sign-off

The Arunodaya business owner (with designated privacy, operations and language reviewers) must provide or approve:

- Dated facts with source and expiry: products, service area, eligibility, pricing/subsidy/financing, warranty, installation, support and any claims the agent may make.
- Policies: qualification fields/order, disqualifiers (if any), negotiation/concessions, booking/visit authority, consent and recording/disclosure, retention, contact provenance, DNC, retries and callback rules.
- Operating hours, time zone, service hours, holidays, calling windows, supported languages and approved Telugu/Tenglish terminology and disclosure wording.
- Supported tasks and channels, selected integrations/destinations, field mapping and permitted side effects; identify tasks explicitly out of scope.
- Named role-based escalation contacts, staffed hours, live-transfer availability, callback response target and unreachable-contact fallback.
- Forbidden actions and claims: including unauthorized commitments, financial/legal advice, unsupported eligibility, cross-customer disclosure, unapproved campaign contact and any tool not expressly granted.
- Pilot volume/duration, approved test contacts/accounts, reviewer roster, incident route, retention/access location, thresholds and severity definitions.
- Written acceptance sign-off for the final scope, fact/policy pack, scenario outcomes and known exclusions. Sign-off must identify approver role, date, release revision and evidence packet.

## Decision register

> **Moved, 2026-10-15.** This register now lives in the single authoritative decision register, [DECISIONS.md, R-series](DECISIONS.md#r-series--release-owner-decisions). Its rows were renumbered to remove an ID collision with the architecture decisions there. The mapping is D1→R1, D2→R2, … D10→R10. The decision text, states and directions were copied verbatim; no state changed. Record any later approval in DECISIONS.md, with approver role, date, scope or revision, and linked evidence.

The ratification record above (RB-01A), the measurable GA conditions, the threshold candidates and the pilot plan remain in this document.

## Evidence basis and validation boundary

Primary evidence reviewed: the four RB-01 read-first documents; `docs/HALO_IMPLEMENTATION_VERIFICATION.md`; `docs/ARUNODHAYA_AGENT.md`; `docs/ARUNODHAYA_NEGOTIATION_POLICY.md`; `docs/SECURITY.md`; `docs/DEPLOYMENT.md`; `docs/OPERATIONS.md`; `docs/PHASE4_REPORT.md`; `docs/VOICE_LATENCY_MODEL.md`; and `docs/HALO_V1_RELEASE_GAPS.md` integration and pilot matrices. In particular, the repository reports 50/50 scripted Arunodhaya golden conversations, but explicitly says this does not score real-model naturalness or speech and that no real call, approved business facts or booking tool on the voice path is evidenced. Implementation verification reports prior local checks and no production deployment/migration. Provider, pilot and owner-approval evidence remain absent for the blockers above.

No runtime files, dependencies, environment/database/provider configuration or production resources were changed. No test, inference, external call or integration was run for this proposal. Validation is limited to documentation consistency and whitespace/link checks reported separately.
