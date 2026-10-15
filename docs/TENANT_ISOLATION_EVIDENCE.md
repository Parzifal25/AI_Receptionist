# Tenant isolation evidence — Phase 2, Workstream 1

**Status: PARTIALLY VERIFIED.** Every tenant-owned table and every access path found in the repository has an explicit enforcement mechanism, and cross-tenant negative tests pass at the database, HTTP API, route, runtime, knowledge, calendar and background-job boundaries, **locally**. Nothing was verified on a hosted, staging or production system: that is prohibited without an authorized target (G2, R8, D19), so deployed isolation remains unverified (§7).

- **Branch:** `Phase-2-Security-Hardening` (Git refuses the requested name `Phase 2 Security Hardening`, because ref names cannot contain spaces), started from integrated `main` at `8fdaa12e`.
- **Date:** 2026-10-15. **Author:** Claude Code (builder role, G3), under the owner's "Branch Integration + Phase 2 Tenant-Isolation Hardening" instruction.
- **Evidence levels** follow [HALO_Architecture.md §1.3](HALO_Architecture.md#13-evidence-levels): `source`, `local test`, `disposable DB`. A mock is not provider proof, and nothing here is `staging` or `production` evidence.

## 1. Test environments (no credentials recorded)

All three are throwaway Docker containers started for this work from images already in the local cache (`--pull=never`), bound to `127.0.0.1` only, with randomly generated passwords and JWT secret kept in mode-600 files outside the repository. None of them is the shared HALO stack (ports 55321/55322) or the other project's stack (5432x), and no hosted Supabase project was contacted.

| Container | Image | Loopback port | Used for |
|---|---|---|---|
| `halo_check_phase2` | `pgvector/pgvector:pg16` (CI's image) | 55461, database `halo_check_phase2` | `check:migrations`, `check:rls`, DB-backed Vitest suites |
| `halo_check_postgrest` | `public.ecr.aws/supabase/postgrest:v14.13` (the local Supabase stack's version) | 55463, private network `halo_check_net` | Real HTTP API boundary for `tenant-isolation-postgrest.test.ts` |
| `halo_check_supa_ref` | `public.ecr.aws/supabase/postgres:17.6.1.155` | 55462, its own `postgres` database | Fidelity reference: Supabase's real default privileges and PostgreSQL 17. Its `postgres` database cannot be cloned (Supabase background workers hold it open), so the chain was applied there directly. It is disposable by provenance (created seconds earlier, no other user), not by name. The repository harnesses were **not** pointed at it. |

**Roles exercised:** `authenticated` with a JWT subject (owner, admin, member and non-member users), `authenticated` without a subject, the real `anon` role, `service_role`, and the table owner where a trigger had to be proven to hold even with RLS and grants bypassed. Over HTTP, PostgREST switched roles from signed JWTs exactly as Supabase does.

## 2. Fidelity defects found in the test harness (fixed)

The existing harness was sound but under-tested two hosted behaviours:

1. **Supabase default privileges.** On the real image, `pg_default_acl` grants `anon`, `authenticated` and `service_role` ALL on every table, function and sequence the migration role creates in `public`. The CI stubs did not, so a missing `revoke ... from anon` passed in CI but would fail open on a hosted project. `infrastructure/ci/supabase-stubs.sql` now issues the same default privileges. With it, the disposable DB reproduces the hosted grant set exactly (for example, 36 tables with client TRUNCATE before `0034`, the same as the real image).
2. **`auth.uid()` and PostgREST 10+.** PostgREST sets only the JSON `request.jwt.claims`, while the stub read only the legacy `request.jwt.claim.sub`, so every HTTP request looked anonymous. The stub now reads both, as GoTrue's definition does.

## 3. Confirmed vulnerabilities and fixes

Severity is the implementer's assessment, not a security-owner rating.

| ID | Finding (reproduced before the fix) | Reachable by | Assessed severity | Fix | Regression evidence |
|---|---|---|---|---|---|
| P2-V1 | A tenant admin could insert an `agent_versions` row for its own tenant under **another tenant's agent**. `agent_versions` is unique on `(agent_id, version)`, so this squats the other tenant's version numbers and inserts a foreign row into any per-agent listing. | Any tenant admin with a session (PostgREST) | Medium | `0034` reference check | `check:rls` (authenticated admin, refused); HTTP test (`23514`, B's agent still has one version) |
| P2-V2 | A tenant member could point its own appointment at another tenant's **staff member**, **conversation** or **lead**. The `appointments_no_overlap` exclusion constraint is keyed on `(staff_id, time)` across tenants, so the first test run showed tenant A's appointment colliding with tenant B's real booking. | Any tenant member (PostgREST) | Medium | `0034` | `check:rls` (member refused; B can still book the slot A tried to occupy); HTTP test, including identical errors for a foreign and a random id (no existence oracle) |
| P2-V3 | A tenant member could link its own lead to another tenant's conversation. | Any tenant member | Low–Medium | `0034` | `check:rls`; HTTP test |
| P2-V4 | Under Supabase's default grants, `anon` and `authenticated` held TRUNCATE (which ignores RLS: demonstrated emptying a table holding two tenants' rows), REFERENCES, TRIGGER and, on PostgreSQL 17, MAINTAIN on 36 tables; `anon` held privileges on 7 sequences and `authenticated` could `setval`; two SECURITY DEFINER trigger functions from `0029` were executable by `anon`. PostgREST exposes none of these verbs, so this was latent rather than reachable through the API. | Any SQL path running as a client role | Medium (latent) | `0034` revokes, including default privileges for future objects | `check:rls` invariants; probes on the real Supabase image after `0034`: 0 such grants, TRUNCATE refused, rows intact |
| P2-V5 | 15 further tenant-to-tenant references had no database ownership check (service-role writers only), for example `calendar_connections.staff_id`, `messages.conversation_id`, `conversation_outcomes.appointment_id` and `workflow_runs.workflow_id/event_id`. The conversation identity guard validated `receptionist_id` only through an admin-chosen agent slug. | Service-role code defects; an admin-crafted agent slug | Low (latent) | `0034` (generic trigger on all 18 columns) | Catalog gate: all 43 tenant FKs ownership-checked; 41 generic cross-tenant cases refused as `service_role`; slug-squat case refused |
| P2-V6 | The web conversation store dropped the trusted tenant: `ChatService` ignored `businessId` when loading model history, and `upsertConversationLead` received `businessId` but found and updated the lead by conversation and id only. Not exploitable today (both ids come from one visitor-token row), but the runtime's store contract passes the tenant expressly so the store can enforce it. The voice store already did. | Defence in depth | Low | `WidgetRepository` now filters history and lead lookup/update by tenant; callers pass the trusted tenant | `widget-repository-tenant-scope.test.ts` (failed before the fix); `widget-messages-security.test.ts` now includes a foreign-tenant row under the same conversation id |
| P2-V7 | Background jobs rebuilt work from several rows loaded by id: a retried workflow run (run, workflow, event) and a reminder (reminder, appointment). Rows of two tenants would have run one tenant's steps on another's event, or sent tenant A's reminder to tenant B's visitor (shown by the failing test). `0034` now refuses such rows; these guards also cover rows written before it. | Defence in depth (legacy rows) | Low | Engine dead-letters the run; reminder is left failed with a reason | `workflow-engine.test.ts` (2 cases), `reminder-service-tenant.test.ts` (failed before the fix) |

**Migration `0034_tenant_reference_integrity.sql`** is additive: no table, column or existing function changed. It has been applied **only** to the disposable databases above. It is not applied to the shared local stack or any hosted project, and adopting it needs owner approval ([DECISIONS.md D22](DECISIONS.md#d22--migration-0034-tenant-reference-integrity)). It provides `tenant_reference_census()` (service role only) to report pre-existing mismatches, because triggers check new writes only.

## 4. Resource inventory

All 44 public tables have RLS enabled. 42 carry `business_id`; `businesses` is the tenant root; `workflow_run_logs` is scoped through `workflow_runs`. Every policy is a membership or admin predicate on the row's own tenant (catalog gate: no `anon` policy, no `OR`, no unconditional policy). "Server-side access" lists the non-test source files that query the table with `.from(...)`; RPC-only access is listed in §5.

| Table | Tenant key | Client access (RLS) | Cross-table references → enforcement | Server-side access |
|---|---|---|---|---|
| `agent_versions` | business_id | admin insert, member read | agent_id→agents (**0034**) | `@halo/agents/agent-repository.ts`, `@halo/voice/stores/supabase-call-store.ts` |
| `agents` | business_id | admin delete, admin insert, admin update, member read | live_version_id→agent_versions (0018 live-version trigger) | `@halo/agents/agent-repository.ts`, `@halo/voice/stores/supabase-call-store.ts` |
| `appointment_feedback` | business_id | member read | appointment_id→appointments (**0034**) | `@halo/scheduling/scheduling-repository.ts` |
| `appointment_reminders` | business_id | member read | appointment_id→appointments (**0034**) | `@/app/api/admin/system-status/route.ts`, `@/app/dashboard/admin/page.tsx`, `@halo/scheduling/scheduling-repository.ts`, `@halo/analytics/operations-analytics-service.ts` |
| `appointments` | business_id | member read, member update | conversation_id→conversations (**0034**); lead_id→leads (**0034**); staff_id→staff_members (**0034**) | `@/app/dashboard/appointments/page.tsx`, `@halo/scheduling/scheduling-repository.ts`, `@halo/analytics/lifecycle-analytics-service.ts`, `@halo/analytics/operations-analytics-service.ts` |
| `booking_drafts` | business_id | member read | conversation_id→conversations (**0034**) | `@halo/scheduling/scheduling-repository.ts` |
| `business_members` | business_id | admin all, member read | — | `@/app/onboarding/page.tsx`, `@halo/tenancy/auth.ts` |
| `business_settings` | business_id | admin update, member read | — | `@/core/services/widget-repository.ts`, `@/features/settings/actions.ts`, `@/app/api/hooks/[businessId]/route.ts`, `@/app/dashboard/settings/page.tsx` |
| `businesses` | id (root) | admin update, member read | — | `@/features/business/actions.ts`, `@/lib/startup-check.ts`, `@/app/dashboard/profile/page.tsx`, `@/app/dashboard/layout.tsx`, `@halo/lifecycle/manage-service.ts`, `@halo/voice/stores/supabase-call-store.ts`, `scripts/demo/voice-tenant.ts` |
| `calendar_connections` | business_id | none (service role only) | staff_id→staff_members (**0034**) | `@/features/settings/actions.ts`, `@/app/api/oauth/google-calendar/callback/route.ts`, `@/app/api/admin/system-status/route.ts`, `@/app/dashboard/settings/page.tsx`, `@/app/dashboard/admin/page.tsx`, `@halo/scheduling/scheduling-repository.ts`, `scripts/calendar-credentials.ts` |
| `call_events` | business_id | member read | call_id→calls (0020 call-child ownership) | `@halo/voice/stores/supabase-call-store.ts` |
| `call_transcript_turns` | business_id | member read | call_id→calls (0020 call-child ownership) | `@halo/voice/stores/supabase-call-store.ts` |
| `calls` | business_id | member read | agent_id→agents (0020 voice ownership); agent_version_id→agent_versions (0020 voice ownership); conversation_id→conversations (0020 voice ownership); phone_number_id→phone_numbers (0020 voice ownership) | `@halo/voice/stores/supabase-call-store.ts` |
| `campaign_contacts` | business_id | member read | campaign_id→campaigns (composite key); customer_id→customers (composite key) | `@/app/api/campaigns/route.ts`, `services/voice-gateway/index.ts` |
| `campaign_events` | business_id | member read | campaign_id→campaigns (composite key); contact_id→campaign_contacts (composite key) | — (RPC/trigger only) |
| `campaigns` | business_id | member read | agent_id→agents (0025 campaign guard); agent_version_id→agent_versions (0025 campaign guard); phone_number_id→phone_numbers (0025 campaign guard) | `@/app/api/campaigns/route.ts`, `@halo/campaigns/supabase-campaign-store.ts`, `@halo/campaigns/dispatch.ts` |
| `conversation_outcomes` | business_id | member read | agent_id→agents (0020 voice ownership); agent_version_id→agent_versions (0020 voice ownership); appointment_id→appointments (**0034**); call_id→calls (0020 voice ownership); conversation_id→conversations (0020 voice ownership) | `@/app/api/learning/route.ts`, `@halo/voice/stores/supabase-call-store.ts` |
| `conversation_state` | business_id | member read | conversation_id→conversations (**0034**) | `@halo/runtime/stores/supabase-conversation-state-store.ts` |
| `conversations` | business_id | member read | agent_id→agents (0021 identity guard); agent_version_id→agent_versions (0021 identity guard); receptionist_id→receptionists (**0034**) | `@/core/services/widget-repository.ts`, `@/app/dashboard/conversations/page.tsx`, `@/app/dashboard/conversations/[id]/page.tsx`, `@halo/voice/stores/supabase-call-store.ts` |
| `customer_timeline` | business_id | member read | customer_id→customers (**0034**) | `@/app/dashboard/customers/[id]/page.tsx`, `@halo/crm/supabase-crm-store.ts` |
| `customers` | business_id | member read | merged_into→customers (**0034**) | `@/app/dashboard/customers/page.tsx`, `@/app/dashboard/customers/[id]/page.tsx`, `@halo/campaigns/supabase-campaign-store.ts`, `@halo/analytics/lifecycle-analytics-service.ts`, `@halo/crm/supabase-crm-store.ts` |
| `faq_revisions` | business_id | member read | faq_id→faqs (composite key) | `@/app/dashboard/faqs/page.tsx` |
| `faqs` | business_id | admin delete, member read | published_revision_id→faq_revisions (composite key) | `@/features/faqs/actions.ts`, `@/app/dashboard/faqs/page.tsx` |
| `intake_responses` | business_id | member read | appointment_id→appointments (**0034**) | `@halo/scheduling/scheduling-repository.ts` |
| `knowledge_chunks` | business_id | member read | document_id→knowledge_documents (composite key); revision_id→knowledge_document_revisions (composite key) | `@halo/providers/knowledge/supabase-knowledge-provider.ts` |
| `knowledge_collections` | business_id | admin delete, admin insert, admin update, member read | — | — (RPC/trigger only) |
| `knowledge_document_revisions` | business_id | member read | document_id→knowledge_documents (composite key) | `@/app/dashboard/knowledge/page.tsx` |
| `knowledge_documents` | business_id | admin delete, member read | collection_id→knowledge_collections (composite key); published_revision_id→knowledge_document_revisions (composite key) | `@/features/knowledge/actions.ts`, `@/app/dashboard/knowledge/page.tsx` |
| `lead_state_events` | business_id | member read | customer_id→customers (composite key) | — (RPC/trigger only) |
| `leads` | business_id | member delete, member read, member update | conversation_id→conversations (**0034**) | `@/core/services/widget-repository.ts`, `@/features/leads/actions.ts`, `@/app/dashboard/conversations/[id]/page.tsx`, `@/app/dashboard/leads/page.tsx` |
| `learning_proposals` | business_id | member read | draft_version_id→agent_versions (**0034**); source_version_id→agent_versions (0027 proposal guard) | `@/app/api/learning/route.ts`, `@halo/learning/proposals.ts` |
| `messages` | business_id | member read | conversation_id→conversations (**0034**) | `@/core/services/widget-repository.ts`, `@/app/dashboard/conversations/[id]/page.tsx`, `@halo/voice/stores/supabase-call-store.ts` |
| `phone_numbers` | business_id | member read | agent_id→agents (0020 voice ownership) | `@halo/campaigns/supabase-campaign-store.ts`, `@halo/campaigns/dispatch.ts`, `@halo/voice/stores/supabase-call-store.ts`, `services/voice-gateway/index.ts`, `scripts/demo/voice-tenant.ts` |
| `phone_suppressions` | business_id | member read | call_id→calls (0020 call-child ownership) | `@halo/voice/stores/supabase-call-store.ts` |
| `receptionists` | business_id | admin delete, admin insert, admin update, member read | — | `@/core/services/widget-repository.ts`, `@/features/receptionist/actions.ts`, `@/app/dashboard/install/page.tsx`, `@/app/dashboard/receptionist/page.tsx`, `scripts/demo/voice-tenant.ts` |
| `scheduling_settings` | business_id | admin all, member read | — | `@halo/scheduling/scheduling-repository.ts` |
| `staff_members` | business_id | admin all, member read | — | `@halo/scheduling/scheduling-repository.ts`, `@halo/analytics/lifecycle-analytics-service.ts` |
| `tool_executions` | business_id | member read | agent_id→agents (0032 ownership); agent_version_id→agent_versions (0032 ownership); conversation_id→conversations (0032 ownership) | `@halo/runtime/stores/supabase-tool-execution-audit-store.ts` |
| `usage_events` | business_id | member read | — | `@/core/services/widget-repository.ts`, `@/app/api/admin/system-status/route.ts`, `@/app/dashboard/admin/page.tsx`, `@halo/workflows/action-registry.ts`, `@halo/workflows/event-bus.ts`, `@halo/scheduling/scheduling-repository.ts`, `@halo/analytics/lifecycle-analytics-service.ts`, `@halo/analytics/operations-analytics-service.ts`, `@halo/voice/stores/supabase-call-store.ts` |
| `workflow_events` | business_id | member read | — | `@halo/workflows/supabase-workflow-store.ts` |
| `workflow_run_logs` | via parent | member read | run_id→workflow_runs (parent-scoped) | `@halo/workflows/supabase-workflow-store.ts` |
| `workflow_runs` | business_id | member read | event_id→workflow_events (**0034**); workflow_id→workflows (**0034**) | `@/app/api/admin/system-status/route.ts`, `@/app/dashboard/admin/page.tsx`, `@halo/workflows/supabase-workflow-store.ts`, `@halo/analytics/operations-analytics-service.ts` |
| `workflow_timers` | business_id | member read | — | `@halo/workflows/supabase-workflow-store.ts` |
| `workflows` | business_id | admin all, member read | — | `@halo/workflows/supabase-workflow-store.ts` |

`calendar_connections` has no client policy at all: even the owning tenant's admin reads no row and no credential column (`check:rls`, HTTP test). The dashboard reads only `created_at` from it, through the service role.

**Privileged database functions.** Clients can execute exactly 11 SECURITY DEFINER functions (catalog gate, an allowlist): `is_business_member`, `is_business_admin`, `create_business_with_owner`, `review_learning_proposal`, and the seven D14 knowledge/FAQ governance RPCs. Each re-derives the caller from `auth.uid()` membership. `anon` can execute none. Every SECURITY DEFINER function pins `search_path`. Retrieval, indexing, census, backfill, purge, campaign and claim RPCs are `service_role` only.

## 5. Access-path inventory

Tenant identity is never accepted from a request body, query string, header or tool argument. It comes from one of these trusted sources:

| Trusted source | Used by |
|---|---|
| Session membership: `requireBusiness()` resolves the signed-in user's `business_members` row through RLS | Dashboard pages and server actions; `/api/workflows/*`, `/api/campaigns`, `/api/learning`, `/api/analytics/*`, `/api/admin/system-status`, OAuth start/callback |
| Widget key → receptionist → tenant, then a visitor token bound to one conversation | `/api/v1/widget/*` |
| Unguessable capability token (uuid) | `/api/v1/appointments/[token]/*` (manage, intake, feedback) |
| Per-tenant secret, compared in constant time | `/api/hooks/[businessId]` |
| Signed carrier webhook, dialled number → `phone_numbers`, HMAC stream token | Voice gateway |
| `CRON_SECRET`; each claimed row's own `business_id` | `/api/cron/*`, workflow engine, reminders, no-show sweep, campaigns |
| JWT `sub` → `auth.uid()` | Every RLS policy and client-callable RPC |

| Path | Enforcement | Evidence |
|---|---|---|
| Dashboard reads and writes under RLS | RLS + explicit `business_id` filters; admin-only writes checked in the route and again in RLS | `source`; `disposable DB` (sweep: read, insert, update, delete, relabel × 42 tables); HTTP test |
| Workflow API (list, detail, update, delete, manual run, run history, run logs, templates) | Session tenant; detail routes compare ownership and answer a foreign id exactly like a missing one; stores add `business_id` to writes and log reads | `tenant-isolation-routes.test.ts`; HTTP test (`SupabaseWorkflowStore`) |
| Campaigns and learning API | Session tenant; foreign agent, version, number or customer refused by `0025`/`0027` guards and composite keys | `source`; `disposable DB` (41 reference cases include campaigns and proposals) |
| Analytics and admin status | Session tenant; owner/admin only for status; every count filtered by tenant | `source`; existing `system-status-security.test.ts` |
| Inbound workflow hook | Path tenant trusted only after its own secret matches; an unknown tenant, a wrong tenant's secret and a missing token answer identically | `tenant-isolation-routes.test.ts` |
| Calendar OAuth connect | Signed state bound to the starting tenant, nonce cookie bound to the browser, re-check that the session's tenant equals the state's; admin only; no token exchange on mismatch | `tenant-isolation-routes.test.ts` (no fetch, no write on mismatch) |
| Calendar credential lookup (booking, sync) | Service-role query filtered by trusted tenant; staff connection or the tenant-level one; decryption server-side only | HTTP test: own credentials resolve; another tenant's staff id and three crafted `or()`-filter strings never return another tenant's credentials |
| Booking, reschedule, cancel, check-in (visitor) | Capability token; reschedule re-derives the slot from the tenant's own availability (a client-named staff id must be one of the tenant's free slots) | `source` (`manage-service.ts`); existing `multi-tenant-isolation.test.ts` |
| Dashboard appointment action | Loads by id, then requires `appointment.businessId === session tenant` before any transition | `tenant-isolation-routes.test.ts` |
| Widget conversation and messages | Widget key tenant; pinned agent/version tuple re-validated against the tenant before any model call; history and leads filtered by tenant (P2-V6) | existing `widget-messages-security.test.ts` (12 cases, now with a foreign-tenant history row); `widget-repository-tenant-scope.test.ts` |
| Agent runtime | Refuses a turn whose trusted tenant, agent or version disagrees with the resolved agent; loads history, state and knowledge with the trusted tenant | existing `agent-runtime`, `runtime-orchestration` suites |
| Tool execution | Closed registry; arguments schema-validated with unknown keys stripped (a model-supplied `businessId` never reaches an executor); executors receive the trusted context; duplicate intents rejected; side-effecting tools fail closed without an audit row | existing `tool-boundary`, `runtime-orchestration`, `tool-execution-audit` suites |
| Tool-execution audit (D7) | Tenant from trusted state; database refuses a row against another tenant's conversation, agent or version, even for `service_role`; finalize matches tenant | `disposable DB`; HTTP test through `SupabaseToolExecutionAuditStore` |
| Knowledge retrieval (keyword and vector) | Service-role RPCs with the tenant and scope applied inside the query; a foreign or unknown collection is refused as "unknown" (no existence oracle); only approved revisions served | `disposable DB` (D14 section, plus tenant B content never served to A); `knowledge-governance-db.test.ts` (production runtime path) |
| Knowledge authoring, approval, withdrawal, deletion | `auth.uid()` membership; owner/admin approval re-checked by trigger; logs carry ids and truncated database errors only, never content | `disposable DB`; existing `layer1-*` suites; `source` |
| Workflow engine (dispatch, retries, timers) | Runs from the event's tenant; a retried run whose workflow or event belongs to another tenant is dead-lettered (P2-V7) | `workflow-engine.test.ts` |
| Reminders | A reminder whose appointment belongs to another tenant is never sent (P2-V7); settings come from the reminder's tenant | `reminder-service-tenant.test.ts` |
| No-show sweep, retention purge, campaign batches | Cross-tenant by design, each row processed with its own tenant; RPCs `service_role` only | `source`; `disposable DB` (purge, campaign claims) |
| Voice gateway | Tenant from the dialled number; identity never accepted from worker frames; ownership triggers | existing voice suites (`source`, `local test`) |
| Operator scripts (`scripts/calendar-credentials.ts`, demos) | Operator-run, cross-tenant by design, guarded to local targets | `source` |
| Pooled connections | PostgREST sets claim and role per transaction (`set local`); nothing carries into the next transaction | `disposable DB` (one reused session: A, then none, then B) |
| Application caches | No module-level cache holds tenant data; `requireBusiness()` is memoized per request only | `source` |

## 6. Commands and results

All run on 2026-10-15 at `Phase-2-Security-Hardening` with the changes in this document. Connection strings and secrets are passed through environment variables and are not recorded.

```bash
npm run typecheck                    # exit 0
npm run lint                         # exit 0
npm test                             # exit 0 — 163 files passed, 2 skipped (the opt-in DB suites below); 1689 tests passed, 24 skipped
npm run check:architecture           # exit 0
npm run check:neutral                # exit 0
npm run preflight:ci                 # exit 0 (warnings: CRON_SECRET unset locally; DB check skipped by flag)
npm run build                        # exit 0 — see the note below on external contact
.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'   # OK, 70 tests (1 skipped)

# Fresh disposable database (recreated), CI stubs, then the destructive gates:
HALO_DISPOSABLE_DATABASE=1 HALO_DISPOSABLE_DB_URL=postgresql://…@127.0.0.1:55461/halo_check_phase2 npm run check:migrations
                                     # exit 0 — 0001–0034 apply; all asserted columns exist
HALO_DISPOSABLE_DATABASE=1 HALO_DISPOSABLE_DB_URL=… npm run check:rls
                                     # exit 0 — 649 ok, 0 FAIL (269 existing + 380 Phase 2)

# DB-backed suites against that database and the disposable PostgREST:
HALO_DISPOSABLE_DATABASE=1 HALO_DISPOSABLE_DB_URL=… HALO_DISPOSABLE_POSTGREST_URL=http://127.0.0.1:55463 HALO_DISPOSABLE_JWT_SECRET=… \
  npx vitest run tests/integration/tenant-isolation-postgrest.test.ts tests/integration/knowledge-governance-db.test.ts
                                     # exit 0 — 2 files, 19 tests passed
```

**External contact during `npm run build`.** `src/app/layout.tsx` uses `next/font/google` (Geist), so the build downloads font files from Google's public font CDN. The build completed without a font warning, so that download almost certainly happened. It is an unauthenticated public request that carries no credentials or tenant data and costs nothing, but it is external network contact. The D7/D14 run skipped `build` for this reason; this run did not, and it is recorded here rather than presented as an offline check. Every other command above made no non-loopback request; the HTTP suite asserts this for its own traffic.

**Failing-first record.** Before `0034` and the code fixes, the extended `check:rls` reported 591 ok and 36 FAIL. The failures were the real gaps in §3, plus correct refusals worded differently from the test's expectation; the expectation was widened only to the schema's own tenant-refusal wordings, which are listed in the harness. The repository-store, reminder and engine tests each failed before their fix. Every refusal in the Phase 2 section is matched against its expected reason; the reasons were audited (31 sweep inserts refused by RLS, 11 by missing grants; 41 reference cases refused by the `0034` check or the older dedicated guards).

**What the Phase 2 `check:rls` section asserts (380):**
- catalog invariants: RLS everywhere; policy predicates; all 43 tenant FKs ownership-checked; the SECURITY DEFINER allowlist; pinned `search_path`; no client TRUNCATE/REFERENCES/TRIGGER; no `anon` sequence access or client `setval`;
- a symmetric two-tenant fixture with rows in all 42 tenant tables (non-vacuous by assertion);
- a 300-assertion sweep: for every tenant table, tenant A's read, `authenticated`-without-JWT read, real `anon` read, insert, update, delete and relabel against tenant B;
- 41 cross-tenant reference inserts as `service_role`;
- targeted P2-V1–V3 cases as the real roles that could exploit them;
- the receptionist slug-squat case; census;
- TRUNCATE as `anon`/`authenticated`;
- calendar connections;
- pooled-session reuse;
- malformed, empty and member-less JWT subjects;
- membership revocation taking effect on the next statement;
- tenant B's approved knowledge never served to tenant A on either retrieval path.

**HTTP suite (`tenant-isolation-postgrest.test.ts`, 11 tests)** is the same kind of attack sent through the real API server that dashboard sessions use:
- list, filter, `count=exact`, OR-widening, update, delete and insert across all 44 tables as a member and an owner;
- header spoofing and a schema switch to `auth`;
- RPCs called with another tenant's id;
- `anon`, forged-signature, expired and non-member tokens;
- the production stores (`SupabaseAgentRepository`, `SupabaseWorkflowStore`, `SupabaseCrmStore`, `SchedulingRepository`, `SupabaseToolExecutionAuditStore`) as `service_role`;
- an assertion that every request stayed on the loopback interface.

## 7. Not verified

- **Any deployed environment.** Hosted Auth, the hosted grant set, the hosted migration ledger and RLS on a staging target are BLOCKED (D19, R8, D21; plan W1.5, W1.6). The fidelity steps in §2 narrow the gap but are not hosted evidence. `0034` has not been applied anywhere real.
- **Existing hosted data.** `tenant_reference_census()` and `knowledge_governance_census()` have never run against real data.
- **Real providers.** Calendar, messaging, carrier and LLM providers were fakes or not called; calendar isolation is proven for HALO's credential lookup and storage, not inside Google or Microsoft.
- **Voice gateway against a real carrier.** Covered by existing `local test` suites only.
- **Browser-level dashboard flows.** Server actions and routes were tested with the session mocked; Next.js rendering under a real Supabase Auth session was not exercised.
- **Repository by-id methods that rely on their callers.** `SchedulingRepository` (`getAppointment`, `updateAppointmentStatus`, `updateAppointmentTimes`, `setExternalEventId`, booking-draft, reminder, feedback and intake methods) and `SupabaseCrmStore` (`update`, `markMerged`) address rows by id through the service role. Every caller was reviewed (`source`) and loads those ids from a tenant-checked source: the session with an ownership comparison, a capability token, a visitor-token conversation, or a claimed row. `0034` makes the database refuse cross-tenant references among them. Each method was not individually adversarially tested, and the `SchedulingRepository` comment saying every method "takes explicit tenant scope" overstates it.

## 8. Remaining risks and findings not fixed

| Finding | Assessment | Recommendation |
|---|---|---|
| Service-role code bypasses RLS; correctness of new code depends on review | Inherent to Regime B | Keep `check:rls` FK/RLS gates; consider tenant-scoped repository signatures for the by-id methods in §7 |
| `authenticated` can `LOCK TABLE` (PostgreSQL grants it to holders of UPDATE/DELETE, which RLS-mediated writes need) | Not reachable through PostgREST | Accept; revisit if any SQL-execution path for clients is added |
| `0018`'s error message names the agent that owns a supplied version id | Low disclosure to a caller who already holds a foreign version id | Generic message in a later migration |
| An admin of two tenants can move an agent between them (the UPDATE policy checks both sides), leaving its versions behind | Edge case; needs dual admin | Owner decision: make `agents.business_id` immutable |
| Hook secret also accepted in `?token=` (can land in access logs); OAuth state HMAC key reuses `SUPABASE_SERVICE_ROLE_KEY` | Existing design, not tenant crossing | Prefer the header only; a dedicated state key |
| Committed documents contain a private local backup path (`CALENDAR_CREDENTIALS_RUNBOOK.md`) and the password of a past disposable loopback container (`HALO_THREE_GATE_EXECUTION.md`) | Not a hosted credential; already pushed to `origin` | Redact in a documentation pass; history rewrite is not authorized |
| Rate limits are in memory and per instance | Existing (D12) | Unchanged |
