# Phase 2 Workstream 3 — final closure evidence

**Date:** 2026-10-15 · **Task ID:** WS3-FINAL · **Status: COMPLETE — ROLLOUT PREPARED (local package).** K1 and recovery acceptance pass locally. Actual hosted rollout remains NOT READY / NOT AUTHORIZED: nine owner decision IDs and all ten actual-target evidence groups are outstanding.

| Dimension | Final disposition |
|---|---|
| Local engineering | COMPLETE: additive 0035, regressions, recovery, inventory/preflight preparation and applicable offline gates |
| Owner decision closure | Reconciliation COMPLETE; nine IDs still pending. Only the separate K1 engineering approval was explicitly granted by this prompt |
| Actual hosted evidence | NOT VERIFIED: T1–T10; no connection made |
| Recovery acceptance | PASS on task-owned disposable infrastructure; actual hosted backup/restore and RPO/RTO NOT VERIFIED |
| Deployment authorization | NO; no deploy, migration or backfill on any real/shared target |

Evidence labels: VERIFIED_LOCAL/local test; VERIFIED_LOCAL/disposable DB; DOCUMENTED/source or historical; INFERRED; OWNER_APPROVAL_REQUIRED; REAL_TARGET_EVIDENCE_REQUIRED; BLOCKED; NOT_APPLICABLE. Simulation is never hosted evidence. This report supersedes the partial closeout report preserved in the new durable snapshot.

## Authorization, starting state and preservation

The owner's **Workstream 3 Final Closure** prompt explicitly authorizes K1 as an additive stored-function correction, without editing 0033. It supplies the task's objective, scope, prerequisites, acceptance and commands. It does not approve D14 defaults, adopt D22, identify a hosted environment or authorize real-target SQL. Rollback of uncommitted local work is selective review/removal of this task's changes after preserving the baseline, never reset/clean. A future applied SQL correction requires a reviewed forward fix or verified restore, not alteration of applied historical files.

**VERIFIED_LOCAL/source:** starting and ending branch `Phase-2-Security-Hardening`, HEAD `ad6a19d830633712b948ff5fc75972c2f61a17fa`; no later commits and no stashes. Local remote names `halo`/`origin` and recent commits inspected without contacting either remote. Start: five modified tracked files and fourteen untracked files (19 dirty paths), all retained. End: five modified tracked files and twenty untracked files (25 dirty paths), no staged files. All 34 historical migrations are byte-identical to HEAD; 0035 is a new untracked file. App/runtime/worker code and lockfiles are unchanged. No commit/push/branch switch/reset/clean or delegation occurred.

**VERIFIED_LOCAL/source backup:** the requested `~/halo-backups/ws3-closeout-20261015T070139Z/` bundle, 12-member dirty archive and SHA-256 manifest verify, but are stale relative to the 19-path starting tree. A new durable snapshot at `~/halo-backups/ws3-final-20261015T073618Z/` contains a complete --all Git bundle, exact 19-member dirty-file archive, binary HEAD diff, HEAD/branch/status/untracked inventories and SHA-256 manifest. Bundle verification and every manifest-member hash pass; archive contents/count checked. It contains current HEAD and the WS2 commits absent from the older a4786683 backup. An additional handoff snapshot at `~/halo-backups/ws3-handoff-20261015T075907Z/` captures all 25 final dirty paths, including 0035 and its tests; bundle/archive/manifest are independently verified after capture. Existing recovery artifacts preserved. These are code backups, not database backups or hosted restore drills.

AGENTS.md and nested-instruction search, the complete current WS3 package, DECISIONS.md, canonical architecture/plan/status/gap/security/deployment/tenant evidence, historical migrations and relevant implementations/tests were inspected. No nested agent instruction file found in applicable task directories. Supabase skill applied; its network steps were overridden by the owner's offline rule. No secret environment files read, packages installed, dependencies downloaded or external provider called.

