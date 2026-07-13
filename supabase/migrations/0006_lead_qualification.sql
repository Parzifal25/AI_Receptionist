-- ============================================================================
-- Lead qualification.
--
-- A captured contact is commodity; the value is prioritisation. Every lead now
-- carries a 0–100 score, a temperature bucket, and the human-readable signals
-- behind it, so the dashboard can answer the only question that matters to an
-- owner with a full pipeline: "who do I call first?"
-- ============================================================================

alter table public.leads
  add column if not exists score int not null default 0
    check (score between 0 and 100),
  add column if not exists temperature text not null default 'cold'
    check (temperature in ('hot', 'warm', 'cold')),
  add column if not exists qualification jsonb not null default '{}'::jsonb;

-- Hottest-first is the default dashboard ordering.
create index if not exists leads_business_score_idx
  on public.leads(business_id, score desc, created_at desc);
