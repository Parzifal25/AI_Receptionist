-- New conversations must be bound to a published, tenant-owned agent version.
-- Keep old null-linked rows readable so application routes can fail closed
-- and an authorized audit can identify them without inventing history.
create or replace function public.enforce_conversation_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.agent_id is null or new.agent_version_id is null then
    raise exception using errcode = '23514', message = 'new conversation requires an agent and version';
  end if;

  if not exists (
    select 1
    from public.agents a
    join public.agent_versions v
      on v.id = new.agent_version_id
     and v.agent_id = a.id
     and v.business_id = a.business_id
    where a.id = new.agent_id
      and a.business_id = new.business_id
      and v.published_at is not null
      and (
        new.receptionist_id is null
        or (a.type = 'receptionist' and a.slug = new.receptionist_id::text)
      )
  ) then
    raise exception using errcode = '23514', message = 'conversation agent identity does not match tenant and receptionist';
  end if;

  return new;
end;
$$;

drop trigger if exists conversations_identity_guard on public.conversations;
create trigger conversations_identity_guard
  before insert or update of business_id, receptionist_id, agent_id, agent_version_id, channel
  on public.conversations
  for each row execute function public.enforce_conversation_identity();

revoke all on function public.enforce_conversation_identity() from public, anon, authenticated;
