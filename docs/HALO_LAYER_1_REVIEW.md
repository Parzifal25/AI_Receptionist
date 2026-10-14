# HALO Layer 1 review — L1-20261014

The initial review below is retained as historical evidence. The **current closure attempt, L1-CLOSE-20261014**, appended below, supersedes its implementation assessment. Layer 1 is not closed.

Owner request: complete the seven Layer 1 requirements, continue available work and report blockers with proposed solutions. Evidence applies to the existing dirty worktree, not a clean revision or deployed target.

## Task card

Objective: assess all seven requirements; fix deterministic qualification validation/outcome defects; prepare concrete owner decisions for architecture/schema and business-policy gaps.

Scope: `packages/qualification/schema.ts`, `packages/qualification/disposition.ts`, new qualification integrity tests, this report and a PENDING entry in `docs/DECISIONS.md`. Existing tenant, agent, knowledge, runtime and identity source/tests inspected read-only.

Out of scope: existing unrelated edits, migration edits, provider calls, deployments, shared databases, paid inference, commits and stack/layout changes. Prerequisites: supplied owner request, AGENTS.md, blueprint and decisions read. Acceptance: malformed deterministic rules rejected; unresolved required answers cannot produce qualified; each Layer 1 gap has evidence and a remedy. Commands: repository gates listed below. Rollback: reverse only this task's patches; preserve all prior worktree changes and new files.

## Requirement assessment

| Requirement | Evidence and result | Remaining work |
|---|---|---|
| Tenant configuration valid | **source:** Arunodhaya bundle parses schemas, fact sources, voice prompts and language consistency. General `parseAgentConfig({})` succeeds; publication does not check activation readiness. **Not closed.** | D14: approve and enforce activation fields at publication, rollback and resolution; reject incomplete legacy live configurations. |
| Reproducible agent configuration | **source:** tenant-owned immutable versions and conversation version pins exist. Context builder falls back to mutable receptionist identity/custom instructions; language can be defaulted. Version prompt and nested config prompt coexist. **Not closed.** | D14: define one effective versioned instruction/identity source, eliminate mutable fallback for activated agents; prove identical pinned configuration after unrelated tenant edits. |
| Controlled knowledge | **source:** all 12 Arunodhaya facts are pending; bundle requires source and answer for verified facts. FAQs use `is_published`. General documents have processing/ready/error, no approval provenance; `0005` searches chunks without document approval or readiness checks. Configured collection IDs are ignored by `ProviderKnowledgeResolver`. **Not closed.** | D14 migration/access model; exclude pending/revoked content on keyword and vector retrieval; enforce tenant ownership of parent document and configured bindings. |
| Explicit qualification | **source:** questions, required fields, retries, confirmations, skips and disqualifiers are deterministic. Fixed duplicate options, missing primary-language keywords, invalid references/dependencies and contradictory bill ranges. Fixed completed questionnaires qualifying with unresolved required answers. | Arunodhaya qualification file expressly says starting configuration, not approved business requirements; approve outcome criteria, required fields, skip rules and ranges. |
| Enforced permissions | **source:** closed registry, configured grants, channel/binding/precondition checks and act-then-narrate validator exist. **local test:** focused tool-boundary tests pass. | Review complete pilot authority/claim matrix; deterministic callback/failure text includes future callback commitments despite missing staffing policy. No claim of universal natural-language enforcement. |
| Tenant isolation tested | **local test:** focused tenant/config resolver and widget isolation tests pass with fakes. **source:** agent queries scope business ID; knowledge RPCs scope chunks/FAQs and are service-role only. | Fresh real-role DB evidence for knowledge/configuration access and parent/binding integrity is still required. Existing `check:rls` has no knowledge search assertions. Do not equate mocks with RLS proof. |
| Arunodhaya reviewed | **source:** reviewed configuration, 12 pending facts, no approved discounts/quotes, Telugu-first identity and starting qualification. External blockers below documented. | Customer approval is absent; reviewed does not mean approved. |

## Blockers and concrete remedies

