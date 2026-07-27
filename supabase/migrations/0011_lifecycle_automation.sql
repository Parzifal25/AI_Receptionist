-- ============================================================================
-- Lifecycle automation: closing the loop on day-of tracking.
--
-- The V1 lifecycle layer (0010) tracks every day-of status but relies on a
-- human to mark a visitor as a no-show. This migration adds the per-business
-- knobs the automatic sweep needs, plus the index that makes finding overdue
-- appointments cheap.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Automatic no-show sweep settings.
--
-- OPT-IN by design (default false): a business that does not work the
-- appointments board would otherwise have every past visit flipped to
-- no_show, poisoning the no-show rate and firing recovery journeys at happy
-- customers. Turned on from Settings → Customer lifecycle.
--
-- The grace period is measured from the appointment's END, so a visit that
-- ran long is never swept out from under the staff.
-- ----------------------------------------------------------------------------
alter table public.scheduling_settings
  add column auto_no_show_enabled   boolean not null default false,
  add column no_show_grace_minutes  int     not null default 30;

alter table public.scheduling_settings
  add constraint scheduling_settings_no_show_grace_check
    check (no_show_grace_minutes between 0 and 1440);

-- ----------------------------------------------------------------------------
-- The sweep scans across every tenant for appointments that are still
-- "live" (nobody ever checked them in or closed them out) whose end time has
-- passed. Partial index over exactly that predicate, ordered by ends_at so
-- the most overdue rows are claimed first.
--
-- checked_in / in_progress are deliberately excluded: the visitor demonstrably
-- showed up, so only staff may close those out.
-- ----------------------------------------------------------------------------
create index appointments_overdue_idx
  on public.appointments(ends_at)
  where status in ('pending', 'confirmed', 'running_late');