## Task ledger

| Task | Status/evidence | Dependencies / next action |
|---|---|---|
| Preserve state | DONE / durable 19-path archive, bundle and manifest verified | Retain private backup |
| K1 additive correction | DONE / 0035; historical 0033 unchanged; function body differs only by approved shared validation branch | No further local K1 approval needed; future real-target operation still separate |
| K1 regression and security | DONE / 7 behavioral DB tests, exact-body/security static tests, before/after upgrade and replay | Authorized hosted validation remains outstanding |
| Recovery | DONE LOCALLY / 70/70 full rehearsal, unsafe restore still rejected | Actual backup scope/Auth/Storage/key handling/RPO/RTO remain unverified |
| Nine owner IDs | RECONCILED / exact questions, alternatives, risks, dependencies and individual requests | All nine require owner/role-specific choice; none implicitly ratified |
| Ten preflight groups | PREPARED / reviewed collector, inventory, saved-evidence assessor and template, operator request | Actual T1–T10 evidence uncollected |
| Migration/runbooks | DONE / 35-file dependency map and prefix/upgrade/bootstrap/rollback paths | Actual ledger/schema/runner must be verified under authorization |
| Local gates/diff | DONE / results below, tracked plus untracked diff reviewed | Network-dependent build intentionally not run |

## K1 implementation and acceptance

**VERIFIED_LOCAL/source:** [0035_knowledge_backfill_source_ref_validation.sql](../supabase/migrations/0035_knowledge_backfill_source_ref_validation.sql) replaces `public.knowledge_backfill_legacy(p_business_id uuid, p_apply boolean default false)`. The approved new branch is `char_length(d.source_ref) > 500` → `quarantined_source_ref_too_long`, before missing-source classification and before either insert path. Existing unusable-content/foreign-collection precedence is preserved. Both modes share validation. Source is never truncated or relabeled; valid mixed records progress. The migration transforms no data and changes no table, constraint, RLS, grant, approval or retrieval behavior. CREATE OR REPLACE retains owner/OID/ACL, SECURITY DEFINER and fixed public search_path.

Migration generation: installed `supabase migration new --help` was inspected offline. CLI created an empty scratch migration outside the repository under an isolated network namespace. The reviewed body was written as 0035 to follow the actual repository's sequential four-digit convention. No historical migration or target ledger was modified.

**VERIFIED_LOCAL/disposable DB:** the rehearsal first applies 0032–0034 over the modeled historical 0001–0031 prefix, reproduces K1's old positive dry-run/atomic apply failure, then applies 0035 to source AND recovered copy. OID and all security snapshot rows remain identical; schema/security match across the two upgraded copies. Replay of the function replacement changes no data/privileges (ledger entries are not replayed). Independent PG16/real-role/PostgREST gates run all 35 files, including 7 K1 DB regressions.

| Required K1 criterion | Regression evidence |
|---|---|
| 499, 500, 501 | Dry/apply accept 499/500 and quarantine 501 consistently; Unicode 500-character/1500-byte reference preserved |
| Dry-run consistency, no unexpected mixed abort | Same document/action mapping; mixed valid docs and FAQ progress while long source remains unchanged |
| Atomicity, failed attempt and retry | Mid-call trigger faults after earlier valid work; zero revisions/FAQ rows and all source statuses restored; successful retry returns accurate counts |
| Idempotency | Retry creates no duplicate/replacement revision; only quarantined rows remain in output |
| Tenant isolation | A call changes only A's revisions; B unchanged; authenticated caller denied and service-only effective EXECUTE verified |
| Provenance, collection and history | Original source_type/source_ref and document collection preserved; immutable revision identity unchanged; no truncation |
| Approval/publication | New documents draft/index pending; FAQs pending review; already approved publication retained during replay, no automatic approval |
| Existing valid data and upgrade | Valid legacy documents/FAQ still backfill; 0034→0035 tested on both source/recovered copy; full clean chain also passes |
| Security model | Static exact-body comparison and before/after full security snapshots; owner/OID/ACL unchanged; no new grants/policies |

