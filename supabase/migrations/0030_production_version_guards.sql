-- Production identities must be published and remain pinned, even if a
-- service-role caller makes a mistake. Existing tenant ownership guards stay.
create function public.guard_production_version() returns trigger language plpgsql security definer set search_path=public as $$
declare version_id uuid; linked public.calls;
begin
 if tg_table_name='agents' then
   version_id:=new.live_version_id;
 else
   version_id:=new.agent_version_id;
 end if;
 if version_id is not null and not exists(select 1 from public.agent_versions where id=version_id and published_at is not null) then
   raise exception 'Production version must be published';
 end if;
 if tg_table_name='calls' then
   if tg_op='UPDATE' then
     if (new.business_id,new.agent_id,new.agent_version_id,new.phone_number_id,new.direction,new.provider,new.provider_call_id,new.from_number,new.to_number)
       is distinct from (old.business_id,old.agent_id,old.agent_version_id,old.phone_number_id,old.direction,old.provider,old.provider_call_id,old.from_number,old.to_number)
     then raise exception 'Call identity is immutable'; end if;
     if old.conversation_id is not null and new.conversation_id is distinct from old.conversation_id then raise exception 'Call conversation is pinned'; end if;
   end if;
   if new.conversation_id is not null and not exists(select 1 from public.conversations c where c.id=new.conversation_id
     and c.business_id=new.business_id and c.agent_id=new.agent_id and c.agent_version_id=new.agent_version_id)
   then raise exception 'Call conversation version mismatch'; end if;
 elsif tg_table_name='conversations' then
   if tg_op='UPDATE' then
     if old.agent_version_id is not null and (new.business_id,new.agent_id,new.agent_version_id) is distinct from
       (old.business_id,old.agent_id,old.agent_version_id) then raise exception 'Conversation version is pinned'; end if;
   end if;
 elsif tg_table_name='conversation_outcomes' then
   if new.call_id is not null then
     select * into linked from public.calls where id=new.call_id;
     if not found or (linked.business_id,linked.agent_id,linked.agent_version_id,linked.conversation_id) is distinct from
       (new.business_id,new.agent_id,new.agent_version_id,new.conversation_id) then raise exception 'Outcome call version mismatch'; end if;
   end if;
 end if;
 return new;
end $$;
create trigger agents_production_version before insert or update of live_version_id on public.agents for each row execute function public.guard_production_version();
create trigger calls_production_version before insert or update on public.calls for each row execute function public.guard_production_version();
create trigger conversations_production_version before insert or update of business_id,agent_id,agent_version_id on public.conversations for each row execute function public.guard_production_version();
create trigger outcomes_production_version before insert or update on public.conversation_outcomes for each row execute function public.guard_production_version();
revoke all on function public.guard_production_version() from public,anon,authenticated;

-- Cross-process session admission. Creating the conversation and claiming
-- the call are one transaction; a second gateway cannot start duplicate turns.
create function public.begin_call_conversation(p_business_id uuid,p_call_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare leg public.calls; conversation uuid;
begin
 select * into leg from public.calls where id=p_call_id and business_id=p_business_id for update;
 if not found or leg.conversation_id is not null or leg.state in ('completed','transferred','no_answer','busy','failed','cancelled') then return null; end if;
 if leg.direction='outbound' and not exists(select 1 from public.campaign_contacts t
   join public.campaigns c on c.id=t.campaign_id join public.phone_numbers n on n.id=c.phone_number_id
   where t.business_id=leg.business_id and t.provider_call_id=leg.provider_call_id and n.provider=leg.provider
   and c.agent_version_id=leg.agent_version_id and t.state='accepted' and public.campaign_contact_eligible(t.business_id,t.id))
 then return null; end if;
 insert into public.conversations(business_id,agent_id,agent_version_id,channel)
 values(leg.business_id,leg.agent_id,leg.agent_version_id,'phone') returning id into conversation;
 update public.calls set conversation_id=conversation where id=leg.id;
 return conversation;
end $$;
revoke all on function public.begin_call_conversation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_call_conversation(uuid,uuid) to service_role;

-- A committed outcome cannot lose its DNC/CRM effect between application
-- writes. Apply to existing verified phone identities in the same transaction.
create function public.persist_outcome_safety() returns trigger language plpgsql security definer set search_path=public as $$
declare leg public.calls; destination text; customer uuid;
begin
 if new.call_id is null then return new; end if;
 select * into leg from public.calls where id=new.call_id and business_id=new.business_id;
 destination:=case when leg.direction='outbound' then leg.to_number else leg.from_number end;
 if new.do_not_call or new.disposition in ('do_not_call','wrong_number') then
   insert into public.phone_suppressions(business_id,e164,reason,call_id)
   values(new.business_id,destination,case when new.disposition='wrong_number' then 'wrong_number' else 'do_not_call' end,new.call_id)
   on conflict(business_id,e164) do nothing;
 end if;
 for customer in select id from public.customers where business_id=new.business_id and phone=destination and merged_into is null loop
   perform public.apply_call_lead_outcome(new.business_id,customer,new.call_id);
 end loop;
 return new;
end $$;
create trigger outcome_safety after insert on public.conversation_outcomes for each row execute function public.persist_outcome_safety();
revoke all on function public.persist_outcome_safety() from public,anon,authenticated;
