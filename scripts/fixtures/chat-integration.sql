-- ONLY after canonical migrations in a fresh disposable database.
-- PostgREST uses request.jwt.claims; the minimal CI stub only reads the legacy GUC.
do $$ begin
  if current_database() <> 'halo_check_integrations' then
    raise exception 'This fixture requires halo_check_integrations in a fresh disposable instance';
  end if;
end $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
create function public.halo_integration_target() returns text language sql stable as $$
  select current_database() || ':synthetic-chat-20261013'
$$;
grant execute on function public.halo_integration_target() to service_role;
grant usage on schema public, auth to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant select on all tables in schema public to authenticated;
insert into auth.users(id, email) values
 ('a1000000-0000-4000-8000-000000000001', 'halo-a@example.invalid'),
 ('b1000000-0000-4000-8000-000000000001', 'halo-b@example.invalid');
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', false);
select public.create_business_with_owner('Synthetic HALO A', 'halo-integration-a');
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', false);
select public.create_business_with_owner('Synthetic HALO B', 'halo-integration-b');
select set_config('request.jwt.claim.sub', '', false);
update public.receptionists set lead_capture_enabled=false, voice_enabled=false
 where business_id in (select id from public.businesses where slug in ('halo-integration-a', 'halo-integration-b'));
update public.business_settings set allowed_domains=array['halo.example.invalid']
 where business_id in (select id from public.businesses where slug in ('halo-integration-a', 'halo-integration-b'));
insert into public.faqs(business_id, question, answer)
 select id, 'What are the opening hours?', 'Synthetic opening hours are nine to five.'
 from public.businesses where slug='halo-integration-a';
notify pgrst, 'reload schema';
