# Migration dependency map — WS3

**DOCUMENTED (source):** inventory of `supabase/migrations/`, 0001–0035 (34 historical files plus K1). No migration is changed or authorized by this document. See [rollout sequence](HOSTED_MIGRATION_RUNBOOK.md), [preflight](HOSTED_TARGET_PREFLIGHT.md), and [recovery](DATABASE_RECOVERY_RUNBOOK.md).

## Execution contract

Apply only a contiguous missing suffix after reconciling the ledger AND schema. Every row requires the preceding numbered prefix; the object dependencies below explain the important direct edges. No file is a general-purpose rerunnable script: even files with IF NOT EXISTS or CREATE OR REPLACE contain mixed operations. Skip recorded versions; never replay a partial file blindly. No down migrations exist. A runner must bind each file and its ledger entry in one transaction, stop on error, and prove this on a clone before target execution. The offline rehearsal models this contract; it does not prove the CLI implements it.

**DOCUMENTED:** ordinary DDL, indexes and DML in this chain can run in transactions; no CREATE INDEX CONCURRENTLY or VACUUM execution is present. Function-body BEGIN/END is not a file transaction. Regular index creation, FK validation, table rewrites and uniqueness checks can lock or scan data: duration and storage headroom require target evidence. Rollback before COMMIT reverses that transaction only; after COMMIT use reviewed forward repair or restore. Function definitions containing DELETE/UPDATE do not execute those bodies during migration.

## Ordered dependency and hazard table

