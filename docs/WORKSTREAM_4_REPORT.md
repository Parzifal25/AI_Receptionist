# WS4 finalization — security, audit and end-to-end correlation

Date: 2026-10-15. Task ID: **WS4-FINAL**. **Disposition: LOCALLY COMPLETE.** This section supersedes the earlier inventory report retained verbatim below. Evidence is source, local test and disposable DB only; there is no staging, production or real-provider evidence.

## Authority, scope and preservation

The owner's current finalization instruction is the task card: implement local D7/D18 resolution, preserve existing security/privacy fixes, prove failure/correlation/replay behavior, update decisions and report. Scope includes security boundary wrappers, platform context, persistence adapters, additive migration 0036, actual gateway/worker/job handoffs, affected retry/provider paths, tests and documentation. Voice ownership/playback, TTS normalization, prompt composition, business policy, hosted rollout and unrelated decision ratification are excluded. Prerequisites were installed dependencies, worker virtualenv and cached disposable images. Acceptance is the six local criteria below. Rollback is a reviewed reversal of this task's overlay only, against the initial snapshots; never reset the tree or drop a populated audit table. No rollback was performed.

**Source:** initial and final branch `Phase-2-Security-Hardening`; HEAD `ad6a19d830633712b948ff5fc75972c2f61a17fa`. The initial 36 dirty/untracked files were hashed before edits; all 36 baseline snapshots were reconstructed and verified against those hashes. [Preservation manifest](WORKSTREAM_4_PRESERVATION.json). Initial tracked diff and verified snapshots remain under `/tmp/ws4-final-baseline.diff` and `/tmp/ws4-baseline-snapshot`. The index stays empty. No branch switch, reset, clean, stash, commit, push, merge, PR or deployment occurred.

**WS3 source preservation:** migration 0035, K1 tests, recovery/preflight/rollout scripts, runbooks, report, owner register and hosted SQL retain their original bytes. One necessary compatibility edit changes `tests/unit/compare-migration-ledger.test.ts`: its saved WS3 scenarios explicitly use the historical 0001–0035 repository slice; a new current-repository assertion proves 0036 cannot silently inherit WS3 rollout authorization. The original comparator and recovery logic are unchanged. Shared decision/status/gap documents retain WS3 evidence and append WS4 history. Historical migrations 0001–0034 match HEAD; 0035 matches the initial manifest.

## D7 decision and implementation

