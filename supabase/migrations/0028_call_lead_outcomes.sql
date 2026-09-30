-- Apply persisted deterministic outcomes to the existing CRM lifecycle.
-- No model text, supplied disposition, or unverified call ID may change it.
create function public.apply_call_lead_outcome(p_business_id uuid,p_customer_id uuid,p_call_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare o public.conversation_outcomes; c public.calls; u public.customers; target text;
begin
 select * into c from public.calls where id=p_call_id and business_id=p_business_id;
 if not found then raise exception 'Call not found'; end if;
 select * into o from public.conversation_outcomes where call_id=p_call_id and business_id=p_business_id;
 if not found then raise exception 'Verified call outcome required'; end if;
 select * into u from public.customers where id=p_customer_id and business_id=p_business_id for update;
 if not found then raise exception 'Customer not found'; end if;
 if u.phone='' or u.phone is distinct from (case when c.direction='outbound' then c.to_number else c.from_number end)
 then raise exception 'Customer does not match call destination'; end if;
 target:=case when o.do_not_call then 'DO_NOT_CONTACT' else case o.disposition
 when 'qualified' then 'QUALIFIED' when 'not_qualified' then 'UNQUALIFIED'
 when 'callback_requested' then 'FOLLOW_UP_REQUIRED' when 'not_interested' then 'LOST'
 when 'wrong_number' then 'DO_NOT_CONTACT' when 'do_not_call' then 'DO_NOT_CONTACT'
 when 'appointment_booked' then 'APPOINTMENT_BOOKED' else null end end;
 if target is null or not public.lead_transition_allowed(u.lead_state,target) then return u.lead_state; end if;
 return public.transition_lead(p_business_id,p_customer_id,'call:'||p_call_id,target,o.disposition);
end $$;
revoke all on function public.apply_call_lead_outcome(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.apply_call_lead_outcome(uuid,uuid,uuid) to service_role;

-- Dashboard edits may not bypass the audited lifecycle service.
create or replace function public.guard_lead_transition() returns trigger language plpgsql set search_path = public as $$
begin
  if new.lead_state is distinct from old.lead_state and current_user in ('authenticated','anon') then
    raise exception 'Lead lifecycle writes require the trusted service';
  end if;
  if not public.lead_transition_allowed(old.lead_state,new.lead_state) then
    raise exception 'Illegal lead transition';
  end if;
  return new;
end $$;