| Migration | Important dependencies / objects and effect | Existing-data transformation / execution hazard |
|---|---|---|
| [0001_init.sql](../supabase/migrations/0001_init.sql) | Supabase auth.users/auth.uid, storage.buckets/objects; anon/authenticated/service_role; pgcrypto and vector; tenant/business/member, receptionist, knowledge, conversations/messages/leads/settings/usage tables; membership RPCs, search RPCs, RLS and Storage policies | Bucket insert; extension bootstrap and grants; gen_random_bytes requires extensions resolution; vector operator pinned to public. Not safe to retry after partial autocommit. |
| [0002_function_grants.sql](../supabase/migrations/0002_function_grants.sql) | 0001 search/membership/business-creation functions; revoke PUBLIC/anon execution, retrieval service-only, future function default EXECUTE revoked | ACL-only; defaults belong to applying creator role. |
| [0003_atomic_message_count.sql](../supabase/migrations/0003_atomic_message_count.sql) | 0001 messages/conversations; bump_conversation_on_message trigger | Recomputes historical message_count; update locks. |
| [0004_data_retention.sql](../supabase/migrations/0004_data_retention.sql) | 0001 retention settings/conversations/usage; purge_expired_data service RPC | Defines future deletion, does not purge on apply. |
| [0005_retrieval_source_attribution.sql](../supabase/migrations/0005_retrieval_source_attribution.sql) | 0001 vector/search types; replaces search_knowledge and match_knowledge_chunks result attribution; service-only grants | Drops/recreates RPC signatures; client compatibility boundary. |
| [0006_lead_qualification.sql](../supabase/migrations/0006_lead_qualification.sql) | 0001 leads; score/temperature/qualification fields and score index | Default values on existing leads; check constraints. |
| [0007_unanswered_questions.sql](../supabase/migrations/0007_unanswered_questions.sql) | 0001 usage_events enum-like check | Replaces check; existing unexpected values fail validation. |
| [0008_appointments.sql](../supabase/migrations/0008_appointments.sql) | 0001 staff/scheduling/appointments/reminders/calendar, btree_gist, exclusion constraint, claim_due_reminders, RLS | Defaults and usage-event check; locks; overlap exclusion; no calendar API call. |
| [0009_workflows.sql](../supabase/migrations/0009_workflows.sql) | 0001,0008; workflow definitions/events/runs/logs/timers, CRM customers/timeline; claim RPCs and RLS | Business webhook-secret column default; event check expanded. |
| [0010_customer_lifecycle.sql](../supabase/migrations/0010_customer_lifecycle.sql) | 0008 appointments/staff and 0001; feedback/intake, RLS | Status and overlap constraint/index replacement, manage_token generated for existing appointments; preserve tokens in backup. |
| [0011_lifecycle_automation.sql](../supabase/migrations/0011_lifecycle_automation.sql) | 0008,0010 scheduling/appointments; no-show configuration and overdue index | Defaults for existing scheduling settings. |
| [0012_booking_drafts.sql](../supabase/migrations/0012_booking_drafts.sql) | 0001 conversations/businesses; booking_drafts with RLS | New table; no existing draft conversion. |
| [0013_agents.sql](../supabase/migrations/0013_agents.sql) | 0001 tenant/member helpers; agents, agent_versions; live-version FK, immutable-version trigger, RLS | New tables; deferred circular agent/version linkage. |
| [0014_agent_backfill.sql](../supabase/migrations/0014_agent_backfill.sql) | 0013 and 0001 receptionists | Creates agents and version 1 from legacy receptionist configuration, sets live_version_id; no invented objective; preserve source mapping. |
| [0015_conversation_agent.sql](../supabase/migrations/0015_conversation_agent.sql) | 0013,0014 conversations/receptionists | Adds pinned agent/version and backfills exact receptionist mapping; inspect unmapped legacy records. |
| [0016_messages_tool_role.sql](../supabase/migrations/0016_messages_tool_role.sql) | 0001 messages | Replaces role/content checks; tool metadata columns; existing data must satisfy replacement checks. |
| [0017_knowledge_collections.sql](../supabase/migrations/0017_knowledge_collections.sql) | 0001 knowledge/business/member helpers | Collections, optional document collection_id, index and admin/member RLS; plain FK alone does not enforce tenant. |
| [0018_agent_live_version_ownership.sql](../supabase/migrations/0018_agent_live_version_ownership.sql) | 0013 agent live_version_id | assert_agent_live_version_ownership trigger; closes cross-agent live pointer; existing rows not repaired. |
| [0019_conversation_state.sql](../supabase/migrations/0019_conversation_state.sql) | 0001 conversations/businesses | conversation_state, timestamps trigger, tenant RLS; no state conversion. |
| [0020_voice_calls.sql](../supabase/migrations/0020_voice_calls.sql) | 0001,0013,0015; voice phone_numbers/calls/events/transcripts/outcomes/suppressions, ownership/state triggers, RLS | Changes conversation channel/receptionist constraints and usage check; replaces retention function to include calls; no carrier call. |
| [0021_business_creation_provisions_agent.sql](../supabase/migrations/0021_business_creation_provisions_agent.sql) | 0013,0014,0018,0001 | Replaces create_business_with_owner to provision agent/version for future businesses, not a historical backfill. |
| [0022_backfill_agents_created_after_0014.sql](../supabase/migrations/0022_backfill_agents_created_after_0014.sql) | 0021,0013,0001 | Idempotent legacy agent/version backfill for the 0014–0021 gap; sets missing live versions; no safe delete rollback. |
| [0023_voice_latency_marks.sql](../supabase/migrations/0023_voice_latency_marks.sql) | 0020 call_events | Expands event-type check for media lifecycle; validates existing events. |
| [0024_lead_lifecycle.sql](../supabase/migrations/0024_lead_lifecycle.sql) | 0009 customers; membership helpers | Lead lifecycle default NEW, tenant-composite customer key, lead_state_events RLS, transition/guard RPCs; future transition DML only. |
| [0025_campaigns.sql](../supabase/migrations/0025_campaigns.sql) | 0020 calls/phone numbers,0024 customers | Campaign/contact/event tables, RLS and tenant guards, claim/settle/complete RPCs, active-contact uniqueness; no outbound call on apply. |
| [0026_runtime_call_events.sql](../supabase/migrations/0026_runtime_call_events.sql) | 0023 call_events | Expands check for runtime_event; existing rows validated. |
| [0027_learning_proposals.sql](../supabase/migrations/0027_learning_proposals.sql) | 0013 versions and tenant/member helpers | Learning proposals, evaluation/review RPCs, ownership guard, RLS; no proposals auto-approved. |
| [0028_call_lead_outcomes.sql](../supabase/migrations/0028_call_lead_outcomes.sql) | 0020 outcomes,0024 lifecycle | apply_call_lead_outcome service RPC and replacement transition guard; future event effects only. |
| [0029_campaign_call_binding.sql](../supabase/migrations/0029_campaign_call_binding.sql) | 0025 campaigns,0020 calls,0028 outcomes | Campaign-call binding/outcome triggers and service callback RPC; future writes can create local call rows, not provider calls. |
| [0030_production_version_guards.sql](../supabase/migrations/0030_production_version_guards.sql) | 0013 versions,0015 conversations,0020 calls/outcomes,0024 lifecycle | Production-version guards, begin_call_conversation service RPC, outcome-safety trigger; existing rows not repaired. |
| [0031_conversation_identity_insert_guard.sql](../supabase/migrations/0031_conversation_identity_insert_guard.sql) | 0030 and conversations | Replaces enforce_conversation_identity and insert/update trigger; protects pinned identity; no historical repair. |
| [0032_tool_executions.sql](../supabase/migrations/0032_tool_executions.sql) | 0001 conversations/membership,0013 agents/versions,0031 baseline | tool_executions, partial unique idempotency index, tenant/lifecycle triggers; authenticated SELECT-only RLS, service writes; no existing data backfill. |
| [0033_knowledge_governance.sql](../supabase/migrations/0033_knowledge_governance.sql) | 0001 knowledge/FAQs/vector,0017 collections, membership helpers | Revision tables, publication pointers, composite FKs (conditionally validated), chunk revision requirement NOT VALID; governance/index/review/retrieval/census/backfill RPCs; grants revoke direct client writes. No legacy approval or migration of content; FAQ default changes only future inserts. |
| [0034_tenant_reference_integrity.sql](../supabase/migrations/0034_tenant_reference_integrity.sql) | All prior table definitions, especially 0029 triggers and 0032/0033 protections | assert_tenant_reference, 16 triggers / 19 column pairs, tenant_reference_census; revokes client TRUNCATE/REFERENCES/TRIGGER/PG17 MAINTAIN, anon sequence rights and authenticated setval; creator-role defaults only. Does not rewrite legacy data or add composite keys. |
| [0035_knowledge_backfill_source_ref_validation.sql](../supabase/migrations/0035_knowledge_backfill_source_ref_validation.sql) | 0033 function/revision constraints and established service-role ACL; ledger order after 0034 | CREATE OR REPLACE adds shared >500 source_ref quarantine; no source-data, grant, policy, approval or retrieval changes. Transactional and function replacement replay-safe; actual ledger entries must still never be duplicated. |
| [0036_security_authorization_audit.sql](../supabase/migrations/0036_security_authorization_audit.sql) | 0001 businesses and is_business_member; 0009 workflow_events/workflow_timers; ledger order after 0035. Added by WS4 (D7/D18 local authorization); this row added 2026-10-15 by the local release-readiness audit | Creates audit_logs (closed action/outcome/reason vocabularies, RLS member SELECT, service_role INSERT/SELECT only, no UPDATE/DELETE/TRUNCATE for application roles) and adds nullable telemetry_correlation_id to workflow_events and workflow_timers. New table plus nullable columns: no existing-data transformation. Business deletion cascades audit rows; no purge or retention window (D23/R8). Real application needs target authorization; the D7 general-audit approval is local-only. |

## Closeout verification

**VERIFIED_LOCAL (disposable DB):** `scripts/check-offline-database.mjs` replays all 35 files and schema assertions, then rebuilds only its own fresh halo_check database for real-role RLS and opt-in production-governance/PostgREST suites. `scripts/check-rollout-rehearsal.mjs` separately models an existing 0001–0031 prefix and applies 0032–0035 with transaction/ledger checks, isolated restore and synthetic legacy fixtures. Saved October 13 push information is historical evidence only; no current hosted ledger/schema was read. K1 is implemented in 0035 under explicit final-closure authorization. Its behavioral tests are separate from chain success; no historical file changes and no real-target authorization follows.

## Exact SQL object inventory

The following source-derived inventory lists CREATE, ALTER, DROP, GRANT and REVOKE statement headers in file order. The linked SQL is authoritative for full predicates, trigger arguments, body DML, and constraints; headers are navigation, not executable SQL. Every newly created application table enables RLS, checked by `npm run check:architecture`.


### 0001_init.sql