1. **Activation and knowledge design (D14):** approve nonempty identity name, objective, explicit supported language and effective versioned instructions; require phone prompts for phone capability; fail closed for unsupported knowledge bindings. Approve additive document approval/provenance and binding migration. Preserve incomplete drafts; old data receives no invented approval. Implement narrow lifecycle/read-boundary validation and adversarial tests after decision. This is an architecture/schema choice, not permission to publish or write a shared database.
2. **Arunodhaya approval (D11):** supply a dated business approver/source for panel brands, warranty, system types, installation duration, roof requirements, service areas, maintenance, price per kW, subsidy, payback, financing and site-visit cost. Unknown answers may remain explicitly UNSET with approved deferral wording. Approve qualification questions/required fields/outcomes, disclosure, consent/DNC/callback policy, escalation owner/contact/coverage, visit rules and Telugu wording. Remove or replace unsupported callback commitments only with approved wording; never fabricate staffing or commercial criteria.
3. **Database proof:** after D14 approval, extend real-role isolation fixtures for documents, chunks, FAQs, collection bindings and both retrieval RPCs; replay only on a fresh `halo_check_<suffix>` disposable database. Do not use developer/shared databases or 5432x ports. This task made no DB changes.

## Changes

**source:** `git diff --stat` for task code initially: qualification schema 24 insertions / 2 deletions; disposition changes one condition. New files: `tests/unit/qualification/config-integrity.test.ts`, `tests/unit/qualification/disposition-integrity.test.ts`, this report. Added D14 PENDING text to the pre-existing untracked decisions file. No pre-existing edits reverted.

## Validation

All provider/network mocks are local test evidence only. No staging or production evidence, paid calls, deployment or shared-database writes.

| Command | Exact result (**local test**) | Log |
|---|---|---|
| `npm test -- tests/unit/qualification tests/unit/tenants/arunodhaya-config.test.ts tests/unit/agent-config.test.ts tests/unit/agent-versioning.test.ts tests/unit/agent-resolver.test.ts tests/unit/runtime/tool-boundary.test.ts tests/integration/multi-tenant-isolation.test.ts` | Exit 0; 11 files / 134 tests passed (before disposition regression addition). | Tool output |
| `npm test -- --maxWorkers=2` (outside sandbox retry, final code) | Exit 0; 152 files passed, 1,573 tests passed, 5 skipped; 75.34 seconds. | `/tmp/halo-layer1-tests-unrestricted.log` |
| `npm run typecheck` | Exit 0, repeated after final code/build. | `/tmp/halo-layer1-typecheck-final.log` |
| `npm run lint` | Exit 0, repeated after final code/build. | `/tmp/halo-layer1-lint-final.log` |
| `npm run check:architecture` | Exit 0; runtime/voice boundaries, provider direction, closed tool registry and table RLS check passed. | `/tmp/halo-layer1-architecture.log` |
| `npm run check:neutral` | Exit 0; packages industry-neutral and boundaries passed. | `/tmp/halo-layer1-neutral.log` |
| `npm run preflight:ci` (outside sandbox retry) | Exit 0; configuration checks passed. Warns missing/short CRON_SECRET, email/WhatsApp not configured, database check skipped. | `/tmp/halo-layer1-preflight-unrestricted.log` |
| `npm run build` (outside sandbox retry) | Exit 0; local production build completed; no deployment. | `/tmp/halo-layer1-build-unrestricted.log` |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'` (outside sandbox retry) | Exit 0; 70 tests run, OK, 1 skipped. | `/tmp/halo-layer1-python-unrestricted.log` |
| `git diff --check` | Exit 0. | Tool output |

Initial sandbox failures: JavaScript full suite exited 1 (7 files failed, 40 tests failed, 12 errors; includes `Error: listen EPERM: operation not permitted 0.0.0.0`); preflight exited 1 (`EPERM`, `listen`, `/tmp/tsx-1000/53.pipe`); build exited 1 (`next/font: error: Failed to fetch Geist from Google Fonts`). Each passed after permission-controlled retry. Worker sandbox run stalled and was interrupted (exit 130) after successful unrestricted retry. Logs: `/tmp/halo-layer1-tests.log`, `/tmp/halo-layer1-preflight.log`, `/tmp/halo-layer1-build.log`, `/tmp/halo-layer1-python.log`.

Skipped checks: destructive migration/RLS gates because this task changed no DB/schema and did not provision a fresh disposable DB; TTS parity because neither normalizer changed. JS reports 5 existing skipped tests; worker reports 1 skip. These remain unexecuted cases. No paid/provider-backed evaluation, human language approval, staging or production checks were performed.

**source:** final task-only tracked diff: 2 files, 25 insertions, 3 deletions (`schema.ts`: 24 insertions/2 deletions; `disposition.ts`: 1 insertion/1 deletion). New regression files add 14 tests. Report and decisions are untracked documents in the existing worktree. Reviewed final code diff after gates; no independent implementing-agent handoff was claimed.

