-- Persist runtime metadata in the existing tenant-isolated call event stream.
alter table public.call_events drop constraint call_events_type_check;
alter table public.call_events add constraint call_events_type_check check (type in (
'runtime_event','session_started','state_changed','speech_started','endpoint','stt_partial','stt_final','context_ready','llm_first_token','agent_turn','tts_start','tts_first_byte','tts_complete','tts_cancel','barge_in','turn_complete','turn_cancelled','silence','dtmf','transfer','provider_error','media_disconnected','media_reconnected','session_ended'));
