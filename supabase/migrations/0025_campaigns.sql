-- Campaigns deliberately require explicit consent and a published pinned version.
create table public.campaigns (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 agent_id uuid not null references public.agents(id),
 agent_version_id uuid not null references public.agent_versions(id),
 phone_number_id uuid not null references public.phone_numbers(id),
 name text not null check(length(name) between 1 and 160),
 state text not null default 'draft' check(state in ('draft','active','paused','completed','cancelled')),
 timezone text not null default 'UTC',
 weekdays integer[] not null default '{1,2,3,4,5}' check(cardinality(weekdays) between 1 and 7 and weekdays <@ array[0,1,2,3,4,5,6]),
 start_minute integer not null default 540 check(start_minute between 0 and 1439),
 end_minute integer not null default 1020 check(end_minute between 1 and 1440 and end_minute > start_minute),
 max_attempts integer not null default 3 check(max_attempts between 1 and 10),
 retry_delay_seconds integer not null default 86400 check(retry_delay_seconds between 60 and 2592000),
 created_at timestamptz not null default now(),
 unique(id,business_id)
);
create table public.campaign_contacts (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 campaign_id uuid not null,
 customer_id uuid not null,
 consent_at timestamptz not null,
 target_number text not null check(target_number ~ '^\+[1-9][0-9]{7,14}$'),
 state text not null default 'pending' check(state in ('pending','dialing','accepted','completed','blocked','exhausted','uncertain')),
 attempt integer not null default 0 check(attempt between 0 and 10),
 due_at timestamptz not null default now(),
 claimed_at timestamptz,
 provider_call_id text,
 outcome text,
 foreign key(campaign_id,business_id) references public.campaigns(id,business_id) on delete cascade,
 foreign key(customer_id,business_id) references public.customers(id,business_id) on delete cascade,
 unique(campaign_id,customer_id),
 unique(id,business_id,campaign_id)
);
create index campaign_contacts_due_idx on public.campaign_contacts(business_id,campaign_id,due_at) where state='pending';
create table public.campaign_events (
 id bigint generated always as identity primary key,
 business_id uuid not null references public.businesses(id) on delete cascade,
 campaign_id uuid not null,
 contact_id uuid,
 type text not null, attempt integer,
 created_at timestamptz not null default now(),
 foreign key(campaign_id,business_id) references public.campaigns(id,business_id) on delete cascade,
 foreign key(contact_id,business_id,campaign_id) references public.campaign_contacts(id,business_id,campaign_id) on delete cascade
);
alter table public.campaigns enable row level security;
alter table public.campaign_contacts enable row level security;
alter table public.campaign_events enable row level security;
create policy campaigns_read on public.campaigns for select to authenticated using(public.is_business_member(business_id));
create policy campaign_contacts_read on public.campaign_contacts for select to authenticated using(public.is_business_member(business_id));
create policy campaign_events_read on public.campaign_events for select to authenticated using(public.is_business_member(business_id));
revoke all on public.campaigns,public.campaign_contacts,public.campaign_events from anon,authenticated;
grant select on public.campaigns,public.campaign_contacts,public.campaign_events to authenticated;
grant all on public.campaigns,public.campaign_contacts,public.campaign_events to service_role;
grant usage,select on sequence public.campaign_events_id_seq to service_role;

create function public.guard_campaign() returns trigger language plpgsql set search_path=public as $$
begin
 if not exists(select 1 from pg_timezone_names where name=new.timezone) then raise exception 'Invalid timezone'; end if;
 if not exists(select 1 from public.agent_versions v join public.agents a on a.id=v.agent_id
   where v.id=new.agent_version_id and v.business_id=new.business_id and v.agent_id=new.agent_id
   and v.published_at is not null and a.business_id=new.business_id) then raise exception 'Invalid campaign version'; end if;
 if not exists(select 1 from public.phone_numbers n where n.id=new.phone_number_id and n.business_id=new.business_id)
 then raise exception 'Invalid campaign number'; end if;
 if tg_op='UPDATE' then
   if old.state in ('completed','cancelled') and new is distinct from old then raise exception 'Campaign is terminal'; end if;
   if (new.business_id,new.agent_id,new.agent_version_id,new.phone_number_id) is distinct from
      (old.business_id,old.agent_id,old.agent_version_id,old.phone_number_id) then raise exception 'Campaign identity is immutable'; end if;
 end if;
 return new;