**Source; disposable DB:** the exact question remains in [DECISIONS D7](DECISIONS.md#d7--new-migrations-tool-executions-and-audit-logs). Under the current written instruction, general audit storage is approved **for local implementation/disposable verification only**. Existing 0032 `tool_executions` is reused for model tools; it is not repurposed for HTTP authorization. New additive [0036](../supabase/migrations/0036_security_authorization_audit.sql) creates `audit_logs` and adds optional workflow event/timer telemetry UUID columns. It follows unchanged 0035. Supabase CLI first generated a timestamped file, then it was renamed to the repository's enforced contiguous 0036 convention. No historical migration or shared database was changed.

Audit rows contain only operation UUID, trusted actor/tenant where available, a closed action name, HTTP method/category, outcome, stable reason, canonical correlation UUID and database-generated timestamp. There is no arbitrary metadata, resource-name, request, token, payload or exception column. User identity comes from verified Auth, tenant membership from its server query, visitor/resource tenant from repository results, and service tenant from authenticated envelopes. Identity can advance from unresolved actor/tenant to trusted context but cannot be replaced by another actor or tenant. Public request metadata cannot override it.

Protected API access, dashboard server actions (including knowledge/FAQ governance), authentication/calendar OAuth, widgets, hooks, authenticated cron admission, signed voice/speech services, Pipecat control attachment and gateway denials use the audit boundary. Public liveness success does not access audit storage. System/visitor or pre-authentication entries can have null actor/tenant; unscoped rows are operator-only. Existing tool/domain job records remain in place.

- `attempted`: durably admitted before protected execution; not proof of authentication or remote success. Anonymous authentication admission can precede identity resolution.
- `denied`: explicit authentication/authorization refusal. Denial records are best effort on audit outage; the refusal still holds.
- `succeeded`: the instrumented handler/executor reported completion. It does not assert a remote commit or prove every row update affected a record.
- `failed`: known rejected request; `unknown`: conservative status for exceptions, partial effects and 5xx. No unknown outcome is described as rolled back.

Mandatory pre-audit failure blocks dashboard/server-action and resolved widget mutations, cron work, signed gateway service work and control attachment. The actual adapter has a five-second abort deadline. Terminal write failure emits safe stage/reason/operation/correlation, preserves the real response, and leaves its durable attempt for reconciliation. There is no exporter retry or action replay because audit finalization failed. Sign-out is explicitly fail-open. Read-only and denial records cannot be guaranteed durable during storage failure. A process death between effect and terminal audit has the same reconciliation requirement.

**Disposable DB:** RLS permits members to SELECT their own tenant only; clients cannot insert/update/delete/truncate. The service role can INSERT/SELECT but cannot UPDATE/DELETE/TRUNCATE. Null-tenant records are invisible to members. Database owner administration and business-deletion cascades remain exceptions; storage is not tamper-proof against its owner. Audit has no automatic purge or invented retention period: local synthetic records live until teardown; real-data retention/backup/access decisions remain D23/R8 release gates. The grant/RLS model also follows the distinction in [Supabase's RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security); the evidence here is the actual disposable role/HTTP tests, not that documentation.

## D18 decision and actual lifecycle

**Source; local test:** [DECISIONS D18](DECISIONS.md#d18--telemetry-export-backend-and-cross-process-correlation) is split transparently. Local export is disabled by default or existing opt-in stdout; the owner authorizes the local correlation design. A hosted log drain/metrics/alert backend still requires the operations owner, budget/target review and deployment authorization. No hosted vendor, SDK, account or paid dependency was added.

`correlationId` is the canonical logical operation/trace ID: lower-case UUID shape, including deterministic job IDs; no second trace ID is necessary. Each HTTP entry also has a local `x-request-id`. Gateway transition logs link that transport ID to the authenticated upstream logical correlation. Security `operationId`, event/run/step/call IDs and the pre-existing business journey `correlation_id` keep separate meanings. Correlation is never authorization or an action idempotency key.

| Boundary | Implementation and safe failure policy | Evidence |
|---|---|---|
| Public API → authentication → trusted tenant → service | Fresh server HTTP ID; incoming headers ignored; AsyncLocalStorage; explicit trusted identity binding; audit links to the same correlation | local API/auth tests, captured safe records |
| Next → signed web STT/TTS/call gateway | Canonical UUID in HMAC-signed body, adopted only after signature/schema/timestamp checks; missing remains backward compatible, malformed rejects; transition log links entry ID | source; real local HTTP STT/TTS/call fixtures |
| Gateway → persisted voice call → worker | Optional correlation signed inside stream token; tampering/extra token segments refuse; trusted correlation persists on call creation, existing call identity wins on reattachment; ready frame carries it | local HTTP/WebSocket fake-provider integration; production store mapping source |
| Python control/media/inference-owned logs | Canonical ready ID; malformed legacy ID becomes a fresh UUID, never authority; per-task ContextVars, reset on exit; owned worker/local/fallback logs carry safe context | 3 new Python context/concurrency tests plus existing worker suite |
| Event enqueue → serialization → execution → cron retry → terminal failure | Separate persisted `telemetry_correlation_id`; UUID normalization before insert; restores event context independently of cron; trusted tenant mismatch check remains before execution | serialized fixtures, failure/retry/dead-letter tests; additive columns applied on disposable DB |
| Timers | Optional serialized UUID restored before event emission; legacy timer fallback derived from namespace/tenant/journey identity | deterministic timer contract |
| DB-scheduled reminders/no-shows/campaign contacts | Stable per-item UUID from namespace + trusted tenant + persisted job ID; each item runs in its own scope and restores parent; unknown outcomes keep safe diagnostics | reminder/campaign contracts and existing tenant/no-show regressions; no real send/dial |

Legacy independently scheduled jobs start their own logical operations; the original enqueue HTTP trace cannot be reconstructed when never stored. Supported workflow/timer enqueue paths do store it. Unsupported downstream providers and third-party Python loggers do not gain tracing automatically. This is a local wire/job contract, not a deployed full Next→carrier→Pipecat/provider session or a complete metrics platform.

## Privacy and duplicate-action review

**Source; local test:** initial canonical UUID validation, recursive private-key redaction, protected logger envelope, calendar token-source sanitization, safe worker inference traceback and no-replay Google/Outlook creates are preserved. New owned worker context is safe and task-local. WhatsApp previously interpolated recipient and raw provider error body into static messages; those paths are now static category/status logs. Resend errors omit response bodies. Synthetic nested error/header/OAuth/customer/container tests retain safe category/correlation while excluding private fixture values.

Logger protection is recursive **key-based** redaction plus inspected static messages. It is not a universal detector for arbitrary secret strings embedded under safe keys, developer-authored static messages or third-party debug output. Audit cannot carry arbitrary customer content because it has no such fields. No real credentials or customer fixtures were used.

**Local test:** unkeyed Google/Outlook/WhatsApp creates get one attempt per invocation, including timeout-after-remote-success fixtures. Workflow errors after executor entry are outcome-unknown and dead-lettered; only an explicit internal `RetrySafeWorkflowError` authorizes safe automatic retry. Retry/backoff/exhaustion/resume tests now use that explicit proof, and generic timeout/exception-after-commit tests prove no automatic replay. If a completed action's success log fails, the run quarantines instead of re-entering the executor. Reminders requeue only pre-send failures; ambiguous or completed-but-unrecorded sends stay failed for reconciliation. Existing event uniqueness, atomic claims, tenant matching and campaign unknown-outcome settlement remain.

**Accepted limits:** no exactly-once guarantee; independent/manual delivery can duplicate work, remote timeout cannot undo a commit, and provider idempotency support/key lifetime is unverified. Resend retains keyed retries; its existing key hashes recipient/subject/first 100 body characters, which can conflate distinct emails. A full caller-supplied operation-key design is a separate follow-up, not silently invented here. CalDAV resource-key/precondition reconciliation and best-effort booking calendar synchronization remain as previously documented. Disabling ambiguous retries trades automatic recovery for operator reconciliation; no claim that an unknown action did not occur is made.

## Final command results

All final gate exit codes must be 0 before the disposition is finalized. Exact argv, local artifact paths, retained earlier failures and hashes are in [command ledger](evidence/ws4-command-ledger.json); portable gate/isolation runners are in `docs/evidence/`. `$FINAL` below is `/tmp/ws4-final-accepted-`; logs are local artifacts, not hosted evidence.

| Exact command (inside the documented synthetic isolation wrapper where applicable) | Exit/result | Evidence |
|---|---|---|
| `npm run typecheck` | 0; no diagnostics | local test |
| `npm run lint` | 0; no errors | local test |
| `npm run check:architecture` | 0 | local test |
| `npm run check:neutral` | 0 | local test |
| `npm run preflight:ci` | 0; DB check intentionally skipped; CRON_SECRET readiness warning retained | local test |
| `npm test -- --maxWorkers=2` | 0; 172 files passed/3 skipped; 1748 tests passed/0 failed/31 skipped | local test |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'` | 0; 75 run: 74 passed, 0 failed, 1 skipped | local test |
| `npm run build` | 0; compiled/generated; local artifact only | local test |
| `HALO_DISPOSABLE_DATABASE=1 HALO_DISPOSABLE_DB_URL=postgresql://postgres:ws4_synthetic@127.0.0.1:55459/halo_check_ws4_final_v4 npm run check:migrations` | 0; full 0001–0036 chain applied to a fresh database | disposable DB |
| Same disposable env, `npm run check:rls` | 0; 669 ok, 0 FAIL; expected negative SQL errors retained | disposable DB |
| Same disposable env, `node scripts/check-security-audit.mjs` | 0; 5 assertions; 40 concurrent durable writes | disposable DB |
| `HALO_DISPOSABLE_DATABASE=1 HALO_DISPOSABLE_POSTGREST_URL=http://127.0.0.1:55460 HALO_DISPOSABLE_JWT_SECRET=ws4-synthetic-local-only-jwt-secret-00000000 node --import tsx --conditions react-server scripts/check-security-audit-http.mjs` | 0; 8 assertions: real adapter attempt/success/denial, identity/time/correlation, isolation/grants and pre/post outage semantics | disposable DB + local integration |
| `git diff --check` | 0 | source |

The final runner uses synthetic environment values, `HALO_OUTBOUND_ENABLED=false`, log messaging, offline model settings, and new `unshare -Urn` namespaces with only loopback for executable TS/worker/preflight suites. It cannot reach shared ports or external services. The build is allowed its existing public Google Font fetch; no deployment/provider action follows. The DB/HTTP harnesses target only the task-created cached-image containers on ports 55459/55460, never Supabase shared 5532x or other-project 5432x ports.

**Skips:** the full TS suite retains 31 skips: 26 opt-in DB/PostgREST cases (K1 7, governance 8, tenant PostgREST 11) and 5 real local-model cases. WS3's prior 26 disposable case results are carried forward, not relabeled as rerun here; WS4's own real-role, concurrency and actual adapter HTTP checks ran separately. Python retains one provisioned-real-model skip. Missing model/provider/hosted evidence is not a pass. No local Supabase CLI advisor command was pointed at the shared stack; explicit disposable SQL/role/HTTP checks provide this task's database evidence.

## Earlier failures and corrections (retained)

- Baseline focused TS: exit 0, 75/75. First intermediate workflow run: exit 1, 25 passed/2 failed because old assertions expected raw exception strings; safe reason-code assertions replaced them. Later retry tests explicitly mark genuinely retry-safe fake failures.
- Initial typecheck iterations caught duplicate timer test fields, mock argument typing, numeric reminder ID conversion, and using `maxAttempts` rather than this repo's `attempts` retry option. These were code/test defects and were fixed, not classified environmental. Lint caught an initially unused audit import; fixed.
- First sandbox full TS: exit 1, 1685 passed/52 failed/31 skipped, 12 unhandled errors. Loopback EPERM plus audit-fixture assumptions caused these. The audit sink is now an explicit fake in existing route fixtures; dedicated tests inject failures and actual PostgREST proves persistence. Isolated runs then found (a) two migration-number convention failures and (b) four saved WS3 ledger expectations affected by 0036; naming and the reviewed historical fixture/current-chain test fixed those.
- Initial sandbox worker run blocked on local networking and was interrupted with exit 130. The isolated/offline worker run passed; this is not recorded as an initial pass.
- First CI preflight: exit 1, `listen EPERM ... /tmp/tsx-1000/...pipe`; outside-sandbox/private-namespace retries passed. First build: exit 1, `next/font ... Failed to fetch Geist`; approved public-font retries passed. No provider calls were used to fix tests.
- First disposable RLS pass: exit 1, empty-row `JSON.parse` in the generic sweep because the new table lacked fixtures. Non-vacuous A/B audit fixtures and dedicated grants checks were added. Second pass: exit 1, the canonical-predicate catalog assertion rejected a redundant `business_id is not null AND` clause. It was simplified to the existing `is_business_member(business_id)` policy, and real unscoped/foreign-read tests still deny. Final passes: 669 ok/0 FAIL. No RLS safeguard was removed.
- Initial WhatsApp regression failed while the wrong retry-option name was ignored, proving the one-attempt assertion catches replay; corrected to `attempts: 1`. The subsequent test passed. Initial audit HTTP harness: exit 1, loopback `listen EPERM`; approved local retry passed 7 assertions, extended/final version passed 8.
- Supabase migration scaffolding first failed because CLI telemetry tried writing outside the sandbox. Approved retry generated only the local migration file; no database connection was involved.

## Acceptance and remaining hosted phase

| Local criterion | Disposition |
|---|---|
| D7/D18 accurate local decisions within current owner authorization | PASS — local-only split, historical trail and hosted approval limits retained |
| Durable audit, trusted identity, tenant isolation, before/after failure policy | PASS — source, local contracts and actual disposable PostgreSQL/PostgREST |
| Actual service/job correlation, serialization, concurrency, retries and terminal failure | PASS — local HTTP/WebSocket and Python contracts, persisted schema and deterministic jobs |
| Privacy and no automatic replay after ambiguous consequential outcomes | PASS — bounded guarantees above, synthetic regression evidence; no exactly-once claim |
| Required gates | PASS — final recorded 9/9 commands exit 0; existing skips explicit |
| Evidence and WS3/tree preservation | PASS — 28 initial files byte-identical; 8 documented WS4/shared-doc/compatibility updates; all initial snapshots verified; 0001–0034 and 0035 preserved |

Hosted execution remains **NOT VERIFIED / NOT AUTHORIZED**: real Auth/JWT/revocation behavior, production service grants and data, hosted migration/session/extension compatibility, provider/carrier/delivery semantics, Python/Node hosting topology, durable export/alert delivery, retention/privacy and full backup/restore including new 0036 audit records. A single real media/provider path is not established by these contracts. WS3's nine outstanding owner decisions and T1–T10 actual-target groups remain unchanged. No named hosted target is inferred from historical project notes.

**Operational closeout:** branch/HEAD preserved; dirty tree intentionally retained; nothing staged, committed, pushed, merged or deployed. No hosted/shared database inspected or modified. No live provider, message, calendar event or outbound call. Spend **$0**. Both task-owned disposable containers and their anonymous test volume were removed (exit 0). [Preservation result](evidence/ws4-preservation-result.json) records the comparison. No shared container was removed.

## Files changed

[File/diff inventory](evidence/ws4-file-changes.txt) distinguishes the original dirty tree from the WS4 overlay and lists all new files. Principal groups: platform/security audit and telemetry; tenancy audit/action adapters/auth binding; API/widget/cron/OAuth/auth/server-action boundaries; voice call/store/token/gateway/worker correlation; workflow event/timer persistence and retry safety; reminder/campaign/no-show context; WhatsApp/Resend privacy/replay paths; focused TS/Python/SQL/HTTP tests; additive 0036 and decision/telemetry/architecture/status/evidence docs. Original logger/calendar/worker privacy fixes remain included in the dirty tree. No package dependency, prompt composer, TTS-normalizer twin, voice playback/turn ownership, historical migration or unrelated decision was changed by finalization.

---

## Previous WS4 report — historical evidence, superseded disposition

The following report is preserved verbatim from the start of this task. Its former pending D7/D18 disposition and earlier command totals are historical, not the final status above.

# WS4 — Local security and telemetry validation

Date: 2026-10-15. Task authority: owner's “Workstream 4 — Local Security and Telemetry Validation” instruction. Evidence levels below are **source** and **local test** only. No staging, production or provider proof is claimed.

**Disposition: targeted fixes verified locally; the full workstream is not locally complete.** General authorization audit coverage and cross-service correlation remain architecture gaps under pending D7/D18. Passing regression tests do not close those requirements.

## Task card and preservation

Objective: inspect and minimally fix local audit, authorization, correlation, log privacy and unsafe replay defects. Scope: platform logger/telemetry, calendar adapters, Pipecat worker logging, focused tests and this report. Out of scope: hosted verification, migrations, telemetry vendors, new audit architecture and other workstreams. Prerequisites: existing dependencies and worker virtualenv. Acceptance: focused synthetic tests plus repository gates, with limitations recorded. Commands and outcomes follow. Rollback: reverse only the WS4 file changes listed below; remove only its three new files. Never reset the working tree or roll back the pre-existing WS3 files.

**Source:** branch remains `Phase-2-Security-Hardening`. Initial tracked dirt: `docs/DECISIONS.md`, `docs/HALO_V1_GAP_ANALYSIS.md`, `docs/HALO_V1_STATUS.md`, `docs/HOSTED_MIGRATION_RUNBOOK.md`, `infrastructure/hosted/preflight-readonly.sql`. Initial untracked work included WS3 runbooks/report, hosted SQL/evidence, migration 0035, recovery/preflight scripts and their tests. These were not edited. No commit, push, merge, deployment, shared database operation or provider action was performed. No outbound or messaging configuration was changed.

## Findings inventory and disposition

| Evidence | Boundary / files | Observation and disposition |
|---|---|---|
| source; local test | `packages/runtime/tools/audit.ts`, `packages/runtime/agent-runtime.ts`; `tests/integration/tool-execution-audit.test.ts` | Existing tool audit records successes, denials, safe failure categories and trusted tenant identity; side effects fail closed without a pre-execution record. Existing tests exercised duplicate rejection, tenant-separated reads and finalize-write failure without replay. Reused; no schema or audit lifecycle changes. |
| source; local test | `tests/integration/tenant-isolation-routes.test.ts`, `tests/integration/dashboard-authorization.test.ts`, `tests/integration/widget-messages-security.test.ts` | Existing application tenant boundaries and safe foreign-resource denials retained and tested by the suite. This is mock/local application evidence, not real-role database proof. |
| source | `docs/DECISIONS.md` D7; `src/lib/api/respond.ts` | General authorization denials currently produce operational logs, not durable security audit records. A general `audit_logs` design remains PENDING. No ordinary log is claimed to satisfy this requirement; no unapproved migration introduced. |
| source; local test | `packages/platform/telemetry.ts`, `packages/platform/logger.ts` | Previously, malformed explicit contexts reached logger output and UUID validation accepted arbitrary arrangements of 36 hex/hyphen characters. Fixed: canonical lower-case UUID shape; invalid context replaced once on entry, inherited by nested logs/retries. Invalid standalone logger correlation values redacted. Context cannot override timestamp, level or static message. |
| source | `src/lib/api/respond.ts`, `services/voice-gateway/pipecat-control.ts`, `docs/TELEMETRY.md`, architecture §9 / D18 | API request context and per-session context exist; Pipecat ready frame carries session identity. No end-to-end Next→gateway→worker telemetry propagation or job-wide correlation exists. Preserved and recorded for owner decision; no unrelated tracing infrastructure added. Caller HTTP IDs remain ignored. |
| source; local test | `packages/platform/logger.ts`, `tests/unit/logger-privacy.test.ts`, new WS4 TS tests | Expanded recursive private-key redaction to request/response/header/data/customer/contact/input/output containers, OAuth client secrets and ID tokens. Existing nested exception/error redaction retained. Synthetic tests assert private values absent while safe categories remain. This is a key-based boundary, not a guarantee against arbitrary secrets embedded in static messages or arbitrary safe-named strings. |
| source; local test | `packages/providers/calendar/token-source.ts` | HTTP errors included provider response text and URL. Replaced with static category plus status; provider body and calendar reference excluded. |
| source; local test | `services/pipecat-worker/worker.py`, `local_speech.py`, new worker test | Removed exception traceback dumps and raw language/start-frame identifiers from owned worker log sites. Inference error frames carry a static message and a newly generated local traceback, not the upstream exception chain. Pipecat requires a traceback to deliver these frames; existing inference/fallback tests verify delivery after the fix. |
| source; local test | Google/Outlook calendar adapters; new WS4 TS tests | Unkeyed create POSTs automatically retried after ambiguous network/HTTP failures. Fixed to one attempt per invocation. Timeout-after-commit tests, including concurrent independent invocations, verify no automatic replay. Read retries still exhaust at three attempts. No exactly-once or cross-invocation deduplication claim. |
| source; local test | `tests/integration/workflow-engine.test.ts`, existing tool audit tests | Existing duplicate-event, partial-step resumption, timeout quarantine, dead-letter exhaustion and tenant-mismatched retry safeguards pass. Reused existing deterministic cases rather than changing business behavior. |
| source | CalDAV adapter and booking service | CalDAV retries use the same UID/resource within an invocation. An ambiguous create can subsequently report a precondition failure. Booking calendar synchronization is best effort; a local booking can survive a calendar failure. Durable reconciliation and cross-invocation provider idempotency are not proved. |

## Changed files

WS4 tracked diff (`git diff --stat -- <WS4 paths>`): 8 files, 45 insertions, 35 deletions:

- `packages/platform/logger.ts` — private containers, protected envelope and correlation validation.
- `packages/platform/telemetry.ts` — shared UUID validation at context entry and observation output.
- `packages/providers/calendar/google-calendar-provider.ts` and `outlook-calendar-provider.ts` — single-attempt unkeyed creates.
- `packages/providers/calendar/token-source.ts` — static HTTP failure messages.
- `services/pipecat-worker/worker.py` and `local_speech.py` — safe owned logging and inference errors.
- `tests/unit/logger-privacy.test.ts` — use a canonical synthetic correlation fixture.

New files: `tests/unit/ws4-security-telemetry.test.ts` (9 tests), `services/pipecat-worker/test_ws4_log_privacy.py` (2 tests), this report. No migration changed. No prompt-composer, TTS normalizer or voice turn ownership/playback behavior changed.

## Executed verification

All results in this table are **local test**. Logs are local artifacts under `/tmp`; no raw credentials or live customer fixtures were intentionally emitted. Redirections shown are part of the commands run.

| Exact command | Exit / result | Evidence artifact |
|---|---|---|
| `npm test -- tests/unit/ws4-security-telemetry.test.ts tests/unit/logger-privacy.test.ts tests/unit/telemetry.test.ts tests/integration/tool-execution-audit.test.ts tests/integration/tenant-isolation-routes.test.ts tests/integration/workflow-engine.test.ts tests/unit/retry.test.ts --maxWorkers=2 > /tmp/ws4-narrow.log 2>&1` | 0; 7 files, 75 tests passed | `/tmp/ws4-narrow.log` |
| `npm run typecheck > /tmp/ws4-typecheck.log 2>&1` | 0 | `/tmp/ws4-typecheck.log` |
| `npm run lint > /tmp/ws4-lint.log 2>&1` | 0 | `/tmp/ws4-lint.log` |
| `npm run check:architecture > /tmp/ws4-architecture.log 2>&1 && npm run check:neutral > /tmp/ws4-neutral.log 2>&1 && npm run preflight:ci > /tmp/ws4-preflight.log 2>&1` | 1 overall; architecture and neutral passed, preflight failed with `listen EPERM ... /tmp/tsx-1000/53.pipe` | respective logs |
| `npm run preflight:ci > /tmp/ws4-preflight-retry.log 2>&1` | 0 outside sandbox; database check deliberately skipped by existing CI command | `/tmp/ws4-preflight-retry.log` |
| `npm test -- --maxWorkers=2 > /tmp/ws4-tests.log 2>&1` | 1 in sandbox; 1687 passed, 41 failed, 31 skipped; loopback `listen EPERM` plus subprocess worksheet failure; 12 unhandled errors | `/tmp/ws4-tests.log` |
| `npm test -- --maxWorkers=2 > /tmp/ws4-tests-retry.log 2>&1` | 0 outside sandbox; 168 files passed, 3 skipped; 1728 tests passed, 31 skipped | `/tmp/ws4-tests-retry.log` |
| `npm run build > /tmp/ws4-build.log 2>&1` | 1; Google Fonts fetch failed under sandbox | `/tmp/ws4-build.log` |
| `npm run build > /tmp/ws4-build-retry.log 2>&1` | 0 outside sandbox; compiled and generated pages | `/tmp/ws4-build-retry.log` |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_ws4_log_privacy.py' > /tmp/ws4-python-narrow.log 2>&1` | 1; test import mistakenly referenced `_language`; corrected to `HaloWorkerSession` | `/tmp/ws4-python-narrow.log` |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_ws4_log_privacy.py' > /tmp/ws4-python-narrow-fixed.log 2>&1` | 0; 2 tests passed at that intermediate revision | `/tmp/ws4-python-narrow-fixed.log` |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py' > /tmp/ws4-python.log 2>&1` | 130; sandbox run stalled, interrupted; not a pass | `/tmp/ws4-python.log` |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py' > /tmp/ws4-python-retry.log 2>&1` | 1; 72 run, 2 failed, 1 skipped. Removing all traceback broke Pipecat frame delivery (`AssertionError: 0 != 1`). Corrected with safe local traceback. | `/tmp/ws4-python-retry.log` |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py' > /tmp/ws4-python-final.log 2>&1` | 0 outside sandbox; 72 run, 71 passed, 1 skipped | `/tmp/ws4-python-final.log` |
| `git diff --check` | 0 | terminal result |

The final Python correction was after the TypeScript gates and affects Python only. Final full worker suite includes the corrected privacy tests and existing fallback/media regressions.

## Skipped checks, residual risks and owner follow-up

- **Local test:** TypeScript's 31 skips are the opt-in disposable PostgreSQL/PostgREST suites: governed knowledge, knowledge backfill and tenant isolation. No disposable database was provisioned for this application-only change. `check:migrations` and `check:rls` were not run: no migration/database write code changed. Existing disposable-DB evidence from other workstreams is not reclassified as new WS4 proof.
- **Local test:** one Python test requires provisioned local speech models; no model download or live speech test was performed.
- **Source:** D7 general durable authorization audit and D18 cross-service/job correlation remain unresolved. They require owner architecture disposition; this report does not change decisions or architecture. Full WS4 acceptance remains open because these are explicit objectives, even though implemented fixes pass.
- **Source:** arbitrary logger message strings, unusual caller metadata and third-party Pipecat/vendor logging have not been exhaustively proven private. Debug logging can include spoken/transcribed content; production logging policy and vendor sink filtering remain unverified. The changed owned worker sites and synthetic regression cases are a bounded result.
- **Source:** separate calendar create invocations can still create separate events. Single-attempt creates favor avoiding automatic duplicate side effects over transparent transient recovery; an error can mean remote success. Operator reconciliation is still needed. No exactly-once guarantee, durable provider reconciliation or live provider behavior is claimed.
- **Pending hosted phase:** hosted identity verification, hosted authorization/RLS, provider telemetry, production log inspection and production retry verification. No hosted action is authorized or attempted by this report.

---

## Addendum — local release-readiness audit, 2026-10-15

Recorded without changing the findings above. Full context: [LOCAL_RELEASE_READINESS_REPORT.md](LOCAL_RELEASE_READINESS_REPORT.md).

- **Re-verified on the current tree (`disposable DB`):** fresh database, `check:migrations` exit 0 (0001–0036), `check:rls` 669 ok / 0 FAIL, `scripts/check-security-audit.mjs` 5/5, `scripts/check-security-audit-http.mjs` 8/8. Undocumented dependency found: the HTTP harness assumes the tenant/actor fixtures that `check:rls` creates, so it fails (`SecurityAuditUnavailable`) on a database where `check:rls` has not run. It passes in the documented order.
- **"WS3 evidence preserved" was incomplete.** WS4 did not rerun `check-rollout-rehearsal.mjs` or `check-rollout-docs.mjs`; both failed once `0036` existed (67/70; missing map row). Fixed with a documented compatibility change ([WORKSTREAM_3_REPORT.md addendum](WORKSTREAM_3_REPORT.md#addendum--local-release-readiness-audit-2026-10-15)); the rehearsal now also restores a post-0036 backup (83/83). This is local evidence for "backup/restore including 0036"; hosted backup remains NOT VERIFIED.
- **Privacy finding fixed:** `ResendMessagingProvider` logged the recipient address and subject on every successful send (`to`/`subject` are not redacted logger keys). Found by the new W7.2 log-leak sweep; the success log now carries only channel, HTML flag and attachment count. Regression: `tests/integration/log-leak-sweep.test.ts` (fails on the pre-fix code).
- **DECISIONS index** rows for D7 and D18 still read PENDING after this report updated their entries; reconciled without changing any state.

## P2-LOOP Codex review addendum — 2026-10-15

**Source/local test:** production timer decoding dropped `telemetry_correlation_id`;
the old in-memory timer test did not exercise that decoder. P2-F6 restores it
with a fail-before/pass-after production-adapter/engine regression. Raw worker
playback exceptions were also removed from logging in the W4.3 failure path.
See [current review](PHASE2_COMPLETION_REVIEW.md) and fresh command ledger;
no schema, hosted backend, retention approval or deployment changed.
