# P2-LOOP — owner-authorized local completion

Authority: owner's “HALO — Autonomous Phase 2 Completion Loop” instruction, 2026-10-15.

Objective: reconcile current evidence, review W4.1, implement W4.7 thinking interruption,
prepare and measure W4.3, correct calendar reconnection loss, and report remaining gates.

Scope: voice sessions and their language helpers, worker invariant tests, calendar OAuth
callback and regression tests, local benchmark scripts, readiness/task/evidence documents.
Follow-up review fixes include production workflow timer correlation deserialization.
Existing WS1–WS4 code is in review scope. Prerequisites: clean baseline at
`9b35beed482f269a9b1d2db1ea9b93f639f87cbc`; inspect architecture and decisions.

Out of scope: migration edits/additions, provider/model selection, hosted access, commits,
pushes, deployments, shared DB writes and decision ratification. D17/W4.2 refer to
provider selection/model configuration, not a write-authorization policy.

Acceptance: reproduced regressions fixed with tests; voice invariants retained; repeatable
mock benchmark; fresh gates and manual review; precise owner/target blockers recorded.
Commands: canonical package scripts, Python worker unittest discovery, isolated disposable
DB scripts, `git diff --check`, baseline migration hash verification.
Rollback: owner may reverse this task's reviewed diff; no schema or external rollback required.
No automatic history changes. Report: `docs/PHASE2_COMPLETION_REVIEW.md`.

Additional scoped completion: W4.4/W4.5/W4.9 implementation, invariant tests and
benchmarks follow [their task card](W4_4_5_9_LOCAL_VOICE_TASKS.md). Runtime parallel
reads, call-owned cache and ordered persistence are in scope under the owner's
continuous completion instruction. No model/architecture decision is ratified.


## P2-INDEPENDENT-REVIEW — 2026-10-16 authorization superseding prior limits

Authority: owner's “HALO Phase 2 — Independent Codex Review, Remediation,
Documentation, Commit, and Push” instruction. Objective: independently review the
complete Phase 2 candidate, fix genuine findings, verify, update canonical evidence,
and commit reviewed scope. Push only to an unambiguous existing Phase 2 upstream.
Scope: all 79 initial modified/untracked Phase 2 paths captured in the completion
JSON's independentCodexReview.initialState, including earlier implementation and
imported new files; remediation in worker routing/tests and migration race harness.
Out of scope: hosted/shared writes, migration execution on hosted targets,
deployments, paid calls, secrets, unrelated work, history rewriting or branch changes.
Prerequisites: branch Phase-2-Security-Hardening at 9b35beed; preserve dirty tree;
separate Codex reviewer; migration 0001–0036 integrity.
Acceptance: all review findings dispositioned with evidence; final local gates pass;
precise staged scope, descriptive commits; safe push only with upstream resolved.
Commands: AGENTS gates, isolated check-offline-database, rollout rehearsal, image
chain, rollout-doc validator, JSON parsing and git whitespace/integrity checks.
Rollback: reverse only this task's reviewed changes under owner direction; no hosted
or schema state changed. Initial patch/inventory: /tmp/halo-p2-independent-review.
No reset, stash, clean, rebase or overwrite of existing work is authorized.
