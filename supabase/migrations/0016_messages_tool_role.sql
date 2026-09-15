-- ============================================================================
-- HALO Phase 1 — message role expansion + tool metadata (plan §P1.2
-- "messages.role", migration 0016).
--
-- The runtime's hottest read path (getRecentMessages) must eventually be
-- able to represent tool-call transcripts: system guidance rows, assistant
-- tool calls and tool results. This migration is ONLY the data foundation —
-- no Tool Runtime, no executes. All new columns are nullable so every
-- existing write path keeps working untouched.
-- ============================================================================

-- Drop the legacy inline CHECK (unnamed by convention messages_role_check;
-- resolved generically so the exact auto-name doesn't matter).
do $$
declare v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.messages'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%role%';
  if v_conname is not null then
    execute format('alter table public.messages drop constraint %I', v_conname);
  end if;
end $$;

alter table public.messages
  add constraint messages_role_check check (role in ('user', 'assistant', 'system', 'tool'));

-- Tool-call metadata (nullable; unused by today's write path).
alter table public.messages
  add column tool_call_id text,
  add column tool_name    text check (tool_name is null or char_length(tool_name) between 1 and 200),
  add column tool_args    jsonb,
  add column tool_result  jsonb;

-- Default tool messages to the content-preserving contract: a tool result
-- row may carry no user-facing content (the runtime narrates from the
-- result), so relax the 1-char minimum for the tool role only.
do $$
declare v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.messages'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%char_length(content)%';
  if v_conname is not null then
    execute format('alter table public.messages drop constraint %I', v_conname);
  end if;
end $$;

alter table public.messages
  add constraint messages_content_check check (
    role = 'tool' or char_length(content) between 1 and 8000
  );