Apply output includes examined/quarantined items: count only draft_created_needs_indexing and pending_review_created as new revisions. An unrelated SQL failure still rolls back the whole call. Serialize per tenant; sequential idempotency is not concurrent-replay proof. All details and operations in [knowledge runbook](KNOWLEDGE_ROLLOUT_RUNBOOK.md).

## Recovery, inventory and migration findings

**VERIFIED_LOCAL/disposable DB:** original unsafe restore still fails acceptance because destination creator defaults can add grants absent from the source. The mitigation preserves PostgreSQL's hardwired creation baseline while restoring, then restores captured source creator defaults, leaving platform-owner defaults untouched. Deterministically ordered comparisons distinguish ownership/RLS, normalized grantor/grantee/privilege/grant-option ACLs, effective table/sequence/function privileges and creator defaults. TRUNCATE, sequence and EXECUTE parity are explicit regressions. Failed restore status, empty/missing evidence or categories cannot pass.

DDL comparison covers columns/types/defaults, functions, triggers, constraints, indexes and policies. PostgreSQL reparsing normalizes dump-roundtrip CHECK expression shape while an AND-versus-OR negative test remains unequal; no regex strips logic. Final recovery/K1 rehearsal **70/70, exit 0**. Sampling scope remains public + synthetic migration ledger on matching platform prerequisites; real Auth/Storage data/configuration, complete table fingerprints, key recovery and actual hosted RPO/RTO are unverified. [Recovery runbook](DATABASE_RECOVERY_RUNBOOK.md) distinguishes data/schema/security/isolation/knowledge/application acceptance.

**VERIFIED_LOCAL/disposable DB:** bootstrap scenarios still reproduce missing gen_random_bytes when 0001 lacks extensions resolution, and the vector-operator failure when vector is installed in extensions. Compatible plain postgres session applies all 35 migrations. The known-prefix upgrade skips 0001; path requirements depend on the actual pending SQL. Saved October 13 push information is historical, not current hosted ledger proof.

**DOCUMENTED/source:** 0033 conditional NOT VALID composite knowledge FKs and 0034's 19 generic tenant pairs/16 tables remain unchanged; existing mismatches are never repaired by installation. Generic census does not cover every orphan/dedicated guard. All 35 migrations are inventoried with prerequisites, grants/RLS effects, data transformations, transaction/replay constraints, rollback/failure hazards and owner/target gates. [Migration map](MIGRATION_DEPENDENCY_MAP.md) and [hosted runbook](HOSTED_MIGRATION_RUNBOOK.md) distinguish fresh initialization, historical 0001–0031, 0032–0035 upgrade, partial ledgers and matching application versions.

Read-only inventory requires an explicit existing tenant and reports counts without content. The collector now samples the 0035 validation marker alongside earlier flags, but a marker is not complete function/schema proof. Saved ledger comparison requires six flags, completion marker and explicit empty/absent distinction. `assess-hosted-preflight.mjs` reads only saved attestations, returns GO/STOP/NOT VERIFIED (0/1/2), rejects failures/duplicate groups and refuses missing target/read approval/evidence/reviewer. It always reports executionAuthorized=false. Tests include missing/malformed/null CLI evidence. The shipped template is all NOT VERIFIED; no hosted GO was fabricated.

## Executed verification ledger

Commands inspected before use. Outputs and exit status checked after completion. Logs retained locally under `/tmp/halo-ws3-final-*`; expected SQL-denial/fault output is synthetic, not customer/provider proof. No failing assertion was removed or relabeled as a skip.

