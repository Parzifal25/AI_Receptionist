# HALO decisions log

The owner's decisions on how the implementation relates to the blueprint (`docs/HALO_Architecture.md`, cited by §). Coding agents read this file with `AGENTS.md` and never decide architecture themselves.

**Source:** HALO Phase 1 plan §9 (2026-10-14). That plan is a proposal; at the time of writing it is not stored in the repository.

## How to use this log
- **PENDING** means no owner decision is recorded. The "Proposed recommendation" column is the plan author's suggestion, **not** an approval, and must not be treated as one.
- **APPROVED** or **REJECTED** needs the owner's explicit decision. Record who decided, the date, and the decision text (it may differ from the recommendation). Agents never change a state on their own.
- A new architectural question gets the next free ID (D14, …) and starts as PENDING.

Decisions already ratified on 2026-10-11 (release target, pilot channels, Telugu-first language, real-integration evidence, provisional numeric targets, mandatory GA gates) are recorded in `docs/HALO_V1_RELEASE_DECISIONS.md` and are not repeated here. The `POA` operating constraints ($0 spend hard limit, outbound off, messaging in `log` mode) also stand.

## Decisions

| ID | Decision | Blueprint position | Proposed recommendation (not approved) | Blocks | State | Decided by | Date |
|---|---|---|---|---|---|---|---|
| D1 | Backend stack | §27: Python / FastAPI / Pydantic | Keep TypeScript/Node plus the Python Pipecat worker, and record it as an approved deviation. The runtime is mature and CI-gated; a rewrite adds no pilot value. | Minimum set for S1–S6; deployment design (S9) | PENDING | — | — |
| D2 | Repository layout | §28: `apps/`, `providers/`, `tenants/`; "exact layout can evolve" | Keep the current layout. Fix only the gateway → app-layer import leak (S4.3). | — | PENDING | — | — |
| D3 | Pilot carrier | §25: Exotel | Owner chooses from a price and Indian-regulatory (DLT/KYC) comparison; no paid test calls. If Exotel, start the paperwork early. Twilio is the implemented adapter. | External gate before S7 | PENDING | — | — |
| D4 | Pilot direction and pre-carrier harness | §39 v0.1: outbound | Confirm outbound. Approve the browser / fake-carrier path as **harness evidence only**, never pilot evidence. | Minimum set for S1–S6 | PENDING | — | — |
| D5 | Tool invocation model | §5 named tools; §11 tool contract; §41 principle 4 | Hybrid: keep qualification and booking deterministic, but expose each action under the §11 contract with an audit row. LLM-callable only where judgment is needed (handoff, contact capture). | Minimum set for S1–S6; S4.4, S4.5 | PENDING | — | — |
| D6 | Call recording in the pilot | §20; §39 v0.1 includes recording | Needs a consent and retention policy. Otherwise approve deferral as a recorded deviation. | External gate before S7; S10 | PENDING | — | — |
| D7 | New migrations | §22 data architecture | Approve the additive `tool_executions` migration (S4.4); `audit_logs` later (S13). | Minimum set for S1–S6; S4.4 | PENDING | — | — |
| D8 | Spend | `POA`: $0 is a hard limit | The pilot needs paid STT, TTS, LLM and carrier usage. It requires an explicit budget or exception; until then S7 onward stays blocked. | External gate before S7 (S7 onward) | PENDING | — | — |
| D9 | Numeric pilot targets (latency, recognition, extraction, cost tolerance) | — | Set after the S3 measurement baseline. The candidates in the plan's §4 are unapproved. | S11 acceptance | PENDING | — | — |
| D10 | Dirty-tree commit grouping; uncommitted edit to `supabase/migrations/0001_init.sql` | — | Commit the working tree in coherent groups. If `0001` was applied anywhere (for example a hosted project), move the edit into a new migration instead. | Minimum set for S1–S6; S0 (CL-0); worktree-based tasks | PENDING | — | — |
| D11 | Arunodhaya facts, disclosures, consent and escalation contacts | §16, §30, §32 | Existing ENG-02 blocker; needs the customer's input. | External gate before S7; pilot facts and handoff | PENDING | — | — |
| D12 | Redis, Sentry, object storage | §27 "where required" | Not now. Triggers: multi-instance gateway (Redis); pilot environment (error tracking); recording (object storage). | — | PENDING | — | — |
| D13 | §17 business-process workflow engine | §17 | Build workflow definitions on the existing workflow and campaign engines, not a new engine. | S8 | PENDING | — | — |

## Open questions (not yet decisions)
### D14 — Layer 1 activation and approved knowledge (PENDING)

**Source, 2026-10-14:** owner requested completion of Layer 1. Current draft parsing permits empty identity/objective/instructions and defaults language; publication has no activation-readiness check. Runtime knowledge collection IDs are ignored. Document indexing status does not establish business approval (blueprint §4, §16, §30).

**Proposed, not approved:** retain incomplete drafts, but reject publication, rollback and runtime resolution unless required identity, objective, explicit language and effective versioned instructions are valid. Reject unsupported knowledge restrictions rather than retrieve tenant-wide. Add an additive migration for document approval provenance and tenant-owned document/collection bindings; retrieval must exclude pending, revoked and unknown facts in keyword and vector paths. Existing documents remain pending until approved; indexing readiness is separate. Pin the approved configuration and knowledge revision used by each conversation. Define legacy migration/backfill policy before enforcement; do not invent identity or approval.

**Owner decision needed:** approve the concrete database knowledge access/approval design and legacy rollout. Detailed remediation card and evidence: `docs/HALO_LAYER_1_REVIEW.md`. The subsequent owner instruction authorizes safe non-migration work, recorded below; no D14 migration is approved.

**2026-10-14 implementation authorization:** the owner's “HALO Layer 1 — Implementation and Closure” instruction explicitly assigns the safe non-migration fixes and requires stopping before an unapproved concrete migration. Those fixes are implemented: strict activation/read/runtime validation, pinned identity/instructions/contact authority, fail-closed unsupported collections and unapproved documents, FAQ draft/unpublish handling, and explicit unresolved pilot blockers. This does not authorize a schema change or approve Arunodhaya facts.

**D14 remains PENDING for database design and rollout.** Inspection found existing `knowledge_collections` and document `collection_id` in migration `0017`; reuse them rather than introduce duplicate collection tables. The concrete additive proposal, existing-data assumptions, access controls and rollback limitations are in the current closure section of `docs/HALO_LAYER_1_REVIEW.md`. No migration was created or applied. Historical legacy published agent versions lack objectives; backend reads now refuse them rather than invent objectives. The owner must approve their replacement-version/backfill rollout and the knowledge approval/revision design before database implementation.

- **Implementation owner naming.** `POA` names "Astra" as implementation owner, while blueprint §36 and `AGENTS.md` name Claude Code (builder) and Codex (reviewer). How Astra relates to these roles is unresolved (plan §8, item 9).
