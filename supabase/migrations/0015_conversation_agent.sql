-- ============================================================================
-- HALO Phase 1 — conversation ↔ agent/agent-version linkage (plan §P1.2
-- "Conversation ↔ agent version linkage (required)", migration 0015).
--
-- Every production conversation records the agent (and the exact agent
-- version) that served it — the precondition for evals, A/B, incident
-- forensics and cost attribution.
--
-- Both columns are NULLABLE in this migration (plan: backfilled now,
-- NOT NULL in a follow-up migration after the write path is fully wired).
-- Historical conversations are backfilled deterministically to the
-- business's single default active receptionist agent (the 0014 backfill
-- creates exactly one per business, keyed slug = receptionist id).
-- In-flight/legacy conversations stay valid: agent fields are optional for
-- every existing read path.
-- ============================================================================

alter table public.conversations
  add column agent_id         uuid references public.agents(id) on delete set null,
  add column agent_version_id uuid references public.agent_versions(id) on delete set null;

create index conversations_agent_started_idx
  on public.conversations(business_id, agent_id, started_at desc);

-- Deterministic backfill: the single active receptionist agent per business.
-- (min(id) makes the choice stable even if a business ever has several.)
update public.conversations c
set agent_id = a.id,
    agent_version_id = a.live_version_id
from public.agents a
where c.business_id = a.business_id
  and a.type = 'receptionist'
  and a.status = 'active'
  and a.id = (
    select a2.id
    from public.agents a2
    where a2.business_id = c.business_id
      and a2.type = 'receptionist'
      and a2.status = 'active'
    order by a2.id
    limit 1
  )
  and c.agent_id is null;