| Exact command / operation | Actual result | Evidence |
|---|---|---|
| git status --short; git branch --show-current; git rev-parse HEAD; git stash list; git remote -v; git log -4 --oneline; applicable nested AGENTS.md search | Exit 0; state above; remotes inspected locally only | VERIFIED_LOCAL/source |
| Python SHA-256/archive verification; git bundle verify on old snapshot | Exit 0; prior complete bundle and 12 archive members valid, stale dirty coverage identified | VERIFIED_LOCAL/source |
| python3 /tmp/halo-ws3-final-backup.py | Exit 0; durable complete bundle + 19 dirty paths; hashes verified again at final review | VERIFIED_LOCAL/source |
| unshare -Urn env SUPABASE_TELEMETRY_DISABLED=1 supabase migration new --help | Exit 0; supported local scaffold command | VERIFIED_LOCAL/local executable |
| unshare -Urn env SUPABASE_TELEMETRY_DISABLED=1 supabase migration new knowledge_backfill_source_ref_validation --workdir /tmp/halo-ws3-final-migration | Exit 0; empty scratch template generated, repository convention used for 0035 | VERIFIED_LOCAL/local executable |
| git diff --no-index <empty-scratch-migration> supabase/migrations/0035_knowledge_backfill_source_ref_validation.sql | Exit 1 = expected nonempty diff, inspected before DB application; not a failed test | VERIFIED_LOCAL/source |
| npm run typecheck | Exit 0; final log halo-ws3-final-typecheck-final.log | VERIFIED_LOCAL/local test |
| npm run lint | Exit 0; final log halo-ws3-final-lint-final.log | VERIFIED_LOCAL/local test |
| python3 /tmp/halo-ws3-final-checks.py narrow | Exit 0; final 30 tests across K1/static, ledger, recovery and assessor; earlier 25/29 before assessor cases | VERIFIED_LOCAL/local test |
| python3 /tmp/halo-ws3-final-checks.py full-tests | Exit 0; npm test -- --maxWorkers=2, final 1,719 passed, 31 skipped, 167 files passed/3 opt-in files skipped | VERIFIED_LOCAL/local test |
| python3 /tmp/halo-ws3-final-checks.py worker | Exit 0; .venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'; 70 run, 1 skipped | VERIFIED_LOCAL/local test |
| npm run check:architecture && npm run check:neutral | Exit 0; boundaries, registry, RLS table gate and neutrality pass | VERIFIED_LOCAL/local test |
| node scripts/check-offline-database.mjs | Exit 0; first run 24 DB cases passed; final expanded run 26 passed (7 K1 + 8 governance + 11 PostgREST); 35 migrations/schema assertions and 649 RLS assertions / 0 FAIL | VERIFIED_LOCAL/disposable DB |
| node scripts/check-rollout-rehearsal.mjs | Exit 0; 70/70 through 0035, initial and final accepted runs | VERIFIED_LOCAL/disposable DB |
| npm run check:supabase-image-chain | Exit 0; A/P/C expected results, 35-file chain | VERIFIED_LOCAL/disposable DB |
| node scripts/assess-hosted-preflight.mjs infrastructure/hosted/preflight-evidence.example.json | Exit 2 EXPECTED; all ten NOT VERIFIED, executionAuthorized=false | VERIFIED_LOCAL/local test |
| node scripts/check-rollout-docs.mjs | Exit 0; 35 contiguous migration rows, 7 linked artifacts, 9 distinct scoped IDs, 10 target groups; template remains uncollected | VERIFIED_LOCAL/local test |
| python3 /tmp/halo-ws3-preflight.py | Exit 0; scratch cwd/minimal synthetic env, tsx --tsconfig <repo>/tsconfig.json --conditions react-server <repo>/scripts/preflight.ts --skip-db-check; CRON_SECRET/DB-skip warnings explicit | VERIFIED_LOCAL/local test |
| psql --help; node --check scripts/check-rollout-rehearsal.mjs; node --check scripts/assess-hosted-preflight.mjs | Exit 0; local command/interface/syntax inspection | VERIFIED_LOCAL/local executable |
| git diff --check; git diff --stat; full historical-file byte comparison to git show HEAD; final manifest/bundle verification and task-container cleanup inspection | Exit 0; no historical mutation, whitespace error or residual task container | VERIFIED_LOCAL/source |