Unresolved and found but not fixed: activation/default/fallback gaps, duplicate instruction sources, document approval and collection enforcement, retrieval parent ownership proof, future callback commitments without approved staffing policy, unapproved Arunodhaya qualification/facts, missing fresh DB knowledge isolation proof. These are listed above with remedies; no unrelated cleanup was performed.

## Current closure attempt — L1-CLOSE-20261014

**source:** owner explicitly authorized safe Layer 1 implementation and required stopping before any concrete unapproved migration. Baseline: current AGENTS.md, blueprint §§3/4/16/23/30, decisions and source were inspected; earlier reports were not treated as proof. Starting git status is `/tmp/halo-l1-initial-status.txt`; SHA-256 hashes of 682 tracked/untracked files are in `/tmp/halo-l1-baseline-hashes.json` (no secret values captured). Existing qualification fixes and their two integrity suites were preserved unchanged.

### Bounded card and scope

Objective: enforce Layer 1 at trusted backend boundaries and prepare the exact remaining approval request. Prerequisites: owner's current task, existing schemas/adapters, current D14 PENDING. Acceptance: incomplete configuration cannot serve, identity/instructions/contact authority are pinned, unsupported knowledge scope and unapproved document answers fail closed, pilot approvals remain explicitly pending, and actual gates are recorded. Rollback: reverse only this task's patches; never reset the worktree. No migration, deployment, hosted access, paid call, commit or outbound activation is authorized or performed.

Intended runtime source scope (expanded during inspection when contact-capture bypass was found):

- `packages/core/domain/agents.ts`: readiness validator, explicit unset draft language, unresolved activation blockers.
- `packages/agents/agent-versioning.ts`, `agent-repository.ts`, `agent-resolver.ts`: validate publication, rollback and published/pinned reads; defensive ownership checks.
- `packages/runtime/agent-runtime.ts`, `context-builder.ts`, `knowledge-resolver.ts`: validate before effects, remove mutable fallback, derive contact authority from pinned grants, deny unsupported collection bindings before provider access.
- `packages/providers/knowledge/supabase-knowledge-provider.ts`: withhold unapproved document/vector answers, verify FAQ tenant/publication from backend rows, reject foreign parent documents before indexing effects.
- `packages/voice/phone-channel-adapter.ts`: require valid published tenant-owned call configuration; no name/language fallback.
- `src/core/services/chat-service.ts`, `lead-capture.ts`: reject unpinned compatibility calls and grant-gate automatic contact writes.
- `src/content/tenants/arunodhaya/agent.ts`: four explicit unresolved approval blockers; facts and policies unchanged.
- `src/features/faqs/actions.ts`: newly created/edited content is unpublished until explicit publication.
- This report and `docs/DECISIONS.md`: evidence and pending concrete approval, not business signoff.

Existing synthetic tests/fixtures changed only to provide complete pinned configurations or explicit grants: agent-versioning/resolver/config unit suites; runtime agent-budgets; agent-linkage/runtime, widget-message-security, multi-tenant-isolation, chat-service, booking-conversation, runtime-golden-transcripts, generic golden, local-voice-loop, Pipecat gateway and voice-gateway-service integration suites; `tests/mocks/runtime-fakes.ts`, `voice-gateway-harness.ts`; generic tenant and Arunodhaya golden fixtures. Arunodhaya golden runs explicitly clear blockers only in synthetic test data; production tenant config retains them. New files: `tests/mocks/layer1-agent-config.ts`, `tests/unit/layer1-activation.test.ts`, `layer1-knowledge-access.test.ts`, `layer1-faq-lifecycle.test.ts`, `tests/unit/runtime/layer1-version-context.test.ts`.

### Implemented behavior and compatibility

**source:** incomplete drafts remain editable. Publication and rollback require nonblank identity name, objective, effective version prompt and explicit valid language tags; invalid schema values and conflicting nested/version templates are rejected. The persisted version's top-level `prompt_template` remains canonical; a nonempty nested template must match it. Phone configuration must include all six existing deterministic prompts. Nonempty unsupported collection IDs and unresolved activation blockers deny activation. Errors identify fields/reasons without echoing configuration values.

