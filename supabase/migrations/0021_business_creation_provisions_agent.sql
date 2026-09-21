-- ============================================================================
-- Tenant initialization completeness — every new business gets its agent.
--
-- 0014_agent_backfill.sql materialized an `agents` row (+ published version
-- 1) for every receptionist that existed *at that moment*. It was a one-shot
-- data migration; `create_business_with_owner` was never taught to do the
-- same for businesses created afterwards.
--
-- Consequence: every tenant onboarded after 0014 got a business, a
-- membership, settings and a receptionist — but no agent. Agent resolution
-- (packages/agents/agent-resolver.ts) then fails with `agent_not_found`, and
-- POST /api/v1/widget/conversations fails CLOSED (503, by design — an
-- unattributed conversation is never created). The tenant's receptionist is
-- permanently unable to hold a conversation, with no dashboard signal.
--
-- Fix: onboarding provisions the agent in the SAME transaction as the
-- business, so a tenant is either fully initialized or not created at all.
-- The rows mirror 0014 exactly (slug = receptionist id, type
-- 'receptionist', published version 1) so resolution stays deterministic in
-- both directions for backfilled and newly-created tenants alike.
--
-- Security is unchanged: same signature, same SECURITY DEFINER + pinned
-- search_path, same `auth.uid()` gate, same grants (authenticated only).
-- Nothing here touches RLS, tenant isolation or agent/version isolation —
-- every row it writes is scoped to the business it just created.
--
-- Idempotent: `on conflict do nothing` on both natural keys, and
-- live_version_id is filled only while null, so re-running (or a retried
-- onboarding) never duplicates or repoints an agent.
--
-- Rollback: restore the 0001 body of create_business_with_owner.
-- ============================================================================

create or replace function public.create_business_with_owner(
  business_name text,
  business_slug text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_business_id     uuid;
  new_receptionist_id uuid;
  new_agent_id        uuid;
  new_version_id      uuid;
  receptionist_row    public.receptionists%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  insert into public.businesses (name, slug)
  values (business_name, business_slug)
  returning id into new_business_id;

  insert into public.business_members (business_id, user_id, role)
  values (new_business_id, auth.uid(), 'owner');

  insert into public.business_settings (business_id)
  values (new_business_id);

  insert into public.receptionists (business_id, name)
  values (new_business_id, 'Receptionist')
  returning id into new_receptionist_id;

  -- Re-read the row so the agent seed uses the column defaults (greeting,
  -- tone, language, custom_instructions) rather than restating them here —
  -- the receptionist table stays the single source of persona defaults.
  select * into receptionist_row
  from public.receptionists
  where id = new_receptionist_id;

  -- 1. The agent. slug = receptionist id is the deterministic mapping the
  --    resolver relies on (widget_key → receptionist → agent).
  insert into public.agents (
    business_id, type, slug, display_name, status, default_channel
  )
  values (
    new_business_id,
    'receptionist',
    new_receptionist_id::text,
    receptionist_row.name,
    case when receptionist_row.is_active then 'active' else 'paused' end,
    'web'
  )
  on conflict (business_id, slug) do nothing
  returning id into new_agent_id;

  if new_agent_id is null then
    select id into new_agent_id
    from public.agents
    where business_id = new_business_id
      and slug = new_receptionist_id::text;
  end if;

  -- 2. Version 1, published immediately: a brand-new receptionist must be
  --    able to serve its first visitor without a separate publish step.
  insert into public.agent_versions (
    agent_id, business_id, version, config, prompt_template,
    prompt_version, model, published_at, created_by
  )
  values (
    new_agent_id,
    new_business_id,
    1,
    jsonb_build_object(
      'identity', jsonb_build_object(
        'name', receptionist_row.name,
        'persona', receptionist_row.tone
      ),
      'language', jsonb_build_object(
        'primary', coalesce(nullif(receptionist_row.language, ''), 'en')
      ),
      'instructions', jsonb_build_object(
        'customInstructions', receptionist_row.custom_instructions,
        'promptTemplate', ''
      ),
      'voice', jsonb_build_object('bargeIn', true)
    ),
    'Receptionist: ' || receptionist_row.name ||
      E'\nGreeting: ' || receptionist_row.greeting ||
      E'\nTone: ' || receptionist_row.tone ||
      E'\nLanguage: ' || coalesce(nullif(receptionist_row.language, ''), 'en') ||
      E'\nCustom instructions: ' || receptionist_row.custom_instructions,
    -- Matches PROMPT_COMPOSER_VERSION in packages/runtime/prompt-composer.ts.
    '2026-09-15.1',
    '{}'::jsonb,
    now(),
    auth.uid()
  )
  on conflict (agent_id, version) do nothing
  returning id into new_version_id;

  if new_version_id is null then
    select id into new_version_id
    from public.agent_versions
    where agent_id = new_agent_id and version = 1;
  end if;

  -- 3. Point the agent at its live version. The FK is deferrable, and the
  --    0018 ownership trigger is satisfied because the version above
  --    belongs to this agent.
  update public.agents
  set live_version_id = new_version_id
  where id = new_agent_id
    and live_version_id is null;

  return new_business_id;
end;
$$;

-- `create or replace` preserves the existing ACL, but re-assert it so the
-- 0002 hardening is visible and survives a from-scratch replay.
revoke execute on function public.create_business_with_owner(text, text) from public, anon;
grant  execute on function public.create_business_with_owner(text, text) to authenticated;
