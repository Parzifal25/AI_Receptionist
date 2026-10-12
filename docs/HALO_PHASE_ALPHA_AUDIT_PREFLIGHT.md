# HALO Phase Alpha audit preflight decision

> **Later-phase update (2026-10-12):** Alpha remains complete within its local boundary. Beta staging verification is blocked pending a positively identified and authorized staging target. The ENG-12 database-audit label in this historical Alpha recommendation is **not owner-approved**; canonical ENG-04/ENG-12 mapping remains pending. See [HALO Phase Beta readiness](HALO_PHASE_BETA_READINESS.md).

**Recorded:** 2026-10-12  
**Decision state:** **LOCAL PHASE ALPHA COMPLETE; target-specific release checks deferred**

## Alpha boundary and ENG-04 scope reconciliation

Repository references assign two different meanings to ENG-04:

- `docs/ENG_01_SECURITY_IDENTITY_REVIEW.md` historically called the read-only migration-ledger and conversation agent/version linkage audit “ENG-04 Phase 2” (SEC-04).
- `docs/HALO_V1_ENGINEERING_BACKLOG.md` consistently defines ENG-04 as authorization and validation of the pilot voice/speech route.
- `ENG-11` is already assigned to local Telugu speech review. `ENG-12` is unused in the current repository and searched Git history.

No owner-approved canonical naming decision was found in release records or searched Git history. As a **local engineering recommendation only**, reserve **ENG-12** for the bounded database migration/linkage identity audit described in SEC-04, and keep **ENG-04** for the pilot voice/speech route. This resolves the local tracking collision without representing an owner decision. Existing SEC-04 technical scope remains the audit definition. Target execution requires its separate target-specific authorization and effective read-only evidence; that target audit is not a local Alpha gate.

Phase Alpha is the pre-deployment engineering gate: local source review, deterministic/mock-backed behavior, security/tenant regression checks, fresh disposable migration replay, real-role RLS/privilege checks, configuration/build checks, and release evidence with explicit verification boundaries. Staging verification is Beta; provider-backed pilot and customer acceptance are Charlie; production audit and final authorization remain in the final release process. None is inferred from local evidence. This note does not change or renumber the ten-criterion register.

### Ten-criterion phase applicability

The existing ten criterion labels and wording remain unchanged. This table sets the evidence boundary for each phase; “Alpha complete” means only the listed local acceptance slice has current evidence.

| # | Alpha local acceptance | Beta staging evidence | Charlie / final-release evidence |
|---|---|---|---|
| 1 | Deterministic orchestration, bounded tools, and mock-backed channel contracts pass locally. | Staging identity/configuration and channel wiring. | Approved pilot behavior and final release-candidate evidence. |
| 2 | Source-level auth/authorization review, widget identity regressions, tenant isolation tests, fresh disposable schema and real-role RLS/privilege checks pass. | Staging Auth, grants, service-role inventory, target-bound identity and historical linkage audit. | Pilot/security owner dispositions; production audit only under separately authorized final-release process. |
| 3 | Deterministic qualification, CRM, consent/DNC guards, idempotency and failure-state tests pass locally. | Staging dispatch-disabled and scheduling configuration checks. | Approved contact policy and any authorized pilot operation/reconciliation. |
| 4 | Local voice lifecycle, cancellation, interruption/failure propagation, fallback refusal, and usage attribution tests pass with mocks/synthetic media. | Deployed staging gateway/worker protocol and provider sandbox checks. | Authorized carrier/speech call, language review, interruption/handoff acceptance. |
| 5 | Version immutability, proposal review gates, and no automatic live-version mutation pass locally. | Staging publish/rollback authorization and audit trail. | Owner-approved corpus/reviewer and pilot or release acceptance. |
| 6 | Context/tool/time bounds and implemented local attribution paths are covered by tests. | Staging provider usage telemetry and alert behavior. | Provider charge reconciliation, approved currency limits and representative baselines. |
| 7 | Local campaign/scheduling logic, consent/DNC safeguards, disabled-by-default controls and idempotent failure paths pass. | Staging cron/secrets, provider sandbox and recovery configuration. | Owner-authorized dispatch/booking with provider receipt and reconciliation. |
| 8 | Startup/config validation, migration replay, build, lint, typecheck, health/config contracts, and runbook review pass locally. | Staging deploy/upgrade, monitoring, restore/rollback and incident exercises. | Production readiness evidence and final release authorization. |
| 9 | Adapter contracts, mock-backed integration tests, authorization and safe-retry behavior pass locally. | Staging provider sandbox contract and operational readiness. | At least one owner-authorized provider-backed pilot transaction; final supported-integration disposition. |
| 10 | Scripted local golden scenarios and acceptance assertions pass; these are not pilot acceptance. | Staging scenario execution without customer activation. | Approved pilot matrix, Telugu/business review, defect disposition and dated customer acceptance. |

