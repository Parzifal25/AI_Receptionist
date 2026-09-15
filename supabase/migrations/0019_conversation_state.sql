-- ============================================================================
-- HALO Phase 2 — conversation state (Agent Runtime, Workstream 4).
--
-- The runtime's typed working memory for one conversation: current intent,
-- collected slots, pending confirmation, escalation status, rolling recap
-- and bookkeeping counters. It is CONVERSATION state, deliberately separate
-- from durable business state (appointments, leads, customers — untouched)
-- and from the scheduling engine's own booking_drafts (untouched, still the
-- authority for an in-flight appointment).
--
-- One row per conversation (primary key), validated on read by the runtime's
-- Zod schema (malformed rows are ignored loudly, never served), cascaded away
-- with the conversation so retention purges need no extra work.
-- ============================================================================

create table public.conversation_state (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  business_id     uuid not null references public.businesses(id) on delete cascade,
  -- Validated by packages/runtime/conversation-state.ts on every read.
  state           jsonb not null default '{}'::jsonb,
  state_version   int not null default 1 check (state_version > 0),
  updated_at      timestamptz not null default now()
);

create index conversation_state_business_idx on public.conversation_state(business_id);

create trigger conversation_state_updated_at
  before update on public.conversation_state
  for each row execute function public.set_updated_at();

-- RLS: written by the runtime on the service role with tenant scoping in
-- code; dashboard members may read their own business's conversation state.
alter table public.conversation_state enable row level security;

create policy "members read conversation state" on public.conversation_state
  for select using (public.is_business_member(business_id));
