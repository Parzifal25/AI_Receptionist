-- ============================================================================
-- HALO Phase 1.5 — agents.live_version_id ownership integrity (workstream 4).
--
-- Finding (verified 2026-09-15, scripts/check-rls.mjs): the 0013 foreign key
-- on agents.live_version_id → agent_versions.id checks EXISTENCE only. The
-- admins-update policy on agents lets a tenant admin repoint their agent's
-- live version at ANY agent_versions row in the database — another tenant's
-- published version included (the RLS SELECT policy on agent_versions does
-- not constrain FK targets; FKs are checked with the table owner's rights).
-- Effect: one tenant could serve another tenant's prompt/model config.
--
-- Fix: a BEFORE INSERT OR UPDATE trigger on agents rejects a live_version_id
-- that is not a version of the SAME agent (which transitively pins the same
-- business_id — agent_versions.agent_id is unique per tenant chain). NULL is
-- allowed (draft agents have no live version). The check is a SECURITY
-- DEFINER helper so it works identically for admins, service role, and any
-- future write path; it is revoked from public/anon/authenticated per the
-- 0002_function_grants.sql precedent (invoked via the trigger only).
--
-- Idempotent, additive, no data rewrite: existing rows are already valid
-- (0014 creates versions from the same receptionist row). Rollback: drop the
-- trigger and function.
-- ============================================================================

create or replace function public.assert_agent_live_version_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_agent_id uuid;
begin
  if new.live_version_id is null then
    return new; -- draft agents legitimately have no live version
  end if;

  select av.agent_id into owner_agent_id
  from public.agent_versions av
  where av.id = new.live_version_id;

  if owner_agent_id is null then
    raise exception 'agents.live_version_id % does not exist', new.live_version_id;
  end if;

  if owner_agent_id <> new.id then
    raise exception 'agents.live_version_id must reference a version of the same agent (agent % tried to use version of agent %)', new.id, owner_agent_id;
  end if;

  return new;
end;
$$;

-- Revoke direct EXECUTE (0002 precedent): only the trigger invokes it.
revoke execute on function public.assert_agent_live_version_ownership() from public, anon, authenticated;

create trigger agents_live_version_ownership
  before insert or update of live_version_id on public.agents
  for each row execute function public.assert_agent_live_version_ownership();
