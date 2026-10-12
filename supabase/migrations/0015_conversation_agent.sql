-- ============================================================================
-- HALO Phase 1 — conversation ↔ agent/agent-version linkage (plan §P1.2
-- "Conversation ↔ agent version linkage (required)", migration 0015).
--
-- Every production conversation records the agent (and the exact agent
-- version) that served it — the precondition for evals, A/B, incident
-- forensics and cost attribution.
--
-- Both columns are added NULLABLE so existing conversations without a proven
-- exact mapping can remain untouched and fail closed at runtime. Migration
-- 0031 guards new identity-bearing writes while preserving these legacy NULLs.
-- Historical conversations are backfilled to the exact receptionist already
-- recorded on each conversation. Migration 0014 keys that receptionist's
-- agent by slug = receptionist id; do not substitute another receptionist
-- from the same business or invent an identity when the mapping is missing.
-- In-flight/legacy conversations stay representable; application reads must
-- reject missing or inconsistent identity before model execution or writes.
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
  and a.slug = c.receptionist_id::text
  and a.type = 'receptionist'
  and c.agent_id is null;
