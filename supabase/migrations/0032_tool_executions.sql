-- ============================================================================
-- D7 — tool-execution audit (blueprint §22 `tool_executions`).
--
-- One row per model-proposed tool call that reaches the agent runtime's tool
-- boundary (packages/runtime/tools/audit.ts):
--   rejected   refused before execution (unknown tool, invalid arguments,
--              budget, or an authorization denial). Inserted final.
--   started    inserted BEFORE the executor runs, then moved exactly once to
--   succeeded  or
--   failed.
-- A row left in `started` means the outcome is unknown (process loss or a
-- failed finalize write). It is reconciled by an operator, never replayed.
--
-- Accountability metadata only. There are deliberately no columns for tool
-- arguments, results, summaries, error messages, transcripts or contact
-- details; `error_code` is a bounded identifier, never a message.
--
-- Tenant safety: written by the runtime on the service role with the trusted
-- tenant on every statement; an ownership trigger (0020 precedent) rejects a
-- conversation, agent or version from another tenant; members read only their
-- own tenant's rows through RLS; clients have no write path.
--
-- Retention: rows cascade away with their conversation, so the existing
-- purge_expired_data() needs no change.
-- ============================================================================

create table public.tool_executions (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  agent_id         uuid not null references public.agents(id) on delete cascade,
  agent_version_id uuid not null references public.agent_versions(id) on delete cascade,
  channel          text not null check (channel ~ '^[a-z][a-z0-9-]{0,39}$'),
  turn_id          text not null check (char_length(turn_id) between 1 and 100),
  correlation_id   text check (correlation_id is null or char_length(correlation_id) between 1 and 100),
  round            smallint not null check (round between 0 and 100),
  intent_id        text not null check (char_length(intent_id) between 1 and 200),
  -- Registry names only; a tool the model invented is recorded as null.
  tool_name        text check (tool_name is null or tool_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  idempotency_key  text check (idempotency_key is null or idempotency_key ~ '^[0-9a-f]{32}$'),
  side_effecting   boolean,
  status           text not null check (status in ('started', 'succeeded', 'failed', 'rejected')),
  rejection_reason text check (rejection_reason is null or rejection_reason in (
    'unknown_tool', 'not_granted', 'channel_disallowed', 'invalid_arguments', 'duplicate',
    'confirmation_required', 'precondition_failed', 'budget_exhausted', 'not_bound')),
  error_code       text check (error_code is null or error_code ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'),
  requested_at     timestamptz not null,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),

  constraint tool_executions_lifecycle check (
    (status = 'rejected' and rejection_reason is not null and error_code is null
       and started_at is null and finished_at is not null)
    or (status = 'started' and rejection_reason is null and error_code is null
       and tool_name is not null and idempotency_key is not null
       and started_at is not null and finished_at is null)
    or (status = 'succeeded' and rejection_reason is null and error_code is null
       and tool_name is not null and idempotency_key is not null
       and started_at is not null and finished_at is not null)
    or (status = 'failed' and rejection_reason is null
       and tool_name is not null and idempotency_key is not null
       and started_at is not null and finished_at is not null)
  ),
  constraint tool_executions_time_order check (
    (started_at is null or started_at >= requested_at)
    and (finished_at is null or finished_at >= coalesce(started_at, requested_at))
  )
);

-- Operator access patterns: a tenant's recent actions; one conversation's actions.
create index tool_executions_business_requested_idx on public.tool_executions (business_id, requested_at desc);
create index tool_executions_conversation_idx on public.tool_executions (conversation_id, requested_at);
-- One execution per action per turn: a duplicate intent is recorded as a
-- `rejected` row (reason `duplicate`), never as a second execution.
create unique index tool_executions_one_execution_per_action
  on public.tool_executions (business_id, turn_id, idempotency_key)
  where status <> 'rejected';

-- ----------------------------------------------------------------------------
-- Ownership: conversation, agent and version must share the row's tenant, and
-- the version must belong to the agent. SECURITY DEFINER so it holds for every
-- write path, including the service role; revoked from clients.
-- ----------------------------------------------------------------------------
create or replace function public.assert_tool_execution_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select c.business_id into owner from public.conversations c where c.id = new.conversation_id;
  if owner is null or owner <> new.business_id then
    raise exception 'tool_executions.conversation_id must reference a conversation of the same business';
  end if;
  select a.business_id into owner from public.agents a where a.id = new.agent_id;
  if owner is null or owner <> new.business_id then
    raise exception 'tool_executions.agent_id must reference an agent of the same business';
  end if;
  select av.business_id into owner from public.agent_versions av
    where av.id = new.agent_version_id and av.agent_id = new.agent_id;
  if owner is null or owner <> new.business_id then
    raise exception 'tool_executions.agent_version_id must reference a version of the same agent and business';
  end if;
  return new;
end;
$$;

create trigger tool_executions_ownership
  before insert on public.tool_executions
  for each row execute function public.assert_tool_execution_ownership();

-- ----------------------------------------------------------------------------
-- Lifecycle: insert only as `started` or `rejected`; the single permitted
-- update moves `started` to `succeeded`/`failed` and may change nothing else.
-- Final rows are immutable through every role. Deletes are not restricted, so
-- business and conversation cascades (including the retention purge) work.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_tool_execution_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('started', 'rejected') then
      raise exception 'tool_executions rows are inserted as started or rejected, not %', new.status;
    end if;
    return new;
  end if;

  if old.status <> 'started' then
    raise exception 'tool_executions row % is final and cannot change', old.id;
  end if;
  if new.status not in ('succeeded', 'failed') then
    raise exception 'tool_executions row % may only move from started to succeeded or failed', old.id;
  end if;
  if (new.id, new.business_id, new.conversation_id, new.agent_id, new.agent_version_id, new.channel,
      new.turn_id, new.correlation_id, new.round, new.intent_id, new.tool_name, new.idempotency_key,
      new.side_effecting, new.rejection_reason, new.requested_at, new.started_at, new.created_at)
     is distinct from
     (old.id, old.business_id, old.conversation_id, old.agent_id, old.agent_version_id, old.channel,
      old.turn_id, old.correlation_id, old.round, old.intent_id, old.tool_name, old.idempotency_key,
      old.side_effecting, old.rejection_reason, old.requested_at, old.started_at, old.created_at) then
    raise exception 'tool_executions row % may only change status, error_code and finished_at', old.id;
  end if;
  return new;
end;
$$;

create trigger tool_executions_lifecycle
  before insert or update on public.tool_executions
  for each row execute function public.enforce_tool_execution_lifecycle();

revoke execute on function public.assert_tool_execution_ownership() from public, anon, authenticated;
revoke execute on function public.enforce_tool_execution_lifecycle() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- RLS: members read their own tenant's audit rows; only the service role
-- writes. Clients hold SELECT only (RLS-filtered); no client write grant.
-- ----------------------------------------------------------------------------
alter table public.tool_executions enable row level security;

create policy tool_executions_read on public.tool_executions
  for select to authenticated using (public.is_business_member(business_id));

-- 0024/0027 grant pattern: read-only for members, writes for the service role.
revoke all on public.tool_executions from anon, authenticated;
grant select on public.tool_executions to authenticated;
grant all on public.tool_executions to service_role;