**source:** published repository reads and runtime entry reject invalid configuration before model, knowledge or action access. Requests must bind tenant, agent and version; phone contexts additionally require publication and matching tenant/agent. Existing conversations continue to read their pinned published version, not the newly selected live version. Identity, language, custom instructions and contact-capture behavior no longer fall back to mutable receptionist settings. An empty versioned custom-instruction string means empty. Legacy `ChatService.respond` rejects with `agent_context_required`; callers must use resolved `respondForAgent`.

**source:** contact capture requires the pinned `save_contact_details` grant even when the receptionist's mutable capture flag is true. Shared runtime doctrine and context use the same grant. Existing deterministic booking/qualification code was not restructured.

**source:** collection restrictions are denied rather than widened. General documents cannot establish approval in the current schema, so their snippets are withheld; vector document search is not invoked. Published FAQs are re-read with explicit tenant, publication and candidate-ID filters; only matching nonblank own-tenant rows reach the model. Pending/foreign rows and failed approval reads cannot produce answers. Creating/editing FAQs through the trusted actions leaves them unpublished. Publication still uses the existing endpoint/role model; full attributable approval and direct Data API constraints remain D14 work.

Compatibility changes are intentional: published legacy backfills in `0014`, `0021`, `0022` omit objective and now fail safely; no objective is invented. The existing onboarding/backfill SQL may still create rows marked active, but invalid rows cannot serve through these backend boundaries. New valid replacement versions are required under an owner-approved rollout. Old mutable contact-capture flags no longer authorize writes; the published grant must do so. Document retrieval and nonempty collection configurations are unavailable until the approved database access model is implemented. This is safe denial, not feature completion.

### Concrete migration proposal — approval required, no SQL file created

**source:** existing `knowledge_documents.status` is processing/ready/error, not approval. `0017` supplies tenant-owned collection rows and optional document binding, with member-read/admin-manage policies. Document/chunk and document/collection foreign keys reference IDs alone; tenant equality is not a composite constraint. FAQ `is_published` defaults true and tenant members have write/update policies. Retrieval functions in `0005` are SECURITY DEFINER, scoped by chunk/FAQ business ID and callable by service_role only; they do not establish document approval or parent-tenant equality. No inspection of hosted rows or migration ledger was performed.

Approve or amend this concrete additive design before implementation:

1. Reuse `knowledge_collections` and `knowledge_documents.collection_id`. Add nullable FAQ collection binding only if FAQ restriction semantics are approved. Add unique `(id, business_id)` targets and composite child→parent tenant foreign keys for document→collection and chunk→document; validate existing consistency before validating those constraints. Do not silently repair mismatched legacy rows.
2. Add approval state (`pending`, `approved`, `revoked`), approving actor, approval timestamp and source reference to documents and FAQs, separate from indexing/publication state. Add content revision and approved revision; edits invalidate approval. Approved content must have complete provenance and matching revisions. Legacy content defaults pending, regardless of `ready` or `is_published`; no automatic approval backfill.
3. Restrict approval/revocation to the owner-approved tenant role (proposed owner/admin), enforcing actor membership and tenant scope in database policies/triggers as well as backend actions. Ordinary editing must never self-approve. Preserve tenant-member editing only if the owner approves it; current policies permit members to write FAQ publication directly and cannot be repaired solely in application code.
4. Replace/add retrieval RPCs with explicit allowed collection IDs, tenant checks for every parent and binding, approval/current-revision checks and indexing readiness. Apply the same rules to keyword and vector retrieval. Unknown/foreign collections deny access. Explicitly decide empty-scope behavior and treatment of unbound documents/FAQs; recommended preservation of current empty-scope meaning is all *approved own-tenant* content, while nonempty scope excludes unbound content. Reapply existing service-role-only execution grants, fixed search_path and tenant checks; do not expose privileged RPCs to public/anon/authenticated.
5. Decide knowledge revision pinning before implementing it: an immutable approved snapshot per conversation versus per-turn current approval with immediate revocation. D14 proposes pinning, but neither snapshot storage nor the behavior of revocation during pinned conversations is concretely approved. An immutable revision/snapshot relation and conversation reference would be additional schema work; no guessed implementation was created.
6. Approve the legacy agent rollout: create attributable valid replacement versions, preserving historical versions and pins; do not edit old migrations or invent objectives, language or approval. Any DB-level active-pointer/readiness constraint is additional approved migration work.

Compatibility is verified at **source** level only: additions can preserve existing columns/IDs, but legacy content would disappear from retrieval until approved and invalid agents already refuse serving. Composite FK validation can fail on old mismatches; fixture/row census is required on an authorized target later. New required provenance cannot be supplied from existing indexing flags. Dropping new objects or reverting application checks cannot safely undo approvals, revision history or external commitments; prefer a forward correction, retaining old data and deny-by-default behavior. No automatic destructive rollback is proposed.

