# HALO decision review — Phase 2, Workstream 2

**Date:** 2026-10-15 · **Author:** Claude Code (builder role, G3), under the owner's instruction "HALO Phase 2 — Workstream 2: Close Pending Decisions and Resolve Unknowns". **Starting point:** branch `Phase-2-Security-Hardening`, HEAD `a4786683`, clean tree. A recovery bundle and SHA-256 manifest are in the operator's local folder `~/halo-backups/phase2-ws2-preflight-20261015T041922Z/`.

**What this record is:** the dated evidence behind the review dispositions in [DECISIONS.md](DECISIONS.md#review-dispositions--2026-10-15). It changes **no decision state**. The register's rule stands: only the owner changes a state. A disposition below is a review finding, not an approval, and deployment remains unauthorized.

**Evidence boundary.** Repository source, tests and documents. Fresh throwaway containers from the locally cached `public.ecr.aws/supabase/postgres:17.6.1.155` image, run with `--network none` and no published ports, reached only through `docker exec`, and removed afterwards. No hosted, staging, shared or developer database was queried or migrated. The shared local stack (55321/55322) and the 5432x project were not addressed. No provider was contacted, nothing was deployed or pushed, and spend was $0. `npm run build` was not run, because it fetches Google Fonts.

Evidence labels follow [HALO_Architecture.md §1.3](HALO_Architecture.md#13-evidence-levels).

---

## 1. Disposition vocabulary

| Disposition | Meaning |
|---|---|
| **Settled** | Repository evidence shows the decision is in force (standing, ratified or executed). No action. |
| **Engineering-resolved** | A technical question answered from evidence. Any execution on a real system still needs the owner's authorization, and that is listed separately. |
| **Owner approval required** | The choice changes policy, consent, retention, exposure, spend, residency, architecture or a customer commitment. A recommendation is given; nothing is approved. |
| **Environment evidence required** | The answer exists only on a real target. The exact check is named. |
| **Superseded / obsolete** | Replaced or no longer applicable, with the successor linked. |

"Blocks" uses three milestones:

- **H:** first hosting, meaning an isolated staging target with synthetic data.
- **P:** the Arunodhaya pilot.
- **GA:** general availability.

---

## 2. Decision matrix

36 register entries and 1 new entry (D23) were reviewed. Every entry has a disposition.

| ID | Topic | State (unchanged) | Disposition | Evidence checked in this review | Blocks |
|---|---|---|---|---|---|
| G1 | Principles | APPROVED (standing) | Settled | `check:architecture`, `check:neutral` pass (§10) | — |
| G2 | $0, outbound off, log messaging | APPROVED (standing) | Settled, and enforced in code | `packages/campaigns/dispatch.ts` dispatches only for the literal `"true"`. `packages/platform/env.ts` defaults `MESSAGING_PROVIDER` to `log`. `.env.example` keeps `HALO_OUTBOUND_ENABLED=false` and `HALO_TELEMETRY=disabled`. | Every paid or external action |
| G3 | Agent roles | APPROVED (standing) | Settled | `AGENTS.md` | — |
| G4 | Documentation authority | APPROVED (owner) | Settled | Canonical set reconciled (§9) | — |
| R1–R7 | Release direction | RATIFIED | Settled (direction only; no criterion passed) | [HALO_V1_RELEASE_DECISIONS.md](HALO_V1_RELEASE_DECISIONS.md) | — |
| R8 | Pilot environment, data handling, providers | PENDING | Owner approval required | No target, owner or authorization recorded | H, P |
| R9 | Pilot acceptance | PENDING | Owner approval required | — | P closure |
| R10 | GA go/no-go | PENDING | Owner approval required | — | GA |
| D1 | Backend stack | PENDING | Owner approval required (recommend: keep, as an approved deviation) | Stack unchanged; 165 TS test files and 7 worker test files (the register said 156) | H (deployment design) |
| D2 | Repository layout | PENDING | Owner approval required (recommend: keep; fix the leak, W1.4) | Leak still present: `services/voice-gateway/index.ts:21–23` imports `@/core/services/voice/*` | P (gateway deployment) |
| D3 | Carrier | PENDING | Owner and compliance approval required | Only the Twilio adapter exists | P |
| D4 | Call direction | PENDING | Owner approval required | Dispatch gate confirmed; `/api/cron/campaigns` is still not scheduled in `vercel.json` | P |
| D5 | Tool model | PENDING | Owner approval required; the `offer_concession` question is open | Three registry tools; system actions are not audited as tools | P |
| D6 | Recording | PENDING | Owner and privacy approval required | Retention coverage of the call tables is now **verified** (§6); recording is still unimplemented | P |
| D7 | `tool_executions` / `audit_logs` | `tool_executions` APPROVED; `audit_logs` PENDING | `tool_executions`: settled; applying it to a real DB follows the runbook. Audit-write failure policy: engineering-resolved (§5). `audit_logs`: owner approval required | `0032` applied on the real Supabase image (§4) | H (applied with the chain); `audit_logs`: GA |
| D8 | Spend | PENDING | Owner and finance approval required | — | P; H too, if hosting is not $0 (§7) |
| D9 | Numeric targets | PENDING | Owner approval required, after a measured baseline (environment evidence) | No real measurement exists | P acceptance |
| D10 | Commit grouping, `0001` edit | APPROVED, executed | Settled. Documentation note: the candidate branch was integrated into `main` and deleted (STATUS "Branch integration") | `0001` blob unchanged | — |
| D11 | Arunodhaya facts and policy | PENDING | Owner (business, privacy, Telugu reviewer) approval required | 12 facts pending; blockers in place | P |
| D12 | Redis, Sentry, object storage | PENDING | Owner approval required (recommend: not now) | In-memory limiter, `packages/platform/rate-limit.ts` | P (error tracking); recording |
| D13 | Workflow engine | PENDING | Owner approval required (recommend: existing engines) | — | P (W6.2) |
| D14 | Knowledge governance items 1–6 | Implemented locally; ratification PENDING | Items 1–2: settled against the original proposal. Items 3–6: owner approval required. Item 5 **diverges** from the original proposal (§3). | §3 | H (if `0033` is applied); P |
| D15 | ENG-04 / ENG-12 naming | PENDING | Owner approval required; non-blocking (descriptive names in use) | — | — |
| D16 | "Astra" | PENDING | Owner approval required; non-blocking | — | — |
| D17 | Speech and LLM route | PENDING | Owner, speech and language approval required | Worker defaults `saarika:v2.5`/`bulbul:v2`; gateway defaults `saaras:v3-realtime`/`bulbul:v3` (unchanged) | P |
| D18 | Telemetry backend | PENDING | Owner and operations approval required | Correlation does not cross processes (§8, gate 8) | P (observability) |
| D19 | Hosting topology and region | PENDING | Owner, deployment and privacy approval required; plus environment evidence | §7 | H |
| D20 | Phone speech streaming | PENDING | Owner approval required, after W4.10 | The phone adapter still passes no speech sink | P (latency) |
| D21 | `0001` on hosted Supabase | PENDING | **Engineering-resolved (method)**; environment evidence required; execution needs owner approval | §4; [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md) | H |
| D22 | `0034` adoption | PENDING | Owner approval required; the census is environment evidence | §4.3 | H (recommended before hosting) |
| **D23** (new) | Retention coverage beyond conversations and calls | PENDING | Owner and privacy approval required; any fix needs a migration | §6 | P |

**Counts (by entry; 37 in total):**

- **Settled in full: 12.** G1–G4, R1–R7 and D10.
- **Settled in part: 2.** D7 (`tool_executions`) and D14 (items 1–2).
- **Engineering-resolved: 2 questions.** The D21 method, and the D7 audit-write failure policy.
- **Owner approval required: 25 entries.**
  - 22 in full: R8–R10, D1–D6, D8, D9, D11–D13, D15–D20, D22 and D23.
  - The remaining parts of 3 more: D7 (`audit_logs`), D14 (items 3–6) and D21 (execution).
- **Environment evidence also required: 4.** D9, D19, D21 and D22 (census).
- **Superseded or obsolete: 0.** No entry duplicates another. The earlier D1–D10 ID collision was already resolved as R1–R10.

---

## 3. D14 items 1–6, checked against their exact wording

The six items are quoted in [HALO_LAYER_1_REVIEW.md](HALO_LAYER_1_REVIEW.md), "Concrete migration proposal". The implemented defaults are in [DECISIONS.md D14](DECISIONS.md#d14--layer-1-activation-and-approved-knowledge). This instruction's labels A–F map onto them as follows: A, self-approval = item 3; B, per-turn freshness = item 5; C, FAQ semantics = item 4; D–F = items 1, 2 and 6.

| Item | Proposal (2026-10-14) | Implementation (checked) | Matches? | Outcome |
|---|---|---|---|---|
| **1** Composite tenant keys | Reuse `0017`; composite FKs document→collection and chunk→document; validate first; never repair | `0033` §1: unique `(id, business_id)` on three parents; both FKs added `NOT VALID`, validated only when no mismatch exists. On the real image the FKs validate on a clean chain, and stay `NOT VALID` with legacy mismatches, which the census reports (`disposable DB`, §4). | Yes | **Settled.** Adoption follows the `0033` approval. |
| **2** Approval separate from indexing | Approval state, actor, timestamp and source; revisions; edits invalidate approval; legacy defaults to pending | Immutable revision tables; `index_status` separate from `state`; approval requires a complete index; editing creates a new revision; legacy unserved | Yes | **Settled.** |
| **3** Who approves (A: self-approval) | "Restrict approval/revocation to the owner-approved tenant role (proposed owner/admin) … Ordinary editing must never self-approve." | Owner/admin only, in the app (`canApprove`, `src/features/{knowledge,faqs}/actions.ts`) and in the database (`knowledge_require_approver` → `is_knowledge_approver`). Editing never approves. An owner/admin may approve a revision they authored. | Yes on the role. The proposal is silent on authoring-versus-approving separation. | **Owner approval required.** Recommend keeping single-approver for the pilot: single-owner tenants exist, and every approval records `created_by` and `reviewed_by`, so self-approval is visible after the fact. If wanted, the cheap later option is a per-tenant flag that refuses `reviewed_by = created_by`; it needs a migration. No two-person rule was introduced. |
| **4** Retrieval scope (C: FAQ semantics) | Explicit allowed collections; unknown or foreign deny; decide empty-scope meaning and unbound content; "Add nullable FAQ collection binding only if FAQ restriction semantics are approved." | `knowledge_assert_scope` raises on a null scope, a null id, or an unknown or foreign id. An empty scope means all approved content of the tenant, documents and FAQs. A nonempty scope means only documents bound to those collections: FAQs and unbound documents are excluded (`faq_revisions` branch requires `cardinality = 0`). The app validates UUIDs before any DB call (`collectionScope`). A denial degrades the turn to no knowledge and never widens (`agent-runtime.ts:295–304`). | Yes. No FAQ binding was added, as the proposal required. | **Owner approval required** for the semantics: a collection-restricted agent never sees FAQs. FAQ retrieval cannot bypass a restriction; it fails toward less content. Alternative: a nullable `faqs.collection_id`, which needs a migration. |
| **5** Pinning (B: per-turn freshness) | "Decide knowledge revision pinning before implementing it" — the original D14 text says "Pin the approved configuration and knowledge revision used by each conversation." | Per-turn resolution against the current publication. No cache: `ProviderKnowledgeResolver` runs on every turn and the factory caches only the client. Snippets are never persisted in history or state, so a withdrawal takes effect on the next turn. An in-flight turn keeps the snippets it already fetched, and approval is atomic under a row lock, so no turn mixes old and new chunks. The served `revisionId` reaches the runtime but is **not persisted** (`messages` has no metadata column). | **No.** It diverges from the original D14 pinning text. | **Owner approval required.** Recommend per-turn: withdrawal effectiveness outweighs intra-conversation consistency for a sales agent. Add durable answer→revision traceability, which needs a migration, before claiming that each answer traces to a source (§9 corrects that claim). |
| **6** Legacy rollout | Replacement versions through normal versioning; no invented objective; legacy knowledge pending | Agents: legacy versions without an objective refuse to serve, and no data is changed. Knowledge: nothing pre-existing is served; census and backfill are dry-run by default and never approve. | Yes | **Owner approval required** for the rollout: existing knowledge stops serving when `0033` lands. Sequencing is in the runbook §5.2. |

**Conclusion:** two items are settled. Four need the owner. Of those four, item 5 is a real divergence from the recorded proposal, not just an unratified default.

---

## 4. D21, and migrations `0032`–`0034` together

### 4.1 D21: what fails, and why

Each scenario ran in its own fresh, isolated container (`disposable DB`). It is reproduced by `npm run check:supabase-image-chain`.

| Scenario | Session | Result |
|---|---|---|
| A | `search_path = "$user", public` (the reported CLI condition) | `0001_init.sql:151`: `function gen_random_bytes(integer) does not exist` |
| P | Plain login as `postgres`; the role config supplies `"$user", public, extensions` | `0001`–`0034` apply. Placement: `pgcrypto@extensions`, `vector@public`, `btree_gist@public`. Governed vector and keyword RPCs run as `service_role`. Both censuses are empty. The `0033` composite FKs are validated, and inserts that use `gen_random_bytes` work. |
| B | Explicit `set search_path = public, extensions` | As P |
| C | `vector` already enabled in `extensions`, then as B | `0001_init.sql:273`: `operator does not exist: extensions.vector <=> extensions.vector`. The body of `match_knowledge_chunks` is validated under its pinned `search_path = public`. |

**Answers to the D21 questions:**

- **Is the issue real?** Yes, for any session without `extensions` on its path.
- **Does an additive migration help?** No: it would run only after `0001`.
- **Can `0001` stay immutable?** Yes, if two conditions hold:
  - the applying session has `extensions` on its `search_path` (log in as `postgres` with `supabase db push --db-url`, not `--linked`, or set it explicitly);
  - `vector` is absent or lives in `public` before `0001` runs.

The second condition is new. Option 1 as previously written did not cover it.

**Recommendation (not approved):** D21 option 1, refined as above, behind the read-only preflight in [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md). If the target has `vector` in `extensions`, stop and return to the owner. Moving the extension, or an owner-approved exception to edit `0001`, are owner choices.

### 4.2 Ordering and compatibility

`0032`, `0033` and `0034` have no mutual dependency beyond file order. They applied cleanly together on the real image, and also on a `0001`–`0031` database that already held a cross-tenant calendar connection and a cross-tenant knowledge collection. Rollback limits and app/schema compatibility are in the runbook (§5.3, §6). **Migrate first, then deploy the matching application.**

### 4.3 D22 review of `0034`

- **Trigger.** Generic, `SECURITY DEFINER`, `search_path` pinned. It runs before the write, so ahead of unique and exclusion checks. A foreign id and a random id give the same error (no existence oracle). An unchanged update skips the lookup.
- **Coverage, corrected.** **19 referencing columns on 16 tables**: 5 client-writable and 14 written by the service role only. DECISIONS, STATUS and the evidence record said "18 columns" or "15 further". The migration's own comment still says "15 further"; migrations are not edited, so this record holds the correct figure.
- **Census.** `tenant_reference_census()` is read-only and service role only. Its pre-`0034` equivalent is in the preflight, tested against a planted mismatch.
- **Privileges.** The revokes cover existing tables and the migrating role's default privileges. `MAINTAIN` is revoked only on PostgreSQL 17+. After the chain on the real image, client TRUNCATE/REFERENCES/TRIGGER grants are 0; before `0034` they were 72 and 144 (preflight §8).
- **Legacy mismatches.** Not rewritten; reported for an owner disposition.
- **Open owner points** (unchanged, [TENANT_ISOLATION_EVIDENCE.md §8](TENANT_ISOLATION_EVIDENCE.md#8-remaining-risks-and-findings-not-fixed)): making `agents.business_id` immutable, and a generic `0018` error message.

---

## 5. Security and architecture areas (Phase E)

| Area | Mechanism (checked) | Finding | Disposition |
|---|---|---|---|
| Tenant isolation, RLS, service role | RLS on 44 tables; 649 real-role assertions; PostgREST suite; `0034` | Local only; not deployed | Owner (D22, R8, D19); environment (W1.5) |
| Tool-execution audit and failure policy | `packages/runtime/tools/audit.ts`; fail closed for side-effecting tools; handoff best-effort | An implementer default inside approved D7, safe-side: no side effect without a record, and a caller is never blocked from reaching a person | **Engineering-resolved**; the owner may override |
| Knowledge | `0033` RPCs and dashboard gates (§3) | App and DB approver checks agree | §3 |
| Calendar credentials, booking authorization | AES-256-GCM `v1.` envelope; `BookingService`; exclusion constraint | One local plaintext row awaits an authorized backfill; a plaintext read fallback remains | Owner authorization (W1.3) |
| Auth, privileged admin actions | `requireBusiness().role`; `auth.uid()` RPCs; 11-function `SECURITY DEFINER` allowlist | Hosted Auth unverified | Environment (Gate 2) |
| Telemetry and traces | stdout allowlist; per-request and per-session IDs | No cross-process correlation; no export | Owner (D18) |
| Secrets and keys | Server-only service-role client; OAuth state HMAC reuses the service-role key; the hook secret is accepted in `?token=` | Hygiene findings, recorded since WS1 | Owner approval recommended (header-only hook secret; a dedicated state key). Not changed: an API and config contract change. |
| Recording, consent, retention, deletion | Consent CHECK on `calls`; purge function | Coverage gap (§6); no export or deletion-on-request procedure | Owner (D6, D23, R8) |
| Background jobs | Tenant-consistency guards (WS1) | — | Settled locally |
| Idempotency and duplicate side effects | Workflow idempotent runs; quarantine without replay; booking constraint; `tool_executions` unique per turn | Not proven per destination | Environment (W6.5, W6.6) |
| External side effects and providers | G2 defaults in code | `npm run build` contacts Google Fonts (`next/font/google`): external contact, not spend | Recorded; self-hosting the font is a separate engineering card |
| Industry-neutral core | `check:neutral`, `check:architecture` pass | The D2 leak is in `services/`, not `packages/` | Owner (D2) |

No requirement was found that is clearly defined but implemented incorrectly. The confirmed defects that are fixed are documentation and configuration defects (§9). The known code defects G1.4 (stream-token replay within its TTL) and G5.4 (English-only knowledge-gap gate) are already planned as W1.2 and W2.1. Each needs its own task card and voice-invariant or language tests, so they were not mixed into this review.

---

## 6. Retention coverage (resolves the D6 unknown; opens D23)

This was derived from the catalog after the full chain on the real image. It is a recursive walk of `ON DELETE CASCADE` from the three tables `purge_expired_data()` deletes (`disposable DB`).

- **Purged by the tenant's `data_retention_days`:**
  - `calls`, with `call_events`, `call_transcript_turns` and `conversation_outcomes`;
  - `conversations`, with `messages`, `conversation_state`, `booking_drafts` and `tool_executions`;
  - `usage_events`.
- **Never purged.** Several of these hold names, phone numbers, emails or free text:
  - `leads`, `lead_state_events`, `customers`, `customer_timeline`;
  - `appointments`, `appointment_reminders`, `appointment_feedback`, `intake_responses`;
  - `campaign_contacts`, `campaign_events`;
  - `workflow_events`, `workflow_runs`, `workflow_run_logs`, `workflow_timers`;
  - `learning_proposals`, `phone_suppressions`.

  `leads`, `appointments` and `phone_suppressions` reference purged rows with `SET NULL`, so they survive the purge.
- **Not all of this is a defect.** DNC suppressions must outlive the window, and appointment records may be business records. Which tables a retention window must cover, and for how long, is a privacy decision: **D23**. A fix is a new migration.

---

## 7. Hosting and residency (Phase F; repository evidence only)

| Question | Evidence | State |
|---|---|---|
| Where the app runs | Vercel is the reference (`DEPLOYMENT.md`). `vercel.json` sets **no `regions`**, so the platform default applies. | Region NOT DECIDED (D19); the default region was not checked here |
| Scheduled jobs | `vercel.json`: retention daily; reminders and workflows every 5 minutes; no-shows every 15 minutes | Whether a $0 plan allows sub-daily crons, and commercial use, is **NOT VERIFIED**: an environment check (D8, D19) |
| Voice gateway and worker | Long-lived processes; candidates Fly, Railway, ECS; single instance (in-memory sessions) | NOT DECIDED (D19) |
| Database region | Existing hosted project `riwgdqogswoewfduajcl`, Sydney; not an authorized target | OWNER APPROVAL REQUIRED (D19) |
| Backups and PITR | Plan-dependent; PITR is paid (`DEPLOYMENT.md`) | NOT VERIFIED; D8 |
| Logs | stdout JSON; retention and location depend on the host | NOT DECIDED (D18, D19) |
| Object storage | Supabase Storage (knowledge files), in the project's region | Follows D19 |
| Embeddings | `EMBEDDING_PROVIDER=none` by default; `ollama` is self-hosted | No third party by default |
| Providers that would receive customer data | LLM: Groq and OpenRouter, plus OpenRouter's model vendors (conversation text, knowledge snippets). Speech: Sarvam (caller audio and text). Carrier: Twilio (audio, numbers). Calendar: Google, Microsoft or CalDAV (appointment details). Messaging: Resend and WhatsApp (contact and content; log mode today). | Each vendor's processing location was **NOT VERIFIED**. No residency or compliance claim is made from any region setting (G2.9) |
| Values needed at deployment | Names in `.env.example`. Six worker and router names were missing and have been added (§9). | Values supplied by the deployment owner |

---

## 8. Release-gate matrix

PASS means the evidence meets the gate at the stated level, never more.

| # | Gate | Status | Evidence | Next action / owner |
|---|---|---|---|---|
| 1 | Authentication and tenant isolation | **NOT VERIFIED** (deployed); PASS locally | 649 real-role assertions; PostgREST suite; Gate 2 not run | Deployment owner: W1.5 on an authorized target |
| 2 | Database migrations and RLS | **NOT VERIFIED** (hosted); PASS on the real image locally (§4) | Chain on `supabase/postgres` 17.6.1.155; hosted ledger unknown | Owner: D21, D22; operator: runbook preflight |
| 3 | Auditability | **OWNER APPROVAL REQUIRED** | `tool_executions` PASS locally; system actions unaudited (D5); no `audit_logs` (D7) | Owner: D5, D7 |
| 4 | Knowledge governance and legacy rollout | **OWNER APPROVAL REQUIRED** | PASS locally; item 5 diverges; legacy content stops serving | Owner: D14 items 3–6 |
| 5 | Calendar connection and failure handling | **NOT VERIFIED** | Fakes only; one plaintext credential row | Integration owner: R5, W6.5; write authorization W1.3 |
| 6 | Sales workflows and safe action execution | **OWNER APPROVAL REQUIRED** | Deterministic engines PASS locally; facts and policy UNSET | Business owner: D11, D13 |
| 7 | Telugu speech quality and measured latency | **NOT VERIFIED** | No live measurement; local fallback 67% WER and not accepted; latency estimated at 2.0–3.5 s | Owner: D8, D9, D17; reviewer: R4 |
| 8 | Telemetry and incident diagnosis | **FAIL** | No cross-process correlation (G3.1), alert destination or responder | Owner: D18; operations owner |
| 9 | Consent and retention | **FAIL** (coverage gap evidenced, §6); policy OWNER APPROVAL REQUIRED | Purge misses CRM, appointment, campaign and workflow data; consent policy absent | Privacy owner: D23, D6, D11, R8 |
| 10 | Zero cost and provider authorization | **PASS** (local controls); hosted plan NOT VERIFIED | G2 defaults in code; build contacts the font CDN | Owner: D8; hosted plan limits (§7) |
| 11 | Backup, rollback and recovery | **NOT VERIFIED** | Local restore PASS; no hosted drill; RPO and RTO unapproved | Owner: RPO and RTO; operator: runbook §5.1, W8.3 |
| 12 | Owner sign-off | **OWNER APPROVAL REQUIRED** | R8–R10 PENDING | Owners |

**Deployment readiness: NOT READY.** First hosting is blocked by R8, D19, D21 (approval plus preflight), D22 and D14 (if `0033` and `0034` are included), and by D8 if any hosting cost arises. The review being complete is not an authorization.

---

## 9. Unknowns sweep (Phase G)

| # | Finding | Class | Action taken |
|---|---|---|---|
| U1 | CI replays migrations on vanilla PostgreSQL only; hosted extension placement is never exercised | Missing verification | **Fixed:** `npm run check:supabase-image-chain` (Docker, cached image, isolated) |
| U2 | `DEPLOYMENT.md` advised `psql -f` for missing hosted migrations, which leaves the ledger without those versions | Confirmed defect (documentation) | **Fixed:** the hosted path points at the runbook |
| U3 | `0034` coverage stated as 18 or "15 further"; actually 19 (5 + 14) | Documentation drift | **Fixed** in DECISIONS, STATUS and the isolation evidence; migration comment unchanged |
| U4 | Six runtime variables read by code are missing from `.env.example` | Documentation drift | **Fixed** (commented, no values) |
| U5 | A past disposable container's password, and an absolute home path, in committed docs | Confirmed defect (secret hygiene) | **Fixed** in current files. History is not rewritten (unauthorized). |
| U6 | Retention misses CRM, appointment, campaign and workflow data | Owner decision | **D23** added |
| U7 | Gap analysis G2.2 claims "each approved answer traces to an approver, date and source"; answer→revision is not persisted | Documentation drift and owner decision | **Fixed** wording; owner question under D14 item 5 |
| U8 | D14 item 5 default diverges from the original pinning text | Owner decision | Recorded (§3) |
| U9 | Vercel region unset; sub-daily crons versus a $0 plan; commercial-use terms | Environment-dependent prerequisite | Recorded under D19 and D8 |
| U10 | The build contacts Google Fonts | Deferred feature | Recorded (memory and STATUS already note it) |
| U11 | D1 test-file count (156) | Documentation drift | Fixed (165) |
| U12 | D10 names a deleted branch | Documentation drift | Note added |
| U13 | Architecture §8.6 says `0001`–`0031`; `DEPLOYMENT.md` says 31 files | Documentation drift | Fixed (34) |
| U14 | Architecture says `piiRules` enforcement is "not verified"; source shows it is never read | Documentation drift | Fixed wording; W2.3 unchanged |
| U15 | G5.4: English-only knowledge-gap gate | Confirmed defect, planned (W2.1) | Not fixed here: needs its own card and language tests |
| U16 | G1.4: stream-token replay within its TTL | Confirmed security defect, planned (W1.2) | Not fixed here: voice-invariant work |
| U17 | Hook secret in `?token=`; OAuth state key reuse | Owner decision | Recorded (§5) |
| U18 | `agents.business_id` mutable by a dual-tenant admin; `0018` error message names the owning agent | Owner decision | D22 option 2 |
| U19 | Whether the CLI's `--linked` path uses a login role without `extensions` | Environment-dependent | Runbook preflight §1 |
| U20 | Hosted ledger and whether `0001` was attempted | Environment-dependent | Runbook preflight §5 |
| U21 | Opt-in DB suites (PostgREST, knowledge governance) do not run in CI | Missing verification | Recorded; CI runs `check:migrations` and `check:rls` |
| U22 | `test_worker_e2e.py` "end-to-end" | False positive | Its docstring states fake carrier, STT, TTS and HALO |
| U23 | One TODO-like marker (`+91XXXXXXXXXX`) | False positive | A format comment |

---

## 10. Changes made and verification

Changed in this workstream (see `git log` for the commits):

- **Added:**
  - `docs/HOSTED_MIGRATION_RUNBOOK.md`
  - `docs/HALO_DECISION_REVIEW.md` (this record)
  - `infrastructure/hosted/preflight-readonly.sql`
  - `scripts/check-supabase-image-chain.mjs`, plus its npm script
- **Updated:**
  - `docs/DECISIONS.md`: dispositions, D23, evidence updates; no state changed.
  - Architecture, gap analysis, plan and status records; `DEPLOYMENT.md`.
  - The isolation evidence count.
  - The two redactions.
  - `.env.example`.

The command results are recorded in [HALO_V1_STATUS.md](HALO_V1_STATUS.md#decision-review--phase-2-workstream-2--2026-10-15).
