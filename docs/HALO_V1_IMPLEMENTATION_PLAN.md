# HALO V1 implementation plan

**Date:** 2026-10-15 · **Status:** PLAN. Listing a task here is not a claim that it is done, started or approved. **Authority:** the single plan of record ([DECISIONS.md G4](DECISIONS.md#g4--documentation-authority)).

**What this plan supersedes.** It replaces three earlier plans as the plan of record: the archived [HALO_IMPLEMENTATION_PLAN.md](archive/HALO_IMPLEMENTATION_PLAN.md) (2026-09-04), the archived [HALO_V1_ENGINEERING_BACKLOG.md](archive/HALO_V1_ENGINEERING_BACKLOG.md) (2026-10-11), and the "Dependency-ordered backlog" in [HALO_V1_STATUS.md §H](HALO_V1_STATUS.md#h-dependency-ordered-backlog). Their identifiers (ENG-xx, RB/BP/CL/PV-xx, POA gates, S-steps) are mapped in [§9](#9-legacy-identifier-crosswalk). Gaps (`G…`) refer to [HALO_V1_GAP_ANALYSIS.md](HALO_V1_GAP_ANALYSIS.md), and decisions (`D…`, `R…`, `G1–G4`) to [DECISIONS.md](DECISIONS.md).

---

## 1. Planning rules

**Task execution**

1. **Task cards.** A task starts only from an owner-approved card stating: ID, objective, files in scope, out of scope, prerequisites, acceptance, commands and rollback (`AGENTS.md`). Claude Code builds; Codex reviews the diff; findings are fixed before any dependent task starts.
2. **Decisions gate tasks.** A task whose prerequisites include a PENDING decision cannot start. A recommendation in [DECISIONS.md](DECISIONS.md) is not an approval.
3. **Cost classes (G2):**
   - **$0-local:** local machine and disposable database only.
   - **auth-local:** a local write that needs a separate written authorization, such as the credential backfill.
   - **target:** needs an identified, authorized environment.
   - **spend:** needs a budget under D8. No spend task can start while D8 is PENDING.

**Required checks**

4. Every task runs the gates in `AGENTS.md`.
5. Every voice-invariant change adds a test per invariant touched: serialized turns, single playback, handoff ownership, commit-point cancellation.
6. Any prompt-composer change bumps `PROMPT_COMPOSER_VERSION`.
7. Any change to either TTS normalizer keeps the TypeScript and Python twins in parity.
8. A new migration needs an APPROVED decision, and is validated only on a fresh `halo_check_<suffix>` database.

**Recording completion**

9. A task is complete only when its completion evidence is recorded in [HALO_V1_STATUS.md](HALO_V1_STATUS.md) or a dated evidence record, labelled `source` / `local test` / `disposable DB` / `staging` / `production`. This plan is updated only to change sequencing, never to claim completion.

---

## 2. Stages and release gates

| Stage | Purpose | Entry condition | Exit evidence | Release phase | State |
|---|---|---|---|---|---|
| **S-0** Decisions and baseline | Owner decisions, commit grouping, review of this consolidation | None | DECISIONS updated by the owner; clean, grouped tree | — | **Now** |
| **S-1** Decision-free local engineering | Hardening and latency work that needs no new decision | None ($0-local) | Each task's tests and gates pass; Codex review | Alpha+ (local) | **Now** |
| **S-2** Local engineering after decisions | Architecture changes enabled by D1, D2, D5, D7, D13, D14, D17, D18, D20 | The relevant decision is APPROVED | Disposable DB migration and RLS checks for schema work; gates pass | Alpha+ (local) | Blocked per task |
| **S-3** Staging | Deploy the pinned candidate; target security, recovery and observability | D19 and R8 decided; staging target identified and authorized; $0 confirmed or D8 | Dated staging evidence per [HALO_PHASE_BETA_READINESS.md](HALO_PHASE_BETA_READINESS.md) | **Beta** | BLOCKED |
| **S-4** Provider validation | Real inference, speech, carrier, calendar and messaging under authorization | D8, D17, R5, R8, plus D3/D4 for carrier work | Provider IDs and receipts; reviewed outcomes; baseline report | Beta/Charlie | BLOCKED |
| **S-5** Pilot | Controlled Arunodhaya pilot | D6, D9, D11, R8; the S-3 and S-4 tasks the pilot uses | Signed pilot matrix; defect disposition; R9 acceptance | **Charlie** | BLOCKED |
| **S-6** GA | Evidence for the ten criteria and the mandatory gates | S-5 closed or explicitly accepted | GA packet; R10 decision | **Final** | BLOCKED |

**Already met:** Alpha (local) was COMPLETE on 2026-10-12, and the subsequent local POA and gate work is recorded in [HALO_V1_STATUS.md](HALO_V1_STATUS.md). That evidence is local only; it does not satisfy S-3 or any later stage.

---

## 3. Workstreams

| WS | Scope | Gaps | Main legacy IDs |
|---|---|---|---|
| W0 | Governance, decisions, baseline | — | S0, RB-01 |
| W1 | Tenancy, identity, data security | G1.x, G2.1, G2.6 | ENG-01, SEC-xx, database migration/linkage audit (SEC-04 scope), CL-01 |
| W2 | Agent configuration, knowledge control, data policy | G1.3, G2.2, G2.4, G2.10, G5.4, G5.5 | D14 / Layer 1, ENG-03 |
| W3 | Runtime, tools, action audit | G5.6, G7.9 | S4.4, S4.5, S13 |
| W4 | Voice pipeline latency and correctness | G6.3–G6.5, G2.8 | Latency audit levers |
| W5 | Providers, speech and Telugu quality | G3.2, G6.1, G6.2, G6.6–G6.8, G5.2 | Pilot voice/speech route (ENG-04), ENG-07, ENG-11, PV-01 |
| W6 | Business execution | G4.x, G5.1, G5.3, G7.x | ENG-02, ENG-03, ENG-05, BP-01–BP-03 |
| W7 | Telemetry and operations | G3.x | ENG-07, ENG-08 |
| W8 | Environments, deployment, recovery | G2.7, G3.6, G6.9 | ENG-08, RB-03, CL-02, POA gates 2–3 |
| W9 | Pilot acceptance | Outcome 7 and criterion 10 | ENG-06, ENG-09, RB-06, BP-04 |
| W10 | GA | All | ENG-10, CL-01–CL-04 |

---

## 4. Tasks by stage

**Columns:** "Prereqs" are tasks or decisions. "Cost" uses the classes in §1.3. "Acceptance / completion evidence" restates the gap's acceptance criteria in brief; the full criteria are in the gap analysis.

### S-0 — Decisions and baseline (owner-led; now)

| ID | Task | Gaps | Prereqs | Cost | Acceptance / completion evidence | Legacy |
|---|---|---|---|---|---|---|
| W0.1 | Owner decides the minimum decision set: D1, D2, D4, D5, D7, D10 ("minimum set for S1–S6"), plus D14 and D20 | — | — | — | Each decision recorded in DECISIONS with approver, date and text | S1–S6 prerequisites |
| W0.2 | Commit the dirty working tree in coherent groups. Never commit tracked edits without the untracked files they import. Move the `0001` edit to a new migration if `0001` was applied anywhere. | G2.6 | D10 | $0-local | Clean tree; reviewed commit groups; no applied migration edited | S0 (CL-0) |
| W0.3 | Codex reviews this documentation consolidation | — | — | $0-local | Findings dispositioned | `AGENTS.md` workflow |
| W0.4 | Owner decides governance items: D15 (ENG-04/ENG-12) and D16 ("Astra") | — | — | — | Recorded in DECISIONS; backlog and record headings updated with alias notes | Beta readiness naming decision |
| W0.5 | Request Arunodhaya business inputs early: facts, policies, disclosure, consent, escalation contacts, visit rules. This is the longest-lead item. | G5.1, G2.3, G7.6 | — | — | D11 inputs received with source and date. Engineers never fill them in. | ENG-02, RB-02 |
| W0.6 | Owner decides budget and provider route: D8, D17 | — | — | — | Recorded; unblocks S-4 | S7 gate |
| W0.7 | Owner decides hosting and target: D19, plus R8 environment and data handling | — | — | — | Recorded; unblocks S-3 | S9, POA gate 3 |

### S-1 — Decision-free local engineering ($0-local; can start now)

| ID | Task | Gaps | Prereqs | Cost | Acceptance / completion evidence | Legacy |
|---|---|---|---|---|---|---|
| W2.1 | Make the knowledge-gap gate (`isSubstantiveQuestion`) language-configurable from `packages/language` | G5.4 | — | $0-local | Telugu and Tenglish gap tests pass; English unchanged; gates pass. **Local work done 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)); awaiting Codex review. | `AGENTS.md` language rule |
| W4.1 | Apply `vad.minSpeechMs` and `bargeIn.minSpeechMs` in the Pipecat worker | G6.4 | — | $0-local | Worker test: speech shorter than the minimum does not interrupt; voice-invariant tests pass. **Local work done 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)); reviewed and corrected by Codex P2-LOOP (hangover silence and raw remote VAD start); [review](PHASE2_COMPLETION_REVIEW.md). | Latency audit §5.3 item 4 |
| W4.2 | Resolve speech model and voice IDs from one configuration on both engines (the mechanism only; the choice is D17) | G6.5 | — | $0-local | Test: gateway and worker resolve identical IDs. **Blocked on D17, 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)): configured deployments already share `VOICE_STT_MODEL`/`VOICE_TTS_MODEL` and `VOICE_PROFILES_JSON`; only the unset defaults differ, and unifying them chooses a model. **LOCALLY COMPLETE 2026-10-16 by owner decision** ([D17](DECISIONS.md#d17--pilot-speech-and-llm-provider-route), W4.2 sub-question): neither path has a built-in Sarvam model; gateway, factory, profiles and worker refuse Sarvam without one (fail-before/pass-after tests). The pair itself remains D17. | Latency audit §5.4 |
| W4.3 | Synthesize TTS chunk *n+1* while chunk *n* plays, keeping delivery accounting by marks | G6.3 | — | $0-local | Single-playback and delivery-truth tests pass; mock-harness gap per sentence reduced. **Locally complete P2-LOOP 2026-10-15** ([card](W4_3_VOICE_PIPELINING_TASK.md), [review](PHASE2_COMPLETION_REVIEW.md)); hosted evidence pending. | Audit lever 2 |
| W4.4 | Run pre-LLM reads in parallel and reuse in-memory history and state on voice turns | G6.3, G2.8 | — | $0-local | Runtime and voice tests pass; mock-harness stage time reduced | Audit lever 4 | **LOCALLY COMPLETE 2026-10-16; manual review; hosted proof pending.** See W4_4_5_9_LOCAL_VOICE_TASKS.md.
| W4.5 | Move post-reply persistence onto an ordered asynchronous queue, preserving commit-point cancellation and delivery truth | G6.3, G2.8 | — | $0-local | Commit-point and delivery-truth invariant tests pass; persistence failure still never fails a call | Audit lever 4 | **LOCALLY COMPLETE 2026-10-16; manual review; hosted proof pending.** See W4_4_5_9_LOCAL_VOICE_TASKS.md.
| W4.6 | Voice router fails over immediately (`maxWaitMs: 0` on the voice path) | G6.3 | — | $0-local | Router test. **Local work done 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)); no harness delta measured. | Audit lever 10 |
| W4.7 | Gate barge-in during "thinking" on a minimum speech duration or a non-backchannel transcript | G6.3 | W4.1 | $0-local | Turn-cancellation invariant tests pass. **Locally complete P2-LOOP 2026-10-15** ([review](PHASE2_COMPLETION_REVIEW.md)); language-specific cues and measured worker progress; matched-artifact rollout pending. | Audit lever 9 |
| W4.8 | Put the stable prompt prefix first (bump `PROMPT_COMPOSER_VERSION`; golden snapshot content unchanged, order only) | G6.3 | — | $0-local | Golden corpus passes; snapshot diff is ordering only. **Needs owner clarification, 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)): the Rules text says knowledge is "above", so moving dynamic sections after it cannot be ordering-only. **CLOSED — DEFERRED BY OWNER DECISION 2026-10-16** ([D24](DECISIONS.md#d24--prompt-section-order-w48)): facts-before-policy and the current text are retained; no composer or snapshot change. A future reorder needs a new task with revised acceptance. | Audit lever 6; archived autonomous engine G7 |
| W4.9 | Pre-connect speech sockets per call and cache fixed-line audio per tenant and voice; request μ-law TTS output | G6.3 | — | $0-local (fakes) | Worker tests; no cross-call audio leakage (test) | Audit levers 7–8 | **LOCALLY COMPLETE 2026-10-16; manual review; hosted proof pending.** See W4_4_5_9_LOCAL_VOICE_TASKS.md.
| W1.1 | Inventory service-role queries against their tenant predicates; add adversarial tests for any gap | G1.2 | — | $0-local | Reviewed inventory table; tests pass. **Local work done 2026-10-15** (Phase 2 Workstream 1: [TENANT_ISOLATION_EVIDENCE.md](TENANT_ISOLATION_EVIDENCE.md)); awaiting Codex review; migration `0034` awaits the owner (D22) | ENG-01 (SEC-02 residual) |
| W1.2 | Allow stream-token re-attach only while a session is waiting for a reconnect | G1.4 | — | $0-local | Replay test; voice invariants pass. **Local work done 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)); awaiting Codex review. | PIPECAT_INTEGRATION §6 carry-forward |
| W7.1 | Emit allowlisted telemetry for LLM router attempts, cooldowns and fallbacks | G3.3 | — | $0-local | Telemetry tests; no payload fields. **Local work done 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)). | TELEMETRY "Not covered" |
| W7.2 | Log-leak sweep test: synthetic suite with no message text, phone number or email in logs | G3.5 | — | $0-local | Test passes. **Local work done 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)); the sweep found and fixed a Resend recipient/subject log leak. | — |
| W2.2 | Review retention-function coverage against every personal-data table on a disposable DB (review only; any fix needs a migration approval) | G2.4 | — | $0-local | Coverage table recorded; gaps proposed as a D-entry if a migration is needed. **Review done 2026-10-15** ([HALO_DECISION_REVIEW.md §6](HALO_DECISION_REVIEW.md#6-retention-coverage-resolves-the-d6-unknown-opens-d23)); gap proposed as [D23](DECISIONS.md#d23--retention-coverage-beyond-conversations-and-calls) | POA gate 1 |
| W2.3 | Document `guardrails.piiRules` as inert until enforcement is decided | G2.10 | — | $0-local | Documentation and a test pin the behaviour. **Local work done 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)). | — |
| W1.3 | Authorized local calendar-credential backfill | G2.1 | Written write authorization | auth-local | Plaintext count = 0; `--verify-current` passes ([runbook](CALENDAR_CREDENTIALS_RUNBOOK.md)) | — |
| W0.8 | Update the public API reference for routes added after 2026-07 | — | — | $0-local | [API.md](API.md) covers every route in `src/app/api`. **Local work done 2026-10-15** ([report](LOCAL_RELEASE_READINESS_REPORT.md)): 30 of 30 routes. | Gap analysis §4 |

