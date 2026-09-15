-- ============================================================================
-- Booking drafts: the appointment a conversation is still assembling.
--
-- A booking is rarely one message — service, day, name and phone arrive over
-- several turns, and visitors correct themselves. Without somewhere to put
-- the half-finished appointment, every turn re-derives it from the
-- transcript and the receptionist re-asks what it was already told.
--
-- One draft per conversation (primary key), deleted the moment the
-- appointment is actually created, and cascaded away with the conversation
-- so the retention purge needs no extra work.
-- ============================================================================

create table public.booking_drafts (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  business_id     uuid not null references public.businesses(id) on delete cascade,
  service         text not null default '',
  -- Wall clock in the business timezone: what the visitor actually said.
  -- Resolved against real open slots at booking time, never stored as an
  -- instant here (an instant would imply a slot we haven't verified).
  draft_date      text not null default '',
  draft_time      text not null default '',
  visitor_name    text not null default '',
  visitor_email   text not null default '',
  visitor_phone   text not null default '',
  notes           text not null default '',
  -- The visitor AGREED to draft_date/draft_time rather than merely asking
  -- about them. Only a committed time may be booked automatically.
  time_committed  boolean not null default false,
  updated_at      timestamptz not null default now()
);

create index booking_drafts_business_idx on public.booking_drafts(business_id);

create trigger booking_drafts_updated_at
  before update on public.booking_drafts
  for each row execute function public.set_updated_at();

-- RLS: written by the widget path on the service role with tenant scoping in
-- code; dashboard members may read their own business's in-flight bookings.
alter table public.booking_drafts enable row level security;

create policy "members read booking drafts" on public.booking_drafts
  for select using (public.is_business_member(business_id));