## Alpha acceptance checklist

| Local Alpha criterion | Acceptance evidence and result |
|---|---|
| 1. Core architecture and deterministic orchestration | **PASS:** architecture boundary checker and full deterministic/mock-backed application suite pass. |
| 2. Authentication, authorization, tenant isolation | **PASS locally:** widget identity regressions; two-tenant tests; 109 real-role database assertions. Deployed configuration is Beta evidence. |
| 3. Migrations, schema, identity relationships and RLS | **PASS:** 31 migrations and schema assertions replay cleanly; exact two-receptionist backfill, unmapped-history null behavior, identity insert guard and idempotent `0014`/`0022` replay are tested; deletion behavior and real roles are checked. No historical row repair performed. |
| 4. Voice/speech lifecycle within local scope | **PASS:** gateway, worker, cancellation/interruption, fallback refusal and failure behavior pass mock/synthetic tests. No real speech quality or provider claim. Sarvam remains primary. |
| 5. Business rules, consent, DNC and workflow safeguards | **PASS locally:** deterministic qualification/CRM/DNC/dispatch guards, duplicate handling and modeled failure transitions pass the full suite. Owner policy and live dispatch remain later-phase evidence. |
| 6. Usage/context budgets and attribution | **PASS locally:** implemented context/tool bounds and local event attribution paths pass. Actual provider billing reconciliation is not claimed. |
| 7. Queueing, scheduling and failure recovery | **PASS locally:** retries, idempotency, terminal states and scheduling behavior pass unit/mock/database checks. Deployed scheduler/queue operation is Beta. |
| 8. Deployment configuration and operational prerequisites | **PASS for pre-deployment checks:** build, startup/config preflight and architecture checks pass; required environment and staging prerequisites are recorded. Staging drills remain Beta. |
| 9. Integration contracts and mock-backed tests | **PASS locally:** adapter contract, authorization, failure and safe-retry tests pass. No external provider request was made. |
| 10. Evidence, limitations and go/no-go | **PASS:** ten-row register retained; phase mapping, corrected migration finding, mock/live boundaries, and Beta/Charlie/final prerequisites recorded. Local Alpha go/no-go is COMPLETE. |

## Beta staging prerequisites

- Name the staging owner; record the exact application revision, environment, Supabase project reference/region, endpoint identity and migration ledger. Use a dedicated staging database; never use the developer database as disposable.
- Obtain target-bound authorization and verify effective role memberships/grants, `BYPASSRLS`/superuser status and read-only session behavior before any target audit. Proposed ENG-12 remains a naming recommendation, not owner approval.
- Verify deployed Auth settings, RLS, service-role callers, secrets injection/redaction, CORS/widget origin, worker trust/signature configuration and tenant identity end to end.
- Exercise migration upgrade, health/readiness, graceful shutdown, logs, bounded retries, queue/cron configuration, monitoring/alerts, backup/restore and rollback on staging; record owners and recovery objectives.
- Configure provider sandboxes with outbound actions disabled by default. Any real provider side effect needs its own explicit authorization and bounded test fixture; no live customer call is implied by Beta.
- Confirm privacy/retention settings, approved test data, business facts/policies, incident contacts and staging scenario reviewers before staging scenario execution.

## Charlie and final-release evidence

Charlie requires owner-approved facts, consent/disclosure/DNC/contact policy, native Telugu review, authorized carrier and speech route, provider-backed integration receipts, reviewed scenario outcomes, and dated business/pilot defect dispositions. Final release additionally requires the ten criteria on the pinned release candidate, production security and data audit under explicit target authorization, representative quality/cost/load evidence, recovery/incident evidence and final owner go/no-go. Synthetic, mock and local speech results do not satisfy those gates.

## Evidence required before any target access

