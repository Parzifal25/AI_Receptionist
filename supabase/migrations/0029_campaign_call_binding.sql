-- Bind accepted attempts to the same call/version records used by inbound
-- voice. Signed provider callbacks can win the race against the dial response.
create function public.create_campaign_call() returns trigger language plpgsql security definer set search_path=public as $$
declare c public.campaigns; n public.phone_numbers;
begin
 if new.state='accepted' and (old.state<>'accepted' or old.provider_call_id is distinct from new.provider_call_id) then
   select * into c from public.campaigns where id=new.campaign_id and business_id=new.business_id;
   select * into n from public.phone_numbers where id=c.phone_number_id and business_id=c.business_id;
   insert into public.calls(business_id,agent_id,agent_version_id,phone_number_id,direction,provider,provider_call_id,from_number,to_number,state)
   values(c.business_id,c.agent_id,c.agent_version_id,n.id,'outbound',n.provider,new.provider_call_id,n.e164,new.target_number,'queued');
 end if;
 return new;
end $$;
create trigger campaign_call_binding after update on public.campaign_contacts for each row execute function public.create_campaign_call();

-- Only the signature-verified gateway uses this callback binding. Identity
-- comes from the claimed contact; provider payloads must match its numbers.
create function public.bind_campaign_callback(p_contact_id uuid,p_attempt integer,p_provider text,p_provider_call_id text,p_from text,p_to text)
returns boolean language plpgsql security definer set search_path=public as $$
declare t public.campaign_contacts; c public.campaigns; n public.phone_numbers;
begin
 select * into t from public.campaign_contacts where id=p_contact_id for update;
 if not found or p_attempt is null or t.attempt<>p_attempt or t.state not in ('dialing','uncertain','accepted','pending','completed') then return false; end if;
 select * into c from public.campaigns where id=t.campaign_id and business_id=t.business_id;
 select * into n from public.phone_numbers where id=c.phone_number_id and business_id=c.business_id;
 if n.provider is distinct from p_provider or n.e164 is distinct from p_from or t.target_number is distinct from p_to
   or p_provider_call_id is null or length(p_provider_call_id) not between 1 and 128 then return false; end if;
 if t.state in ('dialing','uncertain') then
   update public.campaign_contacts set state='accepted',provider_call_id=p_provider_call_id where id=t.id;
   insert into public.campaign_events(business_id,campaign_id,contact_id,type,attempt)
   values(t.business_id,t.campaign_id,t.id,'provider_confirmed',t.attempt);
 elsif t.provider_call_id is distinct from p_provider_call_id then return false;
 end if;
 return true;
end $$;
revoke all on function public.bind_campaign_callback(uuid,integer,text,text,text,text) from public,anon,authenticated;
grant execute on function public.bind_campaign_callback(uuid,integer,text,text,text,text) to service_role;

-- Persisted business outcomes schedule deterministic follow-ups in the same
-- transaction. Duplicate outcome rows are already constrained per call.
create function public.apply_campaign_call_outcome() returns trigger language plpgsql security definer set search_path=public as $$
declare t public.campaign_contacts; c public.campaigns; leg public.calls; result text; followup timestamptz;
begin
 if tg_table_name='conversation_outcomes' then
   select * into leg from public.calls where id=new.call_id and business_id=new.business_id;
   result:=case when new.do_not_call then 'do_not_call' else new.disposition end;
 else
   leg:=new;
   if new.state=old.state or new.state not in ('busy','no_answer','failed') then return new; end if;
   result:=new.state;
 end if;
 if leg.direction<>'outbound' then return new; end if;
 select t0.* into t from public.campaign_contacts t0 join public.campaigns c0 on c0.id=t0.campaign_id
 join public.phone_numbers n on n.id=c0.phone_number_id
 where t0.business_id=leg.business_id and t0.provider_call_id=leg.provider_call_id and n.provider=leg.provider and t0.state='accepted' for update of t0;
 if not found then return new; end if;
 select * into c from public.campaigns where id=t.campaign_id;
 followup:=case when result in ('callback_requested','busy','no_answer','failed') then now()+make_interval(secs=>c.retry_delay_seconds) else null end;
 perform public.complete_campaign_contact(t.business_id,t.id,t.attempt,leg.provider_call_id,result,followup);
 return new;
end $$;
create trigger campaign_business_outcome after insert on public.conversation_outcomes for each row execute function public.apply_campaign_call_outcome();
create trigger campaign_carrier_outcome after update of state on public.calls for each row execute function public.apply_campaign_call_outcome();

-- Fair scheduling across tenants; bounded ticks rotate even when a campaign
-- has no eligible contacts. Concurrent schedulers cannot select the same row.
alter table public.campaigns add column last_dispatched_at timestamptz;
create function public.schedule_campaign_batch(p_limit integer default 20)
returns table(id uuid,business_id uuid) language plpgsql security definer set search_path=public as $$
begin
 if p_limit is null or p_limit<1 or p_limit>20 then raise exception 'Invalid scheduler batch'; end if;
 return query with selected as (select c.id from public.campaigns c where c.state='active'
 and (c.last_dispatched_at is null or c.last_dispatched_at<now()-interval '1 minute')
 order by c.last_dispatched_at nulls first,c.created_at,c.id limit p_limit for update skip locked)
 update public.campaigns c set last_dispatched_at=now() from selected s where c.id=s.id returning c.id,c.business_id;
end $$;
revoke all on function public.schedule_campaign_batch(integer) from public,anon,authenticated;
grant execute on function public.schedule_campaign_batch(integer) to service_role;