Required approval: owner authorization for items 1–6 (including the role model, empty/nonempty scope, legacy handling and revision/revocation semantics), creation of the additive migration, and testing the complete sequence only on a fresh local `halo_check_<suffix>` disposable database. This is not hosted-apply/deployment authorization. D14 and D11 remain PENDING.

### Arunodhaya readiness

| Pilot field | State | Evidence |
|---|---|---|
| Company facts and service area | PENDING BUSINESS APPROVAL / required values MISSING | **source:** 12 pending facts, 0 verified; no source/answer invented. |
| Identity and Telugu/Tenglish behavior | TECHNICALLY VERIFIED; BUSINESS APPROVAL PENDING | **source/local test:** authored Telugu-first language/code switching, versioned identity and deterministic lines; no native reviewer signoff claimed. |
| Qualification questions/required answers/outcomes | TECHNICALLY VERIFIED; BUSINESS APPROVAL PENDING | **source/local test:** deterministic schema/engine and prior unresolved-answer fix retained; tenant file says starting configuration. |
| Callback/escalation policy | PENDING BUSINESS APPROVAL / staffing/contact MISSING | **source:** triggers exist, but approved coverage/contact and callback commitment policy are absent. Existing callback wording retained for review; pilot activation denied. |
| Permitted actions/confirmation requirements | TECHNICALLY VERIFIED boundaries; PILOT AUTHORITY APPROVAL PENDING | **source/local test:** pinned grants, tool authorization and confirmations tested; commercial limits UNSET. |
| Approved knowledge/collection restrictions | BLOCKED | **source:** no approved pilot knowledge; unsupported restrictions deny, document approval schema not authorized. |

The source pilot configuration has four explicit activation blockers; publication and runtime fail while these remain. This does not prove the state of any previously deployed/stored pilot version. Synthetic fixtures clearing blockers are not business approval.

### Current validation and final verdict

All results below are **local test** evidence on the current dirty tree. The architecture/neutrality checks are static source gates, not real-role isolation proof.

| Command | Captured result | Log |
|---|---|---|
| `npm test -- --maxWorkers=2` | Exit 0; 156 files passed; 1,602 tests passed, 5 skipped (1,607 total); 36.87 seconds. | `/tmp/halo-l1-close-tests-verified.log` |
| `npm test -- tests/integration/runtime-golden-transcripts.test.ts tests/integration/chat-service.test.ts tests/unit/runtime/layer1-version-context.test.ts` | Exit 0; 3 files, 24 tests passed. Includes corrected granted contact-capture fixture and denial/fallback tests. | `/tmp/halo-l1-close-grant-regressions.log` |
| `npm run typecheck` | Exit 0; rerun after build completed. | `/tmp/halo-l1-close-typecheck-recorded.log` |
| `npm run lint` | Exit 0. | `/tmp/halo-l1-close-lint-recorded.log` |
| `npm run check:architecture` | Exit 0. | `/tmp/halo-l1-close-architecture-recorded.log` |
| `npm run check:neutral` | Exit 0. | `/tmp/halo-l1-close-neutral-recorded.log` |
| `npm run preflight:ci` | Exit 0; DB skipped; email/WhatsApp not configured; CRON_SECRET missing/short warning. | `/tmp/halo-l1-close-preflight-final.log` |
| `npm run build` | Exit 0; local Next.js production build. Later changes only added a fixture grant and comments. No deployment. | `/tmp/halo-l1-close-build-complete.log` |
| `.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'` | Exit 0; 70 tests run; OK, 1 skipped. Worker source untouched; run to satisfy repository gates. | `/tmp/halo-l1-close-worker-final.log` |
| `git diff --check` | Exit 0. | Tool output |

Intermediate failures were corrected, not treated as passes: early in-progress full suite exited 1 (14 files failed, 95 tests failed, 12 errors; included `Error: listen EPERM: operation not permitted 0.0.0.0` and fixtures still supplying incomplete configurations). Permission-controlled outside-sandbox runs resolved socket restrictions. Initial focused run: 1 file/3 tests failed because its custom resolver still expected now-unsupported collection bindings; new-test run: 4 failed due to the test harness accessor `harness.store.messages`; contact-denial test initially used a nonexistent output context accessor and failed once. These test defects were corrected with explicit synthetic fixtures and actual store access. Logs: `/tmp/halo-l1-close-tests-initial.log`, `/tmp/halo-l1-close-focused-initial.log`, `/tmp/halo-l1-close-new-tests.log`, `/tmp/halo-l1-close-focused-final.log`.

