-- ============================================================================
-- Repair: receptionists onboarded between 0014 and 0021 have no agent.
--
-- 0014 backfilled agents for receptionists existing at that time; 0021 taught
-- `create_business_with_owner` to provision one going forward. Tenants
-- created in the window between the two were left with a receptionist and no
-- agent, so agent resolution fails closed and their widget returns 503.
--
-- This re-runs the 0014 backfill for exactly those rows. It is the same
-- query, unchanged in shape, and idempotent (`on conflict do nothing`;
-- live_version_id filled only while null), so it is a no-op for every tenant
-- 0014 or 0021 already covered, and safe to replay.
--
-- Only `prompt_version` differs from 0014: these versions are created now, so
-- they carry the current assembler version rather than the historical one.
--
-- Rollback: none needed — deleting the agents it creates would re-break the
-- affected tenants.
-- ============================================================================

insert into public.agents (
  business_id, type, slug, display_name, status, default_channel
)
select
  r.business_id,
  'receptionist',
  r.id::text,
  r.name,
  case when r.is_active then 'active' else 'paused' end,
  'web'
from public.receptionists r
on conflict (business_id, slug) do nothing;

insert into public.agent_versions (
  agent_id, business_id, version, config, prompt_template,
  prompt_version, model, published_at, created_by
)
select
  a.id,
  a.business_id,
  1,
  jsonb_build_object(
    'identity', jsonb_build_object('name', r.name, 'persona', r.tone),
    'language', jsonb_build_object('primary', coalesce(nullif(r.language, ''), 'en')),
    'instructions', jsonb_build_object(
      'customInstructions', r.custom_instructions,
      'promptTemplate', ''
    ),
    'voice', jsonb_build_object('bargeIn', true)
  ),
  'Receptionist: ' || r.name || E'\nGreeting: ' || r.greeting ||
    E'\nTone: ' || r.tone || E'\nLanguage: ' || coalesce(nullif(r.language, ''), 'en') ||
    E'\nCustom instructions: ' || r.custom_instructions,
  -- Matches PROMPT_COMPOSER_VERSION in packages/runtime/prompt-composer.ts.
  '2026-09-15.1',
  '{}'::jsonb,
  now(),
  null
from public.receptionists r
join public.agents a
  on a.business_id = r.business_id
 and a.slug = r.id::text
 and a.type = 'receptionist'
on conflict (agent_id, version) do nothing;

update public.agents a
set live_version_id = av.id,
    status = case when r.is_active then 'active' else 'paused' end
from public.agent_versions av, public.receptionists r
where av.agent_id = a.id
  and av.version = 1
  and av.business_id = r.business_id
  and a.slug = r.id::text
  and a.live_version_id is null;
