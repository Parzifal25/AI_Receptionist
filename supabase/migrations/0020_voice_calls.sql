-- ============================================================================
-- HALO Phase 3 — voice / telephony data model (plan §P5.3–§P5.5, §P5.8).
--
--   phone_numbers          tenant DID → agent routing (platform-provisioned)
--   calls                  one telephony leg: technical state + usage, pinned
--                          to the agent VERSION that served it
--   call_events            provider-neutral media-loop event + latency stream
--   call_transcript_turns  speaker-labelled, language-tagged, delivery-aware
--   conversation_outcomes  business outcome, SEPARATE from technical state
--   phone_suppressions     tenant do-not-call list (immediate, permanent)
--
-- Invariants enforced here, not in application code (plan §2.4 rule 4):
--   * a DID routes to exactly one tenant (unique provider+e164);
--   * phone numbers, calls and outcomes can only reference an agent/version
--     of the SAME tenant (ownership triggers, the 0018 precedent);
--   * call state follows the transition graph in packages/voice/call-state.ts;
--     terminal states accept nothing, even through the service role, so a late
--     provider webhook cannot resurrect a finished call;
--   * a provider call id maps to one call row (idempotent start);
--   * one outcome per call; event and transcript sequence numbers are unique
--     per call (idempotent flushes).
--
-- Every new table enables RLS with policies in this migration (§2.4 rule 3):
-- dashboard members READ their tenant's rows; all writes are service-role
-- (the voice gateway, Regime B) with tenant scoping in code AND the triggers.
-- Phone numbers are platform-provisioned (service role) so a tenant cannot
-- squat a DID that belongs to another tenant's future routing.
--
-- Additive except two relaxations on conversations (channel gains 'phone';
-- receptionist_id becomes optional ONLY for phone conversations — the widget
-- channel still requires it by CHECK). No data rewrite.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- conversations: the phone channel.
-- ----------------------------------------------------------------------------
alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations
  add constraint conversations_channel_check check (channel in ('chat', 'voice', 'phone'));
alter table public.conversations alter column receptionist_id drop not null;
alter table public.conversations
  add constraint conversations_receptionist_required
  check (receptionist_id is not null or channel = 'phone');