```sql
create extension if not exists "pgcrypto";
create extension if not exists "vector";
create or replace function public.set_updated_at()
create table public.businesses (
create trigger businesses_updated_at
create type public.member_role as enum ('owner', 'admin', 'member');
create table public.business_members (
create index business_members_user_idx on public.business_members(user_id);
create or replace function public.is_business_member(target_business_id uuid)
create or replace function public.is_business_admin(target_business_id uuid)
create or replace function public.create_business_with_owner(
create table public.receptionists (
create index receptionists_business_idx on public.receptionists(business_id);
create trigger receptionists_updated_at
create table public.knowledge_documents (
create index knowledge_documents_business_idx on public.knowledge_documents(business_id);
create trigger knowledge_documents_updated_at
create table public.knowledge_chunks (
create index knowledge_chunks_business_idx on public.knowledge_chunks(business_id);
create index knowledge_chunks_document_idx on public.knowledge_chunks(document_id);
create index knowledge_chunks_tsv_idx on public.knowledge_chunks using gin(content_tsv);
create table public.faqs (
create index faqs_business_idx on public.faqs(business_id);
create index faqs_tsv_idx on public.faqs using gin(content_tsv);
create trigger faqs_updated_at
create or replace function public.search_knowledge(
create or replace function public.match_knowledge_chunks(
create table public.conversations (
create index conversations_business_idx
create table public.messages (
create index messages_conversation_idx
create index messages_business_idx on public.messages(business_id);
create table public.leads (
create index leads_business_idx on public.leads(business_id, created_at desc);
create trigger leads_updated_at
create table public.business_settings (
create trigger business_settings_updated_at
create table public.usage_events (
create index usage_events_business_idx
alter table public.businesses         enable row level security;
alter table public.business_members   enable row level security;
alter table public.receptionists      enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks   enable row level security;
alter table public.faqs               enable row level security;
alter table public.conversations      enable row level security;
alter table public.messages           enable row level security;
alter table public.leads              enable row level security;
alter table public.business_settings  enable row level security;
alter table public.usage_events       enable row level security;
create policy "members read business" on public.businesses
create policy "admins update business" on public.businesses
create policy "members read memberships" on public.business_members
create policy "admins manage memberships" on public.business_members
create policy "members read receptionists" on public.receptionists
create policy "admins write receptionists" on public.receptionists
create policy "admins update receptionists" on public.receptionists
create policy "admins delete receptionists" on public.receptionists
create policy "members read documents" on public.knowledge_documents
create policy "members write documents" on public.knowledge_documents
create policy "members update documents" on public.knowledge_documents
create policy "members delete documents" on public.knowledge_documents
create policy "members read chunks" on public.knowledge_chunks
create policy "members write chunks" on public.knowledge_chunks
create policy "members delete chunks" on public.knowledge_chunks
create policy "members read faqs" on public.faqs
create policy "members write faqs" on public.faqs
create policy "members update faqs" on public.faqs
create policy "members delete faqs" on public.faqs
create policy "members read conversations" on public.conversations
create policy "members read messages" on public.messages
create policy "members read leads" on public.leads
create policy "members update leads" on public.leads
create policy "members delete leads" on public.leads
create policy "members read settings" on public.business_settings
create policy "admins update settings" on public.business_settings
create policy "members read usage" on public.usage_events
grant usage on schema public to authenticated, service_role;
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to service_role, authenticated;
alter default privileges in schema public
grant all on tables to service_role;
alter default privileges in schema public
grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
grant usage, select on sequences to service_role, authenticated;
create policy "members upload assets" on storage.objects
create policy "members update assets" on storage.objects
create policy "members delete assets" on storage.objects
create policy "public read assets" on storage.objects
```


### 0002_function_grants.sql

```sql
revoke execute on function public.search_knowledge(uuid, text, int) from public, anon, authenticated;
grant  execute on function public.search_knowledge(uuid, text, int) to service_role;
revoke execute on function public.match_knowledge_chunks(uuid, vector, int) from public, anon, authenticated;
grant  execute on function public.match_knowledge_chunks(uuid, vector, int) to service_role;
revoke execute on function public.create_business_with_owner(text, text) from public, anon;
grant  execute on function public.create_business_with_owner(text, text) to authenticated;
revoke execute on function public.is_business_member(uuid) from public, anon;
grant  execute on function public.is_business_member(uuid) to authenticated;
revoke execute on function public.is_business_admin(uuid) from public, anon;
grant  execute on function public.is_business_admin(uuid) to authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
```


### 0003_atomic_message_count.sql

```sql
create or replace function public.bump_conversation_on_message()
revoke execute on function public.bump_conversation_on_message() from public, anon, authenticated;
create trigger messages_bump_conversation
```


### 0004_data_retention.sql

```sql
create or replace function public.purge_expired_data()
revoke execute on function public.purge_expired_data() from public, anon, authenticated;
grant  execute on function public.purge_expired_data() to service_role;
```


### 0005_retrieval_source_attribution.sql

```sql
drop function if exists public.search_knowledge(uuid, text, int);
create function public.search_knowledge(
revoke execute on function public.search_knowledge(uuid, text, int) from public, anon, authenticated;
grant  execute on function public.search_knowledge(uuid, text, int) to service_role;
drop function if exists public.match_knowledge_chunks(uuid, vector, int);
create function public.match_knowledge_chunks(
revoke execute on function public.match_knowledge_chunks(uuid, vector, int) from public, anon, authenticated;
grant  execute on function public.match_knowledge_chunks(uuid, vector, int) to service_role;
```


### 0006_lead_qualification.sql

```sql
alter table public.leads
create index if not exists leads_business_score_idx
```


### 0007_unanswered_questions.sql

```sql
alter table public.usage_events
drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
```


### 0008_appointments.sql

```sql
create extension if not exists btree_gist;
create table public.staff_members (
create index staff_members_business_idx on public.staff_members(business_id) where is_active;
create table public.scheduling_settings (
create trigger scheduling_settings_updated_at
create table public.appointments (
create index appointments_business_time_idx
create index appointments_staff_window_idx
create index appointments_conversation_idx
create trigger appointments_updated_at
create table public.appointment_reminders (
create index appointment_reminders_due_idx
create or replace function public.claim_due_reminders(batch_size int default 25)
revoke all on function public.claim_due_reminders(int) from public, anon, authenticated;
create table public.calendar_connections (
alter table public.staff_members         enable row level security;
alter table public.scheduling_settings   enable row level security;
alter table public.appointments          enable row level security;
alter table public.appointment_reminders enable row level security;
alter table public.calendar_connections  enable row level security;
create policy "members read staff" on public.staff_members
create policy "admins manage staff" on public.staff_members
create policy "members read scheduling settings" on public.scheduling_settings
create policy "admins manage scheduling settings" on public.scheduling_settings
create policy "members read appointments" on public.appointments
create policy "members update appointments" on public.appointments
create policy "members read reminders" on public.appointment_reminders
alter table public.usage_events
drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
```