### S-2 — Local engineering after decisions

| ID | Task | Gaps | Prereqs | Cost | Acceptance / completion evidence | Legacy |
|---|---|---|---|---|---|---|
| W1.4 | Remove the gateway → app-layer import (the call assembly is injected through a port) | G4.2, principle 2 | D2 | $0-local | No `@/` import in `services/*` (add an architecture-gate rule); gateway tests pass | S4.3 |
| W3.1 | Tool contract per D5: per-tool timeout, retry and output schema where approved; decide where `offer_concession` lives | G7.9 | D5 | $0-local | Registry tests; act-then-narrate tests | S4.5 (inferred) |
| W3.2 | Additive `tool_executions` migration plus a writer for allowed, denied and failed actions. Implemented locally on 2026-10-15 against the current tool model, without waiting for W3.1, and verified as real roles on a fresh disposable database the same day; see [the status register](HALO_V1_STATUS.md#d7-and-d14-database-verification--2026-10-15). | G7.9 | D7 | $0-local (disposable DB) | **Met locally:** one row per action (`local test`); `check:migrations` and `check:rls` pass on a fresh `halo_check_*` DB (`disposable DB`). **Remaining:** apply only on an authorized target (R8, D19). | S4.4 |
| W3.3 | `audit_logs` migration | G7.9 | D7 (later phase) | $0-local | As W3.2 | S13 |
| W2.4 | D14 knowledge approval and provenance, composite foreign keys, allowed-collection RPCs, revision semantics, legacy rollout. Implemented locally on 2026-10-15 under owner instruction (migration `0033`); the item 1–6 defaults await owner ratification ([D14](DECISIONS.md#d14--layer-1-activation-and-approved-knowledge)). | G2.2, G1.1, G1.3 | D14 | $0-local (disposable DB) | **Met on a disposable DB:** pending, rejected, withdrawn, superseded and foreign content excluded by both keyword and vector paths; real-role knowledge isolation fixtures pass (`check:rls`, 128 assertions); the production runtime path passes (`knowledge-governance-db.test.ts`). **Remaining:** ratification; legacy backfill and approval on an authorized target. | Layer 1 L1-CLOSE items 1–6 |
| W2.5 | Telugu retrieval: language-aware text search or multilingual embeddings evaluation | G5.5 | New D-entry (migration), D14 | $0-local | Recall@k on an approved Telugu set meets an approved threshold | Archived plan §P3.2–P3.5 |
| W3.4 | Resolve the LLM provider per agent version behind the port | G5.6 | D17 | $0-local | Two agents use different configured models in one process (test) | KNOWN_LIMITATIONS "Other" |
| W4.10 | Validated sentence-level speech streaming on phone (`SafeSpeechStream`) | G6.3 | D20 | $0-local | Act-then-narrate adversarial tests; invariant tests; mock-harness time to first audio reduced | Audit lever 1 |
| W6.1 | Voice reschedule and cancel through `BookingService`, with confirmation | G4.3 | D5, D11 | $0-local | Exactly one appointment changed per confirmed request; no unconfirmed narration (tests) | — |
| W6.2 | Declare the pilot sales process as workflow definitions on the existing engines | G7.8 | D13, D11 | $0-local | Process expressed as configuration; tests | S8 |
| W7.3 | Propagate correlation IDs app → gateway → worker; add worker telemetry | G3.1 | D18 | $0-local | One ID traces a call across all three processes (test) | — |
| W6.3 | Recording, if approved: consent capture, object storage, retention | G2.5 | D6, D12 | $0-local first | No recording without consent; retention enforced (tests) | S10 (inferred) |

### S-3 — Staging (Beta)

All S-3 tasks need: D19 and R8 decided; an identified, authorized target; $0 confirmed or D8 decided.

| ID | Task | Gaps | Prereqs | Cost | Acceptance / completion evidence | Legacy |
|---|---|---|---|---|---|---|
| W8.1 | Provision the isolated staging target and record its identity, region and revision | — | D19, R8, W0.2 | target | Target record per [HALO_PHASE_BETA_READINESS.md](HALO_PHASE_BETA_READINESS.md) | ENG-08, RB-03, POA gate 3 |
| W8.2 | Deploy the pinned candidate with outbound off, messaging in log mode and unsupported features disabled | — | W8.1 | target | Artifact checksum, configuration review, liveness | DEPLOYMENT zero-cost procedure |
| W1.5 | Staging Auth, RLS and service-role verification; tenant A/B adversarial matrix | G1.1, G1.6 | W8.2 | target | Three-gate Gate 2 procedure passes | ENG-01, Gate 2 |
| W1.6 | Read-only migration ledger and conversation-linkage audit, using `infrastructure/hosted/preflight-readonly.sql` ([runbook §3](HOSTED_MIGRATION_RUNBOOK.md#3-read-only-preflight-every-situation)) | G1.5, G2.6 | W8.1, D15 (name), D21 | target | Aggregate-only report; anomalies dispositioned | Database audit (SEC-04 scope; ENG-12 proposed) |
| W8.3 | Restore and rollback drill against owner-approved RPO and RTO | G2.7 | W8.2, RPO/RTO approval | target (+ D8 if storage costs) | Measured RPO and RTO; post-restore tenant checks | Gate 3, ENG-08, CL-01 |
| W7.4 | Alert destination, scheduler and responder drill | G3.7 | D18, W8.2, named responder | target | Synthetic incident delivered and acknowledged | Gate 3 |
| W7.5 | Liveness-only uptime monitoring at $0 | G3.6 | W8.2 | target | Monitor active; cost evidence $0 | — |

### S-4 — Provider validation

All S-4 tasks need D8, D17, R5 and R8 decided. Carrier tasks also need D3 and D4.

| ID | Task | Gaps | Prereqs | Cost | Acceptance / completion evidence | Legacy |
|---|---|---|---|---|---|---|
| W5.1 | Bounded real LLM inference on the approved route | G5.2 | D8, D17 | spend | Three-gate Gate 1 procedure passes with usage receipts | Gate 1 |
| W5.2 | Controlled speech smoke test plus consented human Telugu recordings and review | G6.1, G6.2, G6.6, G6.7 | D8, D17, consent, reviewer | spend | WER/CER and critical-field results; reviewer forms completed | Pilot voice/speech route (ENG-04), ENG-11 |
| W5.3 | Representative latency, usage and cost baseline, so the owner can set D9 | G3.2, G3.9 | W5.1, W5.2, W4.x | spend | Baseline report with sample, denominator and configuration; owner sets D9 | S3, ENG-07, CL-02 |
| W5.4 | Local speech keep-or-retire decision with licence review | G6.8 | W5.2 | $0-local plus reviewer | Decision recorded under D17 | ENG-11, PV-01 |
| W6.4 | Authorized inbound and outbound test calls: callbacks, interruption, transfer and failure | G7.1, G7.2, G7.6 | D3, D4, D8, D11, W8.2 | spend | Provider IDs, terminal states, transfer confirmation, timings | ENG-04 voice route, RB-04 |
| W6.5 | Calendar sandbox booking lifecycle | G4.1 | R5, R8, D11 | target or spend | One event with a provider ID; race does not double-book; reconciliation | ENG-05, RB-05, BP-02 |
| W6.6 | Messaging or CRM destination delivery with idempotency | G4.5, G7.4, G7.10 | R5, R8, D8 | spend | Receipt; a replay creates no duplicate | ENG-05, CL-04 |
| W8.4 | Load test on the target host type | G6.9 | D19, D8, W8.2 | spend | Approved concurrency profile sustained | CL-02 |

### S-5 — Pilot (Charlie)

| ID | Task | Gaps | Prereqs | Cost | Acceptance / completion evidence | Legacy |
|---|---|---|---|---|---|---|
| W9.1 | Pilot entry. Load the owner-approved facts and policies as tenant data. Clear activation blockers **only** with approved data. Bind the pinned version and least-privilege tools. Configure the handoff number and hours. | G5.1, G5.3, G2.3, G7.6 | D6, D11, R8, S-3 and S-4 tasks in scope | spend | Pilot-entry blockers 1–5 in [HALO_V1_RELEASE_DECISIONS.md](HALO_V1_RELEASE_DECISIONS.md) closed with approvals | ENG-02, ENG-03, BP-01–BP-04 |
| W9.2 | Execute pilot scenarios P1–P8 (Telugu first) with a native reviewer, using the scenario evidence template | Outcome 7, criterion 10 | W9.1, D9 | spend | Signed scenario records; defects linked | ENG-06, RB-06 |
| W9.3 | Defect disposition, reconciliation of side effects, support path | — | W9.2 | spend | Issue disposition; reconciliation report | ENG-09 |
| W9.4 | Pilot owner acceptance | — | W9.3 | — | R9 recorded | R9 |

### S-6 — GA (Final)

| ID | Task | Gaps | Prereqs | Cost | Acceptance / completion evidence | Legacy |
|---|---|---|---|---|---|---|
| W10.1 | GA evidence packet for all ten criteria; tenant-neutral GA corpus; security, recovery and operations gates | All | S-5 | spend | Packet per [HALO_V1_RELEASE_DECISIONS.md](HALO_V1_RELEASE_DECISIONS.md) "Progression from pilot to GA" | ENG-10, CL-01–CL-04 |
| W10.2 | Final go/no-go | — | W10.1 | — | R10 recorded | R10 |

---

## 5. Dependency graph

```text
S-0  W0.1 (D1 D2 D4 D5 D7 D10 D14 D20) ─┬─▶ W0.2 commit groups ──────────────────────────┐
     W0.4 (D15 D16)                     │                                                │
     W0.5 business inputs (D11) ────────┼──────────────────────────────┐                 │
     W0.6 budget + route (D8 D17) ──────┼───────────────┐              │                 │
     W0.7 hosting + R8 (D19) ───────────┼──────┐        │              │                 │
                                        │      │        │              │                 │
S-1  W2.1 W4.1–W4.9 W1.1 W1.2 W7.1 W7.2 W2.2 W2.3 W0.8 (now, $0)       │                 │
                                        │      │        │              │                 │
S-2  W1.4(D2) W3.1(D5)→W3.2(D7)→W3.3  W2.4(D14)→W2.5  W3.4(D17)  W4.10(D20)              │
     W6.1(D5,D11) W6.2(D13,D11) W7.3(D18) W6.3(D6)                     │                 │
                                               ▼        │              │                 │
S-3  W8.1 target ◀─────────────────────────────────────────────────────────────── W0.2 ──┘
       └▶ W8.2 deploy ─▶ W1.5 Auth/RLS · W1.6 ledger audit · W8.3 restore · W7.4 alerts · W7.5 uptime
                                                        ▼              │
S-4  W5.1 inference · W5.2 speech review · W6.4 calls(D3,D4) · W6.5 calendar · W6.6 delivery
       └▶ W5.3 baseline ─▶ owner sets D9 ;  W5.2 ─▶ W5.4 local speech decision ; W8.4 load
                                                                       ▼
S-5  W9.1 pilot entry (D6 D11 R8) ─▶ W9.2 scenarios P1–P8 ─▶ W9.3 ─▶ W9.4 (R9)
S-6  W10.1 GA packet ─▶ W10.2 (R10)
```

**Hard serializations**

- No S-3 task before W0.2: the candidate must be a committed, pinned revision.
- No spend task before D8.
- No pilot task before D11 inputs exist. Engineers never substitute values.
- D9 targets are set **after** the W5.3 baseline (R6).
- Schema tasks run only after their decision is APPROVED, and only on disposable databases.

---

## 6. Blocking decisions

| Decision | Blocks |
|---|---|
| D1 Backend stack | W0.2 grouping is affected; any deployment design (W8.1) |
| D2 Repository layout | W1.4 |
| D3 Carrier | W6.4 |
| D4 Call direction and harness | W6.4, W9.1 scope |
| D5 Tool model | W3.1, W3.2, W6.1 |
| D6 Recording | W6.3, W9.1 |
| D7 Audit migrations | W3.2 implemented locally on 2026-10-15 (`tool_executions`); W3.3 (`audit_logs`) still PENDING |
| D8 Spend | Every S-4 task; W8.3 and W8.4 if costed; W9.x |
| D9 Numeric targets | W9.2 acceptance (set after W5.3) |
| D10 Commit grouping and `0001` | Executed 2026-10-15 (W0.2; evidence in [HALO_V1_STATUS.md](HALO_V1_STATUS.md#d10-repository-baseline--2026-10-15)) |
| D21 Running `0001` on hosted Supabase | W1.6, W8.1 and any hosted migration (procedure: [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md)) |
| D22 Migration `0034` | Applying `0034` on any target (W8.1) |
| D23 Retention coverage | A retention migration; pilot data handling (W9.1) |
| D11 Arunodhaya inputs | W6.1, W6.2, W6.4, W6.5, W9.1 |
| D12 Optional infrastructure | W6.3 (object storage), multi-instance gateway |
| D13 Workflow engine | W6.2 |
| D14 Knowledge approval | W2.4, W2.5 |
| D15 / D16 Governance | Naming of W1.6; role clarity |
| D17 Provider route | W3.4, W5.1, W5.2, W5.4 |
| D18 Telemetry backend | W7.3, W7.4 |
| D19 Hosting | W8.1, and through it every S-3 task |
| D20 Phone speech streaming | W4.10 |
| R8 Environment and data handling | Every S-3 and S-4 task; W9.1 |
| R9 / R10 | Pilot closure; GA |

---

## 7. Recommended sequencing

1. **Now, in parallel:**
   - The owner works through S-0, starting with D10 (commit grouping) and the minimum decision set. W0.5 (business inputs) is requested immediately because it has the longest lead time.
   - Engineering runs S-1. Each task is one small reviewed card.
   - Do W2.1 and W4.1 first: they are small, they close an `AGENTS.md` rule violation and a correctness gap, and they need no decision.
   - Then do the latency levers W4.3–W4.9, measured on the mock harness only. No latency claim is made until W5.3.
2. **After D10:** W0.2 produces a committed, pinned candidate.
3. **After architecture decisions:** S-2 tasks, in the order D2 → D5/D7 → D14, so that the tool audit and knowledge schema land before staging.
4. **After D19 and R8:** S-3, which unblocks Beta.
5. **After D8 and D17:** S-4, which produces the baseline for D9.
6. **After D11 and D6:** S-5, the pilot. Then S-6.

---

## 8. Risks to the plan

| Risk | Effect | Mitigation |
|---|---|---|
| D8 stays at $0 | S-4 and later cannot start; no real-provider evidence, pilot or GA | The owner decides between a budget and a web-chat-only scope under `POA` |
| Business inputs (D11) are delayed | The pilot cannot be activated | Request them at S-0; the agent stays blocked by its activation blockers |
| A latency lever breaks a voice invariant | Cross-talk, a false action claim or a lost turn | One lever per card; invariant tests are mandatory |
| Committing the dirty tree loses files | Broken build or lost work | W0.2 commits importers and imported files together; Codex reviews |
| Migration drift on the hosted project | Integrity or RLS gaps | W1.6 ledger audit before any staging migration; never edit applied migrations |
| Hosted region adds latency (D19) | Voice targets missed | Decide the region before W8.1 |

---

## 9. Legacy identifier crosswalk

### ENG backlog (archived)

The original task cards are preserved in [archive/HALO_V1_ENGINEERING_BACKLOG.md](archive/HALO_V1_ENGINEERING_BACKLOG.md).

| ENG ID | Scope | Now |
|---|---|---|
| ENG-01 | Revalidate security and identity boundaries | W1.1 (local), W1.5 (staging) |
| ENG-02 | Approve Arunodaya facts, language, consent and policy | W0.5, then W9.1 (D11) |
| ENG-03 | Pin pilot agent, tools and channel contract | W9.1, informed by W3.1 and W1.4 |
| ENG-04 | Pilot voice/speech route (naming PENDING, D15) | W5.2, W6.4 |
| ENG-05 | Select and prove pilot integrations | W6.5, W6.6 |
| ENG-06 | Telugu-first acceptance matrix | W9.2 |
| ENG-07 | Latency, usage, quality and cost baselines | W5.3 |
| ENG-08 | Target security, deployment, recovery and operations | W8.1–W8.3, W7.4 |
| ENG-09 | Close pilot findings; operational support | W9.3 |
| ENG-10 | GA evidence packet and go/no-go | W10.1, W10.2 |
| ENG-11 | Local Telugu speech keep or retire | W5.4 |
| ENG-12 (proposed; D15) | Database migration/linkage identity audit (SEC-04 scope) | W1.6 |

### HALO_V1_STATUS.md §H backlog

| ID | Now |
|---|---|
| RB-01 | W0.1, W0.4 (ten criteria ratified as R2; owner acceptance still PENDING) |
| RB-02 | W0.5 / D11 |
| RB-03 | W8.1–W8.3, W1.5 |
| RB-04 | W5.2, W6.4 |
| RB-05 | W6.5, W6.6 |
| RB-06 | W9.2–W9.4 |
| BP-01 | W9.1 |
| BP-02 | W6.5, W6.6 |
| BP-03 | W9.1 (handoff) |
| BP-04 | W5.2, W9.1 |
| CL-01 | W8.3, W10.1 |
| CL-02 | W5.3, W8.4 |
| CL-03 | W9.3, W10.1 |
| CL-04 | W6.6, W10.1 |
| PV-01 | W5.4 |
| PV-02 | D12 (distributed limits) |
| PV-03 | W2.5 |
| PV-04 | Post-V1 |

### POA gates

| POA gate | Stage |
|---|---|
| 0 Baseline and scope | S-0 |
| 1 Local remediation | S-1 |
| 2 Zero-cost operational design | W0.6, W0.7 |
| 3 Isolated staging | S-3 |
| 4 Controlled release decision | S-5, S-6 (owner) |
| 5 Post-release | After S-6 |

### S-steps cited by DECISIONS

These steps come from an unstored Phase 1 plan (2026-10-14). "Stated" means the meaning is given in the decision text. "Inferred" and "unknown" carry no authority.

| S-step | Meaning | Confidence | Now |
|---|---|---|---|
| S0 (CL-0) | Commit grouping | Stated (D10) | W0.2 |
| S1–S6 | "Minimum set" of steps before the external gate | Partially stated; exact steps unknown | S-0 to S-2 |
| S3 | Measurement baseline | Stated (D9) | W5.3 (and local W4.x measurements) |
| S4.3 | Gateway → app-layer import leak | Stated (D2) | W1.4 |
| S4.4 | `tool_executions` migration | Stated (D5, D7) | W3.2 |
| S4.5 | Tool contract work | Inferred (D5) | W3.1 |
| S7 | Start of paid and external work | Stated (D3, D6, D8, D11) | S-4 and later |
| S8 | Workflow definitions | Stated (D13) | W6.2 |
| S9 | Deployment design | Stated (D1) | W8.1 / D19 |
| S10 | Recording / privacy step | Inferred (D6); unknown | W6.3 |
| S11 | Acceptance with numeric targets | Stated (D9) | W9.2 |
| S13 | `audit_logs` | Stated (D7) | W3.3 |

### Archived 2026-09-04 plan (P0–P12)

[archive/HALO_IMPLEMENTATION_PLAN.md](archive/HALO_IMPLEMENTATION_PLAN.md): most of phases P0–P2 and P5–P9 were implemented, according to [HALO_IMPLEMENTATION_VERIFICATION.md](HALO_IMPLEMENTATION_VERIFICATION.md) and source. Its remaining design material is still useful input:

| Archived section | Feeds |
|---|---|
| P3 multilingual retrieval | W2.5 |
| P4 voice feasibility gate | W5.2, W5.3 |
| P5.8 India compliance | D3, D11, R8 |
| P10 observability and cost | W7.x, W5.3 |
| P11 security | W1.x |
