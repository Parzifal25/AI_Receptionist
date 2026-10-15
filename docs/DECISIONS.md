# HALO decision register

**Authoritative register** for HALO architecture, release and governance decisions. Consolidated on 2026-10-15, at the owner's request of 2026-10-14. Coding agents read this file together with `AGENTS.md` and [HALO_Architecture.md](HALO_Architecture.md). They never decide architecture themselves and never change a decision's state.

This register merges two earlier registers and preserves their history:

- **D-series:** this file's 2026-10-14 table (D1–D13) and its open questions (D14 and the Astra naming question). Each entry below quotes the original recommendation verbatim.
- **R-series:** the decision register of [HALO_V1_RELEASE_DECISIONS.md](HALO_V1_RELEASE_DECISIONS.md), where these entries were numbered D1–D10. They are renumbered R1–R10 here to remove the ID collision with the D-series. Their wording is preserved verbatim, and their former IDs are recorded beside them.

The consolidation added new **PENDING** questions (D15–D20) and recorded the standing instructions already in force (G-series). It approved nothing. A recommendation in this file is never an approval.

## How to use this register

**States**

- **PENDING:** a proposal or open question with no recorded owner decision. The recommendation is the author's suggestion, **not** an approval, and must not be treated as one.
- **APPROVED:** the accountable owner decided. The entry records the role, date, decision text (which may differ from the recommendation) and evidence. `RATIFIED — RELEASE OWNER DIRECTION` (R-series) and `APPROVED — standing instruction` (G-series) are forms of APPROVED with the evidence noted.
- **REJECTED:** the owner declined the proposal. The entry records who, when and why.
- **SUPERSEDED:** a later decision replaced this one. The entry links to its successor.

**Rules**