### 0009_workflows.sql

```sql
create table public.workflows (
create index workflows_trigger_idx on public.workflows(business_id, trigger) where enabled;
create trigger workflows_updated_at
create table public.workflow_events (
create index workflow_events_business_idx on public.workflow_events(business_id, occurred_at desc);
create index workflow_events_correlation_idx on public.workflow_events(correlation_id)
create table public.workflow_runs (
create index workflow_runs_retry_idx on public.workflow_runs(next_attempt_at)
create index workflow_runs_business_idx on public.workflow_runs(business_id, created_at desc);
create or replace function public.claim_due_workflow_runs(batch_size int default 25)
revoke all on function public.claim_due_workflow_runs(int) from public, anon, authenticated;
create table public.workflow_run_logs (
create index workflow_run_logs_run_idx on public.workflow_run_logs(run_id, id);
create table public.workflow_timers (
create index workflow_timers_due_idx on public.workflow_timers(fire_at) where fired_at is null;
create or replace function public.claim_due_workflow_timers(batch_size int default 25)
revoke all on function public.claim_due_workflow_timers(int) from public, anon, authenticated;
create table public.customers (
create index customers_business_idx on public.customers(business_id, last_seen_at desc);
create index customers_email_idx on public.customers(business_id, lower(email))
create index customers_phone_idx on public.customers(business_id, phone)
create trigger customers_updated_at
create table public.customer_timeline (
create index customer_timeline_customer_idx on public.customer_timeline(customer_id, occurred_at desc);
alter table public.business_settings
alter table public.workflows         enable row level security;
alter table public.workflow_events   enable row level security;
alter table public.workflow_runs     enable row level security;
alter table public.workflow_run_logs enable row level security;
alter table public.workflow_timers   enable row level security;
alter table public.customers         enable row level security;
alter table public.customer_timeline enable row level security;
create policy "members read workflows" on public.workflows
create policy "admins manage workflows" on public.workflows
create policy "members read workflow events" on public.workflow_events
create policy "members read workflow runs" on public.workflow_runs
create policy "members read workflow logs" on public.workflow_run_logs
create policy "members read workflow timers" on public.workflow_timers
alter table public.usage_events
drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
create policy "members read customers" on public.customers
create policy "members read customer timeline" on public.customer_timeline
```


### 0010_customer_lifecycle.sql

```sql
alter table public.appointments
drop constraint appointments_status_check;
alter table public.appointments
alter table public.appointments
drop constraint appointments_no_overlap;
alter table public.appointments
drop index if exists public.appointments_staff_window_idx;
create index appointments_staff_window_idx
alter table public.appointments
create unique index appointments_manage_token_idx
alter table public.scheduling_settings
create table public.appointment_feedback (
create index appointment_feedback_business_idx
create trigger appointment_feedback_updated_at
create table public.intake_responses (
create index intake_responses_business_idx
alter table public.usage_events
drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
alter table public.appointment_feedback enable row level security;
alter table public.intake_responses     enable row level security;
create policy "members read feedback" on public.appointment_feedback
create policy "members read intake responses" on public.intake_responses
```


### 0011_lifecycle_automation.sql

```sql
alter table public.scheduling_settings
alter table public.scheduling_settings
create index appointments_overdue_idx
```


### 0012_booking_drafts.sql

```sql
create table public.booking_drafts (
create index booking_drafts_business_idx on public.booking_drafts(business_id);
create trigger booking_drafts_updated_at
alter table public.booking_drafts enable row level security;
create policy "members read booking drafts" on public.booking_drafts
```


### 0013_agents.sql

```sql
create table public.agents (
create index agents_business_status_idx
create unique index agents_business_slug_idx
create index agents_business_active_idx
create trigger agents_updated_at
create table public.agent_versions (
create index agent_versions_agent_version_desc_idx
create index agent_versions_business_published_idx
alter table public.agents
create or replace function public.enforce_agent_version_immutability()
create trigger agent_versions_immutable
alter table public.agents         enable row level security;
alter table public.agent_versions enable row level security;
create policy "members read agents" on public.agents
create policy "admins insert agents" on public.agents
create policy "admins update agents" on public.agents
create policy "admins delete agents" on public.agents
create policy "members read agent versions" on public.agent_versions
create policy "admins insert agent versions" on public.agent_versions
```


### 0014_agent_backfill.sql

```sql

```


### 0015_conversation_agent.sql

```sql
alter table public.conversations
create index conversations_agent_started_idx
```


### 0016_messages_tool_role.sql

```sql
alter table public.messages
alter table public.messages
alter table public.messages
```


### 0017_knowledge_collections.sql

```sql
create table public.knowledge_collections (
create index knowledge_collections_business_idx
create trigger knowledge_collections_updated_at
alter table public.knowledge_documents
create index knowledge_documents_collection_idx
alter table public.knowledge_collections enable row level security;
create policy "members read knowledge collections" on public.knowledge_collections
create policy "admins insert knowledge collections" on public.knowledge_collections
create policy "admins update knowledge collections" on public.knowledge_collections
create policy "admins delete knowledge collections" on public.knowledge_collections
```


### 0018_agent_live_version_ownership.sql

```sql
create or replace function public.assert_agent_live_version_ownership()
revoke execute on function public.assert_agent_live_version_ownership() from public, anon, authenticated;
create trigger agents_live_version_ownership
```


### 0019_conversation_state.sql

```sql
create table public.conversation_state (
create index conversation_state_business_idx on public.conversation_state(business_id);
create trigger conversation_state_updated_at
alter table public.conversation_state enable row level security;
create policy "members read conversation state" on public.conversation_state
```


### 0020_voice_calls.sql