The final-check wrapper executes npm/worker checks in a new `unshare -Urn` namespace with only its own loopback enabled, sanitized synthetic settings and offline model flags. Thus tests cannot reach external services or shared localhost ports. The DB harness creates a new random halo_check database in a cached-image --network none container, asserts actual identity, publishes no ports, mounts only listed source/test/config assets (no secrets/Git history), and shares only that namespace with a cached PostgREST. It invokes node scripts/check-migrations.mjs and node scripts/check-rls.mjs against that own database, then all three opt-in files with synthetic JWT/configuration. Creation/isolation establish disposability, not the name or URL. The separate Supabase-image rehearsal similarly owns and inspects its containers and cleanup. No 5432x/shared stack was touched. No new command failure required weakening tests; old pre-0035 errors are intentional negative regressions.

**Skipped / limits:** full suite's 26 DB opt-in cases were executed separately and passed; its five other existing skips and the worker's one existing skip remain explicit. `npm run build` is intentionally not run: src/app/layout.tsx imports next/font/google Geist and may download Google Fonts. The older check:recovery:local targets a different pre-existing synthetic-chat fixture; WS3 uses its own complete recovery rehearsal instead. No actual hosted SQL/ledger/CLI push, Auth login, provider call, backup/export or restore drill was attempted; separate exact authorization is required. No paid/external infrastructure or package installation.

## Decisions and actual-target evidence

**DOCUMENTED/source reconciliation:** R8, D19, D21, D22, D14, D8, D23, D11, D15 all remain pending in DECISIONS.md. Existing local permissions, implementation defaults, Sydney setup notes, operational bootstrap proof and descriptive audit naming do not ratify them. D8 is conditional for paid work and not a local-$0 blocker; D23/D11 gate real-data/pilot use. D14's grouped sub-decisions (roles, FAQ scope, per-turn/snapshot/traceability and legacy outage) count once. The separate K1 implementation approval is closed by the explicit prompt and recorded as evidence without changing any of the nine states. [Owner register](WS3_OWNER_ACTIONS.md) provides separate concise requests, recommendations, alternatives, risks, dependencies and required approvers. No pending ID was renamed/invented or marked approved to force closure.

[Actual T1–T10 worksheet and authorization request](HOSTED_TARGET_PREFLIGHT.md) are prepared, not executed. Every group remains NOT VERIFIED: identity/provenance; governance; ledger/schema; bootstrap session/extensions; authority/owners; RLS/effective privileges; tenant/knowledge census; backup/full restore; runner/application compatibility; post-apply acceptance. T2 can be closed through new owner records without connecting; none exists yet. The request names the historically documented candidate project but requires owner confirmation of database/environment/region/owners/operator and exact read scope before the provided read-only collector/inventory commands become executable. Migration, backfill, Auth setup and restore permissions are separate. Missing evidence is never a pass.

## Files and review

Starting five tracked modifications retained: docs/DECISIONS.md, HALO_V1_GAP_ANALYSIS.md, HALO_V1_STATUS.md, HOSTED_MIGRATION_RUNBOOK.md and infrastructure/hosted/preflight-readonly.sql. Decisions changes add only evidence of K1 authorization and the previously corrected historical CLI limitation, with no pending-state edits.

Fourteen pre-existing untracked files retained/updated: six WS3 docs (this report, owner register, migration map, target preflight, knowledge runbook, recovery runbook), infrastructure/hosted/knowledge-inventory-readonly.sql, scripts/check-offline-database.mjs, check-rollout-docs.mjs, check-rollout-rehearsal.mjs, compare-migration-ledger.mjs, recovery-security.mjs, tests/unit/compare-migration-ledger.test.ts and recovery-security.test.ts.