- Agents never change a state. Only the owner's explicit decision does. Record who decided, the date and the decision text.
- A new architectural question gets the next free ID (currently **D24**) and starts as PENDING.
- A **review disposition** (see [below](#review-dispositions--2026-10-15)) is a reviewer's finding, not a state. It never approves anything.
- "Blueprint §N" means the original blueprint v0.1, preserved verbatim at [archive/HALO_BLUEPRINT_v0.1.md](archive/HALO_BLUEPRINT_v0.1.md). Architecture sections ("Arch §N") refer to [HALO_Architecture.md](HALO_Architecture.md).
- The original D1–D13 came from **HALO Phase 1 plan §9 (2026-10-14)**. That plan is a proposal and is not stored in the repository. Its step identifiers (S0–S13) appear in the "Blocks" fields. Their meaning is only partly recoverable; [HALO_V1_IMPLEMENTATION_PLAN.md §9](HALO_V1_IMPLEMENTATION_PLAN.md#9-legacy-identifier-crosswalk) maps them where the context allows and flags the rest as unknown.

## Index

| ID | Topic | State | Decided by / date | Blocks (summary) |
|---|---|---|---|---|
| [G1](#g1--target-design-and-engineering-principles) | Target design and engineering principles | APPROVED — standing instruction | Owner instruction in `AGENTS.md` (2026-10-14) | — |
| [G2](#g2--operating-safety-constraints) | Operating safety constraints ($0, outbound off, log messaging) | APPROVED — standing instruction | `POA` (2026-10-13), `AGENTS.md` | Every paid, external or production action |
| [G3](#g3--agent-roles) | Agent roles (builder and reviewer) | APPROVED — standing instruction | `AGENTS.md`, blueprint §36 | — |
| [G4](#g4--documentation-authority) | Documentation authority after consolidation | APPROVED — owner instruction | Owner's consolidation request (2026-10-14) | — |
| [R1](#r-series--release-owner-decisions) | Release target: production-ready GA | RATIFIED — RELEASE OWNER DIRECTION | Release owner, 2026-10-11 | — |
| R2 | Retain the ten release criteria | RATIFIED — RELEASE OWNER DIRECTION | Release owner, 2026-10-11 | — |
| R3 | Arunodaya pilot channels: voice, chat, workflows, integrations | RATIFIED — RELEASE OWNER DIRECTION | Release owner, 2026-10-11 | — |
| R4 | Telugu-first; English/Tenglish only where validated | RATIFIED — RELEASE OWNER DIRECTION | Release owner, 2026-10-11 | — |
| R5 | At least one real provider-backed pilot integration | RATIFIED — RELEASE OWNER DIRECTION | Release owner, 2026-10-11 | — |
| R6 | Numeric thresholds provisional until baseline review | RATIFIED — RELEASE OWNER DIRECTION | Release owner, 2026-10-11 | — |
| R7 | Security, recovery and operations are mandatory GA gates | RATIFIED — RELEASE OWNER DIRECTION | Release owner, 2026-10-11 | — |
| R8 | Authorize pilot environment, data handling and provider setup | PENDING — other owner approval required | — | Pilot entry |
| R9 | Accept Arunodaya pilot evidence | PENDING — pilot owner acceptance | — | Pilot closure |
| R10 | Final GA go/no-go | PENDING — release owner and accountable owners | — | GA |
| [D1](#d1--backend-stack) | Backend stack | PENDING | — | Minimum set S1–S6; deployment design (S9) |
| [D2](#d2--repository-layout) | Repository layout | PENDING | — | — |
| [D3](#d3--pilot-carrier) | Pilot carrier | PENDING | — | External gate before S7 |
| [D4](#d4--pilot-call-direction-and-pre-carrier-harness) | Pilot call direction and pre-carrier harness | PENDING | — | Minimum set S1–S6 |
| [D5](#d5--tool-invocation-model) | Tool invocation model | PENDING | — | Minimum set S1–S6; S4.4, S4.5 |
| [D6](#d6--call-recording-in-the-pilot) | Call recording in the pilot | PENDING | — | External gate before S7; S10 |
| [D7](#d7--new-migrations-tool-executions-and-audit-logs) | New migrations (tool executions, audit logs) | `tool_executions` APPROVED, implemented and verified on a disposable database; `audit_logs` PENDING | Owner instruction, 2026-10-15 | Applying `0032` to a real database: R8, D19 |
| [D8](#d8--spend) | Spend | PENDING | — | Everything from S7 onward |
| [D9](#d9--numeric-pilot-targets) | Numeric pilot targets (latency, recognition, extraction, cost) | PENDING | — | S11 acceptance |
| [D10](#d10--dirty-tree-commit-grouping-and-the-uncommitted-0001-edit) | Dirty-tree commit grouping; uncommitted `0001` edit | APPROVED and executed | Owner instruction, 2026-10-15 | — (hosted follow-on: D21) |
| [D11](#d11--arunodhaya-facts-disclosures-consent-and-escalation-contacts) | Arunodhaya facts, disclosures, consent, escalation contacts | PENDING | — | External gate before S7; pilot facts and handoff |
| [D12](#d12--redis-sentry-object-storage) | Redis, Sentry, object storage | PENDING | — | — |
| [D13](#d13--business-process-workflow-engine) | Business-process workflow engine (blueprint §17) | PENDING | — | S8 |
| [D14](#d14--layer-1-activation-and-approved-knowledge) | Layer 1 activation and approved knowledge | Implementation authorized and completed locally (migration `0033`, disposable-DB verified); design defaults for items 1–6 await owner ratification | Owner instructions, 2026-10-14 (non-migration subset) and 2026-10-15 (completion) | Ratifying items 1–6; applying `0033` to a real database: R8, D19, D21; pilot knowledge: D11 |
| [D15](#d15--canonical-tracking-ids-eng-04-versus-eng-12) | Canonical tracking IDs: ENG-04 versus ENG-12 | PENDING | — | Backlog and record naming |
| [D16](#d16--implementation-owner-naming-astra) | Implementation-owner naming ("Astra") | PENDING | — | Role clarity |
| [D17](#d17--pilot-speech-and-llm-provider-route) | Pilot speech and LLM provider route | PENDING | — | Voice pilot; S7 |
| [D18](#d18--telemetry-export-backend-and-cross-process-correlation) | Telemetry export backend and cross-process correlation | PENDING | — | Staging observability |
| [D19](#d19--hosting-topology-and-region) | Hosting topology and region | PENDING | — | Staging (S9) |
| [D20](#d20--validated-speech-streaming-on-the-phone-path) | Validated speech streaming on the phone path | PENDING | — | Voice latency task W4.10 |
| [D21](#d21--running-migration-0001-on-hosted-supabase) | Running migration `0001` on hosted Supabase | PENDING | — | Any hosted migration (W1.6, W8.1) |
| [D22](#d22--migration-0034-tenant-reference-integrity) | Migration `0034`: tenant reference integrity and client privilege hardening | PENDING — implemented and verified on disposable databases under owner instruction; adoption needs owner approval | — | Applying `0034` to a real database: owner approval, R8, D19 |
| [D23](#d23--retention-coverage-beyond-conversations-and-calls) | Retention coverage beyond conversations and calls | PENDING | — | Pilot personal-data handling (R8) |

---

## Review dispositions — 2026-10-15

Phase 2 Workstream 2 reviewed every entry against the repository. The full matrix, with evidence, is in [HALO_DECISION_REVIEW.md](HALO_DECISION_REVIEW.md). No state changed.

| Disposition | Entries |
|---|---|
| **Settled** (in force; no action) | G1–G4; R1–R7 (direction only); D10 (executed); D7 `tool_executions`; D14 items 1–2 (match the original proposal) |
| **Engineering-resolved** (technical question answered; execution still needs authorization) | D21 method (`0001` runs unedited when the session has `extensions` on its `search_path` and `vector` is absent or in `public`); D7 audit-write failure policy |
| **Owner approval required** | R8, R9, R10; D1–D6; D7 `audit_logs`; D8; D9; D11–D13; D14 items 3–6 (item 5 diverges from the original pinning text); D15–D20; D21 execution; D22; D23 |
| **Environment evidence required** | D9 (measured baseline); D19 (hosting plan limits, region); D21 (preflight on the target connection); D22 (census on the target) |
| **Superseded / obsolete** | None |

First hosting is blocked by R8, D19, D21 and D22, by D14 if `0033` is applied, and by D8 if hosting costs money. The procedure is in [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md). It authorizes nothing.

---

## G-series — standing instructions in force

These records already have authority from owner-controlled governing documents. They are listed so the register is complete. None of them was decided by this consolidation.

### G1 — Target design and engineering principles

- **State:** APPROVED — standing instruction. **Evidence:** `AGENTS.md` (repository instructions, 2026-10-14) names the blueprint as "the target design" and adopts its engineering rules (blueprint §37, §41). No separate dated approval record exists.
- **Decision:** HALO is a multi-tenant AI employee platform: one shared runtime, many tenants, agents defined by configuration. The ten principles of blueprint §41 apply: HALO is independent of OpsCorp; customers get agents, not codebases; the runtime is shared; tools execute actions ("the LLM decides; deterministic tools act"); workflows control business processes; providers are replaceable; knowledge is controlled; tenant isolation is mandatory; context is minimized; build simple first.
- **Target design:** `AGENTS.md` designates the blueprint as a whole as the target design. Blueprint sections that agree with the implementation, or that no PENDING D-entry contests, are therefore the approved target. Examples:
  - tenant isolation (§3);
  - the agent model and versioning (§4, §23);
  - knowledge guardrails (§16);
  - separate call state and business outcome (§18);
  - structured qualification (§19);
  - provider abstraction (§26);
  - reliability without false success (§33);
  - the business adapter direction (§13, §14).
- **Scope limit:** this does **not** approve blueprint specifics that differ from the implementation and are held PENDING in D1–D20. For example, the Python/FastAPI stack (§27), the `apps/` layout (§28), Exotel (§25), outbound-first and recording (§39), and the per-tool contract and audit tables (§11, §22) all stay open. `AGENTS.md` requires such gaps to be recorded for the owner, not silently resolved.
- **2026-10-15 change:** the blueprint was archived verbatim. [HALO_Architecture.md](HALO_Architecture.md) now carries these principles as the authoritative architecture (see G4).

### G2 — Operating safety constraints

- **State:** APPROVED — standing instruction. **Evidence:** `POA` operating constraints (2026-10-13); `AGENTS.md` Safety section ("non-negotiable"); restated in the owner's consolidation request of 2026-10-14.
- **Decision:**
  - **$0 spend is a hard limit.** No paid provider, LLM, speech, carrier, messaging or calendar call, no outbound call, no deployment, and no production or shared-database write without a named owner, a target and written authorization for that exact action.
  - `HALO_OUTBOUND_ENABLED=false`; messaging stays in `log` mode.
  - The local stack uses ports 5532x; ports 5432x belong to another project.
  - Destructive checks run only against a fresh disposable `halo_check_<suffix>` database.
  - Secrets are never printed or committed. Validation uses synthetic data only.
  - The working tree is preserved.
- **Consequence:** pilot work that needs paid usage stays blocked until D8 is decided. A recommendation never lifts this constraint.

### G3 — Agent roles

- **State:** APPROVED — standing instruction. **Evidence:** `AGENTS.md` "Roles" (blueprint §36).
- **Decision:** the owner sets product and architecture. Claude Code builds and fixes. Codex reviews and debugs, and edits code only when a task assigns it a fix. Neither agent invents architecture: an architecture change enters this register as PENDING. How "Astra" (named in `POA`) relates to these roles is open (D16).

### G4 — Documentation authority

- **State:** APPROVED — owner instruction. **Evidence:** the owner's "HALO Architecture Consolidation" request to Claude Code (2026-10-14). The instruction itself is not stored in the repository; this entry records it.
- **Decision:**
  - [HALO_Architecture.md](HALO_Architecture.md) is the single authoritative architecture.
  - This file is the single authoritative decision register.
  - [HALO_V1_GAP_ANALYSIS.md](HALO_V1_GAP_ANALYSIS.md) maps V1 outcomes and architecture requirements to gaps.
  - [HALO_V1_IMPLEMENTATION_PLAN.md](HALO_V1_IMPLEMENTATION_PLAN.md) is the single dependency-ordered plan. It is a plan, not a completion claim.
  - [HALO_V1_STATUS.md](HALO_V1_STATUS.md) stays authoritative for the current status of the ten release criteria (R2).
  - The blueprint v0.1 and superseded plans and reports are preserved in [archive/](archive/README.md).
- **Consequence:** where a retained subject document disagrees with these canonical documents, the canonical documents and source code win, and the disagreement is recorded rather than silently resolved.

---

## R-series — release-owner decisions

**Source:** [HALO_V1_RELEASE_DECISIONS.md](HALO_V1_RELEASE_DECISIONS.md), "RB-01A release-owner ratification", recorded 2026-10-11 (repository date convention). Decision authority: release owner. The wording in the "Decision" and "Direction" columns is preserved verbatim from that document's decision register (former IDs D1–D10).

That document remains the detailed record of the ratification text, the proposed measurable GA acceptance conditions, the provisional threshold candidates, the pilot scenario plan (P1–P8) and the unresolved mandatory approvals. Ratification records direction only. It is not approval by Arunodaya, privacy, security, integration, language or operations owners, it does not establish that any criterion passed, and it does not authorize GA.

| ID | Former ID | Decision | State | Release-owner direction / remaining owner decision |
|---|---|---|---|---|
| R1 | D1 | Release target: production-ready general availability. | **RATIFIED — RELEASE OWNER DIRECTION** | This target is not a GA authorization. Applicable owner approvals and all mandatory gates remain required. |
| R2 | D2 | Retain all ten existing release criteria and clarify acceptance evidence. | **RATIFIED — RELEASE OWNER DIRECTION** | No criterion is marked passed by ratification; current evidence and closure remain tracked in the status register. |
| R3 | D3 | Arunodaya pilot scope: voice, chat, workflows, and integrations. | **RATIFIED — RELEASE OWNER DIRECTION** | Product/business and Arunodaya owners must still approve tasks, exclusions, policies, and whether booking, campaigns, and follow-up are in scope. |
| R4 | D4 | Language: Telugu-first; English/Tenglish only where validated. | **RATIFIED — RELEASE OWNER DIRECTION** | Telugu-capable reviewer and relevant language owner must validate Telugu acceptance and each English/Tenglish behavior claimed as supported. |
| R5 | D5 | At least one real provider-backed integration must be exercised in the pilot. | **RATIFIED — RELEASE OWNER DIRECTION** | Integration/provider and business owners must select the provider, authorize credentials and permitted live transaction, and approve evidence requirements. The other supported-integration scope in criterion 9 remains subject to owner definition. |
| R6 | D6 | Numeric acceptance thresholds remain provisional until baseline measurement and relevant owner review. | **RATIFIED — RELEASE OWNER DIRECTION** | Engineering and relevant business/release owners must review representative baselines and approve or replace thresholds before any numeric pass claim. |
| R7 | D7 | Security, recovery, and operational readiness are mandatory gates before GA authorization. | **RATIFIED — RELEASE OWNER DIRECTION** | Security and deployment/operations owners must define and supply evidence for their gates; no gate is claimed passed. |
| R8 | D8 | Authorize pilot environment, data/evidence handling, and provider setup. | **PENDING — OTHER OWNER APPROVAL REQUIRED** | Privacy/data, integration/provider, security, and deployment/operations owners must authorize their respective controls and evidence collection; no setup is authorized by this ratification. |
| R9 | D9 | Accept Arunodaya pilot evidence against approved scenarios. | **PENDING — PILOT OWNER ACCEPTANCE** | Pilot owner must review the completed evidence packet and record dated acceptance and defect disposition. |
| R10 | D10 | Make final GA go/no-go after all mandatory blockers pass. | **PENDING — RELEASE OWNER AND ACCOUNTABLE OWNERS** | Separate dated GA review against all ten criteria, applicable owner approvals, and evidence that security, recovery, and operational readiness gates passed. Final GA authorization is not approved. |

**Relationship to the D-series:** R3 sets the pilot channels but not the call direction (D4), the carrier (D3), recording (D6) or spend (D8). R6 is consistent with D9. R8 overlaps D6 (recording consent), D11 (business policy) and D19 (hosting), and none of those is approved.

---

## D-series — architecture and implementation decisions

Each entry gives the question, current evidence, options, the recommendation (never an approval), dependencies and the required approver. Evidence labels follow [HALO_Architecture.md §1.3](HALO_Architecture.md#13-evidence-levels).

### D1 — Backend stack

- **State:** PENDING. **Required approver:** owner (architecture).
- **Question:** keep the TypeScript/Node application and voice gateway plus the Python Pipecat worker, or move the backend to the blueprint's Python/FastAPI/Pydantic stack (blueprint §27)?
- **Current implementation (source):**
  - Next.js 16 App Router with TypeScript packages under `packages/*`.
  - A long-lived Node voice gateway in `services/voice-gateway`.
  - A Python Pipecat worker (`pipecat-ai` 0.0.108) in `services/pipecat-worker`.
  - 165 TypeScript test files and 7 worker test files (counted 2026-10-15; 156 at consolidation).
  - Architecture gates: `check:architecture` and `check:neutral`.
- **Options:**
  1. Keep the current stack and record it as an approved deviation. No rewrite cost, and CI gates and tests are retained. Cost: two languages to operate.
  2. Rewrite the backend in Python/FastAPI. Aligns with the blueprint, but discards a tested runtime, and no pilot benefit has been identified.
  3. Hybrid with more work moved into Python. Media is already in Python; nothing further is proposed.
- **Original recommendation (2026-10-14, verbatim):** "Keep TypeScript/Node plus the Python Pipecat worker, and record it as an approved deviation. The runtime is mature and CI-gated; a rewrite adds no pilot value."
- **Blocks:** minimum set for S1–S6; deployment design (S9). `AGENTS.md` forbids starting a rewrite while D1/D2 are open.

### D2 — Repository layout

- **State:** PENDING. **Required approver:** owner (architecture).
- **Question:** keep the current layout (`src/`, `packages/*`, `services/*`) or restructure to blueprint §28 (`apps/`, `providers/`, `tenants/`)? The blueprint itself says "the exact layout can evolve".
- **Current implementation (source):**
  - `packages/*` is industry-neutral and never imports the app. This is enforced by `check:neutral` (local test, reported 2026-10-14).
  - Business content lives in `src/content/tenants/*`.
  - **Verified leak:** `services/voice-gateway/index.ts` imports `@/core/services/voice/{sales-call,sales-config,visit-booking}` from the application layer.
- **Options:**
  1. Keep the layout and fix the leak by moving call assembly behind a port, driven by tenant configuration.
  2. Restructure to the blueprint layout: large churn, no functional gain.
  3. Keep the layout and accept the leak: the gateway stays coupled to the app layer, which complicates deploying it separately.
- **Original recommendation (2026-10-14, verbatim):** "Keep the current layout. Fix only the gateway → app-layer import leak (S4.3)."

### D3 — Pilot carrier

- **State:** PENDING. **Required approvers:** owner and compliance (Indian telecom regulation).
- **Question:** which carrier carries the Arunodhaya pilot: Exotel (blueprint §25), Twilio, or another approved option?
- **Current implementation (source):**
  - Only a Twilio Media Streams adapter and a Twilio outbound dialer exist, plus a `fake` carrier for tests.
  - There is no Exotel, Plivo or SIP adapter.
  - Twilio has never carried a call (`docs/HALO_V1_STATUS.md` §E).
- **Options:**
  1. **Twilio:** already implemented and contract-tested with fakes. Indian number availability, DLT/KYC obligations and per-minute cost were not evaluated in this repository.
  2. **Exotel:** the blueprint position and an Indian carrier. Needs a new adapter behind the existing `TelephonyProvider` port plus regulatory paperwork.
  3. **Another approved option.**
- **Original recommendation (2026-10-14, verbatim):** "Owner chooses from a price and Indian-regulatory (DLT/KYC) comparison; no paid test calls. If Exotel, start the paperwork early. Twilio is the implemented adapter."
- **Blocks:** external gate before S7. **Depends on:** D4, D8.

### D4 — Pilot call direction and pre-carrier harness

- **State:** PENDING. **Required approver:** owner (product).
- **Question:** is the pilot outbound-first (blueprint §39, v0.1), inbound-first, or both? What does the browser/fake-carrier harness prove?
- **Current implementation:**
  - **Source:** both directions are implemented. There is an inbound webhook path and an outbound dialer with a campaign engine. Dispatch throws unless `HALO_OUTBOUND_ENABLED === "true"` (`packages/campaigns/dispatch.ts`). The `/api/cron/campaigns` route exists but is **not** scheduled in `vercel.json`.
  - **Self-reported, browser-live:** a browser-microphone call through the Pipecat worker to live Sarvam ran on 2026-10-06 (`services/pipecat-worker/worker.py` docstring). This is not telephony.
  - R3 fixes the channels, not the direction. The owner's 2026-10-14 V1 outcomes list both "authorized outreach" and "incoming calls".
- **Options:**
  1. **Outbound-first:** the blueprint position. Needs consent, contact provenance and DNC policy (D11, R8), a carrier (D3) and a budget (D8).
  2. **Inbound-first:** lower consent risk. Needs a published number and a staffed handoff.
  3. **Both in the pilot:** the largest acceptance matrix.
- **Original recommendation (2026-10-14, verbatim):** "Confirm outbound. Approve the browser / fake-carrier path as **harness evidence only**, never pilot evidence."
- **Blocks:** minimum set for S1–S6.

### D5 — Tool invocation model

- **State:** PENDING. **Required approver:** owner (architecture).
- **Question:** which business actions are LLM-callable tools and which are deterministic system actions? Must every action meet the blueprint §11 tool contract (name, description, input and output schema, authorization policy, handler, timeout, retry policy) with an audit record (§5, §11, §41 principle 4)?
- **Current implementation (source):**
  - **LLM-callable tools:** a closed registry of three built-ins, `offer_concession` (side-effecting), `request_human_handoff` and `save_contact_details`. A tool is offered only when the pinned agent version grants it, it is bound, the channel allows it and its precondition holds.
  - **Tool definitions** carry a name, description, argument schema, side-effect flag, confirmation flag and optional precondition. They have **no** per-tool output schema, timeout or retry policy: the turn deadline applies, and executor failures are never retried.
  - **Deterministic system actions:** qualification, visit booking/scheduling and negotiation run before the model as `SystemActionProvider`s.
  - **Enforcement:** the act-then-narrate validator checks replies against verified action records.
  - **Records:** tool turns are stored as `messages.role = 'tool'` rows, and `tool.outcome` telemetry is emitted. Since 2026-10-15 every model tool call is also audited in `tool_executions` (D7; migration `0032`, verified on a disposable database, not applied to any shared or hosted database).
- **Options:**
  1. All actions as LLM-callable tools: blueprint-literal, but more model authority, tokens and latency.
  2. Hybrid (below).
  3. Fully deterministic, with no LLM tool calls.
- **Original recommendation (2026-10-14, verbatim):** "Hybrid: keep qualification and booking deterministic, but expose each action under the §11 contract with an audit row. LLM-callable only where judgment is needed (handoff, contact capture)."
- **Open point for the owner:** the recommendation names handoff and contact capture only. `offer_concession` is LLM-callable today, and every Arunodhaya commercial value is UNSET. The owner must decide whether concessions stay model-callable.
- **Blocks:** minimum set for S1–S6; S4.4, S4.5. **Depends on:** D7.

### D6 — Call recording in the pilot

- **State:** PENDING. **Required approvers:** owner and privacy owner.
- **Question:** does the pilot record call audio (blueprint §20; §39 v0.1 includes recording)?
- **Current implementation (source):**
  - Audio recording is **not implemented**.
  - `calls.recording_ref` and `calls.recording_consent_at` exist, with a CHECK that a recording reference requires consent (migration `0020`).
  - Text transcripts (`call_transcript_turns`) are stored.
  - The retention function (`0004`, redefined in `0020`) purges conversations and analytics past each tenant's window. **Verified 2026-10-15 (`disposable DB`, catalog cascade walk):** it also purges `calls`, with `call_events`, `call_transcript_turns` and `conversation_outcomes`. Tables outside conversations and calls are not covered; see [D23](#d23--retention-coverage-beyond-conversations-and-calls).
- **Options:**
  1. Defer recording and record the deviation.
  2. Implement recording with an approved consent and retention policy. This needs object storage (D12) and an AI/recording disclosure (D11).
- **Original recommendation (2026-10-14, verbatim):** "Needs a consent and retention policy. Otherwise approve deferral as a recorded deviation."
- **Blocks:** external gate before S7; S10.

### D7 — New migrations: tool executions and audit logs

- **State:** split on 2026-10-15.
  - **`tool_executions`: APPROVED, implemented, and verified on a disposable database.** Decided by owner instruction ("HALO D7 — Autonomous Tool-Execution Audit Implementation Loop", given to Claude Code), which directed implementation with a new additive migration. Migration `0032_tool_executions.sql` was applied and tested on 2026-10-15 **only** on fresh disposable `halo_check_*` databases (owner instruction "HALO Autonomous Engineering Loop — Complete D7 + D14"); it has not been applied to any shared, developer or hosted database.
  - **`audit_logs`: still PENDING.** The instruction did not ask for it, and the original recommendation defers it.
- **Required approver:** owner. `AGENTS.md` requires owner approval for any new migration.
- **Question:** approve the additive `tool_executions` migration (blueprint §22) now, and `audit_logs` later?
- **Before 2026-10-15 (source):** neither table existed. Partial audit trails were `messages.role='tool'`, `call_events`, `lead_state_events`, `campaign_events`, `workflow_events`, `workflow_run_logs` and `usage_events`. They remain.
- **Options:**
  1. Add `tool_executions` now and `audit_logs` later (below).
  2. Add both now.
  3. Keep the partial trails. Tool authorization decisions then stay unaudited in the database.
- **Original recommendation (2026-10-14, verbatim):** "Approve the additive `tool_executions` migration (S4.4); `audit_logs` later (S13)."
- **Blocks:** minimum set for S1–S6; S4.4. **Related:** D5, D14 (another migration that needs approval).

**What was implemented (2026-10-15).** Evidence is in [HALO_V1_STATUS.md](HALO_V1_STATUS.md#d7-tool-execution-audit--2026-10-15).

- **Data model** (`0032_tool_executions.sql`): one row per model tool call that reaches the runtime tool boundary.
  - Columns: tenant, conversation, agent and version; channel; turn and correlation ID; round; intent ID; tool name (registry names only, `null` for invented names); idempotency key; side-effect flag; status (`started`/`succeeded`/`failed`/`rejected`); rejection reason; a bounded error code; requested/started/finished times.
  - There are no columns for arguments, results, summaries, error messages or contact data.
- **Database rules** (verified on a disposable database on 2026-10-15, as real roles; see below):
  - An ownership trigger rejects a conversation, agent or version from another tenant.
  - A lifecycle trigger allows inserts only as `started`/`rejected`, and exactly one update from `started` to `succeeded`/`failed` that changes nothing else.
  - A unique index allows one execution per idempotency key per turn.
  - RLS: tenant members get SELECT; clients get no write grant; the service role writes.
  - Rows cascade with their conversation, so the existing retention purge covers them.
- **Runtime:** `packages/runtime/tools/audit.ts`, called from the single tool loop in `agent-runtime.ts`, so no tool can bypass it. Records come from trusted runtime state only, never from tool arguments.
- **Wiring:** `ChatService` (web) and the voice gateway (`PhoneTurnHandler`, `SalesCallAssembly`) use `SupabaseToolExecutionAuditStore`.
- **Audit-write failure policy:**
  - **Side-effecting tools** (`save_contact_details`, `offer_concession`): fail closed. The tool does not run unless its `started` record was written, and its result is `AUDIT_UNAVAILABLE`.
  - **The non-side-effecting handoff tool:** runs anyway, so a caller asking for a person is never blocked.
  - **Rejections:** recorded best-effort.
  - **A failed finalize** leaves the row `started` for an operator to reconcile. The action is never retried.
  - Every audit failure emits `tool.audit_failed`, carrying stage and tool name only.
- **Database verification (2026-10-15, `disposable DB`).** Fresh `pgvector/pgvector:pg16` container started from the cached image (`--pull=never`) on `127.0.0.1:55451`, databases `halo_check_d7d14` and `halo_check_d7d14_final`, with the CI Supabase stubs; never a Supabase CLI port. Full chain `0001`–`0033` applied from a clean state by `check:migrations` (exit 0). `check:rls` (exit 0, 269 assertions in total) ran the D7 section — 32 assertions — as `authenticated` with a JWT subject, `authenticated` without one, the real `anon` role, `service_role`, and the table owner where stated:
  - members read only their tenant's rows; no client UPDATE, DELETE or INSERT grant; `anon` has no access; no client privilege beyond SELECT; clients cannot execute the trigger functions; only the authenticated SELECT policy exists; the column set is exactly the accountability columns;
  - the ownership trigger refuses another tenant's conversation, agent or version and a relabelled conversation, even for the service role;
  - one execution per action and turn, while duplicate intents are still recorded as `rejected`; every runtime `ToolRejectionReason` is accepted and an unknown reason refused;
  - inserts only as `started`/`rejected`; one finalize to `succeeded`/`failed` with an identifier-shaped error code (free text refused); final and rejected rows immutable; a finalize cannot move a row to another tenant or rewrite the tool name;
  - `purge_expired_data()` removes an expired conversation's rows through the cascade and keeps current ones.
  - **Harness defects found and fixed** (not migration defects): the member-update assertion expected 0 rows where Postgres correctly refuses the statement (no grant), which crashed the harness before its later sections ever ran; and the identity-change assertion "changed" tenant B's row to tenant B, proving nothing.
  - Audit-write failure before a side-effecting tool, and a failed finalize after execution, are covered by `tests/integration/tool-execution-audit.test.ts` (`local test`); the Supabase store's column mapping matches the verified column set. The store was not run through PostgREST (none in the disposable stack).
- **Out of D7 scope:**
  - Deterministic system actions (qualification, visit booking, negotiation) are not model tools. Whether they become audited tools is part of D5.
  - Per-tool timeouts do not exist (D5), so there is no `timed_out` status.
  - Retries: tool executors are never retried, and a duplicate intent is recorded as `rejected`/`duplicate`.
  - No operator UI. Operators read the table through RLS.

### D8 — Spend

- **State:** PENDING. **Required approvers:** owner (budget) and finance.
- **Question:** what budget or exception allows paid STT, TTS, LLM and carrier usage for the pilot? G2 makes $0 a hard limit.
- **Evidence:**
  - OpenRouter: free-tier key with zero purchased credits. The selected models are priced. HTTP 402 was returned on full prompts on 2026-09-24.
  - Groq: limited to 8,000 tokens per minute (429 after about five rapid turns); remaining allowance unknown.
  - One bounded free-model inference attempt failed on 2026-10-13 (provider, [HALO_THREE_GATE_EXECUTION.md](HALO_THREE_GATE_EXECUTION.md)).
- **Original recommendation (2026-10-14, verbatim):** "The pilot needs paid STT, TTS, LLM and carrier usage. It requires an explicit budget or exception; until then S7 onward stays blocked."
- **Blocks:** everything from S7 onward, including real inference, the speech smoke test, real calls and real integrations.

### D9 — Numeric pilot targets

- **State:** PENDING. **Required approvers:** owner with the relevant business, language, operations and finance owners (R6).
- **Question:** what are the latency, recognition, extraction and cost-tolerance targets?
- **Evidence:** every candidate is unapproved, and they conflict:
  - End-of-speech to first audio p95 ≤ 3.0 s, STT p95 ≤ 1.5 s, tool p95 ≤ 2.0 s and chat p95 ≤ 5.0 s ([HALO_V1_RELEASE_DECISIONS.md](HALO_V1_RELEASE_DECISIONS.md), provisional).
  - p50 ≤ 1,200 ms / p95 ≤ 2,000 ms (archived plan §P4.3).
  - "≲1,000 ms" for natural conversation ([VOICE_LATENCY_MODEL.md](VOICE_LATENCY_MODEL.md)).
  - "<700 ms" ([VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md)).
  - No real end-to-end measurement exists. The audit **estimates** 2.0–3.5 s for the current Pipecat path.
- **Original recommendation (2026-10-14, verbatim):** "Set after the S3 measurement baseline. The candidates in the plan's §4 are unapproved."
- **Blocks:** S11 acceptance. **Depends on:** D8 (a real baseline needs real providers).

### D10 — Dirty-tree commit grouping and the uncommitted `0001` edit

- **State:** APPROVED and executed, 2026-10-15. **Decided by:** owner instruction ("HALO D10 — Autonomous Repository Baseline Completion", given to Claude Code). **Follow-on:** the hosted question that remains is [D21](#d21--running-migration-0001-on-hosted-supabase).
- **Question:** how should the large uncommitted working tree be committed? What happens to the uncommitted edit to `supabase/migrations/0001_init.sql`?
- **Original recommendation (2026-10-14, verbatim):** "Commit the working tree in coherent groups. If `0001` was applied anywhere (for example a hosted project), move the edit into a new migration instead."
- **Decision text (owner instruction, summarized):**
  - Commit the existing work in coherent local commits, with no push, on a candidate branch.
  - Never keep an edit to a migration that may have been applied.
  - If `0001` was applied anywhere relevant: preserve the edit, restore the committed `0001`, and move the change into an additive migration only if that is clear and safe.
  - Otherwise, isolate and document the change.

**Evidence for the `0001` disposition (2026-10-15)**

- **The edit (verbatim, preserved):** five lines inserted after the header comment of `0001_init.sql`:

  ```sql
  -- Hosted Supabase installs pgcrypto in the `extensions` schema, and the CLI's
  -- login role does not carry the `postgres` role's search_path. A schema that
  -- does not exist (vanilla Postgres in CI) is ignored.
  set search_path = public, extensions;
  ```

  The full edited file (SHA-256 `95e6a095…d4d3cb`) and its patch are kept outside the repository, in the operator's local backup folder `~/halo-backups/d10-preflight-20261014T194816Z/`. The patch still applies cleanly to the restored file.
- **Applied locally (`source`, read-only query):** the local HALO Supabase database (port 55322) records `0001 init` as applied, with 89 statements. None of the stored statements contains the `search_path` line, so `0001` was applied there in its original committed form. The same ledger lists `0001`–`0030`; `0031` is not applied locally. This was recorded only, not acted on.
- **Hosted status unknown:** `supabase/.temp` shows the CLI was linked to the hosted project `riwgdqogswoewfduajcl` at 17:39 on 2026-10-13. The edit was made at 18:34 the same day, and its comment describes a hosted failure. Whether any migration reached the hosted database is **unknown**: no record exists, and no hosted query was made.
- **Why no additive migration was created:** the edit is a session setting that `0001` needs **while it runs**. Its own column defaults call `gen_random_bytes` (lines 142 and 284), which hosted Supabase installs in `extensions`. A later migration runs only after `0001` has succeeded, so it cannot achieve this intent. Creating one would be an ineffective, fabricated fix.

**Outcome**

- `0001_init.sql` was restored to its committed blob `a96bb646`.
- Migration files `0001`–`0031` remain contiguous and unique. No migration was added, executed or edited.
- **Candidate:** branch `d10/baseline-candidate`, based on `cb6b7549`. It was later fast-forwarded into `main` and deleted locally, with every SHA preserved ([HALO_V1_STATUS.md](HALO_V1_STATUS.md#branch-integration-and-phase-2-tenant-isolation--2026-10-15)).
  - `8ea9fb20`: preserved code work.
  - `0dee2570`: pre-consolidation documentation.
  - `ce5816e4`: documentation consolidation.
  - The D10 record commit itself.
- Verification evidence is in [HALO_V1_STATUS.md](HALO_V1_STATUS.md#d10-repository-baseline--2026-10-15).

### D11 — Arunodhaya facts, disclosures, consent and escalation contacts

- **State:** PENDING. **Required approvers:** Arunodhaya business owner, privacy owner and a native Telugu reviewer (blueprint §16, §30, §32).
- **Question:** the dated business facts and sources, AI/recording disclosure, consent and DNC policy, calling windows, escalation contacts and staffed hours, visit rules and permitted commercial claims.
- **Evidence (source):**
  - Of 12 pilot facts, 12 are pending and none verified.
  - Every commercial value is UNSET.
  - The pilot bundle carries four explicit activation blockers and cannot publish ([HALO_LAYER_1_REVIEW.md](HALO_LAYER_1_REVIEW.md)).
- **Original recommendation (2026-10-14, verbatim):** "Existing ENG-02 blocker; needs the customer's input."
- **Blocks:** external gate before S7; pilot facts and handoff. **Rule:** missing facts stay UNSET and visible; they are never defaulted (`AGENTS.md`).

### D12 — Redis, Sentry, object storage

- **State:** PENDING. **Required approver:** owner. Cost is subject to G2 and D8.
- **Question:** when to add Redis, error tracking and object storage (blueprint §27, "where required").
- **Evidence (source):**
  - The rate limiter is in-memory and per instance.
  - Voice sessions live in gateway memory: one instance, or sticky routing.
  - No error tracking is configured.
  - Supabase Storage is used for knowledge documents; no recordings exist.
- **Original recommendation (2026-10-14, verbatim):** "Not now. Triggers: multi-instance gateway (Redis); pilot environment (error tracking); recording (object storage)."
- **Related:** D6, D18, D19.

### D13 — Business-process workflow engine

- **State:** PENDING. **Required approver:** owner (architecture).
- **Question:** how to realize blueprint §17 ("the workflow engine controls the business process").
- **Current implementation (source):**
  - `packages/workflows`: event bus, engine, timers, retries, dead letter and idempotent runs.
  - `packages/campaigns`: eligibility, calling windows, retries and suppression.
  - `packages/crm` lead lifecycle: 13 states with audited transitions.
  - The "Solar Lead Qualification" process of §17 is not defined as a workflow.
- **Original recommendation (2026-10-14, verbatim):** "Build workflow definitions on the existing workflow and campaign engines, not a new engine."
- **Blocks:** S8.

### D14 — Layer 1 activation and approved knowledge

- **State:** implementation authorized and completed locally. The non-migration subset was authorized on 2026-10-14; the owner's instruction "HALO Autonomous Engineering Loop — Complete D7 + D14" (2026-10-15, given to Claude Code) directed completing D14 with additive migrations, choosing secure, backward-compatible defaults where this register is silent, and not marking owner decisions approved to unblock work. The design choices for items 1–6 below are therefore **implementer defaults awaiting owner ratification**, not approvals. Applying `0033` to any real database remains blocked (R8, D19, D21). **Required approver:** owner.
- **Detailed evidence and the concrete migration proposal:** [HALO_LAYER_1_REVIEW.md](HALO_LAYER_1_REVIEW.md), "Current closure attempt — L1-CLOSE-20261014".
- **History (verbatim from the 2026-10-14 register):**

> **Source, 2026-10-14:** owner requested completion of Layer 1. Current draft parsing permits empty identity/objective/instructions and defaults language; publication has no activation-readiness check. Runtime knowledge collection IDs are ignored. Document indexing status does not establish business approval (blueprint §4, §16, §30).
>
> **Proposed, not approved:** retain incomplete drafts, but reject publication, rollback and runtime resolution unless required identity, objective, explicit language and effective versioned instructions are valid. Reject unsupported knowledge restrictions rather than retrieve tenant-wide. Add an additive migration for document approval provenance and tenant-owned document/collection bindings; retrieval must exclude pending, revoked and unknown facts in keyword and vector paths. Existing documents remain pending until approved; indexing readiness is separate. Pin the approved configuration and knowledge revision used by each conversation. Define legacy migration/backfill policy before enforcement; do not invent identity or approval.
>
> **Owner decision needed:** approve the concrete database knowledge access/approval design and legacy rollout. Detailed remediation card and evidence: `docs/HALO_LAYER_1_REVIEW.md`. The subsequent owner instruction authorizes safe non-migration work, recorded below; no D14 migration is approved.
>
> **2026-10-14 implementation authorization:** the owner's “HALO Layer 1 — Implementation and Closure” instruction explicitly assigns the safe non-migration fixes and requires stopping before an unapproved concrete migration. Those fixes are implemented: strict activation/read/runtime validation, pinned identity/instructions/contact authority, fail-closed unsupported collections and unapproved documents, FAQ draft/unpublish handling, and explicit unresolved pilot blockers. This does not authorize a schema change or approve Arunodaya facts.
>
> **D14 remains PENDING for database design and rollout.** Inspection found existing `knowledge_collections` and document `collection_id` in migration `0017`; reuse them rather than introduce duplicate collection tables. The concrete additive proposal, existing-data assumptions, access controls and rollback limitations are in the current closure section of `docs/HALO_LAYER_1_REVIEW.md`. No migration was created or applied. Historical legacy published agent versions lack objectives; backend reads now refuse them rather than invent objectives. The owner must approve their replacement-version/backfill rollout and the knowledge approval/revision design before database implementation.

- **Decisions still needed (from the Layer 1 closure proposal, items 1–6):**
  1. Composite tenant foreign keys reusing `0017`.
  2. Approval state and provenance for documents and FAQs, separate from indexing state.
  3. Which role may approve or revoke.
  4. Retrieval RPCs that enforce allowed collections and approval, including the semantics of an empty versus a nonempty scope.
  5. Knowledge-revision pinning versus per-turn revocation.
  6. The legacy agent-version rollout.
- **Consequence before 2026-10-15 (source, local test):** general documents could not supply answers, and nonempty collection bindings denied retrieval. Since `0033` (below), approved documents are served again, nonempty bindings are enforced, and legacy published versions without an objective still refuse to serve.

**What was implemented (2026-10-15).** Migration `0033_knowledge_governance.sql`, application changes and tests; evidence in [HALO_V1_STATUS.md](HALO_V1_STATUS.md#d7-and-d14-database-verification--2026-10-15). Defaults chosen for the six open items, each awaiting ratification:

1. **Composite tenant keys (item 1):** reuse `0017`. Unique `(id, business_id)` on collections, documents and FAQs; composite FKs document→collection and chunk→document. They are added NOT VALID and validated in the same migration only when no legacy mismatch exists; otherwise they stay NOT VALID (new rows checked), the mismatched rows are quarantined from retrieval, and the census reports them. Mismatches are never silently repaired. New revision tables and chunk→revision use composite FKs from the start.
2. **Approval separate from indexing (item 2):** immutable revision tables (`knowledge_document_revisions`, `faq_revisions`) carry review state, content hash, provenance (source type/reference; a file or URL source must name its reference), origin, and creator/submitter/reviewer/retirer with timestamps. Indexing state is a separate column. Edits never change an approved revision: they create a new one, and an open older draft or pending revision is withdrawn.
3. **Roles (item 3):** any tenant member may create, index and submit; only owner/admin may approve, reject or withdraw, enforced in the app (`requireBusiness().role`) and in the database (`auth.uid()` membership; a trigger re-checks the approver's role for every writer). No separation of duties: an owner/admin may approve their own revision, because single-owner tenants exist and nothing in this register requires four-eyes review. Editing never approves.
4. **Retrieval scope (item 4):** service-role RPCs `search_governed_knowledge` and `match_governed_knowledge_chunks` require an explicit scope array. Empty = all approved content of the tenant (bound and unbound documents, and FAQs); nonempty = only documents bound to those collections (FAQs, which have no binding, and unbound documents are excluded); an unknown, foreign or null scope raises and denies. The scope and every parent's tenant are applied inside the query on both paths. The pre-D14 RPCs keep their signatures and return governed content only. No FAQ collection binding was added.
5. **Revision pinning (item 5):** per-turn resolution of the current publication; no per-conversation snapshot. Withdrawal and replacement take effect on the next turn. Snippets carry the served `revisionId` for traceability; it is not persisted per message.
6. **Legacy rollout (item 6):**
   - **Knowledge:** nothing pre-existing is served after `0033` and nothing is approved automatically. `knowledge_governance_census()` and `knowledge_backfill_legacy()` (service role, dry run by default, one tenant per call, idempotent, never approving) prepare legacy content for human review; backfilled document drafts must then be re-indexed and submitted. `faqs.is_published` now defaults to false and is a display mirror; retrieval ignores it.
   - **Agent versions:** unchanged from 2026-10-14. Legacy published versions without an objective refuse to serve; a replacement version must be authored and published through the normal versioning path. No objective, language or approval is invented, and no agent data was changed.

**Not done, by design:** no `audit_logs` table (D7 keeps it PENDING), no separation-of-duties rule, no conversation-level knowledge snapshot, no FAQ collection binding, no Telugu text-search configuration (W2.5), and no change to D5's tool model (no tool reads knowledge).

**Review, 2026-10-15 (Phase 2 Workstream 2).** Each default was checked against the exact proposal wording in [HALO_LAYER_1_REVIEW.md](HALO_LAYER_1_REVIEW.md) and against source. The details are in [HALO_DECISION_REVIEW.md §3](HALO_DECISION_REVIEW.md#3-d14-items-16-checked-against-their-exact-wording). The state is unchanged.

| Item | Matches the proposal? | Disposition | Owner question |
|---|---|---|---|
| 1 Composite keys | Yes | Settled | — (adopted with `0033`) |
| 2 Approval separate from indexing | Yes | Settled | — (adopted with `0033`) |
| 3 Roles | Yes on owner/admin; the proposal is silent on an author approving their own revision | Owner approval required | Keep single-approver (recommended; author and approver are both recorded), or add a per-tenant "approver ≠ author" rule (migration)? |
| 4 Scope | Yes; no FAQ binding, as the proposal required | Owner approval required | Accept that collection-restricted agents never see FAQs (recommended for now: it fails toward less content), or add `faqs.collection_id` (migration)? |
| 5 Pinning | **No.** The original D14 text says "Pin … the knowledge revision used by each conversation"; the default is per-turn. | Owner approval required | Keep per-turn (recommended: withdrawal works on the next turn, and no snippet persists in history or state)? And persist the served `revisionId` per answer for traceability (migration)? Until then, an answer cannot be traced to a revision after the fact. |
| 6 Legacy rollout | Yes | Owner approval required | Accept that existing knowledge stops serving when `0033` lands, until it is backfilled and approved ([runbook §5.2](HOSTED_MIGRATION_RUNBOOK.md#52-sequence))? |

### D15 — Canonical tracking IDs: ENG-04 versus ENG-12

- **State:** PENDING OWNER APPROVAL (recorded since 2026-10-12). **Required approver:** release owner.
- **Question:** two scopes share a label. The earlier "ENG-04 Phase 2" label was given to the database migration-ledger and conversation-linkage audit (SEC-04 scope), while the engineering backlog defines ENG-04 as the pilot voice/speech route. ENG-11 is assigned to local Telugu speech.
- **Options:**
  1. Keep ENG-04 for the voice/speech route and assign ENG-12 to the database audit. This is the local recommendation in [HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md](HALO_PHASE_ALPHA_AUDIT_PREFLIGHT.md).
  2. Another numbering, with alias notes.
- **Recommendation (not approved):** option 1. Until the owner decides, use descriptive names: "pilot voice/speech route" and "database migration/linkage identity audit (SEC-04 scope)". [HALO_V1_IMPLEMENTATION_PLAN.md](HALO_V1_IMPLEMENTATION_PLAN.md) does so.
- **Source:** [HALO_PHASE_BETA_READINESS.md](HALO_PHASE_BETA_READINESS.md), "ENG-04 / ENG-12 naming decision".

### D16 — Implementation-owner naming ("Astra")

- **State:** PENDING. **Required approver:** owner.
- **Question (verbatim from the 2026-10-14 open questions):** "`POA` names "Astra" as implementation owner, while blueprint §36 and `AGENTS.md` name Claude Code (builder) and Codex (reviewer). How Astra relates to these roles is unresolved (plan §8, item 9)."
- **Options:**
  1. "Astra" is another name for the builder role in G3.
  2. Astra is a separate agent or person with its own role.
  3. Retire the name.
- **Recommendation (not approved):** record the answer here. Until then, apply no interim interpretation, and follow G3 for task ownership.

### D17 — Pilot speech and LLM provider route

- **State:** PENDING. Added at consolidation, 2026-10-15. **Required approvers:** owner, a speech/provider owner and a Telugu language reviewer (R4).
- **Question:** which speech-to-text, text-to-speech and LLM route does the pilot use, and is a local speech fallback acceptable?
- **Evidence:**
  - **Speech primary, Sarvam (source; self-reported browser-live run):**
    - Sarvam is the configured reference/primary speech provider, and `POA` and [LOCAL_SPEECH.md](LOCAL_SPEECH.md) say "Sarvam remains the primary".
    - There is no owner approval record.
    - Default models differ between paths. The worker defaults to `saarika:v2.5`/`bulbul:v2`, the gateway to `saaras:v3-realtime`/`bulbul:v3`, and `VOICE_TTS_DEFAULT_VOICE=shubh` is a v3 speaker ([VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md) §5.4).
  - **Local speech fallback, sherpa-onnx (local test):**
    - It is wired, but "its suitability as a production fallback for Telugu calls is not accepted".
    - It measured 67% WER against Sarvam's 6% on 11 clips.
    - Human audition is pending, and espeak-ng is GPL-3.0 ([LOCAL_SPEECH.md](LOCAL_SPEECH.md)).
  - **LLM route (provider, 2026-09-24):** a fixed order of Groq `openai/gpt-oss-120b`, then Groq `qwen/qwen3.8-27b` (a preview model), then OpenRouter `anthropic/claude-sonnet-4.6`, then OpenRouter `qwen/qwen3.8-27b`. [CLOUD_LLM_REPORT.md](CLOUD_LLM_REPORT.md) §4 calls this "the requested deterministic policy".
  - **The route is not pilot-capable on the current accounts:** Groq returns 429 and OpenRouter returns 402 (D8).
- **Options:**
  1. Sarvam primary with no local fallback in the pilot.
  2. Sarvam primary with the local fallback accepted for degraded mode.
  3. Evaluate at least two speech vendors on the same Telugu audio before committing ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).
  4. For the LLM: keep the chain, pin one model, or enable complexity routing (`HALO_MODEL_ROUTES`, currently unset).
- **Recommendation (not approved):**
  - Pin one speech model pair per agent and use it on both paths.
  - Treat Sarvam as the pilot candidate, subject to a controlled smoke test and native Telugu review (pilot voice/speech route task).
  - Keep the local fallback off for the pilot until the local-speech review (ENG-11) decides.
  - Choose the LLM route only once D8 provides a budget, and exclude preview models from the pilot chain.
- **Depends on:** D8, D9, R4, R5.

### D18 — Telemetry export backend and cross-process correlation

- **State:** PENDING. Added at consolidation, 2026-10-15. **Required approvers:** owner and an operations owner. Cost is subject to G2 and D8.
- **Question:** which backend receives telemetry outside the process (logs, metrics, alerts), and how are correlation IDs carried across the Next.js app, the gateway and the worker?
- **Evidence (source, local test):**
  - Telemetry is allowlisted stdout JSON, enabled with `HALO_TELEMETRY=stdout`.
  - Each HTTP request gets a correlation ID via AsyncLocalStorage, and each voice session gets its own ID.
  - Request IDs are **not** propagated across the Next→gateway HTTP or gateway→worker boundaries ([TELEMETRY.md](TELEMETRY.md)). The Pipecat `ready` frame carries a per-call `correlationId` ([PIPECAT_INTEGRATION.md](PIPECAT_INTEGRATION.md) §3).
  - Python-side metrics are uninstrumented.
  - The alert evaluator runs in-process, with no scheduler, durable store or destination.
  - There is no durable source for provider failure rates.
- **Options:**
  1. Log-derived metrics through a host log drain.
  2. An OpenTelemetry SDK and collector.
  3. A vendor APM or error tracker (overlaps D12).
- **Recommendation ([TELEMETRY.md](TELEMETRY.md), not approved):** "After backend selection, cost review and approval, adapt this single boundary to the chosen stack (prefer an OpenTelemetry SDK/collector if required by staging)."
- **Depends on:** D8, D12, D19.

### D19 — Hosting topology and region

- **State:** PENDING. Added at consolidation, 2026-10-15. **Required approvers:** owner, a deployment owner and a privacy owner.
- **Question:** where and how do the Next.js app, the long-lived voice gateway with its Pipecat worker, and the database run for staging and the pilot? This includes the region, single versus multiple gateway instances, and the data-residency position.
- **Evidence (source and documentation):**
  - **Next.js app:** the reference deployment is Vercel ([DEPLOYMENT.md](DEPLOYMENT.md)).
  - **Gateway:** must be a long-lived process, not a serverless function. Candidates named are Fly, Railway or ECS ([VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md) §6). Sessions are in memory, so it needs a single instance or sticky routing.
  - **Database:** a hosted Supabase project exists in the Sydney region ([HOSTED_SUPABASE_SETUP.md](HOSTED_SUPABASE_SETUP.md)). Hosted Auth and isolation have not been checked, and it is **not** an identified or authorized staging target ([HALO_PHASE_BETA_READINESS.md](HALO_PHASE_BETA_READINESS.md)).
  - **Latency impact:** the voice turn makes 3–4 sequential database round trips before the LLM and 2–3 after it. A database far from Indian callers adds an **estimated** 50–150 ms per trip ([VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md) §2.2).
  - **Data residency:** data-protection obligations for Indian callers were not assessed in this repository.
  - **Added 2026-10-15 (`source`; [HALO_DECISION_REVIEW.md §7](HALO_DECISION_REVIEW.md#7-hosting-and-residency-phase-f-repository-evidence-only)):**
    - `vercel.json` pins no `regions`, so the platform default applies to every function.
    - It schedules reminders and workflows every 5 minutes and no-shows every 15 minutes. Whether a $0 plan permits sub-daily crons, or commercial use, was not verified (environment evidence; interacts with D8).
    - Customer data would reach the LLM, speech, carrier, calendar and messaging vendors named there. None of their processing locations was verified, and no compliance claim follows from any region setting.
- **Options:**
  1. Co-locate the gateway, worker and database in a region near the callers.
  2. Keep the existing project's region and accept the latency.
  3. A single-instance gateway now, multi-instance with Redis later (D12).
- **Recommendation (not approved):** decide region and topology before staging, weighing latency and privacy. Do not assume the existing hosted project is the staging target.
- **Blocks:** staging (S9). **Depends on:** D1, D8, D12.

### D20 — Validated speech streaming on the phone path

- **State:** PENDING. Added at consolidation, 2026-10-15. **Required approver:** owner (architecture).
- **Question:** should phone turns stream validated sentences to TTS as they complete, or keep the documented design in which the validator sees the whole reply before anything is spoken ([VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md) §8; [VOICE_LATENCY_MODEL.md](VOICE_LATENCY_MODEL.md) §4)?
- **Current implementation (source, local test):**
  - `SafeSpeechStream` (`packages/runtime/speech-stream.ts`) exists. It releases a sentence only after it passes the validator over everything said before it.
  - When the model round was offered **any** tool, segments are held, and released only if the round ended with no tool call **and** the whole reply passed `validateReply`. Otherwise they are retracted unheard.
  - Anything already heard is never retracted. A later failure truncates the reply to the heard prefix.
  - The phone adapter does **not** pass a speech sink, so the phone path today validates the whole reply first.
- **Options:**
  1. Keep whole-reply validation: the current behaviour, simplest and highest latency.
  2. Enable validated sentence streaming on phone: lower time to first audio, and the router switches to live streaming. The residual risk is a heard prefix followed by a failure, which the stream handles by truncation.
  3. Enable it only for rounds offered no tools.
- **Recommendation (not approved):** decide after the mock-harness measurement in W4.10 and adversarial act-then-narrate tests. The latency audit ([VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md) §5.5) ranks this lever first.
- **Depends on:** D9. Voice-invariant tests are required for any change.

### D21 — Running migration `0001` on hosted Supabase

- **State:** PENDING. Added 2026-10-15 during D10. **Required approvers:** owner and the database/deployment owner.
- **Question:** how should migration `0001` be applied to a hosted Supabase database without editing a migration that has already been applied?
  - Hosted Supabase installs `pgcrypto` in the `extensions` schema.
  - According to the D10 edit's comment (unverified here), the CLI's login role does not have `extensions` on its `search_path`.
  - `0001`'s column defaults call `gen_random_bytes`, so it may fail there.
- **Evidence:**
  - `0001` is applied locally in its committed form.
  - The hosted ledger is unknown.
  - The edit is preserved outside the repository and quoted verbatim in D10.
  - An additive migration cannot help, because it would run only after `0001`.
- **Options:**
  1. **Operational (no repository change):** run the hosted migration with a connection or role whose `search_path` includes `extensions`. First prove it on a disposable database that has an `extensions` schema.
  2. **Owner-approved exception:** restore the session-only `set search_path` line in `0001`. It has no persisted schema effect, and databases that already applied `0001` skip it by version. However, it breaks the `AGENTS.md` rule against editing applied migrations, so it needs an explicit exception.
  3. **Baseline the hosted project another way:** for example, a reviewed one-off bootstrap. This needs its own design.
- **Recommendation (not approved):** option 1. Before any hosted migration, read the hosted ledger read-only under an authorized target (plan task W1.6), so it is known whether `0001` was ever attempted or applied there.
- **Depends on:** R8, D19 (target), D15 (audit naming). **Blocks:** any hosted migration or staging deployment (W8.1).

**Evidence added 2026-10-15 (Phase 2 Workstream 2; `disposable DB`).** The committed chain was replayed on the real `public.ecr.aws/supabase/postgres:17.6.1.155` image in fresh, network-less containers. Reproduce with `npm run check:supabase-image-chain`. Details: [HALO_DECISION_REVIEW.md §4](HALO_DECISION_REVIEW.md#4-d21-and-migrations-00320034-together).

| Session | Result |
|---|---|
| `search_path` without `extensions` (the reported CLI condition) | `0001` fails at line 151: `gen_random_bytes` not found. The reported failure is real. |
| Plain login as `postgres` (role config `"$user", public, extensions`), or an explicit `set search_path = public, extensions` | `0001`–`0034` apply unedited. Governed retrieval runs as `service_role`, both censuses run, and the `0033` FKs validate. |
| `vector` already installed in `extensions` | `0001` fails at line 273 **even with option 1**. The pinned `search_path = public` hides the `<=>` operator. |

- **Disposition:** the method is engineering-resolved; execution still needs the approvals above.
- **Refined recommendation (not approved):** option 1, made concrete:
  - apply with `supabase db push --db-url` as `postgres`, not `--linked`;
  - first run the read-only `infrastructure/hosted/preflight-readonly.sql` on that exact connection;
  - stop if `extensions` is missing from its `search_path`, if `vector` is outside `public`, or if the ledger and the objects disagree.

  The full procedure, including backup, the fresh and upgrade paths and the stop rules, is [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md).
- **Still unknown (environment evidence):**
  - the target's CLI-path `search_path` (the installed CLI wrapper has no binary to inspect);
  - its `vector` placement;
  - its ledger.

### D22 — Migration `0034`: tenant reference integrity

- **State:** PENDING. Added 2026-10-15. **Required approver:** owner (`AGENTS.md`: a new migration needs owner approval).
- **Context:** the owner's instruction "Branch Integration + Phase 2 Tenant-Isolation Hardening" (2026-10-15, given to Claude Code) directed Phase 2 Workstream 1: prove tenant isolation, reproduce each confirmed issue with a failing test, and fix it "at the appropriate authorization or data-access boundary" with additive migrations only. That instruction authorized the local implementation. It did not approve the migration for any real database, and this entry approves nothing.
- **Question:** adopt `0034_tenant_reference_integrity.sql`?
- **Confirmed gaps it closes** (`disposable DB`, reproduced as real roles before the fix; [TENANT_ISOLATION_EVIDENCE.md §3](TENANT_ISOLATION_EVIDENCE.md#3-confirmed-vulnerabilities-and-fixes)):
  - a tenant admin could insert a version under another tenant's agent (squatting its version numbers);
  - a tenant member could point its appointment at another tenant's staff member (blocking that tenant's slots through the cross-tenant no-overlap constraint), conversation or lead, and link its lead to another tenant's conversation;
  - 14 further tenant-to-tenant references, written only by the service role, had no database ownership check (corrected 2026-10-15 from "15"; the migration's own comment still says 15);
  - under Supabase's default grants, client roles held TRUNCATE (which ignores RLS), REFERENCES, TRIGGER, MAINTAIN and sequence privileges.
- **What it does:**
  - one generic same-tenant reference trigger, `assert_tenant_reference()`, on 19 columns of 16 tables (5 client-writable, 14 service-role only; corrected 2026-10-15 from "18");
  - `tenant_reference_census()`, service role only, to report pre-existing mismatches (triggers check new writes only);
  - revokes those client privileges, including default privileges for future objects;
  - closes two `0029` trigger functions to clients.
  It is additive: no table, column or existing function changed, and existing rows are not rewritten.
- **Verification:**
  - on fresh disposable databases: `check:migrations` exit 0 and `check:rls` 649 ok / 0 FAIL;
  - over a disposable PostgREST;
  - on the real `supabase/postgres` 17.6.1.155 image.
  It is not applied to the shared local stack or any hosted project.
- **Options:**
  1. Adopt `0034` as is.
  2. Adopt it with changes, for example also making `agents.business_id` immutable, or a generic error for `0018`.
  3. Reject it and keep the gaps documented.
- **Recommendation (not approved):** option 1. Before applying it to any real database, run `tenant_reference_census()` read-only on the target and disposition any mismatch. Never auto-repair.
- **Depends on:** R8, D19 (target), D21 (hosted migration path).
- **Review, 2026-10-15 (Phase 2 Workstream 2; [HALO_DECISION_REVIEW.md §4.3](HALO_DECISION_REVIEW.md#43-d22-review-of-0034)):** no defect found.
  - `0032`–`0034` apply together on the real Supabase image, including on top of a `0001`–`0031` database that holds legacy cross-tenant rows.
  - A database that has not reached `0034` has no `tenant_reference_census()`. The read-only preflight therefore carries the same 19 column checks, and it found a planted mismatch.
  - Rollback: dropping the triggers re-opens the references, and re-granting would re-open TRUNCATE, so prefer a forward fix.
  - Order: migrate first, then deploy the matching application ([runbook §6](HOSTED_MIGRATION_RUNBOOK.md#6-application-and-schema-compatibility)).

### D23 — Retention coverage beyond conversations and calls

- **State:** PENDING. Added 2026-10-15 by Phase 2 Workstream 2. **Required approvers:** owner and privacy owner (R8). Any change is a new migration, which needs owner approval.
- **Question:** which personal-data tables must the per-tenant retention window purge, which must be kept longer, and for how long?
- **Evidence (`disposable DB`, catalog cascade walk after the full chain on the real Supabase image; [HALO_DECISION_REVIEW.md §6](HALO_DECISION_REVIEW.md#6-retention-coverage-resolves-the-d6-unknown-opens-d23)):**
  - **Purged:** `purge_expired_data()` reaches `calls` and `conversations` with their cascades, plus `usage_events`.
  - **Never purged:**
    - `leads`, `lead_state_events`, `customers`, `customer_timeline`;
    - `appointments`, `appointment_reminders`, `appointment_feedback`, `intake_responses`;
    - `campaign_contacts`, `campaign_events`;
    - the workflow event, run, log and timer tables;
    - `learning_proposals`, `phone_suppressions`.

    Several of these hold names, numbers, emails or free text. `leads` and `appointments` survive with their conversation link set to null.
  - There is no export or deletion-on-request procedure (G2.4).
- **Options:**
  1. Extend the purge to the CRM, appointment, campaign and workflow tables with per-table windows. Keep `phone_suppressions` (DNC must outlive the window).
  2. Keep business records (appointments, customers) indefinitely by policy, and purge only operational data (workflow payloads, campaign events, intake responses).
  3. No change, and document the retention position.
- **Recommendation (not approved):** decide before the pilot holds real personal data. Option 2 is the smallest safe change, but which tables count as business records is the privacy owner's call. Never delete DNC suppressions.
- **Blocks:** pilot data handling (R8; release gate 9). Does not block first hosting with synthetic data.

---

## Change history

| Date | Change | By |
|---|---|---|
| 2026-10-14 | D1–D13 table created from HALO Phase 1 plan §9 (a proposal). D14 and the Astra question added as open questions. D14 non-migration subset authorized and implemented. | Owner instruction; plan author |
| 2026-10-15 | **Consolidation** (requested 2026-10-14). The register was restructured into per-entry form and every original recommendation was preserved verbatim. The release register was merged in as R1–R10 (formerly D1–D10 in `HALO_V1_RELEASE_DECISIONS.md`). G1–G4 standing instructions were recorded. New PENDING questions D15–D20 were added, and the Astra question became D16. No state changed and nothing was approved. | Claude Code (consolidation task) |
| 2026-10-15 | **D10 executed under owner instruction.** D10 marked APPROVED and executed. `0001` restored to its committed version, with the edit preserved and quoted. D21 added (PENDING). Candidate commits recorded in D10 and in the status register. | Owner instruction; Claude Code |
| 2026-10-15 | **D7 `tool_executions` implemented under owner instruction.** D7 is split: `tool_executions` APPROVED and implemented locally (migration `0032` written, not applied); `audit_logs` PENDING. D5's evidence line updated. No other state changed. | Owner instruction; Claude Code |
| 2026-10-15 | **D7 verified and D14 completed under owner instruction** ("HALO Autonomous Engineering Loop — Complete D7 + D14"). D7: `0032` verified as real roles on a disposable database; two harness defects fixed; state text updated, `audit_logs` still PENDING. D14: migration `0033` and application changes implemented and verified on a disposable database; the defaults for items 1–6 are recorded for owner ratification, not approved. D5's evidence line updated. No other state changed. | Owner instruction; Claude Code |
| 2026-10-15 | **Phase 2 Workstream 1 (tenant isolation) under owner instruction** ("Branch Integration + Phase 2 Tenant-Isolation Hardening"). D10, D7 and D14 work integrated into `main` by fast-forward; D22 added as PENDING for the new migration `0034` (implemented and verified on disposable databases only). No other state changed. | Owner instruction; Claude Code |
| 2026-10-15 | **Phase 2 Workstream 2 (decision review) under owner instruction** ("Close Pending Decisions and Resolve Unknowns"). Every entry received a review disposition ([HALO_DECISION_REVIEW.md](HALO_DECISION_REVIEW.md)). D21 got real-image evidence and a refined recommendation, plus [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md). D14 items 1–6 were each reviewed; item 5 diverges from the original proposal. D6's retention unknown was resolved by evidence, and D23 was added as PENDING. Evidence corrections in D1, D10, D19 and D22. **No state changed and nothing was approved.** | Owner instruction; Claude Code |