-- ----------------------------------------------------------------------------
-- phone_numbers
-- ----------------------------------------------------------------------------
create table public.phone_numbers (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  agent_id       uuid not null references public.agents(id) on delete cascade,
  provider       text not null check (char_length(provider) between 1 and 40),
  e164           text not null check (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Tenant-configured human handoff target. Never model-chosen.
  handoff_number text check (handoff_number is null or handoff_number ~ '^\+[1-9][0-9]{7,14}$'),
  status         text not null default 'active' check (status in ('active', 'disabled')),
  label          text not null default '' check (char_length(label) <= 80),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index phone_numbers_provider_e164_idx on public.phone_numbers(provider, e164);
create index phone_numbers_business_idx on public.phone_numbers(business_id);

create trigger phone_numbers_updated_at
  before update on public.phone_numbers
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- calls
-- ----------------------------------------------------------------------------
create table public.calls (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references public.businesses(id) on delete cascade,
  agent_id             uuid not null references public.agents(id),
  agent_version_id     uuid not null references public.agent_versions(id),
  conversation_id      uuid references public.conversations(id) on delete set null,
  phone_number_id      uuid references public.phone_numbers(id) on delete set null,
  direction            text not null check (direction in ('inbound', 'outbound')),
  provider             text not null check (char_length(provider) between 1 and 40),
  provider_call_id     text not null check (char_length(provider_call_id) between 1 and 128),
  from_number          text not null default '' check (char_length(from_number) <= 32),
  to_number            text not null default '' check (char_length(to_number) <= 32),
  state                text not null check (state in
                         ('created', 'queued', 'dialing', 'ringing', 'connected', 'in_conversation',
                          'interrupted', 'completing', 'completed', 'transferred', 'no_answer',
                          'busy', 'failed', 'cancelled')),
  state_changed_at     timestamptz not null default now(),
  answered_at          timestamptz,
  ended_at             timestamptz,
  duration_seconds     int check (duration_seconds is null or duration_seconds >= 0),
  hangup_cause         text check (hangup_cause is null or hangup_cause in
                         ('caller_hangup', 'agent_completed', 'silence_timeout', 'transferred',
                          'media_disconnected', 'stt_failure', 'tts_failure', 'agent_failure',
                          'provider_status', 'max_duration', 'gateway_shutdown', 'rejected')),
  language             text check (language is null or char_length(language) <= 16),
  -- Measured usage (audio seconds, TTS chars, model calls, tokens when reported).
  usage                jsonb not null default '{}'::jsonb,
  -- NULL = no pricing configuration: cost is reported unavailable, never invented.
  cost_estimate        numeric(12, 4),
  -- Recording is not implemented in Phase 3; columns exist so consent is
  -- recorded before any future recording (plan §P5.8: no consent, no recording).
  recording_ref        text,
  recording_consent_at timestamptz,
  correlation_id       uuid not null default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint calls_provider_call_unique unique (provider, provider_call_id),
  constraint calls_recording_requires_consent check (recording_ref is null or recording_consent_at is not null)
);

create index calls_business_created_idx on public.calls(business_id, created_at desc);
create index calls_business_state_idx on public.calls(business_id, state);
create index calls_conversation_idx on public.calls(conversation_id);

create trigger calls_updated_at
  before update on public.calls
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- call_events — append-only media-loop stream (no transcript text).
-- ----------------------------------------------------------------------------
create table public.call_events (
  id          bigint generated always as identity primary key,
  call_id     uuid not null references public.calls(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  seq         int not null check (seq >= 0),
  type        text not null check (type in
                ('session_started', 'state_changed', 'speech_started', 'endpoint', 'stt_partial',
                 'stt_final', 'agent_turn', 'tts_start', 'tts_first_byte', 'tts_complete',
                 'tts_cancel', 'barge_in', 'turn_complete', 'turn_cancelled', 'silence', 'dtmf',
                 'transfer', 'provider_error', 'media_disconnected', 'media_reconnected',
                 'session_ended')),
  at          timestamptz not null,
  latency_ms  int check (latency_ms is null or latency_ms >= 0),
  detail      jsonb not null default '{}'::jsonb,

  constraint call_events_seq_unique unique (call_id, seq)
);

create index call_events_business_at_idx on public.call_events(business_id, at desc);
create index call_events_latency_idx on public.call_events(business_id, type, at desc) where latency_ms is not null;

-- ----------------------------------------------------------------------------
-- call_transcript_turns
-- ----------------------------------------------------------------------------
create table public.call_transcript_turns (
  id              bigint generated always as identity primary key,
  call_id         uuid not null references public.calls(id) on delete cascade,
  business_id     uuid not null references public.businesses(id) on delete cascade,
  seq             int not null check (seq >= 0),
  turn_index      int not null check (turn_index >= 0),
  speaker         text not null check (speaker in ('caller', 'agent')),
  source          text not null check (source in ('caller', 'runtime', 'voice_policy')),
  -- Original text, verbatim (caller STT output / full agent reply).
  text            text not null check (char_length(text) <= 4000),
  -- For interrupted agent turns: the portion the caller heard.
  delivered_text  text check (delivered_text is null or char_length(delivered_text) <= 4000),
  delivery        text not null check (delivery in ('complete', 'interrupted', 'not_delivered')),
  language        text check (language is null or char_length(language) <= 16),
  stt_confidence  numeric(4, 3) check (stt_confidence is null or (stt_confidence >= 0 and stt_confidence <= 1)),
  turn_id         text check (turn_id is null or char_length(turn_id) <= 64),
  started_at      timestamptz not null,
  ended_at        timestamptz not null,

  constraint call_transcript_seq_unique unique (call_id, seq)
);

create index call_transcript_business_idx on public.call_transcript_turns(business_id);

-- ----------------------------------------------------------------------------
-- conversation_outcomes — the structured business result (plan §P5.4).
-- ----------------------------------------------------------------------------
create table public.conversation_outcomes (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  conversation_id    uuid references public.conversations(id) on delete cascade,
  call_id            uuid references public.calls(id) on delete cascade,
  agent_id           uuid not null references public.agents(id),
  agent_version_id   uuid not null references public.agent_versions(id),
  disposition        text not null check (disposition in
                       ('qualified', 'not_qualified', 'callback_requested', 'not_interested',
                        'wrong_number', 'language_barrier', 'do_not_call', 'appointment_booked',
                        'escalated_to_human', 'no_outcome')),
  disposition_reason text check (disposition_reason is null or char_length(disposition_reason) <= 200),
  -- Normalized qualification fields, each with its raw utterance and confidence.
  qualification      jsonb not null default '{}'::jsonb,
  appointment_id     uuid references public.appointments(id) on delete set null,
  escalated          boolean not null default false,
  do_not_call        boolean not null default false,
  computed_by        text not null default 'deterministic' check (computed_by in ('deterministic', 'human')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint conversation_outcomes_subject check (conversation_id is not null or call_id is not null)
);

create unique index conversation_outcomes_call_idx on public.conversation_outcomes(call_id) where call_id is not null;
create unique index conversation_outcomes_conversation_idx
  on public.conversation_outcomes(conversation_id) where call_id is null;
create index conversation_outcomes_business_idx on public.conversation_outcomes(business_id, created_at desc);
create index conversation_outcomes_disposition_idx on public.conversation_outcomes(business_id, disposition);

create trigger conversation_outcomes_updated_at
  before update on public.conversation_outcomes
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- phone_suppressions — tenant do-not-call list.
-- ----------------------------------------------------------------------------
create table public.phone_suppressions (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  e164        text not null check (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  reason      text not null check (reason in ('do_not_call', 'wrong_number', 'manual')),
  call_id     uuid references public.calls(id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint phone_suppressions_unique unique (business_id, e164)
);

-- ----------------------------------------------------------------------------
-- Ownership: agent / version / conversation / phone number must share the
-- row's tenant. SECURITY DEFINER so it holds for every write path; revoked
-- from clients (0002 precedent), invoked by triggers only.
-- ----------------------------------------------------------------------------
create or replace function public.assert_voice_row_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select a.business_id into owner from public.agents a where a.id = new.agent_id;
  if owner is null or owner <> new.business_id then
    raise exception '%.agent_id must reference an agent of the same business', tg_table_name;
  end if;

  if tg_table_name in ('calls', 'conversation_outcomes') then
    select av.business_id into owner from public.agent_versions av
      where av.id = new.agent_version_id and av.agent_id = new.agent_id;
    if owner is null or owner <> new.business_id then
      raise exception '%.agent_version_id must reference a version of the same agent and business', tg_table_name;
    end if;
    if new.conversation_id is not null then
      select c.business_id into owner from public.conversations c where c.id = new.conversation_id;
      if owner is null or owner <> new.business_id then
        raise exception '%.conversation_id must reference a conversation of the same business', tg_table_name;
      end if;
    end if;
  end if;

  -- Nested IFs: PL/pgSQL resolves every NEW.field in an expression, so a
  -- column that only exists on one table must not share a condition.
  if tg_table_name = 'calls' then
    if new.phone_number_id is not null then
      select p.business_id into owner from public.phone_numbers p where p.id = new.phone_number_id;
      if owner is null or owner <> new.business_id then
        raise exception 'calls.phone_number_id must reference a number of the same business';
      end if;
    end if;
  end if;

  if tg_table_name = 'conversation_outcomes' then
    if new.call_id is not null then
      select c.business_id into owner from public.calls c where c.id = new.call_id;
      if owner is null or owner <> new.business_id then
        raise exception 'conversation_outcomes.call_id must reference a call of the same business';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger phone_numbers_ownership
  before insert or update of business_id, agent_id on public.phone_numbers
  for each row execute function public.assert_voice_row_ownership();
create trigger calls_ownership
  before insert or update of business_id, agent_id, agent_version_id, conversation_id, phone_number_id on public.calls
  for each row execute function public.assert_voice_row_ownership();
create trigger conversation_outcomes_ownership
  before insert or update of business_id, agent_id, agent_version_id, conversation_id, call_id on public.conversation_outcomes
  for each row execute function public.assert_voice_row_ownership();

-- Child rows (events, transcript, suppressions) carry the call's tenant.
create or replace function public.assert_call_child_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  if new.call_id is null then
    return new;
  end if;
  select c.business_id into owner from public.calls c where c.id = new.call_id;
  if owner is null or owner <> new.business_id then
    raise exception '%.call_id must reference a call of the same business', tg_table_name;
  end if;
  return new;
end;
$$;

create trigger call_events_ownership
  before insert or update on public.call_events
  for each row execute function public.assert_call_child_ownership();
create trigger call_transcript_ownership
  before insert or update on public.call_transcript_turns
  for each row execute function public.assert_call_child_ownership();
create trigger phone_suppressions_ownership
  before insert or update on public.phone_suppressions
  for each row execute function public.assert_call_child_ownership();

-- ----------------------------------------------------------------------------
-- Call state transitions — mirrors packages/voice/call-state.ts TRANSITIONS
-- (a parity test keeps the two in sync).
-- ----------------------------------------------------------------------------
create or replace function public.enforce_call_state_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed text[];
begin
  if new.state = old.state then
    return new;
  end if;
  allowed := case old.state
    when 'created'         then array['queued', 'dialing', 'cancelled', 'failed']
    when 'queued'          then array['dialing', 'cancelled', 'failed']
    when 'dialing'         then array['ringing', 'connected', 'no_answer', 'busy', 'failed', 'cancelled']
    when 'ringing'         then array['connected', 'no_answer', 'busy', 'failed', 'cancelled']
    when 'connected'       then array['in_conversation', 'completing', 'transferred', 'failed']
    when 'in_conversation' then array['interrupted', 'completing', 'transferred', 'failed']
    when 'interrupted'     then array['in_conversation', 'completing', 'failed']
    when 'completing'      then array['completed', 'failed']
    else array[]::text[]
  end;
  if not (new.state = any(allowed)) then
    raise exception 'illegal call state transition % -> %', old.state, new.state;
  end if;
  new.state_changed_at := now();
  return new;
end;
$$;

create trigger calls_state_transition
  before update of state on public.calls
  for each row execute function public.enforce_call_state_transition();

revoke execute on function public.assert_voice_row_ownership() from public, anon, authenticated;
revoke execute on function public.assert_call_child_ownership() from public, anon, authenticated;
revoke execute on function public.enforce_call_state_transition() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Usage events for calls.
-- ----------------------------------------------------------------------------
alter table public.usage_events
  drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
  add constraint usage_events_event_type_check check (event_type in
    ('widget_loaded', 'conversation_started', 'message_sent',
     'lead_captured', 'voice_used', 'unanswered_question',
     'appointment_booked', 'appointment_rescheduled', 'appointment_cancelled',
     'appointment_checked_in', 'appointment_completed', 'appointment_no_show',
     'reminder_sent', 'reminder_failed',
     'review_requested', 'feedback_received',
     'customer_created', 'workflow_custom',
     'call_started', 'call_completed'));

-- ----------------------------------------------------------------------------
-- Retention: calls (and, by cascade, their events, transcripts and outcomes)
-- follow business_settings.data_retention_days like conversations do.
-- Signature unchanged (callers read the two existing columns).
-- ----------------------------------------------------------------------------
create or replace function public.purge_expired_data()
returns table (deleted_conversations bigint, deleted_events bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  conv_count bigint;
  event_count bigint;
begin
  delete from public.calls k
  using public.business_settings s
  where k.business_id = s.business_id
    and k.created_at < now() - make_interval(days => s.data_retention_days);

  with settings as (
    select business_id, data_retention_days from public.business_settings
  ),
  deleted as (
    delete from public.conversations c
    using settings s
    where c.business_id = s.business_id
      and c.started_at < now() - make_interval(days => s.data_retention_days)
    returning c.id
  )
  select count(*) into conv_count from deleted;

  with settings as (
    select business_id, data_retention_days from public.business_settings
  ),
  deleted as (
    delete from public.usage_events e
    using settings s
    where e.business_id = s.business_id
      and e.created_at < now() - make_interval(days => s.data_retention_days)
    returning e.id
  )
  select count(*) into event_count from deleted;

  return query select conv_count, event_count;
end;
$$;

revoke execute on function public.purge_expired_data() from public, anon, authenticated;
grant  execute on function public.purge_expired_data() to service_role;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
alter table public.phone_numbers          enable row level security;
alter table public.calls                  enable row level security;
alter table public.call_events            enable row level security;
alter table public.call_transcript_turns  enable row level security;
alter table public.conversation_outcomes  enable row level security;
alter table public.phone_suppressions     enable row level security;

create policy "members read phone numbers" on public.phone_numbers
  for select using (public.is_business_member(business_id));
create policy "members read calls" on public.calls
  for select using (public.is_business_member(business_id));
create policy "members read call events" on public.call_events
  for select using (public.is_business_member(business_id));
create policy "members read call transcripts" on public.call_transcript_turns
  for select using (public.is_business_member(business_id));
create policy "members read conversation outcomes" on public.conversation_outcomes
  for select using (public.is_business_member(business_id));
create policy "members read phone suppressions" on public.phone_suppressions
  for select using (public.is_business_member(business_id));