Six new final-closure files: supabase/migrations/0035_knowledge_backfill_source_ref_validation.sql; tests/unit/knowledge-backfill-migration.test.ts; tests/integration/knowledge-backfill-db.test.ts; scripts/assess-hosted-preflight.mjs; infrastructure/hosted/preflight-evidence.example.json; tests/unit/hosted-preflight-assessment.test.ts. These close K1 and make saved preflight evidence fail closed.

Tracked and untracked changes reviewed against the preserved baseline, including migration body equivalence, effective privileges, tenant boundaries, approvals, source metadata and operator authorization wording. No unrelated app refactor, hidden security weakening or sensitive data added. Final git diff --stat: five tracked files, 111 insertions and 18 deletions (DECISIONS 4 lines changed; gap 4 added; status 5 added; hosted runbook 26 changed; collector 90 changed). Twenty untracked artifacts are separately listed above. All historical migration bytes and unchanged HEAD independently verified. No safe authorized local task remains unfinished; owner/environment gates are accurately deferred, not declared deployment-ready.

WORKSTREAM 3 STATUS: COMPLETE — ROLLOUT PREPARED

HOSTED DATABASE MODIFIED: NO

SPEND: $0

CHANGES COMMITTED OR PUSHED: NO

DEPLOYMENT AUTHORIZED: NO

K1 ACCEPTANCE: PASS — LOCAL / DISPOSABLE DB

RECOVERY ACCEPTANCE: PASS — LOCAL / DISPOSABLE DB

OWNER DECISION IDS OUTSTANDING: 9

REAL-TARGET EVIDENCE GROUPS OUTSTANDING: 10

---

## Addendum — local release-readiness audit, 2026-10-15

Recorded without changing the findings above. Full context: [LOCAL_RELEASE_READINESS_REPORT.md](LOCAL_RELEASE_READINESS_REPORT.md).

- **The 70/70 recovery evidence went stale after WS4.** On the current tree (with WS4's `0036`), `node scripts/check-rollout-rehearsal.mjs` exited 1 with **67/70**: three checks hard-coded "pending exactly 0032–0035" and "0035 ledger complete with no pending files". WS4 carried WS3's result forward without rerunning it. `node scripts/check-rollout-docs.mjs` also failed (`migration map row missing/duplicated: 0036_security_authorization_audit.sql`). The earlier failure is retained as evidence.
- **Documented compatibility change to WS3 artifacts** (the only ones; all other WS3 files and `0035` are byte-identical):
  - `scripts/check-rollout-rehearsal.mjs`: the pending set is now 0032–0036; the three expectations follow it; a new section 7 rolls `0036` forward on the source and the recovered copy, then restores a backup taken **after** 0036 with the same mitigated method. Sections 1–6 are otherwise unchanged. Result: **83/83, exit 0** (`disposable DB`, cached `supabase/postgres:17.6.1.155`, `--network none`, containers removed).
  - `infrastructure/hosted/preflight-readonly.sql`: a read-only `has_0036` flag (`audit_logs` plus both workflow telemetry columns), emitted in the machine-readable objects line. Verified as `0036=f` on a fresh database and `t` after upgrade and after restore.
  - `tests/unit/compare-migration-ledger.test.ts`: one new case proves a 0036 object/ledger disagreement is a STOP.
  - `docs/MIGRATION_DEPENDENCY_MAP.md`, `docs/HOSTED_MIGRATION_RUNBOOK.md`, `docs/HOSTED_TARGET_PREFLIGHT.md`: 0036 added to the map, the sequence (step 5a), rollback and compatibility tables, and the preflight description.
- **Unchanged:** all nine owner decision IDs and all ten actual-target evidence groups (T1–T10) remain outstanding. No hosted or shared database was touched. The rehearsal is not hosted restore evidence; RPO/RTO remain unapproved.
