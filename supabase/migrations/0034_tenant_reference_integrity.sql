-- ============================================================================
-- 0034 — Tenant reference integrity and client privilege hardening
-- (Phase 2, Workstream 1: prove tenant isolation).
--
-- Additive only: no table, column or existing function changes.
--
-- 1. Cross-tenant references. RLS checks only a row's own business_id, and a
--    plain foreign key checks only that the parent exists. Before this
--    migration, verified as real roles on a disposable database:
--      - a tenant admin could insert an agent version under another tenant's
--        agent (agent_versions is unique on (agent_id, version), so it could
--        squat that tenant's version numbers);
--      - a tenant member could point their own appointment at another
--        tenant's staff member, conversation or lead. The no-overlap
--        exclusion constraint is keyed on (staff_id, time) across tenants,
--        so this could block the other tenant's real bookings;
--      - a tenant member could link a lead to another tenant's conversation;
--      - for service-role writers, nothing in the database stopped a row
--        referencing another tenant's parent in 15 further columns.
--    One generic trigger now checks, for each listed column, that the
--    referenced row belongs to the same business. It runs BEFORE the row is
--    written, so it also precedes unique and exclusion checks. Older
--    dedicated guards (0018, 0020, 0021, 0025, 0027, 0032) are unchanged.
--    Existing rows are not rewritten: tenant_reference_census() reports any
--    pre-existing mismatch for review.
--
-- 2. Client privileges. Supabase grants anon and authenticated ALL on every
--    new public table, function and sequence (pg_default_acl on the
--    supabase/postgres image). 0001 intended authenticated to hold only
--    SELECT/INSERT/UPDATE/DELETE. Clients therefore also held:
--      - TRUNCATE, which ignores RLS and empties every tenant's rows;
--      - REFERENCES and TRIGGER;
--      - MAINTAIN (PostgreSQL 17), which allows LOCK TABLE;
--      - sequence USAGE/UPDATE (setval).
--    PostgREST exposes none of these verbs, but no client needs them. They
--    are revoked here and for tables created later by the same role. Two
--    SECURITY DEFINER trigger functions from 0029 are also closed to
--    clients, like every other trigger function.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Generic same-tenant reference check.
--    Trigger arguments are pairs: <column>, <referenced table>. Every
--    referenced table has a uuid `id` and a `business_id`.
-- ---------------------------------------------------------------------------
create or replace function public.assert_tenant_reference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  i int := 0;
  col text;
  parent text;
  ref_id text;
  owner uuid;
  next_row jsonb := to_jsonb(new);
  prev_row jsonb;
begin
  if tg_op = 'UPDATE' then
    prev_row := to_jsonb(old);
  end if;
  while i < tg_nargs loop
    col := tg_argv[i];
    parent := tg_argv[i + 1];
    i := i + 2;
    ref_id := next_row ->> col;
    continue when ref_id is null;
    -- An update that keeps both the reference and the tenant was already checked.
    if prev_row is not null
       and (prev_row ->> col) is not distinct from ref_id
       and (prev_row ->> 'business_id') is not distinct from (next_row ->> 'business_id') then
      continue;
    end if;
    execute format('select business_id from public.%I where id = $1::uuid', parent) into owner using ref_id;
    if owner is null or owner::text is distinct from (next_row ->> 'business_id') then
      raise exception using
        errcode = '23514',
        message = format('%s.%s must reference a row of %s in the same business', tg_table_name, col, parent);
    end if;
  end loop;
  return new;
end;
$$;

revoke execute on function public.assert_tenant_reference() from public, anon, authenticated;

-- Client-writable today (RLS write policies exist): agent_versions (admin
-- insert), appointments and leads (member update).
create trigger agent_versions_tenant_reference
  before insert or update of business_id, agent_id on public.agent_versions
  for each row execute function public.assert_tenant_reference('agent_id', 'agents');
create trigger appointments_tenant_reference
  before insert or update of business_id, staff_id, conversation_id, lead_id on public.appointments
  for each row execute function public.assert_tenant_reference('staff_id', 'staff_members', 'conversation_id', 'conversations', 'lead_id', 'leads');
create trigger leads_tenant_reference
  before insert or update of business_id, conversation_id on public.leads
  for each row execute function public.assert_tenant_reference('conversation_id', 'conversations');

-- Service-role writers only: the database now holds the invariant itself.
create trigger appointment_feedback_tenant_reference
  before insert or update of business_id, appointment_id on public.appointment_feedback
  for each row execute function public.assert_tenant_reference('appointment_id', 'appointments');
create trigger appointment_reminders_tenant_reference
  before insert or update of business_id, appointment_id on public.appointment_reminders
  for each row execute function public.assert_tenant_reference('appointment_id', 'appointments');
create trigger intake_responses_tenant_reference
  before insert or update of business_id, appointment_id on public.intake_responses
  for each row execute function public.assert_tenant_reference('appointment_id', 'appointments');
create trigger booking_drafts_tenant_reference
  before insert or update of business_id, conversation_id on public.booking_drafts
  for each row execute function public.assert_tenant_reference('conversation_id', 'conversations');
create trigger calendar_connections_tenant_reference
  before insert or update of business_id, staff_id on public.calendar_connections
  for each row execute function public.assert_tenant_reference('staff_id', 'staff_members');
create trigger conversation_outcomes_tenant_reference
  before insert or update of business_id, appointment_id on public.conversation_outcomes
  for each row execute function public.assert_tenant_reference('appointment_id', 'appointments');
create trigger conversation_state_tenant_reference
  before insert or update of business_id, conversation_id on public.conversation_state
  for each row execute function public.assert_tenant_reference('conversation_id', 'conversations');
create trigger conversations_tenant_reference
  before insert or update of business_id, receptionist_id on public.conversations
  for each row execute function public.assert_tenant_reference('receptionist_id', 'receptionists');
create trigger customer_timeline_tenant_reference
  before insert or update of business_id, customer_id on public.customer_timeline
  for each row execute function public.assert_tenant_reference('customer_id', 'customers');
create trigger customers_tenant_reference
  before insert or update of business_id, merged_into on public.customers
  for each row execute function public.assert_tenant_reference('merged_into', 'customers');
create trigger learning_proposals_tenant_reference
  before insert or update of business_id, draft_version_id on public.learning_proposals
  for each row execute function public.assert_tenant_reference('draft_version_id', 'agent_versions');
create trigger messages_tenant_reference
  before insert or update of business_id, conversation_id on public.messages
  for each row execute function public.assert_tenant_reference('conversation_id', 'conversations');
create trigger workflow_runs_tenant_reference
  before insert or update of business_id, workflow_id, event_id on public.workflow_runs
  for each row execute function public.assert_tenant_reference('workflow_id', 'workflows', 'event_id', 'workflow_events');

-- ---------------------------------------------------------------------------
-- Census of pre-existing mismatches (the triggers check only new writes).
-- Read-only; service role only; one row per checked column.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_reference_census()
returns table (table_name text, column_name text, referenced_table text, mismatched bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t record;
  args text[];
  i int;
begin
  for t in
    select c.relname::text as tbl, string_to_array(encode(g.tgargs, 'escape'), '\000') as argv
    from pg_trigger g
    join pg_class c on c.oid = g.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not g.tgisinternal
      and g.tgfoid = 'public.assert_tenant_reference()'::regprocedure
    order by 1
  loop
    args := array_remove(t.argv, '');
    i := 1;
    while i < coalesce(array_length(args, 1), 0) loop
      table_name := t.tbl;
      column_name := args[i];
      referenced_table := args[i + 1];
      execute format(
        'select count(*) from public.%I r join public.%I p on p.id = r.%I where p.business_id is distinct from r.business_id',
        table_name, referenced_table, column_name)
        into mismatched;
      if mismatched > 0 then
        return next;
      end if;
      i := i + 2;
    end loop;
  end loop;
end;
$$;

revoke execute on function public.tenant_reference_census() from public, anon, authenticated;
grant execute on function public.tenant_reference_census() to service_role;

-- 0029's SECURITY DEFINER trigger functions: closed to clients like every
-- other trigger function (they cannot be called directly, but no client
-- needs EXECUTE on them).
revoke execute on function public.apply_campaign_call_outcome() from public, anon, authenticated;
revoke execute on function public.create_campaign_call() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Client privileges: no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any
--    public table; no sequence access for anon; no setval for authenticated.
--    Default privileges cover tables and sequences this role creates later.
-- ---------------------------------------------------------------------------
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;

do $$
begin
  -- MAINTAIN exists from PostgreSQL 17 (hosted Supabase); CI runs 16.
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on all tables in schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke maintain on tables from anon, authenticated';
  end if;
end;
$$;

revoke all on all sequences in schema public from anon;
revoke update on all sequences in schema public from authenticated;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke update on sequences from authenticated;
