# HALO V1 gap analysis

**Date:** 2026-10-15 · **Status:** canonical gap analysis ([DECISIONS.md G4](DECISIONS.md#g4--documentation-authority)).

This document maps each owner-stated V1 outcome, and the architecture requirements behind it, to:

- the current implementation;
- the evidence for it;
- the gap or risk;
- the required change;
- dependencies;
- acceptance criteria;
- blocking decisions.

**What this document is not**

- It is not the status register. The current status of the ten release criteria stays in [HALO_V1_STATUS.md](HALO_V1_STATUS.md) (R2).
- It is not the plan. Sequencing is in [HALO_V1_IMPLEMENTATION_PLAN.md](HALO_V1_IMPLEMENTATION_PLAN.md).
- It grants no approval. A "required change" is a **proposal** unless it cites an APPROVED decision.
- Acceptance criteria are proposed. Every numeric threshold stays provisional until D9 and R6 are decided.

**Conventions**

- Evidence levels and classification labels follow [HALO_Architecture.md §1.2–1.3](HALO_Architecture.md#12-classification-labels).
- IDs in the form `G<outcome>.<n>` are gap IDs. The plan's task IDs (`W…`) reference them.
- Decision IDs (D…, R…) link to [DECISIONS.md](DECISIONS.md).

---

## 1. Summary

| # | V1 outcome | Current state | Most important gap | Blocking decisions | Local | Staging | Pilot |
|---|---|---|---|---|---|---|---|
| 1 | Tenant isolation | RLS on every table; service-role paths scoped in code; pinned agent identity | Not verified in any deployed environment; knowledge foreign keys not tenant-composite | D14, D15, D19, R8 | VERIFIED | BLOCKED | BLOCKED |
| 2 | Secure data, privacy, reliable database access | Secrets server-side; calendar credentials encrypted; retention cron; disposable restore | Consent, retention and deletion policy; knowledge approval schema; hosted backup and RPO/RTO; data residency | D6, D10, D11, D14, D19, R8 | Partial | BLOCKED | BLOCKED |
| 3 | Telemetry and observability | Allowlisted stdout telemetry; call-stage events; tenant-scoped system status; local alert evaluator | No cross-process correlation, export backend, alert delivery or real latency baseline | D8, D18, D19 | Partial | BLOCKED | BLOCKED |
| 4 | Calendar integration | Race-safe booking engine; Google, Outlook and CalDAV adapters; voice visit booking wired | No real calendar write; voice cannot reschedule or cancel; visit rules unset | D2, D11, D17, R5, R8 | Partial | BLOCKED | BLOCKED |
| 5 | Sales intelligence and tactics | Deterministic qualification and negotiation; act-then-narrate; 50/50 scripted golden conversations | No approved facts or commercial policy; no real-model Telugu quality evidence; English-only knowledge-gap and retrieval paths | D5, D9, D11, D17 | Partial | — | BLOCKED |
| 6 | Natural, accurate, low-latency Telugu voice | Pipecat path ran browser-live with Sarvam; fallbacks; interruption invariants | No measured end-to-end latency (estimated 2.0–3.5 s); no LLM→TTS streaming; no human Telugu review; no confidence-based read-back | D8, D9, D17, R4 | Partial | BLOCKED | BLOCKED |
| 7 | End-to-end sales execution | Campaign, lead lifecycle, follow-up, handoff and outcome mechanisms exist | No carrier, spend, consent policy or call direction; messaging log-only; outbound disabled; §17 process not defined | D3, D4, D7, D8, D11, D13, R5, R8 | Partial | BLOCKED | BLOCKED |

**Overall:** HALO has a substantial, locally verified implementation. Every staging, provider and pilot gate is blocked by owner decisions, budget, an environment, or business input. No outcome is pilot-ready.

The largest block of work that needs no owner decision is local-only engineering: the voice latency levers in G6.3 (mock-harness acceptance only), G6.4, the mechanism in G6.5, G5.4, G1.4, G3.3 and G3.5. These are safe at $0 under G2.

---

## 2. Outcome-by-outcome gap matrix

### Outcome 1 — Tenant isolation

#### G1.1 — Database-enforced tenant isolation

- **Current implementation:** RLS on all 41 migrated tables, via the `is_business_member` / `is_business_admin` helpers. Ownership triggers in `0020`; identity guards in `0030` and `0031`.
- **Evidence:** `disposable DB` (109 real-role assertions, 2026-10-13); `check:architecture` (`local test`).
- **Gap / risk:** no hosted or staging verification. Knowledge chunk→document and document→collection foreign keys are not tenant-composite.
- **Required change:** run the real-role isolation suite on an authorized staging target. Add composite tenant foreign keys under the D14 design (after a census of existing rows).
- **Dependencies:** staging target (D19, R8); D14 approval.
- **Acceptance criteria:** 100% of the versioned adversarial cross-tenant cases are denied on staging as `authenticated` and `service_role`. Composite foreign keys validate with zero mismatched rows, and any mismatch is dispositioned by the owner, never auto-repaired.
- **Blocking decisions:** D14, D19, R8.

#### G1.2 — Service-role paths scoped

- **Current implementation:** explicit `business_id` predicates in stores; tenant-scoped repositories; mutating routes check membership and role.
- **Evidence:** `source` ([ENG_01_SECURITY_IDENTITY_REVIEW.md](ENG_01_SECURITY_IDENTITY_REVIEW.md)); `local test` (multi-tenant isolation, widget security and agent linkage suites).
- **Gap / risk:** correctness depends on code (STATUS P0 risk). There is no inventory of service-role queries checked against a deployment (SEC-02).
- **Required change:** inventory every service-role read and write against its tenant predicate or capability, then add adversarial tests for any path without one.
- **Dependencies:** none locally; staging for deployed proof.
- **Acceptance criteria:** every service-role query is mapped to a tenant predicate or capability in a reviewed table, and the adversarial suite passes.
- **Blocking decisions:** — (local); D19 (deployed).

#### G1.3 — Published-agent identity pinned on every channel

- **Current implementation:** pinned tenant/agent/version tuples; Layer 1 activation readiness; conversations and calls bind published versions only.
- **Evidence:** `source`, `local test`, `disposable DB`.
- **Gap / risk:** legacy published versions without an objective refuse to serve, and their rollout is undecided. There is no database-level readiness constraint.
- **Required change:** create attributable replacement versions under an approved rollout (D14 item 6). Never invent objectives.
- **Dependencies:** D14.
- **Acceptance criteria:** every in-scope channel resolves the same approved version. Legacy rows are dispositioned and none is invented.
- **Blocking decisions:** D14.

#### G1.4 — Voice identity and session takeover

- **Current implementation:** the dialled number resolves the tenant; an HMAC stream token is bound to the call and both numbers; the worker cannot assert identity.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** a valid token replayed within its 120 s TTL can re-attach a session and redirect the call's audio.
- **Required change:** allow re-attach only while the session is waiting for a reconnect. The fix was deferred pending real reconnect evidence; a conservative local fix plus tests is possible now.
- **Dependencies:** none for the local fix; real reconnect behaviour needs D3 and D8.
- **Acceptance criteria:** a replayed token outside the reconnect window is rejected (test), and the voice-session invariant tests still pass.
- **Blocking decisions:** — (local).

#### G1.5 — Historical migration ledger and conversation linkage on a real target

- **Current implementation:** audit procedure defined (SEC-04 scope).
- **Evidence:** `source` only; no target inspected.
- **Gap / risk:** migration state and anomaly counts on any hosted project are unknown, which is not the same as zero.
- **Required change:** a read-only, aggregate-only audit under a target-specific authorization.
- **Dependencies:** authorized target; least-privilege identity.
- **Acceptance criteria:** the ledger matches the repository files, and linkage anomalies are counted and dispositioned.
- **Blocking decisions:** D15 (naming), D19, R8.

#### G1.6 — Dashboard Auth in a hosted environment

- **Current implementation:** proxy session refresh; fail-closed outage handling; cookie scope.
- **Evidence:** `local test` with synthetic JWTs.
- **Gap / risk:** no real hosted sign-in, refresh or logout (Gate 2 BLOCKED).
- **Required change:** an isolated Auth target with synthetic users, sending no email.
- **Dependencies:** D19, R8.
- **Acceptance criteria:** the [HALO_THREE_GATE_EXECUTION.md](HALO_THREE_GATE_EXECUTION.md) Gate 2 procedure passes.
- **Blocking decisions:** D19, R8.

### Outcome 2 — Secure data, privacy and reliable database access

#### G2.1 — Secrets and integration credentials

- **Current implementation:** environment validation; a server-only service-role client; calendar credentials encrypted with AES-256-GCM in a `v1.` envelope, with key rotation.
- **Evidence:** `source`, `local test` (55 credential tests).
- **Gap / risk:**
  - One local plaintext row is not yet encrypted, and the write awaits authorization.
  - The secret manager for the target is unknown.
  - A legacy plaintext read fallback remains.
- **Required change:**
  - Run the authorized local backfill per [CALENDAR_CREDENTIALS_RUNBOOK.md](CALENDAR_CREDENTIALS_RUNBOOK.md).
  - Run a hosted backfill only under separate authorization.
  - Remove the plaintext fallback once every database and backup has been migrated.
- **Dependencies:** write authorization; target (D19).
- **Acceptance criteria:** the plaintext-count query returns 0 and `--verify-current` passes. No secret appears in logs or responses.
- **Blocking decisions:** R8, D19.

#### G2.2 — Approved knowledge only

- **Current implementation:** unapproved document snippets are withheld; FAQs are re-read as published and tenant-owned; collection bindings fail closed.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** no approval or provenance schema exists, so general documents cannot be used at all, and knowledge revisions are not pinned.
- **Required change:** implement the approved D14 design: approval state, composite foreign keys, retrieval RPCs, revision semantics.
- **Dependencies:** D14.
- **Acceptance criteria:** pending, revoked or foreign content never reaches a prompt by either the keyword or the vector path (tests on a disposable DB). Each approved answer traces to an approver, date and source.
- **Blocking decisions:** D14.

#### G2.3 — Consent, disclosure and DNC policy

- **Current implementation:** consent on campaign contacts; `phone_suppressions`; DNC is terminal; the greeting must carry a disclosure.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** no approved lawful basis, contact provenance, disclosure wording or calling windows.
- **Required change:** an owner-approved policy pack, configured as tenant data.
- **Dependencies:** D11, R8.
- **Acceptance criteria:** the policy is recorded with approver and date. Scenario P3 (consent, wrong number, DNC) passes in the pilot.
- **Blocking decisions:** D11, R8.

#### G2.4 — Retention, deletion and export

- **Current implementation:** per-tenant `data_retention_days`, with a daily purge of conversations and analytics (`0004`).
- **Evidence:** `source`.
- **Gap / risk:**
  - Coverage of `calls`, `call_transcript_turns`, `call_events`, `conversation_state` and CRM rows is **not verified**.
  - There is no export or deletion-on-request procedure.
  - Backups and provider copies are not covered.
- **Required change:**
  - Review the retention function's coverage against every personal-data table, and propose changes. A new migration needs owner approval.
  - Define a deletion and export procedure.
- **Dependencies:** privacy owner (R8).
- **Acceptance criteria:**
  - On a disposable DB, a synthetic tenant past its window has every in-scope personal-data table purged.
  - The request procedure is approved by the privacy owner.
- **Blocking decisions:** R8.

#### G2.5 — Recording

- **Current implementation:** not implemented; a consent CHECK exists on `calls`.
- **Evidence:** `source`.
- **Gap / risk:** blueprint v0.1 includes recording in its first version.
- **Required change:** either approve deferral, or implement recording with consent, retention and object storage.
- **Dependencies:** D6, D12.
- **Acceptance criteria:** the decision is recorded. If recording is implemented: no recording is stored without consent, and retention is enforced.
- **Blocking decisions:** D6.

#### G2.6 — Migration integrity

- **Current implementation:** 31 additive migrations, plus an uncommitted edit to `0001`.
- **Evidence:** `source`, `disposable DB`.
- **Gap / risk:** an edit to a migration that may already have been applied (hosted?), and an unknown hosted ledger.
- **Required change:** decide D10. If `0001` was applied anywhere, move the edit into a new migration (owner approval).
- **Dependencies:** D10; G1.5.
- **Acceptance criteria:** no applied migration is edited, and the target ledger equals the repository's set.
- **Blocking decisions:** D10.

#### G2.7 — Backup, restore, RPO and RTO

- **Current implementation:** local synthetic dump and restore (44 table fingerprints: 41 `public` tables plus CI-stub `auth`/`storage` tables; six identity checks).
- **Evidence:** `disposable DB`.
- **Gap / risk:** no hosted backup inventory, restore drill, or approved RPO/RTO.
- **Required change:** the owner approves RPO and RTO. Restore onto an isolated target, then run the acceptance matrix in [OPERATIONS.md](OPERATIONS.md).
- **Dependencies:** D19, D8 (storage cost), R8.
- **Acceptance criteria:** measured RPO and RTO meet the approved values, and tenant and identity checks pass after restore.
- **Blocking decisions:** D19, D8, R8.

#### G2.8 — Reliable database access on the voice path

- **Current implementation:** 3–4 sequential reads before the LLM and 2–3 awaited writes after it; state load/save time out at 2 s and degrade the turn; persistence failures never fail a call.
- **Evidence:** `source` ([VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md) §2.4).
- **Gap / risk:** the added latency of a remote database (the existing project is in Sydney) is unmeasured, and the read pattern is sequential.
- **Required change:**
  - Decide the region (D19).
  - Run pre-LLM reads in parallel and reuse in-memory history and state.
  - Move post-reply persistence onto an ordered asynchronous queue, preserving the commit-point and delivery-truth invariants.
- **Dependencies:** D19; voice invariant tests.
- **Acceptance criteria:** turn-level database time is measured on the target and meets the D9 budget. Invariant tests pass for every touched invariant.
- **Blocking decisions:** D19, D9.

#### G2.9 — Data residency and Indian data protection

- **Current implementation:** not assessed.
- **Evidence:** —
- **Gap / risk:** unknown legal obligations for the pilot.
- **Required change:** a privacy owner's assessment.
- **Dependencies:** R8, D19.
- **Acceptance criteria:** a written position recorded in DECISIONS.
- **Blocking decisions:** R8, D19.

#### G2.10 — PII rules

- **Current implementation:** the `guardrails.piiRules` configuration field exists.
- **Evidence:** `source`: the field is **never read** by `packages/` or `src/`.
- **Gap / risk:** a field that looks configured but is not enforced.
- **Required change:** either implement enforcement or document the field as inert. Do not let tenants rely on it.
- **Dependencies:** owner decision if implementation is wanted.
- **Acceptance criteria:** behaviour is documented and tested.
- **Blocking decisions:** — (documenting); D-entry if implementing.

### Outcome 3 — Telemetry and operational observability

#### G3.1 — Correlation across components

- **Current implementation:** one correlation ID per HTTP request and one per voice session; a per-call `correlationId` in Pipecat `ready`.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** IDs do not cross Next→gateway or gateway→worker telemetry, and the worker emits no telemetry.
- **Required change:**
  - Propagate the correlation ID in the `/web/*` offer and in control frames.
  - Have the worker emit allowlisted events.
  - Choose the export backend.
- **Dependencies:** D18.
- **Acceptance criteria:** a single call or chat can be traced end to end by one ID across app, gateway and worker, and IDs never appear as metric labels.
- **Blocking decisions:** D18.

#### G3.2 — Stage latency

- **Current implementation:** latency marks in `call_events` (including `context_ready` and `llm_first_token`) and `voice.*` telemetry.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** no real measurement, and worker internals are not instrumented.
- **Required change:** an S3 baseline on representative authorized calls.
- **Dependencies:** D8, D17.
- **Acceptance criteria:** per-stage p50/p95 with sample size, denominator and configuration recorded.
- **Blocking decisions:** D8, D17.

#### G3.3 — Error, retry and fallback metrics

- **Current implementation:** `dependency.attempt`, `dependency.retry`, `voice.fallback`, `tool.outcome` and `booking.outcome` events.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** most LLM HTTP calls, OAuth, database and messaging paths bypass `withRetry`, so they are unmeasured. There is no durable provider failure rate.
- **Required change:** emit allowlisted events for LLM router attempts, cooldowns and fallbacks.
- **Dependencies:** none locally.
- **Acceptance criteria:** every router attempt or fallback emits one event (test), with no payloads.
- **Blocking decisions:** —

#### G3.4 — Call and lead outcomes

- **Current implementation:** `conversation_outcomes`, lead states, campaign events, analytics APIs.
- **Evidence:** `source`.
- **Gap / risk:** no approved conversion definitions or reports for the pilot.
- **Required change:** define pilot metrics such as qualified rate, appointment rate and handoff rate.
- **Dependencies:** D9.
- **Acceptance criteria:** approved definitions, and a report from the pilot data.
- **Blocking decisions:** D9.

#### G3.5 — Logging redaction and access

- **Current implementation:** logger redaction, telemetry allowlists, content-free log messaging.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** static log messages are each caller's responsibility, and no full review of log call sites has been done.
- **Required change:** review log call sites, and add a test that scans for transcript or PII leakage.
- **Dependencies:** —
- **Acceptance criteria:** the sweep finds no message text, phone number or email in logs on the synthetic suite.
- **Blocking decisions:** —

#### G3.6 — Health and readiness

- **Current implementation:** liveness; authenticated deep readiness; gateway `/health`.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** the deep probe costs money, and no hosted uptime check exists.
- **Required change:** decide the target, and use liveness-only uptime checks.
- **Dependencies:** D19, D18.
- **Acceptance criteria:** the uptime check runs at $0 on the target.
- **Blocking decisions:** D19.

#### G3.7 — Alerts

- **Current implementation:** a deterministic evaluator and a bounded in-process sink.
- **Evidence:** `local test`.
- **Gap / risk:** no scheduler, durable store, destination or named responder.
- **Required change:** choose the destination and the responder, then add the scheduler.
- **Dependencies:** D18, operations owner.
- **Acceptance criteria:** a synthetic incident is delivered and acknowledged within the approved window.
- **Blocking decisions:** D18.

#### G3.8 — Dashboards

- **Current implementation:** none; log recipes in [TELEMETRY.md](TELEMETRY.md).
- **Evidence:** —
- **Gap / risk:** no operational view.
- **Required change:** build the panels listed in TELEMETRY.md once D18 is decided.
- **Dependencies:** D18.
- **Acceptance criteria:** request rate, 5xx rate, p50/p95, fallbacks and booking rejections are visible per component.
- **Blocking decisions:** D18.

#### G3.9 — Cost per call

- **Current implementation:** token usage when the provider reports it.
- **Evidence:** `source`.
- **Gap / risk:** no currency figure and no invoice reconciliation (criterion 6).
- **Required change:** a pricing table and a reconciliation procedure.
- **Dependencies:** D8, finance owner.
- **Acceptance criteria:** estimated per-call cost reconciles to the provider invoice within an approved tolerance.
- **Blocking decisions:** D8, R6.

### Outcome 4 — Calendar integration

#### G4.1 — Real calendar booking

- **Current implementation:** availability engine; `BookingService`; GiST exclusion; Google adapter with OAuth and encrypted tokens.
- **Evidence:** `local test` with fakes.
- **Gap / risk:** no real calendar API booking, free/busy check or reconciliation.
- **Required change:** an authorized Google sandbox or pilot calendar run.
- **Dependencies:** R5 (selection), R8, D11 (rules), D8 if any cost.
- **Acceptance criteria:**
  - Free/busy returns real availability.
  - Booking creates exactly one event with a provider ID.
  - Under a race or a provider failure, no false booking is reported.
  - The HALO appointment reconciles to the calendar event.
- **Blocking decisions:** R5, R8, D11.

#### G4.2 — Voice booking path

- **Current implementation:** `VisitBookingStepProvider` → `visit-booking.ts` → `BookingService`; idempotent per conversation; exact read-back and confirmation.
- **Evidence:** `source`, `local test`.
- **Gap / risk:**
  - It is imported by the gateway from the application layer (D2).
  - It uses the business's staff calendar configuration, and the Arunodhaya visit rules are unset.
- **Required change:** fix the D2 import leak, and configure staff, calendar and visit rules as tenant data.
- **Dependencies:** D2, D11.
- **Acceptance criteria:** scenario P6 (in [HALO_V1_RELEASE_DECISIONS.md](HALO_V1_RELEASE_DECISIONS.md)) passes.
- **Blocking decisions:** D2, D11.

#### G4.3 — Rescheduling and cancelling on voice

- **Current implementation:** web chat and self-service links support book, reschedule and cancel. The voice `VisitBookingPort` has only `offerSlots` and `book`.
- **Evidence:** `source`.
- **Gap / risk:** a caller cannot reschedule or cancel by phone.
- **Required change:** extend the voice step through the existing `BookingService` reschedule and cancel operations, with confirmation.
- **Dependencies:** D5 (whether this is a tool or a system action); D11 (policy).
- **Acceptance criteria:** reschedule and cancel by voice change exactly one appointment after an explicit confirmation, and never narrate an unconfirmed action.
- **Blocking decisions:** D5, D11.

#### G4.4 — Calendar credentials

See G2.1.

#### G4.5 — Confirmations and reminders delivered

- **Current implementation:** ICS, email and WhatsApp content and reminder cron exist; messaging is in `log` mode.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** nothing is actually delivered.
- **Required change:** select a messaging provider and destination, then authorize real delivery.
- **Dependencies:** R5, R8, D8.
- **Acceptance criteria:** one real reminder is delivered with a provider receipt, and a replay does not duplicate it.
- **Blocking decisions:** R5, R8, D8; G2 log mode.

### Outcome 5 — Sales intelligence and tactics

#### G5.1 — Approved facts and commercial policy

- **Current implementation:** 12 pilot facts pending, 0 verified; every commercial value UNSET; four activation blockers.
- **Evidence:** `source`.
- **Gap / risk:** the agent cannot answer a commercial question or authorize anything involving money.
- **Required change:** a dated, sourced fact pack and commercial policy from the business owner.
- **Dependencies:** D11.
- **Acceptance criteria:** every material claim in the reviewed sample traces to an approved source, and there are zero unsupported high-impact promises (the provisional criterion in RELEASE_DECISIONS).
- **Blocking decisions:** D11.

#### G5.2 — Objection handling and conversation quality with a real model

- **Current implementation:** objection detection; tenant-authored acknowledgements; "never say" lists; limited live smoke tests.
- **Evidence:** `local test` (50/50 scripted); `provider` smoke test (2026-09-24).
- **Gap / risk:** no real-model quality evaluation on Telugu or Tenglish at scale, and no reviewer rubric.
- **Required change:** a corpus evaluation with a real model and a native reviewer.
- **Dependencies:** D8, D17, reviewer.
- **Acceptance criteria:** an approved rubric, with scores at or above the D9 thresholds.
- **Blocking decisions:** D8, D9, D17.

#### G5.3 — Qualification accuracy on speech

- **Current implementation:** read-back only for `confirm: true` fields (`monthly_bill`, `phone`). No STT confidence is reported, so confidence-gated read-back never fires.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** a misheard name, area or capacity is stored without confirmation.
- **Required change:** the owner decides which fields require read-back (D11). Evaluate STT confidence availability (D17).
- **Dependencies:** D11, D17.
- **Acceptance criteria:** misheard-field scenarios are caught or confirmed in the pilot matrix.
- **Blocking decisions:** D11, D17.

#### G5.4 — Knowledge-gap detection in Telugu

- **Current implementation:** `isSubstantiveQuestion` matches English greetings and interrogatives only.
- **Evidence:** `source`.
- **Gap / risk:** on Telugu turns, knowledge gaps are never recorded and the "repeated misunderstanding" escalation cannot fire. This breaks the `AGENTS.md` rule that regex and word-list checks must be language-configurable.
- **Required change:** make the gate language-configurable using the existing `packages/language` lexicon.
- **Dependencies:** —
- **Acceptance criteria:** Telugu and Tenglish questions with no knowledge are recorded as gaps (tests). English behaviour is unchanged.
- **Blocking decisions:** —

#### G5.5 — Telugu retrieval quality

- **Current implementation:** full-text search uses the `english` dictionary; embeddings are optional (768-dimension, Ollama).
- **Evidence:** `source`.
- **Gap / risk:** poor Telugu recall.
- **Required change:** evaluate a language-aware text configuration or multilingual embeddings (archived plan Phase 3 §P3.2).
- **Dependencies:** a migration (owner approval); D14.
- **Acceptance criteria:** recall@k on an approved Telugu question set meets an approved threshold.
- **Blocking decisions:** new D-entry when proposed; D14.

#### G5.6 — Per-agent model choice

- **Current implementation:** `getLLMProvider()` is process-global.
- **Evidence:** `source`.
- **Gap / risk:** a voice agent and a chat agent cannot use different models, and a tenant cannot pin one.
- **Required change:** resolve the provider per agent version, behind the port.
- **Dependencies:** D17.
- **Acceptance criteria:** two agents in one process use their configured models (test).
- **Blocking decisions:** D17.

#### G5.7 — Controlled learning

- **Current implementation:** proposals, evaluation, and review into an unpublished draft.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** no approved corpus or reviewer.
- **Required change:** an owner-approved corpus and a named reviewer.
- **Dependencies:** R9-type owner.
- **Acceptance criteria:** a proposal → review → publish → rollback trail is recorded on the target.
- **Blocking decisions:** R8, R9.

### Outcome 6 — Natural, accurate, low-latency Telugu voice

#### G6.1 — Telugu STT accuracy on phone audio

- **Current implementation:** Sarvam measured 6% WER and local speech 67% WER on 11 benchmark clips (not phone audio). Human FLEURS audio is missing.
- **Evidence:** `local test` (benchmark).
- **Gap / risk:** no consented human Telugu phone-band evaluation.
- **Required change:** record per the consent log and recording manifest, then evaluate WER, CER and critical-field accuracy.
- **Dependencies:** consent, D8, D17.
- **Acceptance criteria:** metrics meet the D9 thresholds, and a native reviewer signs off (R4).
- **Blocking decisions:** D8, D9, D17.

#### G6.2 — TTS naturalness

- **Current implementation:** Sarvam and local voices; review packets built.
- **Evidence:** `local test` (synthesis only).
- **Gap / risk:** no human has listened to the output.
- **Required change:** a native panel review using [LOCAL_TELUGU_REVIEWER_FORM.md](LOCAL_TELUGU_REVIEWER_FORM.md).
- **Dependencies:** reviewer; D8 (Sarvam samples).
- **Acceptance criteria:** per-voice scores meet the approved criteria in [LOCAL_TELUGU_TTS_BLIND_REVIEW.md](LOCAL_TELUGU_TTS_BLIND_REVIEW.md).
- **Blocking decisions:** D8, D17, R4.

#### G6.3 — End-to-end latency

- **Current implementation:** no LLM→TTS streaming on the phone path (`SafeSpeechStream` unwired); serial per-chunk TTS; endpointing at 700–900 ms; sequential database I/O; reasoning effort unset; cold sockets per call.
- **Evidence:** `source`; estimated 2.0–3.5 s.
- **Gap / risk:** almost certainly above any candidate target.
- **Required change:** apply the levers in [VOICE_LATENCY_COST_AUDIT.md](VOICE_LATENCY_COST_AUDIT.md) §5.5 as separate tasks:
  - wire `SafeSpeechStream` into phone turns;
  - synthesize the next chunk while the current one plays;
  - retune endpointing on real speech;
  - move persistence off the critical path;
  - run reads in parallel;
  - order the prompt for caching (bump `PROMPT_COMPOSER_VERSION`);
  - pre-warm sockets and cache fixed lines;
  - use μ-law TTS output;
  - gate barge-in during thinking;
  - stop the router sleeping on cooldowns.
- **Dependencies:** invariant tests per change; D9 for the target; D8 and D17 for measurement.
- **Acceptance criteria:**
  - Locally, each lever has an invariant-preserving test and a measured mock-harness delta.
  - In the pilot, measured p50/p95 end-of-speech→first audio meets D9.
- **Blocking decisions:** D9 (target); D8 (real measurement).

#### G6.4 — Barge-in and endpoint configuration honoured

- **Current implementation:** the worker parses `vad.minSpeechMs` and `bargeIn.minSpeechMs` but does not apply them.
- **Evidence:** `source`.
- **Gap / risk:** coughs and backchannels interrupt the agent, or abort a paid LLM call.
- **Required change:** apply both values in the worker's VAD and gate.
- **Dependencies:** worker tests.
- **Acceptance criteria:** speech shorter than the minimum does not interrupt (worker test), and the invariant tests still pass.
- **Blocking decisions:** —

#### G6.5 — Speech-model configuration consistency

- **Current implementation:** worker defaults are `saarika:v2.5`/`bulbul:v2`; gateway defaults are `saaras:v3-realtime`/`bulbul:v3`; the default voice `shubh` is a v3 speaker.
- **Evidence:** `source`.
- **Gap / risk:** a mismatched deployment.
- **Required change:** pin model IDs per agent or profile, and use them on both engines.
- **Dependencies:** D17.
- **Acceptance criteria:** both engines resolve identical model IDs from one configuration (test).
- **Blocking decisions:** D17 (choice); — (mechanism).

#### G6.6 — Spoken numbers, currency and codes for Sarvam

- **Current implementation:** the text normalizer applies to local TTS only; Sarvam runs with `enable_preprocessing=False`.
- **Evidence:** `source`.
- **Gap / risk:** digits, `₹` and booking codes may be read badly.
- **Required change:** evaluate Sarvam preprocessing, or apply the shared normalizer. Changing either normalizer requires the TypeScript and Python twins to stay in parity.
- **Dependencies:** D17, reviewer.
- **Acceptance criteria:** a reviewer confirms numbers and currency are spoken correctly, and the parity script passes.
- **Blocking decisions:** D17.

#### G6.7 — Code-switching

- **Current implementation:** per-turn response-language resolution; STT is pinned to `te-IN` with codemix.
- **Evidence:** `local test`.
- **Gap / risk:** unmeasured on real speech.
- **Required change:** include code-switching cases in the G6.1 evaluation.
- **Dependencies:** as G6.1.
- **Acceptance criteria:** reviewer acceptance of each English/Tenglish variant claimed (R4).
- **Blocking decisions:** R4, D8.

#### G6.8 — Local speech fallback

- **Current implementation:** wired; not accepted for Telugu; espeak-ng is GPL-3.0.
- **Evidence:** `local test`.
- **Gap / risk:** silent quality degradation if enabled.
- **Required change:** a keep-or-retire decision (ENG-11) and a licence review.
- **Dependencies:** D17.
- **Acceptance criteria:** the decision is recorded, and the fallback stays off in the pilot until it is.
- **Blocking decisions:** D17.

#### G6.9 — Concurrency and CPU

- **Current implementation:** in-memory sessions; Python μ-law codec on the event loop.
- **Evidence:** `source`.
- **Gap / risk:** no load test; unknown capacity per host.
- **Required change:** a load test on the target host type.
- **Dependencies:** D19, D8.
- **Acceptance criteria:** an approved concurrency profile is sustained without latency or memory regressions.
- **Blocking decisions:** D19, D8.

### Outcome 7 — End-to-end sales execution

#### G7.1 — Authorized outreach

- **Current implementation:** a campaign engine with consent, calling windows, attempts and suppression. Dispatch is gated off, and the cron route is not scheduled.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** direction, carrier, spend and consent are all undecided.
- **Required change:** after the decisions, run an authorized test campaign against approved test contacts.
- **Dependencies:** D3, D4, D8, D11, R8.
- **Acceptance criteria:** DNC prevents every later attempt; missing consent blocks dispatch; one authorized call is reconciled.
- **Blocking decisions:** D3, D4, D8, D11, R8; G2.

#### G7.2 — Inbound calls

- **Current implementation:** verified webhook, routing and answer flow.
- **Evidence:** `source`, contract tests.
- **Gap / risk:** has never carried a call.
- **Required change:** an authorized inbound test call.
- **Dependencies:** D3, D8, R8.
- **Acceptance criteria:** the call has provider IDs, a pinned version, a terminal state, an outcome and stage timings.
- **Blocking decisions:** D3, D8, R8.

#### G7.3 — Qualification end to end

See G5.1–G5.3.

#### G7.4 — Follow-ups

- **Current implementation:** deterministic due times; workflow timers; reminders.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** delivery is log-only, and no destination has been chosen.
- **Required change:** select a destination (CRM, webhook or WhatsApp) and authorize delivery.
- **Dependencies:** R5, R8, D8.
- **Acceptance criteria:** scenario P7 passes: one delivery with a receipt, and a replay does not duplicate it.
- **Blocking decisions:** R5, R8, D8.

#### G7.5 — Appointments

See Outcome 4.

#### G7.6 — Human handoff

- **Current implementation:** a TwiML `<Dial>` to the tenant's `handoff_number`; a typed escalation; a callback when no live transfer is available.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** no staffed number or hours, no warm transfer, and no real transfer test.
- **Required change:** approve the handoff contact, hours and wording, then test a provider-confirmed transfer and its failure path.
- **Dependencies:** D11, D3, D8.
- **Acceptance criteria:** scenario P4 passes, and "connected" is never claimed without carrier confirmation.
- **Blocking decisions:** D11, D3, D8.

#### G7.7 — Conversion measurement

- **Current implementation:** lead states including `CONVERTED`; outcomes; analytics.
- **Evidence:** `source`.
- **Gap / risk:** no approved definitions or targets.
- **Required change:** see G3.4.
- **Dependencies:** D9.
- **Acceptance criteria:** see G3.4.
- **Blocking decisions:** D9.

#### G7.8 — Declared business process (blueprint §17)

- **Current implementation:** the process is implicit in the call assembly, campaign engine and lead lifecycle.
- **Evidence:** `source`.
- **Gap / risk:** no declared, versioned process definition to inspect or change.
- **Required change:** a workflow definition on the existing engines.
- **Dependencies:** D13.
- **Acceptance criteria:** the pilot process is expressed as configuration and covered by tests.
- **Blocking decisions:** D13.

#### G7.9 — Action audit

- **Current implementation:** tool rows in `messages`, and partial event trails.
- **Evidence:** `source`.
- **Gap / risk:** authorization decisions and failures are not durably audited per action.
- **Required change:** add the `tool_executions` table, and later `audit_logs`.
- **Dependencies:** D5, D7.
- **Acceptance criteria:** every allowed, denied and failed action has one audit row (test on a disposable DB).
- **Blocking decisions:** D5, D7.

#### G7.10 — Idempotency of external effects

- **Current implementation:** workflow timeouts are quarantined; idempotent runs; booking constraint.
- **Evidence:** `source`, `local test`.
- **Gap / risk:** idempotency is not proven for each destination.
- **Required change:** idempotency keys and reconciliation per destination before enabling it.
- **Dependencies:** R5.
- **Acceptance criteria:** a replay in the sandbox produces exactly one effect, and an uncertain outcome is reconciled before any manual replay.
- **Blocking decisions:** R5, R8.

---

## 3. Cross-cutting architecture requirements

The principles are APPROVED under [G1](DECISIONS.md#g1--target-design-and-engineering-principles).

| Principle | Current state | Gap | Linked gaps |
|---|---|---|---|
| 1. HALO is independent of OpsCorp | VERIFIED: an `OpsProvider` port with a log adapter only | — | — |
| 2. Customers get agents, not codebases | VERIFIED for configuration; the Arunodhaya call assembly lives in app code, imported by the gateway | Leak (D2) | G4.2 |
| 3. The runtime is shared | VERIFIED: one runtime for web and phone | The model is process-global | G5.6 |
| 4. Tools execute actions | VERIFIED: closed registry, act-then-narrate | No per-tool contract fields or audit | G7.9 |
| 5. Workflows control business processes | Partial: engines exist, process not declared | D13 | G7.8 |
| 6. Providers are replaceable | VERIFIED: ports and adapters; `check:architecture` | Exotel absent; speech defaults differ | G6.5 |
| 7. Knowledge is controlled | VERIFIED as fail-closed | No approval schema; English-only paths | G2.2, G5.4, G5.5 |
| 8. Tenant isolation is mandatory | VERIFIED locally | Not verified when deployed | G1.1–G1.6 |
| 9. Optimize context | VERIFIED: budgets, voice limits | No prompt caching; static lists sent every turn | G6.3 |
| 10. Build simple first | VERIFIED: modular monolith plus one gateway process | — | — |
| `AGENTS.md`: language-configurable guards | Partial | `isSubstantiveQuestion` is English-only | G5.4 |
| `AGENTS.md`: missing facts stay UNSET | VERIFIED: activation blockers, UNSET commercial values | — | G5.1 |

---

## 4. Documentation gaps found during consolidation

| Finding | Evidence | Disposition |
|---|---|---|
| "No booking tool bound on the voice path" is stale | `source`: `services/voice-gateway/index.ts` passes `visitBookingForCall` | Correction notes added to [ARUNODHAYA_AGENT.md](ARUNODHAYA_AGENT.md), [HALO_V1_STATUS.md](HALO_V1_STATUS.md) and [HALO_V1_RELEASE_GAPS.md](HALO_V1_RELEASE_GAPS.md); recorded in [HALO_Architecture.md §13](HALO_Architecture.md#13-known-limitations) |
| "Pipecat worker has no entry point / never run" is stale | `source`: `worker.py` IMPLEMENTED, `browser-live` 2026-10-06 | Correction notes on [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), [PIPECAT_INTEGRATION.md](PIPECAT_INTEGRATION.md) and [VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md) |
| "Retrieval skipped on non-substantive turns" is wrong | `source`: `agent-runtime.ts` resolves knowledge on every turn with a non-empty query | Correction note on [VOICE_TOKEN_BUDGET.md](VOICE_TOKEN_BUDGET.md) |
| "`collectionIds` ignored" is stale | `source`: `knowledge-resolver.ts` denies a non-empty binding | Correction notes on [RUNTIME.md](RUNTIME.md) and [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) |
| "Two built-in tools" is stale | `source`: three tools in `registry.ts` | Correction notes on [RUNTIME.md](RUNTIME.md) and [SECURITY.md](SECURITY.md) |
| Paths under `src/core/*`, `src/providers/*` and `src/lib/*` no longer exist | `source` | Path notes on [AI.md](AI.md), [SECURITY.md](SECURITY.md), [SCHEDULING.md](SCHEDULING.md), [WORKFLOWS.md](WORKFLOWS.md), [LIFECYCLE.md](LIFECYCLE.md), [OPERATIONS.md](OPERATIONS.md) and [COMPONENTS.md](COMPONENTS.md) |
| Migration range "0001–0009" is stale (31 migrations exist) | `source` | Notes on [INSTALLATION.md](INSTALLATION.md) and README |
| Test counts in TESTING.md are historical (565 tests) | Latest report: 1,602 passed | Note on [TESTING.md](TESTING.md) |
| [API.md](API.md) omits routes added later (voice-call, speech, synthesis, campaigns, learning, admin, analytics/operations) | `source` | Note added; a full API reference is a plan task |
| [CHANGELOG.md](CHANGELOG.md) not updated after 2026-09-22 | `source` | Recorded; not back-filled (history is in the dated evidence records) |
| Two registers used IDs D1–D10 | DECISIONS and RELEASE_DECISIONS | Merged; release IDs became R1–R10 |
| The S0–S13 plan steps cited by DECISIONS come from an unstored plan | DECISIONS header | Crosswalk with unknowns flagged in [the plan §9](HALO_V1_IMPLEMENTATION_PLAN.md#9-legacy-identifier-crosswalk) |
| Discovery report cites `docs/` paths of now-archived files as plain text | [HALO_PHASE_BETA_DISCOVERY_REPORT.md](HALO_PHASE_BETA_DISCOVERY_REPORT.md) | Left unchanged (user-owned per `POA` constraint 4); the path map is in [archive/README.md](archive/README.md) |

---

## 5. Carried-forward technical debt (not re-verified)

These items come from the archived [ROADMAP.md](archive/ROADMAP.md), "Technical debt" (receptionist era, written before 2026-09). They are recorded so they are not lost, but **they have not been re-verified against current source**. Verify each before acting on it.

1. `upsertConversationLead` reads then writes, so concurrent requests can create a duplicate lead.
2. The message-count update is a second round trip.
3. The widget configuration is fetched twice per message turn.
4. The widget builds HTML with `escapeHtml` plus `innerHTML`.
5. There is no end-to-end (Supabase plus Playwright) suite in CI.
6. Staff and booking policy are configured in SQL only.
7. Reminder and confirmation copy is fixed English. This matters for R4 (Telugu-first).
8. The no-show sweep batch is global, not round-robin per tenant.

A ninth item, "no LLM retry", has since been superseded by the fallback router. That is VERIFIED in source.

---

## 6. Relationship to the ten release criteria

The criteria and their status remain in [HALO_V1_STATUS.md §C](HALO_V1_STATUS.md#c-ten-criterion-release-checklist-reconciliation). This table only shows which gaps feed which criterion.

| Criterion | Gaps |
|---|---|
| 1. Shared runtime and bounded tools across channels | G1.3, G5.6, G7.9 |
| 2. Tenant and published-agent identity enforced | G1.1–G1.6 |
| 3. Deterministic qualification, CRM, consent, DNC, campaigns | G2.3, G5.3, G7.1 |
| 4. Voice lifecycle and failure handling | G1.4, G6.3–G6.5, G6.9, G7.2, G7.6 |
| 5. Controlled learning | G5.7 |
| 6. Bounded and attributable usage and context | G3.9, G5.6 |
| 7. Campaign dispatch and scheduling configuration | G4.1–G4.5, G7.1 |
| 8. Release and operations evidence | G2.6, G2.7, G3.1–G3.8 |
| 9. Integrations, one exercised end to end | G4.1, G4.5, G7.4, G7.10 |
| 10. Arunodhaya pilot scenarios | G5.1–G5.3, G6.1–G6.2, G6.7, G7.6 |