end $$;
create trigger campaigns_guard before insert or update on public.campaigns for each row execute function public.guard_campaign();

create function public.campaign_contact_eligible(p_business_id uuid,p_contact_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
select exists(select 1 from public.campaign_contacts t join public.campaigns c on c.id=t.campaign_id
 join public.customers u on u.id=t.customer_id and u.business_id=t.business_id
 join public.agents a on a.id=c.agent_id and a.business_id=c.business_id
 join public.phone_numbers n on n.id=c.phone_number_id and n.business_id=c.business_id
 where t.id=p_contact_id and t.business_id=p_business_id and c.business_id=p_business_id
 and c.state='active' and a.status='active' and n.status='active' and t.consent_at <= now()
 and u.lead_state not in ('DO_NOT_CONTACT','LOST','CONVERTED','UNQUALIFIED') and u.merged_into is null
 and u.phone=t.target_number
 and not exists(select 1 from public.phone_suppressions s where s.business_id=t.business_id and s.e164=t.target_number)
 and extract(dow from now() at time zone c.timezone)::integer=any(c.weekdays)
 and (extract(hour from now() at time zone c.timezone)*60+extract(minute from now() at time zone c.timezone)) >= c.start_minute
 and (extract(hour from now() at time zone c.timezone)*60+extract(minute from now() at time zone c.timezone)) < c.end_minute);
$$;
create function public.claim_campaign_contacts(p_business_id uuid,p_campaign_id uuid,p_limit integer default 10)
returns setof public.campaign_contacts language plpgsql security definer set search_path=public as $$
begin
 if p_limit < 1 or p_limit > 100 then raise exception 'Invalid batch'; end if;
 return query
 with picked as (select t.id from public.campaign_contacts t join public.campaigns c on c.id=t.campaign_id
 where t.business_id=p_business_id and t.campaign_id=p_campaign_id and t.state='pending' and t.due_at<=now()
 and t.attempt<c.max_attempts and public.campaign_contact_eligible(p_business_id,t.id)
 order by t.due_at,t.id limit p_limit for update of t skip locked),
 claimed as (update public.campaign_contacts t set state='dialing',attempt=attempt+1,claimed_at=now()
 from picked where t.id=picked.id returning t.*),
 audit as (insert into public.campaign_events(business_id,campaign_id,contact_id,type,attempt)
 select business_id,campaign_id,id,'claimed',attempt from claimed)
 select * from claimed;
end $$;
revoke all on function public.campaign_contact_eligible(uuid,uuid),public.claim_campaign_contacts(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.campaign_contact_eligible(uuid,uuid),public.claim_campaign_contacts(uuid,uuid,integer) to service_role;

create function public.settle_campaign_contact(p_business_id uuid,p_contact_id uuid,p_attempt integer,p_status text,p_retryable boolean,p_provider_call_id text default null)
returns void language plpgsql security definer set search_path=public as $$
declare t public.campaign_contacts; c public.campaigns; next_state text;
begin
 select * into t from public.campaign_contacts where id=p_contact_id and business_id=p_business_id for update;
 if not found then raise exception 'Contact not found'; end if;
 if t.attempt<>p_attempt then raise exception 'Stale attempt'; end if;
 if t.state<>'dialing' then return; end if;
 select * into c from public.campaigns where id=t.campaign_id;
 if p_status='accepted' then
   if p_provider_call_id is null or length(p_provider_call_id) not between 1 and 128 then raise exception 'Missing call id'; end if;
   next_state:='accepted';
 elsif p_status='unknown' then next_state:='uncertain';
 elsif p_status='rejected' then
   next_state:=case when not p_retryable then 'blocked' when t.attempt>=c.max_attempts then 'exhausted' else 'pending' end;
 else raise exception 'Invalid dial result'; end if;
 update public.campaign_contacts set state=next_state,provider_call_id=p_provider_call_id,
 due_at=now()+make_interval(secs=>c.retry_delay_seconds) where id=t.id;
 insert into public.campaign_events(business_id,campaign_id,contact_id,type,attempt) values(p_business_id,t.campaign_id,t.id,next_state,p_attempt);
end $$;
revoke all on function public.settle_campaign_contact(uuid,uuid,integer,text,boolean,text) from public,anon,authenticated;
grant execute on function public.settle_campaign_contact(uuid,uuid,integer,text,boolean,text) to service_role;

-- A verified completion can deterministically schedule ONE next attempt.
-- Re-delivery is harmless; stale outcomes cannot settle a newer attempt.
create function public.complete_campaign_contact(p_business_id uuid,p_contact_id uuid,p_attempt integer,p_provider_call_id text,p_outcome text,p_followup_at timestamptz default null)
returns void language plpgsql security definer set search_path=public as $$
declare t public.campaign_contacts; c public.campaigns; target text; current_lead text;
begin
 select * into t from public.campaign_contacts where id=p_contact_id and business_id=p_business_id for update;
 if not found then raise exception 'Contact not found'; end if;
 if t.attempt<>p_attempt or t.provider_call_id is distinct from p_provider_call_id then raise exception 'Stale or foreign call outcome'; end if;
 if t.state<>'accepted' then return; end if;
 if p_outcome not in ('qualified','not_qualified','callback_requested','not_interested','wrong_number','language_barrier','do_not_call','appointment_booked','escalated_to_human','no_outcome','busy','no_answer','failed') then raise exception 'Invalid outcome'; end if;
 if p_followup_at is not null and (p_outcome not in ('callback_requested','busy','no_answer','failed') or p_followup_at<=now()) then raise exception 'Invalid follow-up'; end if;
 select * into c from public.campaigns where id=t.campaign_id;
 target:=case p_outcome when 'qualified' then 'QUALIFIED' when 'not_qualified' then 'UNQUALIFIED'
 when 'callback_requested' then 'FOLLOW_UP_REQUIRED' when 'not_interested' then 'LOST'
 when 'wrong_number' then 'DO_NOT_CONTACT' when 'do_not_call' then 'DO_NOT_CONTACT'
 when 'appointment_booked' then 'APPOINTMENT_BOOKED' else null end;
 select lead_state into current_lead from public.customers where id=t.customer_id and business_id=p_business_id for update;
 if target is not null and public.lead_transition_allowed(current_lead,target) then
 perform public.transition_lead(p_business_id,t.customer_id,'campaign:'||t.id||':'||p_attempt,target,p_outcome);
 end if;
 update public.campaign_contacts set outcome=p_outcome,
 state=case when p_followup_at is not null and t.attempt<c.max_attempts and current_lead<>'DO_NOT_CONTACT' then 'pending' else 'completed' end,
 due_at=coalesce(p_followup_at,due_at) where id=t.id;
 insert into public.campaign_events(business_id,campaign_id,contact_id,type,attempt)
 values(p_business_id,t.campaign_id,t.id,case when p_followup_at is not null and t.attempt<c.max_attempts then 'followup_created' else 'outcome_recorded' end,p_attempt);
end $$;
revoke all on function public.complete_campaign_contact(uuid,uuid,integer,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.complete_campaign_contact(uuid,uuid,integer,text,text,timestamptz) to service_role;

-- A consent record is tied to its enrolled destination, not a mutable CRM phone.
create function public.guard_campaign_contact() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op='INSERT' then
   select phone into new.target_number from public.customers where id=new.customer_id and business_id=new.business_id;
 elsif (new.business_id,new.campaign_id,new.customer_id,new.target_number,new.consent_at) is distinct from
       (old.business_id,old.campaign_id,old.customer_id,old.target_number,old.consent_at) then
   raise exception 'Contact identity and consent are immutable';
 end if;
 return new;
end $$;
create trigger campaign_contact_guard before insert or update on public.campaign_contacts
for each row execute function public.guard_campaign_contact();
-- Avoid simultaneous calls to one lead even across separate campaigns.
create unique index campaign_one_active_contact on public.campaign_contacts(business_id,customer_id)
where state in ('dialing','accepted','uncertain');
