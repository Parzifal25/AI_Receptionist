-- ============================================================================
-- Supabase platform surface stubs — CI ONLY.
--
-- The migrations in supabase/migrations/ assume a Supabase-shaped database:
-- the `auth` schema (auth.users FK targets, auth.uid()) and the `storage`
-- schema (storage.buckets / storage.objects rows and RLS policies). The CI
-- migration job applies them to a plain pgvector Postgres, so the minimal
-- shapes the migrations actually reference are created here first.
--
-- Never deploy this file to a real Supabase project (which already provides
-- the full auth/storage schemas); it exists only so `check:migrations` can
-- run against a throwaway database.
-- ============================================================================

-- Supabase's pre-provisioned roles. Migrations grant privileges to these
-- (e.g. `grant ... to authenticated, service_role`); on vanilla Postgres
-- they must exist before the migration set applies.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- Supabase's default privileges, as read from pg_default_acl on the
-- supabase/postgres 17.6.1.155 image (2026-10-15): every table, function and
-- sequence the migration role creates in `public` is granted in full to
-- anon, authenticated and service_role, unless a migration revokes it.
-- Without this, a missing revoke would pass here and fail open on a hosted
-- project. Issued by the role that then applies the migrations.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

-- Mirrors Supabase's auth.uid() as GoTrue defines it (JWT subject → uuid,
-- null when absent). PostgREST 10+ sets only the JSON `request.jwt.claims`;
-- the harnesses set the legacy per-claim GUC. Both are read, as on hosted
-- Supabase. No real authentication here.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create schema if not exists storage;

create table if not exists storage.buckets (
  id         text primary key,
  name       text not null,
  public     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets(id),
  name       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);