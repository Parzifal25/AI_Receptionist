-- ============================================================================
-- Function grant hardening.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and
-- PostgREST exposes every executable function in the exposed schema as an
-- RPC endpoint. Left as-is, anyone holding the public anon key could call
-- the SECURITY DEFINER retrieval functions with an arbitrary business_id
-- and read another tenant's knowledge base. Lock every function down to the
-- least privilege it actually needs.
-- ============================================================================

-- Tenant-scoped retrieval: only ever called from server code on the service
-- role. No browser role may execute these.
revoke execute on function public.search_knowledge(uuid, text, int) from public, anon, authenticated;
grant  execute on function public.search_knowledge(uuid, text, int) to service_role;

revoke execute on function public.match_knowledge_chunks(uuid, vector, int) from public, anon, authenticated;
grant  execute on function public.match_knowledge_chunks(uuid, vector, int) to service_role;

-- Onboarding RPC: requires a signed-in user (it also checks auth.uid()).
revoke execute on function public.create_business_with_owner(text, text) from public, anon;
grant  execute on function public.create_business_with_owner(text, text) to authenticated;

-- Membership helpers are referenced by RLS policies, which evaluate them as
-- the querying role — authenticated must keep EXECUTE. anon has no table
-- grants and never passes these policies, so it doesn't need them.
revoke execute on function public.is_business_member(uuid) from public, anon;
grant  execute on function public.is_business_member(uuid) to authenticated;

revoke execute on function public.is_business_admin(uuid) from public, anon;
grant  execute on function public.is_business_admin(uuid) to authenticated;

-- Trigger function: fired by triggers as the table owner; no role calls it.
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- Future functions in this schema start with no PUBLIC execute, so a
-- forgotten grant fails closed instead of open.
alter default privileges in schema public revoke execute on functions from public;
