-- ============================================================================
-- Missing-knowledge detection.
--
-- When a visitor asks a real question and retrieval finds nothing to ground
-- the answer in, that's the business's knowledge base talking: something
-- customers care about isn't written down. Recording those moments as events
-- (with the question in metadata) turns every unanswerable question into a
-- to-do item for the owner — the knowledge base improves in exactly the
-- order customers ask for it.
-- ============================================================================

alter table public.usage_events
  drop constraint if exists usage_events_event_type_check;

alter table public.usage_events
  add constraint usage_events_event_type_check check (event_type in
    ('widget_loaded', 'conversation_started', 'message_sent',
     'lead_captured', 'voice_used', 'unanswered_question'));
