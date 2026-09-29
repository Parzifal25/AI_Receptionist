-- Generic lead lifecycle extends the existing CRM identity, not a second lead store.
alter table public.customers add column lead_state text not null default 'NEW';
alter table public.customers add constraint customers_lead_state_check check (lead_state in ('NEW','CONTACTING','CONNECTED','QUALIFYING','QUALIFIED','UNQUALIFIED','APPOINTMENT_PENDING','APPOINTMENT_BOOKED','FOLLOW_UP_REQUIRED','NURTURE','CONVERTED','LOST','DO_NOT_CONTACT'));
alter table public.customers add constraint customers_id_business_unique unique (id, business_id);
create table public.lead_state_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null,
  event_key text not null check (length(event_key) between 1 and 200),
  from_state text not null, to_state text not null,
  reason text not null check (length(reason) between 1 and 300),
  created_at timestamptz not null default now(),
  foreign key (customer_id,business_id) references public.customers(id,business_id) on delete cascade,
  unique (business_id,event_key)
);
create index lead_state_events_customer_idx on public.lead_state_events(business_id,customer_id,created_at);
alter table public.lead_state_events enable row level security;
create policy lead_state_events_read on public.lead_state_events for select to authenticated using (public.is_business_member(business_id));
revoke all on public.lead_state_events from anon, authenticated;
grant select on public.lead_state_events to authenticated;
grant all on public.lead_state_events to service_role;

create function public.lead_transition_allowed(old_state text,new_state text) returns boolean
language sql immutable set search_path = public as $$
select old_state = new_state or new_state = 'DO_NOT_CONTACT' or case old_state
when 'NEW' then new_state = any(array['CONTACTING','CONNECTED','QUALIFYING','QUALIFIED','UNQUALIFIED','APPOINTMENT_BOOKED','FOLLOW_UP_REQUIRED','LOST']::text[])
when 'CONTACTING' then new_state = any(array['CONNECTED','QUALIFYING','QUALIFIED','UNQUALIFIED','APPOINTMENT_BOOKED','FOLLOW_UP_REQUIRED','NURTURE','LOST']::text[])
when 'CONNECTED' then new_state = any(array['QUALIFYING','QUALIFIED','UNQUALIFIED','APPOINTMENT_PENDING','APPOINTMENT_BOOKED','FOLLOW_UP_REQUIRED','LOST']::text[])
when 'QUALIFYING' then new_state = any(array['QUALIFIED','UNQUALIFIED','APPOINTMENT_PENDING','APPOINTMENT_BOOKED','FOLLOW_UP_REQUIRED','LOST']::text[])
when 'QUALIFIED' then new_state = any(array['APPOINTMENT_PENDING','APPOINTMENT_BOOKED','FOLLOW_UP_REQUIRED','CONVERTED','LOST']::text[])
when 'UNQUALIFIED' then new_state = any(array['NURTURE','LOST']::text[])
when 'APPOINTMENT_PENDING' then new_state = any(array['APPOINTMENT_BOOKED','FOLLOW_UP_REQUIRED','LOST']::text[])
when 'APPOINTMENT_BOOKED' then new_state = any(array['FOLLOW_UP_REQUIRED','CONVERTED','LOST']::text[])
when 'FOLLOW_UP_REQUIRED' then new_state = any(array['CONTACTING','CONNECTED','QUALIFYING','QUALIFIED','UNQUALIFIED','APPOINTMENT_PENDING','APPOINTMENT_BOOKED','NURTURE','CONVERTED','LOST']::text[])
when 'NURTURE' then new_state = any(array['CONTACTING','CONNECTED','FOLLOW_UP_REQUIRED','LOST']::text[])
when 'CONVERTED' then new_state = any(array[]::text[])
when 'LOST' then new_state = any(array[]::text[])
when 'DO_NOT_CONTACT' then new_state = any(array[]::text[])
else false end;
$$;
create function public.guard_lead_transition() returns trigger language plpgsql set search_path = public as $$
begin
  if not public.lead_transition_allowed(old.lead_state,new.lead_state) then
    raise exception 'Illegal lead transition';
  end if;
  return new;
end $$;
create trigger customers_lead_transition before update of lead_state on public.customers
for each row execute function public.guard_lead_transition();

-- Lock the customer before checking idempotency: concurrent deliveries serialize.
create function public.transition_lead(p_business_id uuid,p_customer_id uuid,p_event_key text,p_to_state text,p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare current_state text; prior public.lead_state_events;
begin
  select lead_state into current_state from public.customers where id=p_customer_id and business_id=p_business_id for update;
  if not found then raise exception 'Customer not found'; end if;
  select * into prior from public.lead_state_events where business_id=p_business_id and event_key=p_event_key;
  if found then
    if prior.customer_id <> p_customer_id or prior.to_state <> p_to_state then raise exception 'Idempotency key conflict'; end if;
    return current_state;
  end if;
  update public.customers set lead_state=p_to_state where id=p_customer_id and business_id=p_business_id;
  insert into public.lead_state_events(business_id,customer_id,event_key,from_state,to_state,reason)
  values(p_business_id,p_customer_id,p_event_key,current_state,p_to_state,p_reason);
  return p_to_state;
end $$;
revoke all on function public.transition_lead(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.transition_lead(uuid,uuid,text,text,text) to service_role;
