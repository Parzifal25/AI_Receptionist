-- ---------------------------------------------------------------------------
-- 0023 — two latency marks the call-event stream was missing (Phase 4.5).
--
-- `agent_turn` is one number covering retrieval, context assembly, every
-- model call and validation. With only that, a slow call cannot be diagnosed:
-- a bloated prompt and a slow model look identical. These two marks split it
-- at the points where the fix differs.
--
--   context_ready    model context assembled; the first model call is about
--                    to be sent. Slow here = prompt/retrieval work.
--   llm_first_token  first usable model output. Slow here = the model.
--                    Emitted ONLY when the provider streamed; its absence is
--                    a real signal, not a gap to fill with a guess.
--
-- Additive: no column changes, no backfill, no behaviour change. Existing
-- rows and readers are untouched; `latencySummary()` already computes p50/p95
-- for any latency-bearing type.
--
-- `call_events` keeps its RLS from 0020 (this migration creates no table).
-- ---------------------------------------------------------------------------

alter table public.call_events drop constraint if exists call_events_type_check;

alter table public.call_events
  add constraint call_events_type_check check (type in
    ('session_started', 'state_changed', 'speech_started', 'endpoint', 'stt_partial',
     'stt_final', 'context_ready', 'llm_first_token', 'agent_turn', 'tts_start',
     'tts_first_byte', 'tts_complete', 'tts_cancel', 'barge_in', 'turn_complete',
     'turn_cancelled', 'silence', 'dtmf', 'transfer', 'provider_error',
     'media_disconnected', 'media_reconnected', 'session_ended'));