```sql
alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations
alter table public.conversations alter column receptionist_id drop not null;
alter table public.conversations
create table public.phone_numbers (
create unique index phone_numbers_provider_e164_idx on public.phone_numbers(provider, e164);
create index phone_numbers_business_idx on public.phone_numbers(business_id);
create trigger phone_numbers_updated_at
create table public.calls (
create index calls_business_created_idx on public.calls(business_id, created_at desc);
create index calls_business_state_idx on public.calls(business_id, state);
create index calls_conversation_idx on public.calls(conversation_id);
create trigger calls_updated_at
create table public.call_events (
create index call_events_business_at_idx on public.call_events(business_id, at desc);
create index call_events_latency_idx on public.call_events(business_id, type, at desc) where latency_ms is not null;
create table public.call_transcript_turns (
create index call_transcript_business_idx on public.call_transcript_turns(business_id);
create table public.conversation_outcomes (
create unique index conversation_outcomes_call_idx on public.conversation_outcomes(call_id) where call_id is not null;
create unique index conversation_outcomes_conversation_idx
create index conversation_outcomes_business_idx on public.conversation_outcomes(business_id, created_at desc);
create index conversation_outcomes_disposition_idx on public.conversation_outcomes(business_id, disposition);
create trigger conversation_outcomes_updated_at
create table public.phone_suppressions (
create or replace function public.assert_voice_row_ownership()
create trigger phone_numbers_ownership
create trigger calls_ownership
create trigger conversation_outcomes_ownership
create or replace function public.assert_call_child_ownership()
create trigger call_events_ownership
create trigger call_transcript_ownership
create trigger phone_suppressions_ownership
create or replace function public.enforce_call_state_transition()
create trigger calls_state_transition
revoke execute on function public.assert_voice_row_ownership() from public, anon, authenticated;
revoke execute on function public.assert_call_child_ownership() from public, anon, authenticated;
revoke execute on function public.enforce_call_state_transition() from public, anon, authenticated;
alter table public.usage_events
drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
create or replace function public.purge_expired_data()
revoke execute on function public.purge_expired_data() from public, anon, authenticated;
grant  execute on function public.purge_expired_data() to service_role;
alter table public.phone_numbers          enable row level security;
alter table public.calls                  enable row level security;
alter table public.call_events            enable row level security;
alter table public.call_transcript_turns  enable row level security;
alter table public.conversation_outcomes  enable row level security;
alter table public.phone_suppressions     enable row level security;
create policy "members read phone numbers" on public.phone_numbers
create policy "members read calls" on public.calls
create policy "members read call events" on public.call_events
create policy "members read call transcripts" on public.call_transcript_turns
create policy "members read conversation outcomes" on public.conversation_outcomes
create policy "members read phone suppressions" on public.phone_suppressions
```


### 0021_business_creation_provisions_agent.sql

```sql
create or replace function public.create_business_with_owner(
revoke execute on function public.create_business_with_owner(text, text) from public, anon;
grant  execute on function public.create_business_with_owner(text, text) to authenticated;
```


### 0022_backfill_agents_created_after_0014.sql

```sql

```


### 0023_voice_latency_marks.sql

```sql
alter table public.call_events drop constraint if exists call_events_type_check;
alter table public.call_events
```


### 0024_lead_lifecycle.sql

```sql
alter table public.customers add column lead_state text not null default 'NEW';
alter table public.customers add constraint customers_lead_state_check check (lead_state in ('NEW','CONTACTING','CONNECTED','QUALIFYING','QUALIFIED','UNQUALIFIED','APPOINTMENT_PENDING','APPOINTMENT_BOOKED','FOLLOW_UP_REQUIRED','NURTURE','CONVERTED','LOST','DO_NOT_CONTACT'));
alter table public.customers add constraint customers_id_business_unique unique (id, business_id);
create table public.lead_state_events (
create index lead_state_events_customer_idx on public.lead_state_events(business_id,customer_id,created_at);
alter table public.lead_state_events enable row level security;
create policy lead_state_events_read on public.lead_state_events for select to authenticated using (public.is_business_member(business_id));
revoke all on public.lead_state_events from anon, authenticated;
grant select on public.lead_state_events to authenticated;
grant all on public.lead_state_events to service_role;
create function public.lead_transition_allowed(old_state text,new_state text) returns boolean
create function public.guard_lead_transition() returns trigger language plpgsql set search_path = public as $$
create trigger customers_lead_transition before update of lead_state on public.customers
create function public.transition_lead(p_business_id uuid,p_customer_id uuid,p_event_key text,p_to_state text,p_reason text)
revoke all on function public.transition_lead(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.transition_lead(uuid,uuid,text,text,text) to service_role;
```


### 0025_campaigns.sql

```sql
create table public.campaigns (
create table public.campaign_contacts (
create index campaign_contacts_due_idx on public.campaign_contacts(business_id,campaign_id,due_at) where state='pending';
create table public.campaign_events (
alter table public.campaigns enable row level security;
alter table public.campaign_contacts enable row level security;
alter table public.campaign_events enable row level security;
create policy campaigns_read on public.campaigns for select to authenticated using(public.is_business_member(business_id));
create policy campaign_contacts_read on public.campaign_contacts for select to authenticated using(public.is_business_member(business_id));
create policy campaign_events_read on public.campaign_events for select to authenticated using(public.is_business_member(business_id));
revoke all on public.campaigns,public.campaign_contacts,public.campaign_events from anon,authenticated;
grant select on public.campaigns,public.campaign_contacts,public.campaign_events to authenticated;
grant all on public.campaigns,public.campaign_contacts,public.campaign_events to service_role;
grant usage,select on sequence public.campaign_events_id_seq to service_role;
create function public.guard_campaign() returns trigger language plpgsql set search_path=public as $$
create trigger campaigns_guard before insert or update on public.campaigns for each row execute function public.guard_campaign();
create function public.campaign_contact_eligible(p_business_id uuid,p_contact_id uuid) returns boolean
create function public.claim_campaign_contacts(p_business_id uuid,p_campaign_id uuid,p_limit integer default 10)
revoke all on function public.campaign_contact_eligible(uuid,uuid),public.claim_campaign_contacts(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.campaign_contact_eligible(uuid,uuid),public.claim_campaign_contacts(uuid,uuid,integer) to service_role;
create function public.settle_campaign_contact(p_business_id uuid,p_contact_id uuid,p_attempt integer,p_status text,p_retryable boolean,p_provider_call_id text default null)
revoke all on function public.settle_campaign_contact(uuid,uuid,integer,text,boolean,text) from public,anon,authenticated;
grant execute on function public.settle_campaign_contact(uuid,uuid,integer,text,boolean,text) to service_role;
create function public.complete_campaign_contact(p_business_id uuid,p_contact_id uuid,p_attempt integer,p_provider_call_id text,p_outcome text,p_followup_at timestamptz default null)
revoke all on function public.complete_campaign_contact(uuid,uuid,integer,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.complete_campaign_contact(uuid,uuid,integer,text,text,timestamptz) to service_role;
create function public.guard_campaign_contact() returns trigger language plpgsql set search_path=public as $$
create trigger campaign_contact_guard before insert or update on public.campaign_contacts
create unique index campaign_one_active_contact on public.campaign_contacts(business_id,customer_id)
```


