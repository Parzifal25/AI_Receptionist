-- ============================================================================
-- Conversation counters maintained by the database.
--
-- The application previously read message_count and wrote it back +N — two
-- extra round trips and a lost-update race when turns overlap. A trigger
-- keeps message_count and last_message_at correct no matter who inserts.
-- ============================================================================

create or replace function public.bump_conversation_on_message()
returns trigger
language plpgsql
as $$
begin
  update public.conversations
  set message_count   = message_count + 1,
      last_message_at = greatest(last_message_at, new.created_at)
  where id = new.conversation_id;
  return new;
end;
$$;

revoke execute on function public.bump_conversation_on_message() from public, anon, authenticated;

create trigger messages_bump_conversation
  after insert on public.messages
  for each row execute function public.bump_conversation_on_message();

-- Backfill: make stored counts trustworthy before code starts relying on them.
update public.conversations c
set message_count = coalesce(m.actual, 0),
    last_message_at = greatest(c.last_message_at, coalesce(m.latest, c.last_message_at))
from (
  select conversation_id, count(*) as actual, max(created_at) as latest
  from public.messages
  group by conversation_id
) m
where m.conversation_id = c.id
  and (c.message_count is distinct from m.actual);