After the contact-grant fix, one full run exited 1 (155 files/1,601 tests passed, 1 failed, 5 skipped) because the golden contact fixture supplied no grant; corrected to explicitly grant `save_contact_details`, preserving the snapshot, then targeted and full runs passed. Concurrent typecheck/build produced TS6053 for missing generated `.next/types/cache-life.d.ts` and `validator.ts`; typecheck rerun after completed build exited 0. Logs: `/tmp/halo-l1-close-tests-complete.log`, `/tmp/halo-l1-close-typecheck-complete.log`. No check was weakened.

Skipped: destructive migration/RLS tests because no concrete migration is approved or created and no disposable DB was provisioned for this task; hosted/production access, provider-backed tests, deployments and paid inference; TTS parity because normalizers were unchanged. Five JS and one worker skipped cases remain unexecuted. Documentation fetch of the Supabase markdown changelog was unavailable (unsupported content type); existing query filtering was checked against the official JS filtering documentation and local tests. No new Supabase feature/schema was implemented.

**source:** final code diff reviewed; the late review found and fixed the automatic-contact grant bypass. Current scoped `git diff --stat` output is `/tmp/halo-l1-current-diff-stat.txt`; it includes pre-existing tracked changes in runtime/phone files and therefore is not a task-only line count. New regression/fixture files are listed in Scope. Compared with the starting-file hashes: 35 pre-existing paths changed, 5 files added, 0 starting files missing. Of the changed paths, 34 belong to this task; `scripts/voice-pipeline-baseline.ts` changed without any task edit and was left untouched. All other baseline file contents match. This comparison excludes ignored build artifacts. No existing qualification patches were altered, no tracked/untracked file was removed, and no commit/push/branch switch/stash/reset/clean was performed.

| Layer 1 criterion | Verdict | Evidence and limit |
|---|---|---|
| Tenant/agent configuration valid | PASS at backend boundaries | **source/local test:** invalid publication, rollback and serving fail before effects. Direct database active-row constraints/legacy rollout remain D14 work; no deployed evidence. |
| Agent configuration reproducible | PASS for pinned agent configuration | **source/local test:** version selection/ownership, missing configuration and mutable fallback denial tested. Knowledge revision pinning is separately BLOCKED. |
| Knowledge controlled | BLOCKED | **source/local test:** pending documents and unapproved/foreign FAQs cannot supply answers through the adapter; restrictions fail closed. Full approval/provenance, allowed-collection retrieval and revision lifecycle need D14. |
| Qualification rules explicit | BLOCKED for pilot acceptance | **source/local test:** deterministic schemas/outcomes verified; Arunodhaya's starting criteria lack business approval. |
| Permissions enforced | BLOCKED for complete pilot authority/commitment review | **source/local test:** grant/channel/binding/argument/action checks and automatic-contact denial pass. Callback/escalation commitments and staffing policy remain unapproved; source pilot activation blocked. |
| Tenant isolation tested | BLOCKED for database acceptance | **local test:** real backend classes/routes with synthetic stores deny cross-tenant config/knowledge. No fresh real-role knowledge/configuration DB evidence; mocks are not RLS proof. |
| Arunodhaya configuration reviewed | PASS for review/blocker documentation | **source/local test:** fields reviewed, pending approvals documented and source bundle cannot activate. BUSINESS-APPROVED remains BLOCKED. |

**Implementation complete:** the authorized safe non-migration subset only. **Locally verified:** backend changes and recorded gates. **Business-approved:** no new approval; D11 remains pending. **Production-ready:** not established; no hosted/deployed evidence. **Overall Layer 1: BLOCKED**, not complete.

Remaining risks/found but not fixed: direct Data API/RPC approval enforcement and legacy FAQ publication defaults; tenant-composite FK validation; allowed collections and immutable knowledge revisions; DB active-pointer/readiness enforcement; attribution/rollout for legacy published configs; opaque tool-policy schemas still validated by their existing specific adapters; unsupported callback wording until business policy review. The pilot bundle stays blocked. The source `.env`/provider/preflight configuration is not evidence of approved business facts, provider operation or production readiness. Follow-up requires concrete D14 decisions above and D11 business input, not more unrelated layer work.