### 0026_runtime_call_events.sql

```sql
alter table public.call_events drop constraint call_events_type_check;
alter table public.call_events add constraint call_events_type_check check (type in (
```


### 0027_learning_proposals.sql

```sql
create table public.learning_proposals (
alter table public.learning_proposals enable row level security;
create policy learning_proposals_read on public.learning_proposals for select to authenticated using(public.is_business_member(business_id));
revoke all on public.learning_proposals from anon,authenticated;
grant select on public.learning_proposals to authenticated;
grant all on public.learning_proposals to service_role;
create function public.guard_learning_proposal() returns trigger language plpgsql set search_path=public as $$
create trigger learning_proposal_guard before insert or update on public.learning_proposals for each row execute function public.guard_learning_proposal();
create function public.evaluate_learning_proposal(p_business_id uuid,p_id uuid,p_corpus text,p_passed integer,p_total integer)
revoke all on function public.evaluate_learning_proposal(uuid,uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.evaluate_learning_proposal(uuid,uuid,text,integer,integer) to service_role;
create function public.review_learning_proposal(p_business_id uuid,p_id uuid,p_approve boolean)
revoke all on function public.review_learning_proposal(uuid,uuid,boolean) from public,anon;
grant execute on function public.review_learning_proposal(uuid,uuid,boolean) to authenticated;
```


### 0028_call_lead_outcomes.sql

```sql
create function public.apply_call_lead_outcome(p_business_id uuid,p_customer_id uuid,p_call_id uuid)
revoke all on function public.apply_call_lead_outcome(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.apply_call_lead_outcome(uuid,uuid,uuid) to service_role;
create or replace function public.guard_lead_transition() returns trigger language plpgsql set search_path = public as $$
```


### 0029_campaign_call_binding.sql

```sql
create function public.create_campaign_call() returns trigger language plpgsql security definer set search_path=public as $$
create trigger campaign_call_binding after update on public.campaign_contacts for each row execute function public.create_campaign_call();
create function public.bind_campaign_callback(p_contact_id uuid,p_attempt integer,p_provider text,p_provider_call_id text,p_from text,p_to text)
revoke all on function public.bind_campaign_callback(uuid,integer,text,text,text,text) from public,anon,authenticated;
grant execute on function public.bind_campaign_callback(uuid,integer,text,text,text,text) to service_role;
create function public.apply_campaign_call_outcome() returns trigger language plpgsql security definer set search_path=public as $$
create trigger campaign_business_outcome after insert on public.conversation_outcomes for each row execute function public.apply_campaign_call_outcome();
create trigger campaign_carrier_outcome after update of state on public.calls for each row execute function public.apply_campaign_call_outcome();
alter table public.campaigns add column last_dispatched_at timestamptz;
create function public.schedule_campaign_batch(p_limit integer default 20)
revoke all on function public.schedule_campaign_batch(integer) from public,anon,authenticated;
grant execute on function public.schedule_campaign_batch(integer) to service_role;
```


### 0030_production_version_guards.sql

```sql
create function public.guard_production_version() returns trigger language plpgsql security definer set search_path=public as $$
create trigger agents_production_version before insert or update of live_version_id on public.agents for each row execute function public.guard_production_version();
create trigger calls_production_version before insert or update on public.calls for each row execute function public.guard_production_version();
create trigger conversations_production_version before insert or update of business_id,agent_id,agent_version_id on public.conversations for each row execute function public.guard_production_version();
create trigger outcomes_production_version before insert or update on public.conversation_outcomes for each row execute function public.guard_production_version();
revoke all on function public.guard_production_version() from public,anon,authenticated;
create function public.begin_call_conversation(p_business_id uuid,p_call_id uuid)
revoke all on function public.begin_call_conversation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_call_conversation(uuid,uuid) to service_role;
create function public.persist_outcome_safety() returns trigger language plpgsql security definer set search_path=public as $$
create trigger outcome_safety after insert on public.conversation_outcomes for each row execute function public.persist_outcome_safety();
revoke all on function public.persist_outcome_safety() from public,anon,authenticated;
```


### 0031_conversation_identity_insert_guard.sql

```sql
create or replace function public.enforce_conversation_identity()
drop trigger if exists conversations_identity_guard on public.conversations;
create trigger conversations_identity_guard
revoke all on function public.enforce_conversation_identity() from public, anon, authenticated;
```


### 0032_tool_executions.sql

```sql
create table public.tool_executions (
create index tool_executions_business_requested_idx on public.tool_executions (business_id, requested_at desc);
create index tool_executions_conversation_idx on public.tool_executions (conversation_id, requested_at);
create unique index tool_executions_one_execution_per_action
create or replace function public.assert_tool_execution_ownership()
create trigger tool_executions_ownership
create or replace function public.enforce_tool_execution_lifecycle()
create trigger tool_executions_lifecycle
revoke execute on function public.assert_tool_execution_ownership() from public, anon, authenticated;
revoke execute on function public.enforce_tool_execution_lifecycle() from public, anon, authenticated;
alter table public.tool_executions enable row level security;
create policy tool_executions_read on public.tool_executions
revoke all on public.tool_executions from anon, authenticated;
grant select on public.tool_executions to authenticated;
grant all on public.tool_executions to service_role;
```


### 0033_knowledge_governance.sql

