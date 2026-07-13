-- ============================================================================
-- Data retention.
--
-- Each business chooses how long to keep conversational data
-- (business_settings.data_retention_days, 30–3650). This function deletes
-- everything older than that threshold, per tenant, in one pass. Deleting a
-- conversation cascades to its messages and nulls its leads' conversation_id
-- (leads themselves are retained — they're the business's CRM records).
--
-- Runs on the service role from a scheduled route; never exposed to clients.
-- ============================================================================

create or replace function public.purge_expired_data()
returns table (deleted_conversations bigint, deleted_events bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  conv_count bigint;
  event_count bigint;
begin
  with settings as (
    select business_id, data_retention_days from public.business_settings
  ),
  deleted as (
    delete from public.conversations c
    using settings s
    where c.business_id = s.business_id
      and c.started_at < now() - make_interval(days => s.data_retention_days)
    returning c.id
  )
  select count(*) into conv_count from deleted;

  with settings as (
    select business_id, data_retention_days from public.business_settings
  ),
  deleted as (
    delete from public.usage_events e
    using settings s
    where e.business_id = s.business_id
      and e.created_at < now() - make_interval(days => s.data_retention_days)
    returning e.id
  )
  select count(*) into event_count from deleted;

  return query select conv_count, event_count;
end;
$$;

revoke execute on function public.purge_expired_data() from public, anon, authenticated;
grant  execute on function public.purge_expired_data() to service_role;
