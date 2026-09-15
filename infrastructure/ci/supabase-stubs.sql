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

create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

-- Mirrors Supabase's auth.uid() (JWT claim → uuid, null when absent). Enough
-- for RLS policy bodies to parse and execute; no real authentication here.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
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