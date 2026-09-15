-- ============================================================================
-- HALO Phase 1 — receptionists → agents + agent_versions v1 backfill (plan
-- §P1.2 "Backwards compatibility", migration 0014).
--
-- For every EXISTING receptionist, materialize one `agents` row
-- (type='receptionist') and one published `agent_versions` row (version 1),
-- then point the agent's live_version_id at it.
--
-- Guarantees:
--   * idempotent + re-runnable (on conflict do nothing; live_version_id
--     repointed only when null) — re-running never duplicates agents.
--   * historical data preserved: receptionists is NOT dropped or altered;
--     the widget_key/identity stays on receptionists through the
--     compatibility period (widget contract unchanged).
--   * every agent is deterministically linked to its receptionist via
--     agents.slug = receptionist.id::text, so the app resolver can map
--     receptionist → agent → live version in either direction.
--   * version 1 is stamped published_at = now(): the backfill represents
--     existing production behaviour and must serve traffic immediately.
--   * prompt_template seeds the static persona content that prompt-builder
--     assembles; prompt_version matches the assembler's PROMPT_VERSION.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Agents — one per receptionist, keyed by (business_id, slug).
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 2. Agent versions v1 — published immediately (backfilled behaviour is the
--    live production behaviour). config seeds the documented hierarchy;
--    prompt_template carries the receptionist's static persona content.
-- ----------------------------------------------------------------------------
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
  -- The static persona content (the part of the production prompt that is
  -- per-receptionist, not per-business/per-conversation).
  'Receptionist: ' || r.name || E'\nGreeting: ' || r.greeting ||
    E'\nTone: ' || r.tone || E'\nLanguage: ' || coalesce(nullif(r.language, ''), 'en') ||
    E'\nCustom instructions: ' || r.custom_instructions,
  '2026-07-28.1',
  '{}'::jsonb,
  now(),
  null
from public.receptionists r
join public.agents a
  on a.business_id = r.business_id
 and a.slug = r.id::text
 and a.type = 'receptionist'
on conflict (agent_id, version) do nothing;

-- ----------------------------------------------------------------------------
-- 3. Repoint live_version_id (idempotent: only fills agents that have no live
--    version yet; later re-publications are the application's job).
-- ----------------------------------------------------------------------------
update public.agents a
set live_version_id = av.id,
    status = case when r.is_active then 'active' else 'paused' end
from public.agent_versions av, public.receptionists r
where av.agent_id = a.id
  and av.version = 1
  and av.business_id = r.business_id
  and a.slug = r.id::text
  and a.live_version_id is null;