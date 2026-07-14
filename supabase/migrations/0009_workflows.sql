-- ============================================================================
-- Business automation platform: workflow engine + CRM.
--
-- Every business event (appointment booked, lead captured, …) lands in
-- workflow_events (the audit trail / outbox). Enabled workflows matching the
-- event's trigger get a workflow_run each — unique(workflow_id, event_id)
-- makes duplicate event delivery idempotent at the database level. Failed
-- runs retry with backoff via the cron worker until max_attempts, then park
-- in 'dead_letter'. workflow_run_logs records every step attempt.
--
-- customers + customer_timeline are the built-in CRM: one row per real
-- person (deduped by email/phone), with an append-only activity timeline.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Workflow definitions. steps/conditions are JSONB validated in code (zod);
-- version increments on every definition change so runs record what they ran.
-- ----------------------------------------------------------------------------
create table public.workflows (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  description text not null default '',
  trigger     text not null,
  enabled     boolean not null default true,
  version     int not null default 1,
  conditions  jsonb not null default '[]'::jsonb,
  steps       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index workflows_trigger_idx on public.workflows(business_id, trigger) where enabled;

create trigger workflows_updated_at
  before update on public.workflows
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Event log (outbox + audit trail). correlation_id threads one visitor
-- journey (conversation, appointment) across events, runs, and logs.
-- ----------------------------------------------------------------------------
create table public.workflow_events (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  type           text not null,
  correlation_id text not null default '',
  payload        jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index workflow_events_business_idx on public.workflow_events(business_id, occurred_at desc);
create index workflow_events_correlation_idx on public.workflow_events(correlation_id)
  where correlation_id <> '';

-- ----------------------------------------------------------------------------
-- Runs. One per (workflow, event) — the unique constraint IS the idempotency
-- guarantee. current_step lets a retry resume where it failed instead of
-- re-running completed steps (actions are still written to be idempotent).
-- ----------------------------------------------------------------------------
create table public.workflow_runs (
  id               uuid primary key default gen_random_uuid(),
  workflow_id      uuid not null references public.workflows(id) on delete cascade,
  business_id      uuid not null references public.businesses(id) on delete cascade,
  event_id         uuid not null references public.workflow_events(id) on delete cascade,
  workflow_version int not null default 1,
  status           text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped', 'dead_letter')),
  attempt          int not null default 0,
  max_attempts     int not null default 3,
  next_attempt_at  timestamptz,
  current_step     int not null default 0,
  correlation_id   text not null default '',
  error            text not null default '',
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),

  constraint workflow_runs_idempotent unique (workflow_id, event_id)
);

create index workflow_runs_retry_idx on public.workflow_runs(next_attempt_at)
  where status = 'failed';
create index workflow_runs_business_idx on public.workflow_runs(business_id, created_at desc);

-- Atomically claims failed runs due for retry (SKIP LOCKED — overlapping
-- cron runs are safe). Claimed rows flip to 'running' so no other worker
-- picks them up; the engine settles them to succeeded/failed/dead_letter.
create or replace function public.claim_due_workflow_runs(batch_size int default 25)
returns setof public.workflow_runs
language sql
security definer
set search_path = public
as $$
  update public.workflow_runs r
  set status = 'running', started_at = now()
  from (
    select id from public.workflow_runs
    where status = 'failed' and next_attempt_at is not null and next_attempt_at <= now()
    order by next_attempt_at
    limit batch_size
    for update skip locked
  ) due
  where r.id = due.id
  returning r.*;
$$;

revoke all on function public.claim_due_workflow_runs(int) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Per-step execution log — the observable history of what every run did.
-- ----------------------------------------------------------------------------
create table public.workflow_run_logs (
  id         bigint generated always as identity primary key,
  run_id     uuid not null references public.workflow_runs(id) on delete cascade,
  step_id    text not null,
  attempt    int not null default 1,
  status     text not null check (status in ('succeeded', 'failed', 'skipped')),
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index workflow_run_logs_run_idx on public.workflow_run_logs(run_id, id);

-- ----------------------------------------------------------------------------
-- Timers — scheduled triggers ("follow up in 3 days", review reminders).
-- The cron worker claims due timers and emits their event.
-- ----------------------------------------------------------------------------
create table public.workflow_timers (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  event_type     text not null,
  payload        jsonb not null default '{}'::jsonb,
  correlation_id text not null default '',
  fire_at        timestamptz not null,
  fired_at       timestamptz,
  created_at     timestamptz not null default now()
);

create index workflow_timers_due_idx on public.workflow_timers(fire_at) where fired_at is null;

create or replace function public.claim_due_workflow_timers(batch_size int default 25)
returns setof public.workflow_timers
language sql
security definer
set search_path = public
as $$
  update public.workflow_timers t
  set fired_at = now()
  from (
    select id from public.workflow_timers
    where fired_at is null and fire_at <= now()
    order by fire_at
    limit batch_size
    for update skip locked
  ) due
  where t.id = due.id
  returning t.*;
$$;

revoke all on function public.claim_due_workflow_timers(int) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- CRM: one row per real person. Dedupe keys are normalized email and phone
-- digits; merges keep the oldest row and stamp merged_into on the loser.
-- ----------------------------------------------------------------------------
create table public.customers (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  name               text not null default '',
  email              text not null default '',
  phone              text not null default '',
  -- Pipeline stage: where this person is in the funnel.
  stage              text not null default 'lead'
    check (stage in ('lead', 'engaged', 'booked', 'customer', 'lost')),
  source             text not null default '',
  total_appointments int not null default 0,
  -- Revenue attribution: accumulated by the crm_record_revenue action /
  -- appointment value hooks. Currency is the business's own.
  revenue_total      numeric(12,2) not null default 0,
  merged_into        uuid references public.customers(id) on delete set null,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index customers_business_idx on public.customers(business_id, last_seen_at desc);
create index customers_email_idx on public.customers(business_id, lower(email))
  where email <> '' and merged_into is null;
create index customers_phone_idx on public.customers(business_id, phone)
  where phone <> '' and merged_into is null;

create trigger customers_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- Append-only activity history per customer.
create table public.customer_timeline (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind        text not null,
  title       text not null default '',
  detail      jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index customer_timeline_customer_idx on public.customer_timeline(customer_id, occurred_at desc);

-- ----------------------------------------------------------------------------
-- Inbound webhook trigger secret, one per business (empty = disabled).
-- ----------------------------------------------------------------------------
alter table public.business_settings
  add column workflow_webhook_secret text not null default '';

-- ----------------------------------------------------------------------------
-- RLS. Automation writes flow through the service role with tenant scoping
-- in code; dashboard users get read access for observability. workflow
-- definitions are admin-managed.
-- ----------------------------------------------------------------------------
alter table public.workflows         enable row level security;
alter table public.workflow_events   enable row level security;
alter table public.workflow_runs     enable row level security;
alter table public.workflow_run_logs enable row level security;
alter table public.workflow_timers   enable row level security;
alter table public.customers         enable row level security;
alter table public.customer_timeline enable row level security;

create policy "members read workflows" on public.workflows
  for select using (public.is_business_member(business_id));
create policy "admins manage workflows" on public.workflows
  for all using (public.is_business_admin(business_id));

create policy "members read workflow events" on public.workflow_events
  for select using (public.is_business_member(business_id));
create policy "members read workflow runs" on public.workflow_runs
  for select using (public.is_business_member(business_id));
create policy "members read workflow logs" on public.workflow_run_logs
  for select using (exists (
    select 1 from public.workflow_runs r
    where r.id = run_id and public.is_business_member(r.business_id)
  ));
create policy "members read workflow timers" on public.workflow_timers
  for select using (public.is_business_member(business_id));

-- Workflow-originated analytics events.
alter table public.usage_events
  drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
  add constraint usage_events_event_type_check check (event_type in
    ('widget_loaded', 'conversation_started', 'message_sent',
     'lead_captured', 'voice_used', 'unanswered_question',
     'appointment_booked', 'appointment_rescheduled', 'appointment_cancelled',
     'customer_created', 'workflow_custom'));

create policy "members read customers" on public.customers
  for select using (public.is_business_member(business_id));
create policy "members read customer timeline" on public.customer_timeline
  for select using (public.is_business_member(business_id));
