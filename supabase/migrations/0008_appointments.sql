-- ============================================================================
-- Appointment intelligence: staff, scheduling settings, appointments,
-- reminders, and calendar connections.
--
-- Race handling happens here, not in application code: an exclusion
-- constraint on (staff_id, time range) makes double-booking impossible at
-- the database level. Two visitors confirming the same slot concurrently
-- resolve to exactly one appointment; the loser gets a constraint violation
-- the booking service converts into "that slot was just taken".
-- ============================================================================

create extension if not exists btree_gist;

-- ----------------------------------------------------------------------------
-- Staff — bookable people/resources. working_hours null = use business hours.
-- ----------------------------------------------------------------------------
create table public.staff_members (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  name              text not null,
  role              text not null default '',
  working_hours     jsonb,
  is_active         boolean not null default true,
  calendar_provider text not null default 'internal'
    check (calendar_provider in ('internal', 'google', 'outlook', 'caldav')),
  calendar_ref      text not null default '',
  created_at        timestamptz not null default now()
);

create index staff_members_business_idx on public.staff_members(business_id) where is_active;

-- ----------------------------------------------------------------------------
-- Per-business scheduling policy.
-- ----------------------------------------------------------------------------
create table public.scheduling_settings (
  business_id           uuid primary key references public.businesses(id) on delete cascade,
  booking_enabled       boolean not null default false,
  timezone              text not null default 'UTC',
  slot_duration_minutes int not null default 30 check (slot_duration_minutes between 5 and 480),
  buffer_minutes        int not null default 0 check (buffer_minutes between 0 and 240),
  min_notice_minutes    int not null default 120 check (min_notice_minutes >= 0),
  max_advance_days      int not null default 14 check (max_advance_days between 1 and 365),
  holidays              jsonb not null default '[]'::jsonb,
  reminders_enabled     boolean not null default true,
  reminder_lead_minutes jsonb not null default '[1440, 60]'::jsonb,
  updated_at            timestamptz not null default now()
);

create trigger scheduling_settings_updated_at
  before update on public.scheduling_settings
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Appointments. State machine enforced in code; the columns enforce the
-- invariants that must survive any code path: valid status, end after start,
-- and no overlapping live appointments per staff member.
-- ----------------------------------------------------------------------------
create table public.appointments (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  staff_id          uuid not null references public.staff_members(id) on delete cascade,
  conversation_id   uuid references public.conversations(id) on delete set null,
  lead_id           uuid references public.leads(id) on delete set null,
  service_name      text not null default '',
  visitor_name      text not null default '',
  visitor_phone     text not null default '',
  visitor_email     text not null default '',
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  timezone          text not null default 'UTC',
  status            text not null default 'confirmed'
    check (status in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  external_event_id text not null default '',
  notes             text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint appointments_time_valid check (ends_at > starts_at),
  -- The race arbiter: live appointments for one staff member never overlap.
  constraint appointments_no_overlap exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('pending', 'confirmed'))
);

create index appointments_business_time_idx
  on public.appointments(business_id, starts_at desc);
create index appointments_staff_window_idx
  on public.appointments(staff_id, starts_at)
  where status in ('pending', 'confirmed');
create index appointments_conversation_idx
  on public.appointments(conversation_id)
  where conversation_id is not null;

create trigger appointments_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Reminder queue. Rows are claimed by the cron worker with SKIP LOCKED so
-- overlapping runs never double-send.
-- ----------------------------------------------------------------------------
create table public.appointment_reminders (
  id             bigint generated always as identity primary key,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  business_id    uuid not null references public.businesses(id) on delete cascade,
  channel        text not null check (channel in ('sms', 'whatsapp', 'email')),
  send_at        timestamptz not null,
  status         text not null default 'scheduled'
    check (status in ('scheduled', 'sent', 'failed', 'cancelled')),
  attempts       int not null default 0,
  last_error     text not null default '',
  created_at     timestamptz not null default now()
);

create index appointment_reminders_due_idx
  on public.appointment_reminders(send_at)
  where status = 'scheduled';

-- Atomically claims due reminders: flips them out of 'scheduled' so no other
-- worker sees them, and returns the claimed rows for delivery.
create or replace function public.claim_due_reminders(batch_size int default 25)
returns setof public.appointment_reminders
language sql
security definer
set search_path = public
as $$
  update public.appointment_reminders r
  set status = 'failed', attempts = r.attempts + 1
  from (
    select id from public.appointment_reminders
    where status = 'scheduled' and send_at <= now()
    order by send_at
    limit batch_size
    for update skip locked
  ) due
  where r.id = due.id
  returning r.*;
$$;

revoke all on function public.claim_due_reminders(int) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Calendar connections — OAuth/Basic credentials per business or staff
-- member. Service-role only: no RLS grants to dashboard users; tokens never
-- reach the browser.
-- ----------------------------------------------------------------------------
create table public.calendar_connections (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  staff_id      uuid references public.staff_members(id) on delete cascade,
  provider      text not null check (provider in ('google', 'outlook', 'caldav')),
  calendar_ref  text not null default '',
  access_token  text not null default '',
  refresh_token text not null default '',
  expires_at    timestamptz,
  basic_username text not null default '',
  basic_password text not null default '',
  created_at    timestamptz not null default now(),
  unique (business_id, staff_id, provider)
);

-- ----------------------------------------------------------------------------
-- RLS. The widget/booking path uses the service role with tenant scoping in
-- code; dashboard users read their own business's scheduling data.
-- ----------------------------------------------------------------------------
alter table public.staff_members         enable row level security;
alter table public.scheduling_settings   enable row level security;
alter table public.appointments          enable row level security;
alter table public.appointment_reminders enable row level security;
alter table public.calendar_connections  enable row level security;

create policy "members read staff" on public.staff_members
  for select using (public.is_business_member(business_id));
create policy "admins manage staff" on public.staff_members
  for all using (public.is_business_admin(business_id));

create policy "members read scheduling settings" on public.scheduling_settings
  for select using (public.is_business_member(business_id));
create policy "admins manage scheduling settings" on public.scheduling_settings
  for all using (public.is_business_admin(business_id));

create policy "members read appointments" on public.appointments
  for select using (public.is_business_member(business_id));
create policy "members update appointments" on public.appointments
  for update using (public.is_business_member(business_id));

create policy "members read reminders" on public.appointment_reminders
  for select using (public.is_business_member(business_id));

-- calendar_connections: intentionally no policies — service role only.

-- New usage events for the booking funnel.
alter table public.usage_events
  drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
  add constraint usage_events_event_type_check check (event_type in
    ('widget_loaded', 'conversation_started', 'message_sent',
     'lead_captured', 'voice_used', 'unanswered_question',
     'appointment_booked', 'appointment_rescheduled', 'appointment_cancelled'));
