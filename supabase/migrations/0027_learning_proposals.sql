-- Learning produces proposals. Only a tenant admin may approve an evaluated
-- proposal; approval creates an inert draft and never changes production.
create table public.learning_proposals (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 source_version_id uuid not null references public.agent_versions(id),
 proposal_key text not null check(length(proposal_key) between 1 and 160),
 rationale text not null check(length(rationale) between 1 and 2000),
 candidate_config jsonb not null check(jsonb_typeof(candidate_config)='object'),
 candidate_prompt text not null check(length(candidate_prompt)<=40000),
 state text not null default 'proposed' check(state in ('proposed','evaluated','approved','rejected')),
 evaluation jsonb,
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 draft_version_id uuid references public.agent_versions(id),
 created_at timestamptz not null default now(),
 unique(business_id,proposal_key)
);
alter table public.learning_proposals enable row level security;
create policy learning_proposals_read on public.learning_proposals for select to authenticated using(public.is_business_member(business_id));
revoke all on public.learning_proposals from anon,authenticated;
grant select on public.learning_proposals to authenticated;
grant all on public.learning_proposals to service_role;
create function public.guard_learning_proposal() returns trigger language plpgsql set search_path=public as $$
begin
 if not exists(select 1 from public.agent_versions where id=new.source_version_id and business_id=new.business_id and published_at is not null)
 then raise exception 'Learning source must be a published version of this tenant'; end if;
 if tg_op='UPDATE' then
   if (new.business_id,new.source_version_id,new.proposal_key,new.candidate_config,new.candidate_prompt,new.rationale) is distinct from
      (old.business_id,old.source_version_id,old.proposal_key,old.candidate_config,old.candidate_prompt,old.rationale)
   then raise exception 'Proposal content is immutable; create a new proposal'; end if;
   if old.state in ('approved','rejected') then raise exception 'Reviewed proposal is immutable'; end if;
 end if;
 return new;
end $$;
create trigger learning_proposal_guard before insert or update on public.learning_proposals for each row execute function public.guard_learning_proposal();

create function public.evaluate_learning_proposal(p_business_id uuid,p_id uuid,p_corpus text,p_passed integer,p_total integer)
returns void language plpgsql security definer set search_path=public as $$
begin
 if p_corpus is null or p_total is null or p_passed is null or length(p_corpus) not between 1 and 160 or p_total<1 or p_passed<0 or p_passed>p_total then raise exception 'Invalid evaluation'; end if;
 update public.learning_proposals set state='evaluated',evaluation=jsonb_build_object('corpus',p_corpus,'passed',p_passed,'total',p_total,'at',now())
 where id=p_id and business_id=p_business_id and state in ('proposed','evaluated');
 if not found then raise exception 'Proposal unavailable'; end if;
end $$;
revoke all on function public.evaluate_learning_proposal(uuid,uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.evaluate_learning_proposal(uuid,uuid,text,integer,integer) to service_role;

create function public.review_learning_proposal(p_business_id uuid,p_id uuid,p_approve boolean)
returns uuid language plpgsql security definer set search_path=public as $$
declare p public.learning_proposals; source public.agent_versions; draft uuid; next_version integer;
begin
 if p_approve is null then raise exception 'Review decision required'; end if;
 if auth.uid() is null or not public.is_business_admin(p_business_id) then raise exception 'Tenant administrator required'; end if;
 select * into p from public.learning_proposals where id=p_id and business_id=p_business_id for update;
 if not found then raise exception 'Proposal unavailable'; end if;
 if p.state='approved' and p_approve then return p.draft_version_id; end if;
 if p.state in ('approved','rejected') then raise exception 'Proposal already reviewed'; end if;
 if not p_approve then
   update public.learning_proposals set state='rejected',reviewed_by=auth.uid(),reviewed_at=now() where id=p.id;
   return null;
 end if;
 if p.state<>'evaluated' or p.evaluation is null or (p.evaluation->>'total')::integer<1 or
    (p.evaluation->>'passed')::integer is distinct from (p.evaluation->>'total')::integer then raise exception 'Passing evaluation required'; end if;
 select * into source from public.agent_versions where id=p.source_version_id and business_id=p_business_id;
 perform 1 from public.agents where id=source.agent_id and business_id=p_business_id and status<>'archived' for update;
 if not found then raise exception 'Agent unavailable'; end if;
 select coalesce(max(version),0)+1 into next_version from public.agent_versions where agent_id=source.agent_id;
 insert into public.agent_versions(agent_id,business_id,version,config,prompt_template,prompt_version,model,created_by)
 values(source.agent_id,p_business_id,next_version,p.candidate_config,p.candidate_prompt,source.prompt_version,source.model,auth.uid()) returning id into draft;
 update public.learning_proposals set state='approved',reviewed_by=auth.uid(),reviewed_at=now(),draft_version_id=draft where id=p.id;
 return draft;
end $$;
revoke all on function public.review_learning_proposal(uuid,uuid,boolean) from public,anon;
grant execute on function public.review_learning_proposal(uuid,uuid,boolean) to authenticated;