```sql
alter table public.knowledge_collections
alter table public.knowledge_documents
alter table public.faqs
alter table public.knowledge_documents
alter table public.knowledge_chunks
alter table public.knowledge_documents validate constraint knowledge_documents_collection_tenant_fk;
alter table public.knowledge_chunks validate constraint knowledge_chunks_document_tenant_fk;
create table public.knowledge_document_revisions (
create index knowledge_document_revisions_document_idx
create index knowledge_document_revisions_review_idx
create unique index knowledge_document_revisions_one_approved
create table public.faq_revisions (
create index faq_revisions_faq_idx on public.faq_revisions (faq_id, revision desc);
create index faq_revisions_review_idx on public.faq_revisions (business_id, state);
create index faq_revisions_tsv_idx on public.faq_revisions using gin (content_tsv);
create unique index faq_revisions_one_approved on public.faq_revisions (faq_id) where state = 'approved';
alter table public.knowledge_documents add column published_revision_id uuid;
alter table public.knowledge_documents
alter table public.faqs add column published_revision_id uuid;
alter table public.faqs
alter table public.faqs alter column is_published set default false;
alter table public.knowledge_chunks add column revision_id uuid;
alter table public.knowledge_chunks
alter table public.knowledge_chunks
create index knowledge_chunks_revision_idx on public.knowledge_chunks (revision_id);
create or replace function public.knowledge_content_sha256(value text)
create or replace function public.is_knowledge_approver(target_business_id uuid, actor uuid)
create or replace function public.enforce_knowledge_document_revision()
create trigger knowledge_document_revisions_integrity
create or replace function public.enforce_faq_revision()
create trigger faq_revisions_integrity
create or replace function public.enforce_knowledge_chunk()
create trigger knowledge_chunks_integrity
create or replace function public.enforce_knowledge_document()
create trigger knowledge_documents_governance
create or replace function public.enforce_faq()
create trigger faqs_governance
create or replace function public.check_knowledge_publication()
create constraint trigger knowledge_document_revisions_publication
create constraint trigger knowledge_documents_publication
create constraint trigger faq_revisions_publication
create constraint trigger faqs_publication
create or replace function public.knowledge_require_member(target_business_id uuid)
create or replace function public.knowledge_require_approver(target_business_id uuid)
create or replace function public.knowledge_create_document_revision(
create or replace function public.knowledge_submit_revision(p_revision_id uuid)
create or replace function public.knowledge_review_revision(p_revision_id uuid, p_approve boolean)
create or replace function public.knowledge_withdraw_document(p_document_id uuid)
create or replace function public.faq_create_revision(
create or replace function public.faq_review_revision(p_revision_id uuid, p_approve boolean)
create or replace function public.faq_withdraw(p_faq_id uuid)
create or replace function public.knowledge_begin_indexing(p_business_id uuid, p_document_id uuid, p_revision_id uuid)
create or replace function public.knowledge_finish_indexing(
create or replace function public.knowledge_assert_scope(target_business_id uuid, allowed_collection_ids uuid[])
create or replace function public.search_governed_knowledge(
create or replace function public.match_governed_knowledge_chunks(
create or replace function public.search_knowledge(
create or replace function public.match_knowledge_chunks(
create or replace function public.knowledge_governance_census(p_business_id uuid default null)
create or replace function public.knowledge_backfill_legacy(p_business_id uuid, p_apply boolean default false)
alter table public.knowledge_document_revisions enable row level security;
alter table public.faq_revisions enable row level security;
create policy knowledge_document_revisions_read on public.knowledge_document_revisions
create policy faq_revisions_read on public.faq_revisions
revoke all on public.knowledge_document_revisions from public, anon, authenticated, service_role;
revoke all on public.faq_revisions from public, anon, authenticated, service_role;
grant select on public.knowledge_document_revisions to authenticated, service_role;
grant select on public.faq_revisions to authenticated, service_role;
revoke insert, update on public.knowledge_documents from anon, authenticated;
revoke insert, update on public.faqs from anon, authenticated;
drop policy if exists "members write documents" on public.knowledge_documents;
drop policy if exists "members update documents" on public.knowledge_documents;
drop policy if exists "members delete documents" on public.knowledge_documents;
drop policy if exists "members write faqs" on public.faqs;
drop policy if exists "members update faqs" on public.faqs;
drop policy if exists "members delete faqs" on public.faqs;
create policy "admins delete unpublished documents" on public.knowledge_documents
create policy "admins delete unpublished faqs" on public.faqs
revoke insert, update, delete on public.knowledge_chunks from anon, authenticated;
revoke update on public.knowledge_chunks from service_role;
drop policy if exists "members write chunks" on public.knowledge_chunks;
drop policy if exists "members delete chunks" on public.knowledge_chunks;
revoke execute on function public.knowledge_content_sha256(text) from public, anon, authenticated;
revoke execute on function public.is_knowledge_approver(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.enforce_knowledge_document_revision() from public, anon, authenticated;
revoke execute on function public.enforce_faq_revision() from public, anon, authenticated;
revoke execute on function public.enforce_knowledge_chunk() from public, anon, authenticated;
revoke execute on function public.enforce_knowledge_document() from public, anon, authenticated;
revoke execute on function public.enforce_faq() from public, anon, authenticated;
revoke execute on function public.check_knowledge_publication() from public, anon, authenticated;
revoke execute on function public.knowledge_require_member(uuid) from public, anon, authenticated;
revoke execute on function public.knowledge_require_approver(uuid) from public, anon, authenticated;
revoke execute on function public.knowledge_create_document_revision(uuid, uuid, text, text, text, text, uuid) from public, anon;
revoke execute on function public.knowledge_submit_revision(uuid) from public, anon;
revoke execute on function public.knowledge_review_revision(uuid, boolean) from public, anon;
revoke execute on function public.knowledge_withdraw_document(uuid) from public, anon;
revoke execute on function public.faq_create_revision(uuid, uuid, text, text, text) from public, anon;
revoke execute on function public.faq_review_revision(uuid, boolean) from public, anon;
revoke execute on function public.faq_withdraw(uuid) from public, anon;
grant execute on function public.knowledge_create_document_revision(uuid, uuid, text, text, text, text, uuid) to authenticated;
grant execute on function public.knowledge_submit_revision(uuid) to authenticated;
grant execute on function public.knowledge_review_revision(uuid, boolean) to authenticated;
grant execute on function public.knowledge_withdraw_document(uuid) to authenticated;
grant execute on function public.faq_create_revision(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.faq_review_revision(uuid, boolean) to authenticated;
grant execute on function public.faq_withdraw(uuid) to authenticated;
revoke execute on function public.knowledge_begin_indexing(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.knowledge_finish_indexing(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.knowledge_assert_scope(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.search_governed_knowledge(uuid, text, uuid[], int) from public, anon, authenticated;
revoke execute on function public.match_governed_knowledge_chunks(uuid, vector, uuid[], int) from public, anon, authenticated;
revoke execute on function public.search_knowledge(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.match_knowledge_chunks(uuid, vector, int) from public, anon, authenticated;
revoke execute on function public.knowledge_governance_census(uuid) from public, anon, authenticated;
revoke execute on function public.knowledge_backfill_legacy(uuid, boolean) from public, anon, authenticated;
grant execute on function public.knowledge_begin_indexing(uuid, uuid, uuid) to service_role;
grant execute on function public.knowledge_finish_indexing(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.search_governed_knowledge(uuid, text, uuid[], int) to service_role;
grant execute on function public.match_governed_knowledge_chunks(uuid, vector, uuid[], int) to service_role;
grant execute on function public.search_knowledge(uuid, text, int) to service_role;
grant execute on function public.match_knowledge_chunks(uuid, vector, int) to service_role;
grant execute on function public.knowledge_governance_census(uuid) to service_role;
grant execute on function public.knowledge_backfill_legacy(uuid, boolean) to service_role;
```


