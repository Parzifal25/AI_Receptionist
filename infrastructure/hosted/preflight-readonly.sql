-- ============================================================================
-- HALO hosted migration preflight — READ ONLY (docs/HOSTED_MIGRATION_RUNBOOK.md, step 2).
--
-- Run it with psql on the EXACT connection (role, host, pooler mode) that will
-- apply the migrations, after the target is authorized (R8, D19, D21):
--   psql "$TARGET_URL" -X -f infrastructure/hosted/preflight-readonly.sql
-- It prints facts; it changes nothing. Everything runs in a READ ONLY
-- transaction that is rolled back, to prevent ordinary persistent SQL writes; function bodies still require review.
-- Census functions are called only when they already exist on the target.
-- Output is counts and catalog facts only: no row content, no secrets.
-- Save the output to a file; scripts/compare-migration-ledger.mjs reads its
-- §5 lines offline. A section that did not print is NOT VERIFIED, not a pass.
-- Rehearsed on the real Supabase image by node scripts/check-rollout-rehearsal.mjs.
-- ============================================================================
\set ON_ERROR_STOP on
begin transaction isolation level repeatable read read only;

\echo '== 1. Session (extensions resolution required before 0001 with pgcrypto in extensions; see D21)'
select current_user, session_user, current_setting('server_version') as server_version,
       current_setting('search_path') as search_path,
       current_setting('search_path') ~ '(^|[ ,])"?extensions"?($|[ ,])' as search_path_has_extensions,
       current_setting('transaction_read_only') as read_only;

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
       exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.knowledge_backfill_legacy(uuid,boolean)')
         and position('quarantined_source_ref_too_long' in p.prosrc)>0) as has_0035,
       -- 0036 (WS4): the audit table plus both workflow telemetry columns.
       (to_regclass('public.audit_logs') is not null
         and exists(select 1 from pg_attribute where attrelid = to_regclass('public.workflow_events')
                      and attname = 'telemetry_correlation_id' and not attisdropped)
         and exists(select 1 from pg_attribute where attrelid = to_regclass('public.workflow_timers')
                      and attname = 'telemetry_correlation_id' and not attisdropped)) as has_0036,
       -- 0037 (P2-R1): the business-level calendar connection unique index.
       to_regclass('public.calendar_connections_business_level_unique') is not null as has_0037,
       (select count(*) from pg_tables where schemaname = 'public') as public_tables
\gset
select :'has_0001' as has_0001, :'has_0017' as has_0017, :'has_0032' as has_0032,
       :'has_0033' as has_0033, :'has_0034' as has_0034, :'has_0035' as has_0035, :'has_0036' as has_0036,
       :'has_0037' as has_0037,
       :'public_tables' as public_tables;
-- Machine-readable copy; the offline comparison checks it against the ledger.
select 'objects|0001=' || :'has_0001' || '|0017=' || :'has_0017' || '|0032=' || :'has_0032'
       || '|0033=' || :'has_0033' || '|0034=' || :'has_0034' || '|0035=' || :'has_0035'
       || '|0036=' || :'has_0036' || '|0037=' || :'has_0037' as objects_row;

\echo '== 4b. Ownership (STOP on unexpected owners; default ACL changes in 0034 are creator-specific)'
select r.rolname as owner,
       count(*) filter (where c.relkind in ('r', 'p')) as tables,
       count(*) filter (where c.relkind = 'S') as sequences
  from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner
 where n.nspname = 'public' and c.relkind in ('r', 'p', 'S')
 group by 1 order by 1;
select count(*) as public_objects_not_owned_by_current_user
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p', 'S')
   and c.relowner <> (select oid from pg_roles where rolname = current_user);

\echo '== 5. Migration ledger (compare offline: node scripts/compare-migration-ledger.mjs --preflight <this output>)'
select to_regclass('supabase_migrations.schema_migrations') is not null as ledger_exists \gset
\if :ledger_exists
  select 'ledger|empty' as ledger_row where not exists(select 1 from supabase_migrations.schema_migrations);
  select 'ledger|' || version || '|' || coalesce(name, '') as ledger_row
    from supabase_migrations.schema_migrations order by version;
\else
  select 'ledger|absent' as ledger_row;
\endif

