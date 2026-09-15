-- ============================================================================
-- HALO Phase 1 — the agent model (plan §P1.2).
--
--   businesses 1─N agents 1─N agent_versions
--   agents.live_version_id ──▶ agent_versions.id   (deferrable: chicken-and-egg)
--   conversations N─1 agents / N─1 agent_versions  (added in 0015)
--   receptionists ── data-migrated ──▶ agents(type='receptionist') (0014)
--
-- `agent_versions` is an immutable snapshot: editing creates version n+1,
-- publishing sets `published_at` (the only permitted mutation) and repoints
-- `agents.live_version_id`. Immutability is enforced by RLS (no
-- update/delete policies) AND the BEFORE UPDATE trigger below, so even the
-- service role cannot silently mutate a published version.
--
-- Every new table ships its RLS policies in the same migration (plan §2.4
-- rule 3), following the existing members-read / admins-write pattern.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- agents — one per persona per tenant. type/slug/status/default_channel use
-- the CHECK-over-enum convention used elsewhere in the schema.
-- ----------------------------------------------------------------------------
create table public.agents (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  type            text not null check (type in
                    ('receptionist', 'sales', 'support', 'qualification',
                     'appointment', 'custom')),
  slug            text not null check (char_length(slug) between 1 and 80),
  display_name    text not null check (char_length(display_name) between 1 and 80),
  status          text not null default 'draft' check (status in
                    ('draft', 'active', 'paused', 'archived')),
  -- Points at the published version serving traffic; null until first publish.
  -- The FK is added after agent_versions exists (below) and is deferrable
  -- (initially deferred) so agents and their first version can be created in
  -- any order within one transaction.
  live_version_id uuid,
  default_channel text not null default 'web' check (default_channel in
                    ('web', 'phone', 'whatsapp', 'sms')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index agents_business_status_idx
  on public.agents(business_id, status);
create unique index agents_business_slug_idx
  on public.agents(business_id, slug);
-- The hot read path: an agent currently serving traffic.
create index agents_business_active_idx
  on public.agents(business_id)
  where status = 'active';

create trigger agents_updated_at
  before update on public.agents
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- agent_versions — an immutable snapshot of one agent's configuration.
-- config/model are jsonb validated by Zod on read (the workflowDefinition
-- precedent); prompt_template holds the content that leaves prompt-builder.
-- ----------------------------------------------------------------------------
create table public.agent_versions (
  id             uuid primary key default gen_random_uuid(),
  agent_id       uuid not null references public.agents(id) on delete cascade,
  business_id    uuid not null references public.businesses(id) on delete cascade,
  version        int  not null check (version > 0),
  config         jsonb not null default '{}'::jsonb,
  prompt_template  text not null,
  prompt_version   text not null,
  model          jsonb not null default '{}'::jsonb,
  -- null = draft; set once, on publish, and never changed again.
  published_at   timestamptz,
  -- First created_by in the schema — the audit-log seed.
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),

  constraint agent_versions_agent_version_unique unique (agent_id, version)
);

create index agent_versions_agent_version_desc_idx
  on public.agent_versions(agent_id, version desc);
create index agent_versions_business_published_idx
  on public.agent_versions(business_id, published_at desc);

-- agents.live_version_id ──▶ agent_versions.id. Deferred: a transaction may
-- create the version before pointing the agent at it, in any order.
alter table public.agents
  add constraint agents_live_version_fk
  foreign key (live_version_id) references public.agent_versions(id)
  deferrable initially deferred;

-- ----------------------------------------------------------------------------
-- Immutability: the only permitted mutation is the publish transition
-- (published_at null → set). Anything else — column edits, re-publish,
-- unpublish, delete — is rejected even for the service role.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_agent_version_immutability()
returns trigger
language plpgsql
as $$
declare
  unchanged boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'agent_versions are immutable: delete is not allowed';
  end if;

  unchanged := (
    old.agent_id = new.agent_id
    and old.business_id = new.business_id
    and old.version = new.version
    and old.config is not distinct from new.config
    and old.prompt_template = new.prompt_template
    and old.prompt_version = new.prompt_version
    and old.model is not distinct from new.model
    and old.created_by is not distinct from new.created_by
    and old.created_at = new.created_at
  );

  if not unchanged then
    raise exception 'agent_versions are immutable: changing agent % version % requires creating version %',
      old.agent_id, old.version, old.version + 1;
  end if;

  if old.published_at is not null and old.published_at is distinct from new.published_at then
    raise exception 'a published agent_version cannot be re-published or unpublished';
  end if;

  return new;
end;
$$;

create trigger agent_versions_immutable
  before update or delete on public.agent_versions
  for each row execute function public.enforce_agent_version_immutability();

-- ----------------------------------------------------------------------------
-- RLS. Members read, admins manage agents; agent_versions is read-only for
-- every role (immutability) — mutations flow through service-role code paths
-- that honor the same rules, with the trigger as the database backstop.
-- ----------------------------------------------------------------------------
alter table public.agents         enable row level security;
alter table public.agent_versions enable row level security;

create policy "members read agents" on public.agents
  for select using (public.is_business_member(business_id));
create policy "admins insert agents" on public.agents
  for insert with check (public.is_business_admin(business_id));
create policy "admins update agents" on public.agents
  for update using (public.is_business_admin(business_id));
create policy "admins delete agents" on public.agents
  for delete using (public.is_business_admin(business_id));

create policy "members read agent versions" on public.agent_versions
  for select using (public.is_business_member(business_id));
create policy "admins insert agent versions" on public.agent_versions
  for insert with check (public.is_business_admin(business_id));
-- No update/delete policies: agent_versions is immutable.

-- New SECURITY DEFINER functions are revoked from public per the
-- 0002_function_grants.sql precedent. enforce_agent_version_immutability is
-- owned by the migration role and invoked only via the trigger, so no
-- EXECUTE grant is added — matching the existing pattern.