### 0034_tenant_reference_integrity.sql

```sql
create or replace function public.assert_tenant_reference()
revoke execute on function public.assert_tenant_reference() from public, anon, authenticated;
create trigger agent_versions_tenant_reference
create trigger appointments_tenant_reference
create trigger leads_tenant_reference
create trigger appointment_feedback_tenant_reference
create trigger appointment_reminders_tenant_reference
create trigger intake_responses_tenant_reference
create trigger booking_drafts_tenant_reference
create trigger calendar_connections_tenant_reference
create trigger conversation_outcomes_tenant_reference
create trigger conversation_state_tenant_reference
create trigger conversations_tenant_reference
create trigger customer_timeline_tenant_reference
create trigger customers_tenant_reference
create trigger learning_proposals_tenant_reference
create trigger messages_tenant_reference
create trigger workflow_runs_tenant_reference
create or replace function public.tenant_reference_census()
revoke execute on function public.tenant_reference_census() from public, anon, authenticated;
grant execute on function public.tenant_reference_census() to service_role;
revoke execute on function public.apply_campaign_call_outcome() from public, anon, authenticated;
revoke execute on function public.create_campaign_call() from public, anon, authenticated;
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;
revoke all on all sequences in schema public from anon;
revoke update on all sequences in schema public from authenticated;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke update on sequences from authenticated;
```


## Failure detection and approval gates

For EVERY file: require exit 0, transaction commit plus exact ledger version/name, schema definition comparison (not merely object existence), expected grants/RLS/triggers and data reconciliation. Any disagreement means STOP and preserve evidence. A committed prefix is not undone by a later-file failure. Resume only after a separately reviewed recovery plan; see the failure table in [recovery](DATABASE_RECOVERY_RUNBOOK.md).

0001 requires D21 and actual extension/session/partial-attempt evidence. 0032 is locally authorized under D7; real application still requires target authorization. 0033 requires D14 ratification and planned knowledge outage. 0034 requires D22 adoption; mismatch correction and FK validation are separate authorized operations. R8/D19 and exact target authorization gate all real execution; D8 gates any cost (this workstream permits none).

### 0035_knowledge_backfill_source_ref_validation.sql

```sql
create or replace function public.knowledge_backfill_legacy(p_business_id uuid, p_apply boolean default false)
```

## 0035 execution and recovery detail

Run only after the recorded prefix through 0034 is reconciled; do not skip pending D14/D22 approvals to reach it. Preserve a backup and function-definition/ACL snapshot. Apply 0035 with its ledger row in one transaction; it replaces a function but transforms no existing data. Verify signature, fixed public path, SECURITY DEFINER, identical owner/OID/effective ACL, and the new quarantine branch. Test dry/apply on synthetic 499/500/501 fixtures before any authorized legacy operation. The local source/recovered-copy rehearsal and independent PG16 real-role harness pass this sequence; actual hosted runner/ledger behavior remains unverified.

A failed uncommitted transaction leaves the previous function intact. After commit, rolling app code back does not undo 0035; its function contract remains compatible. Do not restore the older buggy implementation as an operational rollback. For a new defect use a separately reviewed forward correction or a verified full restore with ledger reconciliation. Quarantined source remains available for human disposition; no source was deleted or truncated to recover.

### 0036_security_authorization_audit.sql

```sql
create table public.audit_logs
create index audit_logs_tenant_time on public.audit_logs
alter table public.audit_logs enable row level security
create policy audit_logs_read on public.audit_logs for select to authenticated
revoke all on public.audit_logs from public, anon, authenticated, service_role
grant select on public.audit_logs to authenticated
grant insert, select on public.audit_logs to service_role
alter table public.workflow_events add column telemetry_correlation_id uuid
alter table public.workflow_timers add column telemetry_correlation_id uuid
```

## 0036 execution and recovery detail

**Added 2026-10-15 by the local release-readiness audit**, because `scripts/check-rollout-docs.mjs` failed once WS4 added 0036 without a map row ([report](LOCAL_RELEASE_READINESS_REPORT.md)). The WS3 sections above are unchanged.

Run only after the recorded prefix through 0035 is reconciled, and only under a target authorization; WS4's D7/D18 approval covers local and disposable verification only ([WORKSTREAM_4_REPORT.md](WORKSTREAM_4_REPORT.md)). Apply with its ledger row in one transaction. It creates one table and two nullable columns and transforms no existing data. Verify the table's grants (authenticated SELECT; service_role INSERT/SELECT; nothing else for application roles), RLS enabled with the single membership policy, and both columns present. The application build that writes audit rows and serialized correlation must follow the schema, never precede it: mandatory pre-audit fails closed when the table is missing.

Rolling the application back does not undo 0036, and an older build ignores the table and columns. Do not drop a populated audit_logs table as a rollback: that discards security evidence. Local evidence: the full 0001–0036 chain, 669 real-role RLS assertions and the audit concurrency/HTTP harnesses passed on disposable databases (WS4). No hosted ledger, grant set or backup including audit rows is verified.
