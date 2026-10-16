-- P2-R1: owner-approved local implementation (2026-10-16, Phase 2 blocker
-- loop). Local and disposable-database use only; applying it to any hosted,
-- staging or shared database needs a separate target authorization.
-- Prerequisite: 0008 calendar_connections; ledger order after 0036.
-- Invariant: at most one business-level connection (staff_id IS NULL) per
-- business and provider. 0008's unique (business_id, staff_id, provider)
-- treats NULL staff_id values as distinct, so two concurrent first connects
-- could both insert, after which business-level lookups became ambiguous.
-- Staff-level rows are already unique under 0008 and are unaffected.
-- A partial unique index rather than UNIQUE NULLS NOT DISTINCT: valid on every
-- Postgres major the target might run, and 0008's constraint stays untouched.
-- Existing duplicates: the guard aborts with a count only (no tenant
-- identifiers). No row is deleted, merged or chosen here; the operator
-- resolves duplicates under a separate authorization first.
-- One statement: the SHARE lock, the guard and the index build run in a
-- single DO block, so they are atomic whether or not the runner wraps the
-- file in a transaction (LOCK TABLE alone requires one). The lock is taken
-- before the guard, so no writer can add a duplicate between the guard and
-- the build, whose own error would name the tenant. It is the lock CREATE
-- INDEX takes anyway: it blocks writes (not reads) on calendar_connections,
-- which holds a few rows per business. Not CONCURRENTLY (not allowed in a
-- transaction or a function). Rollback: dropping the index restores 0008
-- behaviour and transforms no data. No grant, policy, RLS or row change.

do $$
declare
  duplicate_groups bigint;
begin
  lock table public.calendar_connections in share mode;
  select count(*) into duplicate_groups
  from (
    select 1 from public.calendar_connections
    where staff_id is null
    group by business_id, provider
    having count(*) > 1
  ) d;
  if duplicate_groups > 0 then
    raise exception '0037: % business-level calendar connection group(s) are duplicated; resolve them before applying', duplicate_groups;
  end if;
  create unique index calendar_connections_business_level_unique
    on public.calendar_connections (business_id, provider)
    where staff_id is null;
end;
$$;
