-- ============================================================================
-- Customer lifecycle: everything before, during, and after an appointment.
--
-- BEFORE  — manage tokens power self-service reschedule/cancel links, intake
--           forms, and richer confirmations (prep instructions, directions).
-- DURING  — the appointment state machine grows day-of statuses:
--           checked_in, running_late, in_progress.
-- AFTER   — appointment_feedback captures satisfaction surveys and reviews;
--           new usage_events feed lifecycle analytics; workflows react to
--           appointment.completed / appointment.no_show / feedback.received.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Day-of statuses. The exclusion constraint must keep holding the slot for
-- every non-terminal status, so it is rebuilt with the expanded set.
-- ----------------------------------------------------------------------------
alter table public.appointments
  drop constraint appointments_status_check;
alter table public.appointments
  add constraint appointments_status_check check (status in
    ('pending', 'confirmed', 'checked_in', 'running_late', 'in_progress',
     'cancelled', 'completed', 'no_show'));

alter table public.appointments
  drop constraint appointments_no_overlap;
alter table public.appointments
  add constraint appointments_no_overlap exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('pending', 'confirmed', 'checked_in', 'running_late', 'in_progress'));

drop index if exists public.appointments_staff_window_idx;
create index appointments_staff_window_idx
  on public.appointments(staff_id, starts_at)
  where status in ('pending', 'confirmed', 'checked_in', 'running_late', 'in_progress');

-- ----------------------------------------------------------------------------
-- Manage token: the capability credential in reschedule/cancel/check-in/
-- feedback links. Unguessable (uuid v4), one per appointment, revoked by
-- clearing. Public endpoints look appointments up ONLY by this token.
-- ----------------------------------------------------------------------------
alter table public.appointments
  add column manage_token uuid not null default gen_random_uuid();

create unique index appointments_manage_token_idx
  on public.appointments(manage_token);

-- ----------------------------------------------------------------------------
-- Per-business lifecycle content: where the visitor should go (directions),
-- how to prepare, what to fill in beforehand, and where reviews live.
-- intake_form is a JSON array of fields: [{ id, label, type, required }]
-- with type in ('text', 'textarea', 'checkbox') — validated in code.
-- ----------------------------------------------------------------------------
alter table public.scheduling_settings
  add column location_address  text  not null default '',
  add column prep_instructions text  not null default '',
  add column intake_form       jsonb not null default '[]'::jsonb,
  add column review_url        text  not null default '';

-- ----------------------------------------------------------------------------
-- Post-appointment feedback / satisfaction survey. One row per appointment;
-- resubmission updates in place. rating 1–5; nps 0–10 optional.
-- ----------------------------------------------------------------------------
create table public.appointment_feedback (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  business_id    uuid not null references public.businesses(id) on delete cascade,
  rating         int not null check (rating between 1 and 5),
  nps            int check (nps between 0 and 10),
  comment        text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint appointment_feedback_one_per_appointment unique (appointment_id)
);

create index appointment_feedback_business_idx
  on public.appointment_feedback(business_id, created_at desc);

create trigger appointment_feedback_updated_at
  before update on public.appointment_feedback
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Intake form responses. One per appointment; answers keyed by field id.
-- ----------------------------------------------------------------------------
create table public.intake_responses (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  business_id    uuid not null references public.businesses(id) on delete cascade,
  answers        jsonb not null default '{}'::jsonb,
  submitted_at   timestamptz not null default now(),

  constraint intake_responses_one_per_appointment unique (appointment_id)
);

create index intake_responses_business_idx
  on public.intake_responses(business_id, submitted_at desc);

-- ----------------------------------------------------------------------------
-- Lifecycle analytics events.
-- ----------------------------------------------------------------------------
alter table public.usage_events
  drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
  add constraint usage_events_event_type_check check (event_type in
    ('widget_loaded', 'conversation_started', 'message_sent',
     'lead_captured', 'voice_used', 'unanswered_question',
     'appointment_booked', 'appointment_rescheduled', 'appointment_cancelled',
     'appointment_checked_in', 'appointment_completed', 'appointment_no_show',
     'reminder_sent', 'reminder_failed',
     'review_requested', 'feedback_received',
     'customer_created', 'workflow_custom'));

-- ----------------------------------------------------------------------------
-- RLS. Public manage/feedback/intake writes flow through the service role
-- (token-scoped in code); dashboard members read for observability.
-- ----------------------------------------------------------------------------
alter table public.appointment_feedback enable row level security;
alter table public.intake_responses     enable row level security;

create policy "members read feedback" on public.appointment_feedback
  for select using (public.is_business_member(business_id));
create policy "members read intake responses" on public.intake_responses
  for select using (public.is_business_member(business_id));