1. **Release/deployment owner:** intended environment; exact Supabase project reference and region; deployed application revision/commit; authoritative target endpoint details; and approved UTC audit start/end.
2. **Security/data owner:** dated, target-bound authorization naming the operator, exact project/environment, purpose, approved migration/linkage metadata scope, audit window, and evidence handling.
3. **Database owner:** dedicated least-privilege audit identity plus target-specific effective-grants and role-membership evidence, including inherited privileges, superuser/BYPASSRLS attributes, and allowed schema/table/column access.
4. **Operator:** session evidence matching the approved target (sanitized endpoint host, database, authenticated role, project/region and UTC time), verified effective privileges and read-only transaction state, all within the authorized window.

Do not provide or record passwords, tokens, connection strings, or service-role keys. The local `supabase/config.toml` project name is not target evidence. No remote connection or query is authorized by this preflight note.

## Checks executable after verification

After the release owner resolves scope and all target, authorization, and identity gates above pass, the operator may, within the approved window and using the verified read-only identity:

1. Read migration version/name metadata and compare only the approved migration set, including `0014`, `0015`, `0021`, and `0022`.
2. Run the existing aggregate linkage audit for null/missing agent or version references, cross-tenant references, agent/version mismatch, and unpublished versions. Return aggregate counts only; any row-level follow-up needs separate owner approval and must use opaque identifiers.
3. Record target-bound evidence and findings, then have security/data and release owners disposition findings before criteria are closed.

Stop on target ambiguity/mismatch, missing or out-of-window authorization, unverifiable or excessive privileges, unexpected RLS incompleteness, or any request for out-of-scope data. Do not test permissions with a write, use service-role access, bypass RLS, repair historical rows, or access production data outside this verified audit.

## Local evidence and deferred target gate

Fresh 2026-10-12 verification on the current dirty candidate passed: full JavaScript suite (128 files, 1,257 passed, 5 skipped), lint, typecheck, production build, CI configuration preflight, architecture check, worker suite (54 tests, 1 skipped), all 31 migrations and schema assertions on a separately named throwaway PostgreSQL container, two-receptionist/unmapped-link/idempotency fixtures, and the disposable real-role RLS/privilege harness (109 assertions). The final `git diff --check` result is recorded in the status register. Initial sandboxed runs could not bind loopback/tsx IPC or fetch Google Fonts; authorized reruns passed. The default migration target is the existing development database and was not used. No staging or production target was queried, no provider request or live call was made, and no speech-quality acceptance is claimed.

**Phase Alpha is COMPLETE locally.** The ten-row register remains intact; applicable local acceptance evidence is present and no confirmed critical/high-severity local defect remains unresolved. Later-phase items remain open: staging configuration/security/deployment evidence (Beta), real voice/provider operation and pilot acceptance (Charlie), and production audit/final authorization (final release).

| Former audit preflight item | Current evidence and status |
|---|---|
| ENG-12 target identity/access preflight | **DEFERRED TO BETA or final release, if target audit is required:** no target was accessed; collect target, authorization, effective grants, and read-only session evidence before any target query. |
| ENG-12 migration/linkage census | **COMPLETE locally for schema assumptions; DEFERRED TO target phase:** all migrations replayed on a disposable database; target ledger and historical row counts remain unknown, not zero. |
| Release disposition | **COMPLETE for local Alpha:** local evidence reviewed and phase boundaries documented; Beta/Charlie/final-release approvals remain open. |

| Dependency / next action | Responsible owner role |
|---|---|
| Review the proposed ENG-12 naming if canonical backlog ownership is needed | Release owner |
| Supply exact environment/project/region/revision/endpoint and UTC audit window | Release/deployment owner |
| Issue dated authorization bound to the named operator, target, scope, window, and evidence handling | Security/data owner |
| Supply dedicated audit identity and target-specific effective privilege evidence | Database owner |
| Execute any required staging or production read-only checks only after all target-specific gates pass | Named operator |
| Review findings and record criterion dispositions | Security/data owner and release owner |

See [status register](HALO_V1_STATUS.md), [release decisions](HALO_V1_RELEASE_DECISIONS.md), [release gaps](HALO_V1_RELEASE_GAPS.md), [engineering backlog](HALO_V1_ENGINEERING_BACKLOG.md), and [security review](ENG_01_SECURITY_IDENTITY_REVIEW.md).
