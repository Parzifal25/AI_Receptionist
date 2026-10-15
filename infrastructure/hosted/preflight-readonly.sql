-- ============================================================================
-- HALO hosted migration preflight — READ ONLY (docs/HOSTED_MIGRATION_RUNBOOK.md, step 2).
--
-- Run it with psql on the EXACT connection (role, host, pooler mode) that will
-- apply the migrations, after the target is authorized (R8, D19, D21):
--   psql "$TARGET_URL" -X -f infrastructure/hosted/preflight-readonly.sql
-- It prints facts; it changes nothing. Everything runs in a READ ONLY
-- transaction that is rolled back, so even a mistaken statement cannot write.
-- Census functions are called only when they already exist on the target.
-- Output is counts and catalog facts only: no row content, no secrets.
-- ============================================================================
\set ON_ERROR_STOP on
begin transaction isolation level repeatable read read only;

\echo '== 1. Session (search_path MUST include extensions; see D21)'
select current_user, session_user, current_setting('server_version') as server_version,
       current_setting('search_path') as search_path,
       current_setting('search_path') ~ '(^|[ ,])"?extensions"?($|[ ,])' as search_path_has_extensions;

\echo '== 2. Extensions (STOP if vector is installed in schema extensions before 0001 runs)'
select e.extname, n.nspname as schema, e.extversion
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
 where e.extname in ('pgcrypto', 'vector', 'btree_gist')
 order by 1;
select coalesce(bool_or(e.extname = 'vector' and n.nspname <> 'public'), false) as stop_vector_outside_public
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace;

\echo '== 3. Platform objects the chain needs'
select to_regclass('storage.buckets') is not null as storage_buckets,
       to_regclass('storage.objects') is not null as storage_objects,
       to_regprocedure('auth.uid()') is not null as auth_uid,
       (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) = 3 as client_roles;

\echo '== 4. HALO objects already present (all false = fresh database)'
select to_regclass('public.businesses') is not null as has_0001,
       to_regclass('public.knowledge_collections') is not null as has_0017,
       to_regclass('public.tool_executions') is not null as has_0032,
       to_regclass('public.knowledge_document_revisions') is not null as has_0033,
       to_regprocedure('public.tenant_reference_census()') is not null as has_0034,
       (select count(*) from pg_tables where schemaname = 'public') as public_tables
\gset
select :'has_0001' as has_0001, :'has_0017' as has_0017, :'has_0032' as has_0032,
       :'has_0033' as has_0033, :'has_0034' as has_0034, :'public_tables' as public_tables;

\echo '== 5. Migration ledger (compare version and name with supabase/migrations/)'
select to_regclass('supabase_migrations.schema_migrations') is not null as ledger_exists \gset
\if :ledger_exists
  select version, name from supabase_migrations.schema_migrations order by version;
\else
  select 'no supabase_migrations.schema_migrations table' as ledger;
\endif

\echo '== 6. Knowledge (0033 serves nothing pre-existing until it is re-reviewed)'
\if :has_0033
  select * from public.knowledge_governance_census();
\elif :has_0017
  select (select count(*) from public.knowledge_documents d
            join public.knowledge_collections c on c.id = d.collection_id
           where c.business_id <> d.business_id) as document_collection_tenant_mismatches,
         (select count(*) from public.knowledge_chunks k
            join public.knowledge_documents d on d.id = k.document_id
           where d.business_id <> k.business_id) as chunk_document_tenant_mismatches,
         (select count(*) from public.knowledge_documents) as documents_that_stop_serving,
         (select count(*) from public.faqs) as faqs_that_stop_serving;
\else
  select 'no knowledge tables yet' as knowledge;
\endif

\echo '== 7. Tenant references (0034 checks new writes only; mismatches must be dispositioned, never auto-repaired)'
\if :has_0034
  select * from public.tenant_reference_census();
\elif :has_0001
  -- The same column pairs 0034 guards; a pair whose tables do not exist yet is skipped.
  with p(table_name, column_name, referenced_table) as (values
      ('agent_versions', 'agent_id', 'agents'),
      ('appointments', 'staff_id', 'staff_members'),
      ('appointments', 'conversation_id', 'conversations'),
      ('appointments', 'lead_id', 'leads'),
      ('leads', 'conversation_id', 'conversations'),
      ('appointment_feedback', 'appointment_id', 'appointments'),
      ('appointment_reminders', 'appointment_id', 'appointments'),
      ('intake_responses', 'appointment_id', 'appointments'),
      ('booking_drafts', 'conversation_id', 'conversations'),
      ('calendar_connections', 'staff_id', 'staff_members'),
      ('conversation_outcomes', 'appointment_id', 'appointments'),
      ('conversation_state', 'conversation_id', 'conversations'),
      ('conversations', 'receptionist_id', 'receptionists'),
      ('customer_timeline', 'customer_id', 'customers'),
      ('customers', 'merged_into', 'customers'),
      ('learning_proposals', 'draft_version_id', 'agent_versions'),
      ('messages', 'conversation_id', 'conversations'),
      ('workflow_runs', 'workflow_id', 'workflows'),
      ('workflow_runs', 'event_id', 'workflow_events'))
  select p.table_name, p.column_name, p.referenced_table,
         (xpath('/row/n/text()', query_to_xml(format(
           'select count(*) as n from public.%I r join public.%I p on p.id = r.%I where p.business_id is distinct from r.business_id',
           p.table_name, p.referenced_table, p.column_name), false, true, '')))[1]::text::bigint as mismatched
    from p
   where to_regclass('public.' || p.table_name) is not null
     and to_regclass('public.' || p.referenced_table) is not null
     and exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = p.table_name and c.column_name = p.column_name)
   order by 1, 2;
\else
  select 'no HALO tables yet' as tenant_references;
\endif

\echo '== 8. Client privileges 0034 revokes (expected nonzero before 0034, zero after)'
select count(*) filter (where privilege_type = 'TRUNCATE') as client_truncate_grants,
       count(*) filter (where privilege_type in ('REFERENCES', 'TRIGGER')) as client_references_trigger_grants
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'authenticated');

rollback;
