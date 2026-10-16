# P2-LOOP — Phase 2 completion and release review

**Current review update:** see [P2-INDEPENDENT-REVIEW](#p2-independent-review--2026-10-16) below. Earlier “Codex pending” and “commit declined” statements describe prior sessions and are superseded by the current owner authorization and review results. Hosted readiness remains pending.

2026-10-15–16 (Asia/Kolkata). Codex manual source review and local engineering under the owner's
“Autonomous Phase 2 Completion Loop” instruction. Task authority/scope:
[task card](PHASE2_COMPLETION_TASK_CARD.md). This record supersedes stale baseline
and task-disposition claims in the earlier local report, without erasing history.

## Executive disposition

**PARTIALLY COMPLETE; HOSTED VERIFICATION PENDING.** W4.1 review found additional
bugs; those bugs, W4.7, W4.3 local pipelining, calendar reconnection loss and a
production timer correlation defect are corrected with regression evidence.
W4.2/D17 and W4.8 require specific owner choices. W4.4, W4.5 and W4.9
are locally implemented, benchmarked and manually reviewed; details below.
Build verification is recorded in the final evidence ledger. No deployment or
provider result is claimed. Remaining release work requires owner decisions,
separate review/commit authorization or an authorized real target.

**Update 2026-10-16 — Phase 2 blocker loop ([section below](#phase-2-blocker-loop--2026-10-16)).** The owner decided the open local questions in conversation. W4.2 is locally complete: there is no built-in speech model on either path, and the model pair itself stays D17. W4.8 is closed as deferred (D24). The calendar first-connect race (P2-R1) is fixed locally by migration `0037` (D25, local and disposable use only). The owner declined commit authorization. The disposition is unchanged: **PARTIALLY COMPLETE; HOSTED VERIFICATION PENDING.**

Evidence labels throughout: **source**, **local test**, **disposable DB**.
No staging, production, real-provider or end-to-end caller/PSTN Telugu evidence exists.
Installed local-model contract and synthetic English/Telugu round-trip evidence
was collected separately, as described below.
The separate independent reviewer mechanism was not invoked: running another
external model/CLI is outside the authorized $0/no-provider scope. The review
below is a manual Codex review by this agent, including a fresh post-fix pass;
it is not a second-agent approval of this agent's own implementation.

## Baseline reconciliation and preservation (source)

- Root `/home/parzifal/AI_Receptionist`; branch `Phase-2-Security-Hardening`.
- Actual starting HEAD `9b35beed482f269a9b1d2db1ea9b93f639f87cbc`, not the old
  report's `ad6a19d830633712b948ff5fc75972c2f61a17fa`. The former commits the
  previous report's 145 paths. Working tree, index and untracked inventory were
  **empty** before this task. There were no pre-existing working-tree edits to
  preserve. Review scope includes `ad6a19d..9b35beed` and this task's diff.
- Initial status, index and migration SHA-256 manifest recorded before edits in
  `/tmp/halo-phase2-loop/baseline-*`. Final preservation artifact records checks.
- No branch switch, commit, push, stash, reset, cleanup of user files or historical
  rewrite. All 36 migrations remain byte-identical to starting HEAD, including
  0001–0034, 0035 and 0036. No migration added.
- Existing five `supabase_*_AI_Receptionist` containers remain untouched. Disposable
  checks create `halo_check_*` databases with task-owned containers and cleanup.

## Task acceptance and disposition

| Priority/task | Acceptance and evidence-backed disposition |
|---|---|
| 1 / W4.2, D17 | *2026-10-16: W4.2 LOCALLY COMPLETE by owner decision; D17 model pair, speaker and fallback still PENDING (see blocker loop).* Original 2026-10-15 disposition: **BLOCKED ON OWNER DECISION (source).** Owner clarified in this conversation to use repository definitions. W4.2 is shared speech model/voice ID resolution, not write authorization. D17 is pilot provider selection. Configured paths use `VOICE_STT_MODEL`, `VOICE_TTS_MODEL` and `VOICE_PROFILES_JSON`; worker and gateway still have different unset defaults. Choose the STT/TTS model pair, speaker/voice profile and fallback route under D17; do not infer a policy or silently select a default. Existing configured-model tests remain applicable. No write-authorization policy was invented. |
| 2 / W4.1 | **LOCALLY COMPLETE after review corrections (source/local test).** Reviewed `_build_vad`, `VadRunner`, `MediaGate` and both session engines through VAD, transcript, cancellation, turn settlement and cleanup. Earlier acceptance missed hangover silence and remote thinking cancellation. New fail-before/pass-after tests and full worker/session suites cover the corrected paths. |
| 2 / W4.7 | **LOCALLY COMPLETE; manual review (source/local test).** Raw remote VAD starts no longer cancel generation. Worker emits bounded `speech_progress` at its audio-duration threshold; substantive transcripts can interrupt sooner. Exact per-language acknowledgement lists gate short thinking transcripts. Telugu, Tenglish, English, disabled barge-in, stale progress, final retention and one cancellation are tested. Playback interruption remains worker-owned. |
| 3 / W4.8 | *2026-10-16: CLOSED — DEFERRED BY OWNER DECISION ([D24](DECISIONS.md#d24--prompt-section-order-w48)).* Original 2026-10-15 disposition: **BLOCKED ON OWNER DECISION (source/local test).** Exact conflict and alternatives below. Prompt composer, version and snapshots unchanged. Current RRF tie behavior gained characterization coverage; golden retrieval/conversation tests pass. |
| 4 / W4.3 | **LOCALLY COMPLETE; hosted measurements pending (source/local test).** Standalone [card](W4_3_VOICE_PIPELINING_TASK.md), actual-gate benchmark, delivery/cancellation invariants, bounded one-chunk prefetch and measured synthetic improvement. No real Telugu/model latency claim. |
| 5 / W0.2 | *2026-10-16: the owner was asked and chose "No commit"; still BLOCKED ON AUTHORIZATION.* **Baseline commit requirement already executed; new commit BLOCKED ON AUTHORIZATION (source).** D10 records approval/execution and actual starting tree is clean at a pinned commit. The old report's dirty-tree blocker is stale. This task's new diff is deliberately uncommitted. Review/validation does not require a new commit; releasing this new candidate eventually does. |
| 5 / overall review | **Manual Codex review complete for inspected risk paths; separate approval pending (source/local test/disposable DB).** Reviewed tenant/auth boundaries, audit admission/terminal failure, replay ownership, correlation, providers' ambiguous retries, workflow/reminder recovery, migration/recovery evidence and new diffs. Findings/dispositions below; no independent second-review claim. |
| 6 / hosted preparation | **LOCALLY PREPARED; HOSTED VERIFICATION PENDING (source/disposable DB).** Existing T1–T10 worksheet/runbook and owner-action package remain the exact target gates. Fresh chain/RLS/audit/recovery evidence accompanies them; no target contacted. Calendar loss fixed; first-connect uniqueness race explicitly remains. |

## Findings and review disposition

| ID / severity | Source/function and failure | Remediation and evidence |
|---|---|---|
| P2-F1 / high | Google OAuth callback deleted working credentials before replacement insertion. | Encrypt first; tenant/provider/null-staff-scoped lookup; update an existing row atomically by ID, or insert only when absent. Lookup/duplicate errors fail closed. Regression reproduced old row becoming null on insert failure. Success, failure, missing refresh, foreign tenant, member and lookup failure tests now pass. **local test**; no live OAuth call. |
| P2-F2 / medium | `RemoteVoiceSession.onSpeechStart` assumed worker VAD starts were duration-gated, but worker sent starts immediately. | Separate presence from measured progress; transcript and duration gates. Seven tests failed before W4.7 fix. **local test**. |
| P2-F3 / medium | `Endpointer.currentSpeechMs` and worker media gate counted VAD hangover silence toward the speech minimum, so a short cough eventually interrupted. `VadRunner` also re-emitted a start when STOPPING returned to SPEAKING. | Track current speech run in Node; tag analyzer SPEAKING/STOPPING locally in worker frames, reset count on hangover, avoid double-counting onset and repeated starts. Two new cough tests failed before and pass after; analyzer-transition test pins metadata and one start/end. **local test**. This is synthetic VAD/frame proof, not a real cough-classifier quality result. |
| P2-F4 / medium | Worker waited for each carrier acknowledgement before next TTS request. | Synchronous FIFO mark reservation before arming the next synthesis; at most one prefetched chunk. Tests prove next synthesis precedes old acknowledgement, each delivered index follows its mark, cancellation rejects late audio and failed marks never complete a playback. **local test**. |
| P2-F5 / medium | Failed playout waiter could fall through to `completed`; exception path exposed raw vendor exception text and did not clear buffered audio. | Report failed, clear prefetch and cancel waits; static log category. Failure and privacy tests pass. **local test**. |
| P2-F6 / medium | `SupabaseWorkflowStore.claimDueTimers` omitted `telemetry_correlation_id` although the schema, enqueue and in-memory tests retained it. | Decode the actual returned column; regression runs production decoder through `WorkflowEngine`, fails before and passes after. **local test**, not deployed propagation. |
| P2-R1 / *locally resolved 2026-10-16* | Calendar nullable-staff uniqueness admits concurrent first-connection inserts. Existing duplicate rows cause lookup failure instead of destructive repair. | **BLOCKED ON MIGRATION APPROVAL (source).** A robust DB uniqueness/atomic reconnect design needs an approved additive migration plus legacy duplicate policy. No migration or cleanup invented. Reconnection updates preserve the working row but do not promise global serialization or provider-token revocation recovery. *2026-10-16: owner approved additive `0037` for local and disposable use ([D25](DECISIONS.md#d25--calendar-business-level-connection-uniqueness-0037)): a count-only duplicate guard plus a partial unique index, and the callback replaces the winner's row after a lost race. **disposable DB**; hosted application and any legacy disposition still need authorization. The winner's provider tokens are not revoked.* |
| P2-R2 / remaining | Mixed worker/gateway releases: older gateway rejects new `speech_progress`; older worker cannot emit measured progress. | **HOSTED VERIFICATION PENDING (source).** Ship matched artifacts after target authorization and test version combinations before rollout. No production upgrade compatibility proof. Substantive transcripts still gate the new gateway with older workers. |
| P2-R3 / resolved | Canonical `next/font/google` build initially needed an uncached Geist response. | **LOCALLY COMPLETE (local test).** Owner authorized public Google Fonts fetch in a credential-free snapshot. Final source-matched canonical build exited 0 in 128.97s; widget, compilation, type analysis and static generation succeeded. No mocked font, real credentials, hosted target or deployment. Earlier isolation/preparation failures retained. |

The post-fix review inspected queue/marker order, context attribution, late frames,
confirmation failure, interrupted mark tasks, one-playback ownership, current-turn
cancellation, verified tenant predicates and fail-closed lookup. Existing
commit-point, handoff and no-replay contract tests remain required evidence.
No finding grants an external side effect or changes owner decision states.

## W4.8 decision record (source; resolved 2026-10-16 as option 1, D24; no semantics changed)

The repository's W4.8 is **prompt section ordering**, not a request to change
knowledge ranking. `HALO_V1_IMPLEMENTATION_PLAN.md` W4.8 asks to “Put the stable
prompt prefix first” and requires “snapshot diff is ordering only.” But
`buildSafetyRules` says “Answer ONLY from the business profile, business hours
and knowledge base above”; additional instructions also refer to “Rules above.”
`prompt-composer.ts` documents facts-before-policy as an injection defense.
Stable-prefix-first moves dynamic facts/knowledge after text that refers to them
as above. Changing that reference changes content and violates the literal
ordering-only acceptance. No approved owner record resolves this conflict.

Owner alternatives:

1. Retain facts-before-policy and current text; defer caching-oriented reorder.
2. Approve stable-policy-first **and** direction-neutral Rules wording, composer
   version bump, reviewed snapshot content changes and model evaluation. This is
   not order-only and requires revised acceptance.
3. Specify another explicit safe prefix boundary and approved expected order.

Recommended interim: option 1, because it preserves the current safety contract.
If optimizing later, option 2 must explicitly approve wording and evaluation.
Affected tests: prompt-composer snapshots, context budget and golden transcripts.
No prompt version bump is needed now because no composer code changed.

Retrieval inspection: governed RPCs filter tenant/approval/collection before
ranking; provider drops foreign/empty rows; keyword and optional vector results
use RRF (k=60), stable JS sorting preserves first occurrence on equal fused score.
Resolver preserves provider order, filters minimum score and applies character
budget. Embedding failure falls back to keyword; permission failure never widens
scope. SQL ties without a secondary key are not promised deterministic across DB
plans. The added RRF test is a characterization of current code, **not** owner
approval of a new ranking or SQL tie-breaking contract.

## Voice measurements and executable invariants (local test)

`benchmark_chunk_pipeline.py` drives actual `MediaGate` with two fake chunks,
30 ms synthesis and 100 ms playout, ten samples per mode. Before optimization,
both modes were serial. After optimization, serial control p50 total 265.572 ms,
p95 266.414 ms; pipelined p50 234.112 ms, p95 234.734 ms. Sentence gap p50
30.835 → 0 ms, p95 31.059 → 0 ms. This measures overlap under injected conditions,
not vendor throughput or model quality. Final benchmark artifact/ledger contains
fresh rerun numbers; earlier values are retained as iteration evidence.

Node `voice:latency -- --calls 2 --turns 2`: four turns, injected STT 250 ms,
model 600 ms, TTS 200 ms; speech-end-to-first-audio p50/p95 1008 ms, max 1011 ms.
Small sample; separate engine and metric from worker sentence gaps.

Installed local models were discovered at `models/voice-local/manifest.json`;
they are **available**, rather than an unavailable-model blocker. With
`VOICE_LOCAL_MODEL_DIR` explicitly set, the TS local-provider contract file
passes 10 tests (5 stand-in and 5 actual-model cases), and the worker local-speech
file passes 20 tests with no skip, including its English/Telugu TTS→STT test
(two synthetic phrases, similarity >0.8). This is **local test** evidence using
installed sherpa-onnx/Piper weights, no external provider or human recording.
It does not overturn the historical broader Telugu WER result or supply native
human audition, real-call latency, pronunciation quality or consented recordings.
All 31 general JS skips are thus separately covered: 26 disposable DB and 5
local-model cases. The worker's one general skip is covered by its opt-in run.

Two sandboxed Pipecat fixture runs stalled at pipeline teardown and were
terminated with SIGTERM (child exit -15); their raw logs and runner durations
remain in the ledger. The same suite passed outside the sandbox in a private
loopback-only namespace. Sandbox-specific cause is not fully diagnosed; no
product fix or model failure is inferred from those stalls. Early full JS runs
also failed with socket EPERM and loopback-down ENETUNREACH; the corrected
isolation run passed. Early runner log-name reuse is explicitly qualified in
the ledger; later invocations use unique paths. An incorrect new calendar
success-redirect assertion was corrected from `calendar_connected=1` to the
existing `calendar=connected` contract; its earlier failing result is retained.

Executable contracts: `test_chunk_pipeline.py`, `test_speech_minimums.py`,
`thinking-interruption.test.ts`, protocol bounds, existing voice/session/remote,
gateway replay and handoff/commit-point suites, worker real-WebSocket fake-vendor
loop, golden transcripts, privacy sweeps and correlation tests. Single playback,
mark-confirmed delivery, tenant/session ownership, serialized turns and cleanup
are engineering invariants. Language examples pin text/language behavior only;
none proves Telugu recognition, naturalness, actual cough classification or PSTN.

## Hosted preparation and owner actions (source)

[WS3 owner actions](WS3_OWNER_ACTIONS.md), [target worksheet](HOSTED_TARGET_PREFLIGHT.md),
[migration runbook](HOSTED_MIGRATION_RUNBOOK.md) and [telemetry contract](TELEMETRY.md)
remain operative. T1–T10 are all **real-target evidence required**: identify target,
operator, exact read/write scope, credentials via secure channel, migration ledger,
object/extension placement, owners/effective and default grants, orphan/tenant census,
backup coverage/restorability, recovery/rollback method, lock/load behavior and
captured evidence. A database restore is the recovery method; irreversible data
loss must never be described as SQL migration rollback.

Migration range: fresh disposable ledger ends at 0036 with all 0001–0036 applied.
The rehearsal's synthetic 0001–0031 prefix expects exactly 0032–0036 pending;
actual hosted pending range is **unknown until authorized read-only preflight**.
Compatible `0001` bootstrap uses `public, extensions`; vector in `extensions` is
still STOP. Do not edit historical migrations. Source/recovered schema, ownership,
ACL/default privileges, audit rows and append-only service restrictions are checked.

Unresolved decisions, rechecked against DECISIONS.md (nothing ratified):

| Canonical ID | Exact choice needed / impacted work / consequence |
|---|---|
| D1, D2 | Keep/change stack and layout; runtime/deployment/import boundary; no rewrite authorized. |
| D3, D4 | Pilot carrier and call direction; carrier integration/outreach remains blocked. |
| D5 | Tool invocation model; broader tools/execution work waits. |
| D6 | Recording and consent policy; no recording activation. |
| D7 | Exact target application of 0032/0036; local audit approval does not authorize real DB writes. |
| D8 | Budget/limits or retain $0; paid inference/speech/carrier/messaging remains blocked. |
| D9 | Numeric pilot recognition/latency/extraction/cost targets; no pilot performance acceptance. |
| D11 | Attributable business facts, disclosure/DNC/handoff/contact/visit policy; missing facts stay UNSET. |
| D12, D13 | Optional infrastructure and workflow engine choice; no infrastructure or workflow redesign inferred. |
| D14 | Ratify remaining knowledge defaults and legacy rollout: approval separation, FAQ binding, per-turn vs snapshot, traceability and blackout/replacement-version process. No target application authorized. |
| D15, D16 | Canonical audit/voice tracking IDs and implementation-owner naming; no silent renaming. |
| D17 | Speech/LLM route, model pair, speaker and degraded local fallback; provider validation waits. *W4.2 unset-default question resolved 2026-10-16 (no defaults).* |
| D25 | *Added 2026-10-16.* Authorize applying `0037` to a real target after the read-only duplicate census; disposition any duplicate separately. Local/disposable use approved. |
| D18 | Hosted telemetry backend, export/access/retention/cost and operations owner; export stays disabled or opt-in local stdout. |
| D19 | Hosting topology, region/residency and target identity; no staging provisioning. |
| D20 | Phone sentence streaming safety design; W4.10 remains blocked. |
| D21 | Approve target-specific 0001 bootstrap/runner method after extension/ledger evidence; no hosted migration execution. |
| D22 | Adopt 0034 and authorize any legacy correction separately; local success is not adoption. |
| D23 | Per-table personal-data retention/deletion/export/backup/DNC policy; no invented audit retention duration. |
| R8 | Environment/data/provider/privacy/security/operations owners and exact evidence/action authorization; target access and real-data pilot blocked. |
| R9, R10 | Pilot acceptance and GA go/no-go evidence/owners; downstream release gates remain pending. |
| Recovery objectives | Owner-approved RPO/RTO, backup scope/copies and target restore drill; local timing is not an approved service objective. |
| W4.8 clarification | *Resolved 2026-10-16: option 1 (D24).* Select one prefix contract above; preserve current prompt until approved. |

Audit uses minimal append-only tenant-readable records; service INSERT/SELECT,
no service UPDATE/DELETE/TRUNCATE. DB-owner administration and tenant cascade are
exceptions; no owner-tamper hash-chain claim. Real-data audit and backup retention,
operator access and deletion/export remain D23/R8 gates. No automatic audit purge
is configured. Telemetry is allowlisted, privacy-safe, disabled by default or
opt-in stdout; no hosted aggregation, external exporter, alert destination,
retention/cost evidence or alert delivery drill exists.

Provider readiness: no secret values inspected or printed and no credential
validity probe. Required deployment inputs remain LLM route keys/account quotas
and rate-limit evidence, Sarvam/model/voice inputs, optional local model files and
license/native-language review, Twilio signing/token/callback/DID configuration,
Google OAuth ID/secret/redirect/consented refresh token, calendar credential
cipher key, and real messaging sender/webhook configuration. Presence is not
validity or authorization. Account-level capacities/costs and callbacks remain
unverified. Unkeyed calendar/WhatsApp creates are one attempt after ambiguity;
Resend content-prefix idempotency collision, manual duplicate invocation and
remote commit/response gaps remain documented limits, not exactly-once guarantees.

## Verification, files and remaining actions

Actual commands, exit codes, counts, failures, skips and hashes are maintained in
[evidence ledger](evidence/local-release-verification-ledger.json) and
[completion evidence](evidence/phase2-completion-results.json). Raw synthetic logs
are under `/tmp/halo-phase2-loop`; portable source tests and benchmark are retained.
The full JS suite's 26 opt-in database cases are covered by the separate disposable
harness; remaining intentional skips and worker skip are individually inventoried
there. No skipped real-provider test is counted as provider proof.

Changed files: voice language helper/pack, in-process endpointer/session, Pipecat
protocol/remote/worker/client/gate and tests; calendar callback and failure tests;
runtime parallel reads, call-local history/state cache and ordered persistence;
policy audio cache and opt-in codec adapter; one workflow decoder and its
regression; task/report/status/evidence documents.
The completion evidence contains `git diff --stat` plus all new file paths.
TTS normalizer twins and prompt composer are unchanged; parity/version changes
are unnecessary. No dependency or lockfile changed.

Highest-priority next release action: owner resolves D17 with the speech/provider
owner and Telugu reviewer, including exact future $0/budget authorization; this
unblocks shared unset defaults and meaningful voice evaluation. Independently,
choose W4.8 semantics, approve
an additive calendar uniqueness correction if desired, and obtain a separate
review/commit authorization for this diff. No commit is made merely to clear a
label. W4.4/W4.5/W4.9 local acceptance is now met; provider codec activation and
real latency/quality remain hosted validation gates.

External actions: no hosted/shared database reads or writes, provider inference,
STT/TTS/carrier/calendar/messaging calls, outbound calls, deployments, publication,
merge, push, commit, paid resources or production changes. Public Supabase docs
were read; the changelog markdown fetch was unsupported by the web tool. Isolated
font requests initially failed in isolation; the owner then authorized public Google
font fetch for the credential-free canonical build, which passed. Synthetic tests
attempted no reachable inference, speech or business-action provider;
third-party import-time NLTK downloads were blocked by network isolation.


## Remaining local voice cards — completed (source/local test)

[W4.4/W4.5/W4.9 task card](W4_4_5_9_LOCAL_VOICE_TASKS.md) records scope,
acceptance, commands and rollback. Fresh manual review inspected cache ownership,
budget short-circuit, storage failure ordering, cleanup, frame context attribution,
codec defaults and vendor startup. This is this agent's review, not separate approval.

| Card | Result and measured evidence |
|---|---|
| W4.4 | Independent state/history reads start together. Per-call tenant/conversation-pinned cache clones values and bounds history; knowledge remains per-turn. Five focused tests include exhausted budget with hung history and late state-read protection. Ten sequential samples after two warmups, 20ms/read: turn-wall p50 serial control 43.52ms, parallel 22.64ms, warm reuse 1.52ms. |
| W4.5 | Voice-only FIFO queue admits up to 64 pending writes; no retry after ambiguous error. Close waits at most 5s and reports pending work. Three queue and two runtime integration tests cover failures, hung storage, clone ownership and heard-prefix history. Ten samples, two 20ms writes: p50 awaited 43.71ms, queued 1.25ms. Admission is not durability: crashes/full queues may lose transcript/state; failures are privacy-safe logs/degraded status. Business actions and critical audit writes remain awaited. |
| W4.6 | Existing voice cooldown skip now has an actual-router synthetic benchmark: ten samples, seeded 30ms cooldown, p50 wait 30.518ms versus voice skip 0.0446ms. No provider quality/latency claim. |
| W4.9 | Existing Pipecat per-call StartFrame preconnect is retained. Call-local fixed-policy-only LRU uses tenant/agent/profile/voice/language/rate keys; 4 entries/512KB, 128KB/256 frames per chunk, cleared on fallback/close. Replies never cached; replay gets new context and its own carrier mark. Nine tests cover isolation, lifecycle, default routing and wire bytes. Ten fake-synthesis samples: first-audio p50 miss 31.425ms, hit 1.764ms. Twenty one-second serialization samples: PCM conversion p50 11.15ms vs μ-law passthrough 0.116ms, identical wire bytes. |

`VOICE_TTS_OUTPUT_CODEC` defaults to `linear16` and preserves the original vendor
service class. Explicit `mulaw` selects an adapter correcting the pinned SDK's
codec configuration/frame metadata; no deployed setting changed. Live codec
support, audio quality and cost require D17 and exact provider authorization.
A startup cancellation regression protects queued greeting ownership. No duplicate
socket connection or global/cross-call audio cache was added.

Final general suites: **1,818 TypeScript tests passed, 31 skipped; 182 files passed,
3 skipped. Worker: 100 tests, OK, 1 skipped.** All general opt-in skips are covered
by separate disposable DB and installed-model runs described above. Final
configuration/type/lint/architecture gates and build outcomes are in the ledger.
A fresh final disposable DB run again passed all 36 migrations, RLS 669/0 and
26 production governance/PostgREST cases. No schema changed.

P2-F7 / medium — final fresh review found a late state-load race in the new
call-local cache: a timed-out DB snapshot could overwrite a newer saved call
state. The cache now checks a revision before adopting read results. A fifth
cache regression holds the old read, saves turnCount=3, then completes the old
snapshot and verifies both returned/cached state stay at 3. Focused seven cache/
runtime tests pass; final full gates and source-matched build were rerun after
this correction. No database/schema/provider behavior changed.

Build isolation preparation (local test): the first credential-free snapshot used
a dependency symlink which Turbopack rejected as outside its root. A hardlink
copy then failed because `/tmp` and the repository are on different devices;
a premature build of that incomplete copy failed resolving esbuild. A complete
ordinary dependency copy resolved both preparation failures. No dependency was
downloaded or changed in the repository. Successful build evidence hashes source
files and records synthetic environment and the exact public-font authorization.

After the cache revision correction, the same ten-sample context benchmark was
rerun while full tests/build were active: p50 serial38.677ms, parallel29.741ms,
warm3.841ms; p95 61.929/38.549/5.891ms. CPU/timer contention explains variability;
both runs are retained rather than selecting only the faster result. This is a
repeatable injected-latency experiment, not a production performance threshold.

## Phase 2 blocker loop — 2026-10-16

**Authority.** The owner's "Autonomous Phase 2 Blocker Resolution, Verification, Documentation, and Commit Loop" instruction (Claude Code). Four owner decisions were given in conversation and are recorded verbatim in [DECISIONS.md](DECISIONS.md): D17 (W4.2 sub-question), D24 and D25. The owner answered "No commit" to the commit question. Evidence labels: **source**, **local test**, **disposable DB**. No staging, production or provider evidence exists.

**Interpretation note.** The instruction described W4.8 as "knowledge ordering". The repository defines W4.8 as *prompt section ordering* (plan row W4.8), and that is what the owner decided (D24). No retrieval-ranking contract was changed or approved.

### Baseline (source)

- Branch `Phase-2-Security-Hardening`, HEAD `9b35beed482f269a9b1d2db1ea9b93f639f87cbc`; nothing staged.
- 26 tracked modifications and 24 untracked files from P2-LOOP were present before this loop. All of them are preserved and none is reverted.
- Baseline gates: typecheck 0, lint 0, `npm test` 1,818 passed / 31 skipped (182 files, 3 skipped), worker 100 OK / 1 skipped. These match the P2-LOOP ledger.

### Blocker ledger

| Blocker | Disposition | Evidence |
|---|---|---|
| D17 / W4.2 model configuration | **W4.2 LOCALLY COMPLETE (owner decision); D17 PENDING.** There is no built-in Sarvam model on any path. The gateway refuses to boot, and the factory, adapters and profiles refuse, without one. The worker refuses to start for its deployment selection, and refuses a tenant profile per session. Blank counts as unset, and the old worker-only `HALO_*_MODEL` names are no longer read. Still open under D17: the pair, the speaker, the local fallback and the LLM route, which need the speech/provider owner and a Telugu reviewer. | local test (fail-before/pass-after: 6 TS cases and 1 Python case failed on the pre-session sources; restored byte-identical) |
| W4.8 prompt order | **CLOSED — DEFERRED (D24).** No composer, version or snapshot change. | source |
| P2-R1 calendar first-connect race | **LOCALLY RESOLVED (D25, local and disposable use only).** `0037` takes a SHARE lock, runs a count-only duplicate guard and builds a partial unique index, all in one `DO` statement. The callback replaces the winner's row after a `23505`. The preflight gains a `0037` flag and a duplicate census (section 10), and the comparator requires the 0036/0037 flags. | local test (4 callback race cases; the main race case failed before) and disposable DB (below) |
| Review | **Independent fresh-context review completed; findings fixed.** This was a separate read-only reviewer pass of the same model family. It is **not** the Codex review that AGENTS.md requires (W0.3), which remains pending. | below |
| Commit | **NOT AUTHORIZED.** The owner chose "No commit". Nothing is staged or committed. | source |
| Hosted verification | **NOT VERIFIED.** No target was identified, read or written. The owner actions are unchanged except the added D25 row. | — |

### Verification (final runs after every fix)

| Command | Result |
|---|---|
| `npm run typecheck` / `lint` | exit 0 / exit 0 |
| `npm test` | exit 0: 1,827 passed, 31 skipped (183 files passed, 3 skipped) |
| `npm run check:architecture` / `check:neutral` / `preflight:ci` | exit 0 each; `check:architecture` was rerun after the final migration edit |
| `npm run build` | exit 0 (compiled; 15/15 static pages). It fetched public Google Fonts through `next/font/google`: an unauthenticated public GET, with no credentials or provider. |
| worker `unittest discover` | OK: 102 tests, 1 skipped |
| `node scripts/check-offline-database.mjs` (own container, `--network none`, `halo_check_*`) | exit 0. 37 migrations. 0037 refuses a seeded duplicate with a count only, no index and no row change. In the two-session race, one commits and the other waits 559 ms and is refused. `check:rls` 674 ok / 0 FAIL (669 + 5 new). 26/26 governance/PostgREST cases. |
| `node scripts/check-rollout-rehearsal.mjs` (Supabase image 17.6.1.155) | exit 0, 90/90 (83 + 7 for section 8) |
| `npm run check:supabase-image-chain` | exit 0: A refused, P applied, C refused (as expected) |
| `node scripts/check-rollout-docs.mjs` | PASS: 37 migration rows, 10 owner IDs |
| `git diff --check`; migration SHA-256 | clean; 0001–0036 byte-identical to the baseline; 0037 `6bcff77b…46fa1b` |

**Failures retained as history:**

1. The first rehearsal scored 89/90 because the 0035 ledger step still expected only `0036` pending. The harness expectation was fixed.
2. The first post-review disposable-DB run failed with `LOCK TABLE can only be used in transaction blocks`. `check:rls` replays migrations without a transaction, and a bare `LOCK TABLE` needs one. The transactional rehearsal had passed with the same file. Fix: the lock, guard and index build now form one `DO` statement, atomic in either runner mode. The hosted runner's transaction behaviour is still unverified (T9).

**Skipped:**

- The local-TTS parity script: the normaliser twins are unchanged.
- Real-provider, Telugu, hosted and PSTN tests: not authorized ($0, no target).
- The general suite's 31 skips are covered as before: the 26 DB cases by the disposable run above, and the 5 local-model cases by P2-LOOP's installed-model run. That run was not repeated here; this loop did not touch the local speech paths.

### Independent review findings and disposition

| # | Finding | Disposition |
|---|---|---|
| M1 | Between the 0037 guard and the index build, a concurrent writer could add a duplicate. The index error would then name the tenant. | **Fixed:** the SHARE lock comes first (later merged into the single `DO`). |
| M2 | The worker failed per call, not at startup as the owner's option said. | **Fixed:** `_check_speech_models()` runs in `main()` and is tested. |
| L3 | The race test did not prove the sessions overlapped. | **Fixed:** the loser must wait at least 300 ms; it observed 559 ms. |
| L4 | The reconnect assertion counted rows rather than updated rows. | **Fixed:** an `update … returning` count, expected `1,3`. |
| L5 | The comparator did not require the 0036/0037 flags. | **Fixed,** with tests; the worksheet text was updated. |
| L6 | The worker still read the `HALO_*_MODEL` aliases. | **Fixed:** removed and tested. |
| L7 | A whitespace-only model passed validation. | **Fixed** on all paths and tested. |
| L8 | Docs: last-writer-wins and the "83 checks" count. | **Fixed** in D25 and the runbook. |

### Remaining actions (smallest first)

1. **Owner:** authorize a commit scope for the P2-LOOP diff plus this loop's diff (W0.2), and trigger the Codex review (W0.3). Both are prerequisites in the AGENTS.md workflow.
2. **D17:** the speech/provider owner and a Telugu reviewer choose the model pair and speaker. On both paths, the STT name must be one the worker SDK accepts (`saaras:v3` or `saarika:v2.5`).
3. **D8:** authorize the budget for any provider smoke test.
4. **Hosted (R8, D19, D21, D22, D25):** name the target and the read-only authorization. Run the preflight, including section 10, and the ledger comparison. Then authorize the migration scope (0032–0037) and the recovery plan.
5. **Recovery, audit retention and telemetry:** RPO/RTO and the restore drill, D23 retention, and the D18 hosted backend remain owner/operations decisions. No values are invented here.

## P2-INDEPENDENT-REVIEW — 2026-10-16

**Current disposition: independent Codex review and local verification passed;
commit/push receipts follow below. HOSTED VERIFICATION PENDING.** The owner's
current instruction authorizes scoped remediation, documentation, commit and push;
prior “no commit” and “Codex pending” statements above are historical. The owner
separately confirmed `origin` (`Parzifal25/AI_Receptionist`) as the destination.

### Initial state and reviewed scope (source)

Repository `/home/parzifal/AI_Receptionist`, branch `Phase-2-Security-Hardening`,
HEAD `9b35beed482f269a9b1d2db1ea9b93f639f87cbc`; index empty; 53 modified tracked
paths and 26 untracked paths, all pre-existing Phase 2 work. Both `origin` and
`halo` exist; there was no upstream. Fetching the owner-confirmed origin branch
succeeded; its HEAD and merge base match initial HEAD (0 ahead/0 behind).
The complete relevant review includes `ad6a19d..9b35beed` and all 79 initial paths,
including imported untracked implementations and tests. No unrelated/unreviewed
paths were identified for inclusion. Initial status, full tracked patch, empty
index patch, per-file hashes and migration manifest were captured before edits
under `/tmp/halo-p2-independent-review`; the durable inventory is in the canonical
JSON's `independentCodexReview.initialState` and `classification` fields.

### Independent method, findings and disposition

Separate read-only Codex agents `/root/independent_review` and
`/root/remaining_review` were invoked using the collaboration reviewer mechanism.
They reviewed source independently of implementation, reproduced the configuration
faults with synthetic settings and performed a post-fix pass. This satisfies W0.3's
Codex review requirement; it is distinct from the earlier implementing agent's
manual self-review. Findings: **0 critical, 0 high, 2 medium, 1 low; all fixed**.

| Finding | Evidence and required action | Disposition |
|---|---|---|
| P2-CR1 / medium | Worker `_sarvam_key` ignored `VOICE_STT_API_KEY`/`VOICE_TTS_API_KEY` preferred by the gateway. **source/local test** | Match per-kind precedence; profile credential still wins. `test_per_kind_sarvam_credentials_match_gateway_precedence` proves independent per-kind and profile/common/legacy precedence. |
| P2-CR2 / medium | Worker startup ignored profile models; a missing/blank profile model silently inherited deployment config, contrary to gateway validation. **source/local test** | Startup validates every profile primary/fallback; profile Sarvam model must be explicit. `test_worker_startup_rejects_missing_profile_models_without_env_inheritance` covers both kinds, absent/empty/whitespace models, both fallback and primary, and valid profiles. |
| P2-CR3 / low | Calendar race harness inferred lock waiting from process runtime; scheduling delay could satisfy the threshold. **source/disposable DB** | Hold the winner transaction after an explicit readiness marker; observe the uniquely named loser in `pg_stat_activity` with `wait_event_type='Lock'` and nonempty `pg_blocking_pids` before committing. Final disposable run observes that wait, unique-index refusal and exactly one row. |

The independent post-fix worker suite passed **8 tests, exit 0**; the race harness
passed source re-review and disposable execution. A fail-first rehearsal restored
only the two pre-remediation function definitions in memory: the two new regression
methods produced 12 failed subtests and one signature error; current focused tests
pass. The first system-Python attempt lacked Pipecat and was repeated in `.venv`;
it is not counted as defect reproduction. No working-tree source was swapped.
A suspected callback error disclosure was rejected: the structured logger's
`PRIVATE_FIELDS` redacts the `error` property. No established finding was waived.

Review covered model startup/fallback consistency, tenant cache/persistence,
voice cancellation/delivery invariants, stream replay/authorization, audit/RLS,
calendar callback scopes and conflicts, migration duplicate refusal, recovery,
documentation consolidation, dependency/build and architecture implications.
No dependency/lockfile or prompt-composer/version/snapshot changes were made.

### Final verification (local test unless identified otherwise)

All commands below exited **0** on final applicable source. Exact commands, log
paths, counts, skipped-case coverage and failed/interrupted attempts are in
`docs/evidence/phase2-completion-results.json` under `independentCodexReview`.

| Command | Actual result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test -- --maxWorkers=2` | 183 files passed, 3 skipped; **1,827 tests passed, 31 skipped** |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'` | **104 run, 1 skipped** |
| `npm run check:architecture` | Passed — **source** |
| `npm run check:neutral` | Passed — **source** |
| `npm run preflight:ci` | Passed; deliberately skips DB; warns absent production email/WhatsApp configuration and CRON_SECRET; no hosted-readiness claim |
| `npm run build` | Canonical build passed; public Google Fonts fetch; no deployment |
| `node scripts/check-offline-database.mjs` | Fresh isolated `halo_check_*` database: **37 migrations, 674 RLS assertions/0 failures, 26 governance/PostgREST tests**; explicit observed-lock race passed — **disposable DB** |
| `node scripts/check-rollout-rehearsal.mjs` | **90/90 checks passed**, including duplicate-data refusal, recovery and 0037 — **disposable DB** |
| `npm run check:supabase-image-chain` | A refused, P applied/probed, C refused as expected — **disposable DB** |
| `node scripts/check-rollout-docs.mjs` | 37 ordered rows, 7 linked docs, 10 owner IDs and 10 evidence groups — **source** |
| `git diff --check` | Passed — **source** |

Separate opt-in coverage: with
`VOICE_LOCAL_MODEL_DIR=/home/parzifal/AI_Receptionist/models/voice-local`,
`node node_modules/vitest/vitest.mjs run tests/contracts/local.contract.test.ts`
passed **10/10**, including the five skipped actual-model cases; and
`.venv/bin/python -m unittest discover -s services/pipecat-worker -p test_local_speech.py -k RealModelTests`
passed **1/1**, covering the worker skip. The other 26 general-suite skips passed
in the disposable DB run. Stand-in `tests/unit/voice/local-speech.test.ts` also
passed 9/9; this is distinct from the actual-model contract run.

The restricted first JS run had 42 failures and 12 errors due to socket EPERM;
preflight IPC, Docker access and Google Fonts also required approved unrestricted
retries. Restricted worker pipelines and restart-interrupted DB/recovery runs
are incomplete evidence, superseded by completed final runs. No skipped or
interrupted run is represented as passed. Normalizer parity was not rerun because
both twins are unchanged. No hosted, production, paid-provider, PSTN or native
human Telugu acceptance test was run.

### Migration, decision and release boundary (source/disposable DB)

Migrations **0001–0036 remain byte-identical** to initial HEAD and captured hashes.
Migration **0037 remains unchanged during this review**, SHA-256
`6bcff77bc94f0d5c14189033e808b4418c3493972240b322d61d66a3dd46fa1b`.
Its SHARE lock precedes the count-only duplicate guard; guard and index are atomic;
the partial key permits separate tenants/providers and excludes staff rows.
Duplicate rows cause refusal without automatic data repair. It is reviewed and
tested locally and **not executed on a hosted target**. Removing the index would
restore the old nullable uniqueness behavior; target recovery and any legacy row
disposition need separate authorization, not an automatic cleanup.

D17 model pair, speaker, fallback and LLM route remain PENDING for the owner,
speech/provider owner and Telugu reviewer. W4.2's explicit-configuration decision
is implemented; it does not choose a provider route. W4.8/D24 remains closed as
deferred; facts-before-policy, prompt text, version and snapshots are unchanged.
Hosted target authorization, migration approval, duplicate census/disposition,
target-specific recovery proof, audit retention (D23/R8), telemetry (D19) and
live-provider/native Telugu/PSTN validation remain release gates. Local success
does not establish hosted-release readiness. No hosted/shared database writes,
application provider calls, outbound calls, deployment or paid usage occurred.

### Commit and push receipts (source)

Implementation commit `b2610b71a7440482d0d24a032aa71c0af426f824` contains exactly the 58 explicitly staged, reviewed
implementation/configuration/migration/harness/test paths (+2054/-153). Its contents
were inspected after commit; no hooks bypassed. The remaining 21 paths are the
reviewed canonical documentation/evidence set and are committed separately.
Push is pending; the destination is the owner-confirmed
`origin/Phase-2-Security-Hardening`. The final transport receipt below and canonical
JSON record supersede this pending statement after verification.

**Verified primary push receipt (source).** Documentation/evidence commit
`fef800b854ad733b871e9da58a3c2407b128f428` contains the 21 reviewed documentation paths (+6659/-94). After a fresh
fetch showed 2 ahead/0 behind, `git push --set-upstream origin
HEAD:refs/heads/Phase-2-Security-Hardening` exited 0. Independent
`git ls-remote origin refs/heads/Phase-2-Security-Hardening` returned
`fef800b854ad733b871e9da58a3c2407b128f428`, matching local HEAD and containing implementation commit `b2610b71a7440482d0d24a032aa71c0af426f824`.
Upstream is now `origin/Phase-2-Security-Hardening`; the working tree was clean.
No remote work was overwritten and no force push occurred.

This transport receipt is a separate documentation-only follow-up. Its own hash
is resolved from Git history and reported in the final audit, rather than embedded
inside its own contents. JSON parsing, rollout-document validation, architecture,
neutrality and staged whitespace checks are repeated for that follow-up; executable
source remains byte-identical to the full verified implementation commit.
The initial 79 paths were all reviewed and committed in coherent groups; no
unrelated work was discarded or included. Only the original five Supabase
containers remained after disposable cleanup. One incomplete restricted model-test
process was terminated after its unrestricted replacement passed.