\echo '== 6. Knowledge (0033 serves nothing pre-existing until it is re-reviewed)'
\if :has_0033
  select * from public.knowledge_governance_census();
  -- Before 0035 these abort apply despite a positive dry run. With 0035
  -- they are quarantined consistently. This count requires disposition, not
  -- automatic source truncation (KNOWLEDGE_ROLLOUT_RUNBOOK.md).
  select count(*) as legacy_documents_source_ref_over_500_backfill_aborts
    from public.knowledge_documents d
   where char_length(d.source_ref) > 500
     and not exists (select 1 from public.knowledge_document_revisions r where r.document_id = d.id);
\elif :has_0017
  select (select count(*) from public.knowledge_documents d
            join public.knowledge_collections c on c.id = d.collection_id
           where c.business_id <> d.business_id) as document_collection_tenant_mismatches,
         (select count(*) from public.knowledge_chunks k
            join public.knowledge_documents d on d.id = k.document_id
           where d.business_id <> k.business_id) as chunk_document_tenant_mismatches,
         (select count(*) from public.knowledge_documents) as documents_that_stop_serving,
         (select count(*) from public.faqs) as faqs_that_stop_serving;
  -- What 0033's knowledge_backfill_legacy() will do with them.
  select (select count(*) from public.knowledge_documents where btrim(content) = '' or char_length(content) > 100000)
           as documents_quarantined_unusable_content,
         (select count(*) from public.knowledge_documents where source_type <> 'manual' and source_ref = '')
           as documents_quarantined_missing_source,
         (select count(*) from public.knowledge_documents where char_length(source_ref) > 500)
           as documents_source_ref_over_500_backfill_aborts,
         (select count(*) from public.faqs where char_length(category) > 100) as faqs_quarantined_category_over_100,
         (select count(*) from public.knowledge_chunks where embedding is not null) as legacy_chunks_with_embedding;
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
select count(*) filter (where x.grantee = 'anon'::regrole) as anon_sequence_privileges,
       count(*) filter (where x.grantee = 'authenticated'::regrole and x.privilege_type = 'UPDATE') as authenticated_sequence_update
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) x
 where n.nspname = 'public' and c.relkind = 'S';
-- Default privileges per creating role. 0034 changes only those of the role
-- that runs it; rows for other roles (for example supabase_admin) are
-- expected to stay nonzero and matter only for objects that role creates.
select pg_get_userbyid(d.defaclrole) as defaults_of_role,
       count(*) filter (where d.defaclobjtype = 'r' and x.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'))
         as client_table_defaults_0034_revokes,
       count(*) filter (where d.defaclobjtype = 'S' and x.grantee = 'anon'::regrole) as anon_sequence_defaults
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) x
 where n.nspname = 'public' and x.grantee in ('anon'::regrole, 'authenticated'::regrole)
 group by 1 order by 1;

\echo '== 9. Knowledge serving state (after 0033; re-run after authorized backfill, indexing and review)'
\if :has_0033
  select (select count(*) from public.knowledge_documents where published_revision_id is not null) as documents_served,
         (select count(*) from public.faqs where published_revision_id is not null) as faqs_served,
         (select count(*) from public.knowledge_document_revisions where state = 'draft' and origin = 'legacy_backfill')
           as backfilled_drafts_awaiting_indexing,
         (select count(*) from public.knowledge_document_revisions where state = 'draft' and index_status = 'failed')
           as drafts_index_failed,
         (select count(*) from public.knowledge_document_revisions where state = 'pending_review')
           + (select count(*) from public.faq_revisions where state = 'pending_review') as revisions_pending_review,
         (select count(*) from public.knowledge_chunks k
            join public.knowledge_document_revisions r on r.id = k.revision_id
           where r.state = 'approved' and k.embedding is null) as served_chunks_without_embedding,
         (select count(*) from pg_constraint
           where conname in ('knowledge_documents_collection_tenant_fk', 'knowledge_chunks_document_tenant_fk')
             and not convalidated) as knowledge_composite_fks_not_valid;
\else
  select 'no 0033 yet' as knowledge_serving;
\endif

\echo '== 10. Calendar connections (0037 aborts while duplicate business-level groups exist; resolve under separate authorization, never automatically)'
\if :has_0001
  select count(*) as calendar_business_level_duplicate_groups
    from (select 1 from public.calendar_connections where staff_id is null
           group by business_id, provider having count(*) > 1) d;
\else
  select 'no 0001 yet' as calendar_connections;
\endif

rollback;
\echo preflight|complete
