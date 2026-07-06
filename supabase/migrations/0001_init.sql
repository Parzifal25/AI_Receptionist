-- ============================================================================
-- AI Receptionist — Initial Schema
-- Multi-tenant, RLS-enforced. Every tenant-owned table carries business_id
-- and is protected by membership-based policies. The public widget NEVER
-- talks to these tables directly — it goes through server API routes that
-- use the service role and scope every query by the receptionist widget key.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Tenancy
-- ----------------------------------------------------------------------------

create table public.businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  description text not null default '',
  industry    text not null default '',
  website     text not null default '',
  phone       text not null default '',
  email       text not null default '',
  address     text not null default '',
  -- { "mon": {"open":"09:00","close":"17:00","closed":false}, ... }
  business_hours jsonb not null default '{}'::jsonb,
  logo_url    text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger businesses_updated_at
  before update on public.businesses
  for each row execute function public.set_updated_at();

create type public.member_role as enum ('owner', 'admin', 'member');

create table public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.member_role not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);

create index business_members_user_idx on public.business_members(user_id);

-- Membership check used by every RLS policy. SECURITY DEFINER so it can read
-- business_members without recursing through that table's own policies.
create or replace function public.is_business_member(target_business_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.business_members
    where business_id = target_business_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.is_business_admin(target_business_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.business_members
    where business_id = target_business_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

-- Atomic business + owner-membership creation, called from onboarding.
create or replace function public.create_business_with_owner(
  business_name text,
  business_slug text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_business_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  insert into public.businesses (name, slug)
  values (business_name, business_slug)
  returning id into new_business_id;

  insert into public.business_members (business_id, user_id, role)
  values (new_business_id, auth.uid(), 'owner');

  insert into public.business_settings (business_id)
  values (new_business_id);

  insert into public.receptionists (business_id, name)
  values (new_business_id, 'Receptionist');

  return new_business_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- Receptionist configuration
-- ----------------------------------------------------------------------------

create table public.receptionists (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null default 'Receptionist' check (char_length(name) between 1 and 80),
  greeting    text not null default 'Hi! Welcome — how can I help you today?',
  tone        text not null default 'friendly'
              check (tone in ('friendly', 'professional', 'casual', 'formal')),
  language    text not null default 'en',
  custom_instructions text not null default '',
  -- Public, non-secret identifier embedded in the website snippet.
  widget_key  text not null unique default encode(gen_random_bytes(16), 'hex'),
  is_active   boolean not null default true,
  lead_capture_enabled boolean not null default true,
  voice_enabled        boolean not null default true,
  -- { "theme":"auto", "primaryColor":"#4f46e5", "position":"bottom-right",
  --   "avatarUrl":"", "launcherLabel":"Chat with us" }
  branding    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index receptionists_business_idx on public.receptionists(business_id);

create trigger receptionists_updated_at
  before update on public.receptionists
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Knowledge base
-- ----------------------------------------------------------------------------

create table public.knowledge_documents (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  content     text not null default '',
  source_type text not null default 'manual' check (source_type in ('manual', 'file', 'url')),
  source_ref  text not null default '',
  status      text not null default 'ready' check (status in ('processing', 'ready', 'error')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index knowledge_documents_business_idx on public.knowledge_documents(business_id);

create trigger knowledge_documents_updated_at
  before update on public.knowledge_documents
  for each row execute function public.set_updated_at();

create table public.knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  content     text not null,
  chunk_index integer not null default 0,
  -- Populated only when an embedding provider is configured.
  embedding   vector(768),
  -- Keyword search always works, embeddings are an optional upgrade.
  content_tsv tsvector generated always as (to_tsvector('english', content)) stored,
  created_at  timestamptz not null default now()
);

create index knowledge_chunks_business_idx on public.knowledge_chunks(business_id);
create index knowledge_chunks_document_idx on public.knowledge_chunks(document_id);
create index knowledge_chunks_tsv_idx on public.knowledge_chunks using gin(content_tsv);

create table public.faqs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  question    text not null check (char_length(question) between 1 and 500),
  answer      text not null check (char_length(answer) between 1 and 4000),
  category    text not null default '',
  sort_order  integer not null default 0,
  is_published boolean not null default true,
  content_tsv tsvector generated always as
    (to_tsvector('english', question || ' ' || answer)) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index faqs_business_idx on public.faqs(business_id);
create index faqs_tsv_idx on public.faqs using gin(content_tsv);

create trigger faqs_updated_at
  before update on public.faqs
  for each row execute function public.set_updated_at();

-- Keyword retrieval across chunks + published FAQs, scoped to one tenant.
-- Called with the service role from server code; also callable by members.
create or replace function public.search_knowledge(
  target_business_id uuid,
  query text,
  match_limit int default 6
)
returns table (source text, ref_id uuid, content text, rank real)
language sql
security definer
set search_path = public
stable
as $$
  with q as (select websearch_to_tsquery('english', query) as tsq)
  (
    select 'chunk'::text, kc.id, kc.content,
           ts_rank(kc.content_tsv, q.tsq) as rank
    from public.knowledge_chunks kc, q
    where kc.business_id = target_business_id
      and kc.content_tsv @@ q.tsq
  )
  union all
  (
    select 'faq'::text, f.id,
           'Q: ' || f.question || E'\nA: ' || f.answer,
           ts_rank(f.content_tsv, q.tsq) as rank
    from public.faqs f, q
    where f.business_id = target_business_id
      and f.is_published
      and f.content_tsv @@ q.tsq
  )
  order by rank desc
  limit match_limit;
$$;

-- Vector retrieval (used when an embedding provider is configured).
create or replace function public.match_knowledge_chunks(
  target_business_id uuid,
  query_embedding vector(768),
  match_limit int default 6
)
returns table (ref_id uuid, content text, similarity float)
language sql
security definer
set search_path = public
stable
as $$
  select kc.id, kc.content,
         1 - (kc.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks kc
  where kc.business_id = target_business_id
    and kc.embedding is not null
  order by kc.embedding <=> query_embedding
  limit match_limit;
$$;

-- ----------------------------------------------------------------------------
-- Conversations, messages, leads
-- ----------------------------------------------------------------------------

create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  receptionist_id uuid not null references public.receptionists(id) on delete cascade,
  -- Opaque token held by the visitor's browser; proves conversation ownership.
  visitor_token   text not null unique default encode(gen_random_bytes(24), 'hex'),
  channel         text not null default 'chat' check (channel in ('chat', 'voice')),
  status          text not null default 'active' check (status in ('active', 'ended')),
  page_url        text not null default '',
  user_agent      text not null default '',
  message_count   integer not null default 0,
  started_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  ended_at        timestamptz
);

create index conversations_business_idx
  on public.conversations(business_id, started_at desc);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  business_id     uuid not null references public.businesses(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (char_length(content) between 1 and 8000),
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx
  on public.messages(conversation_id, created_at);
create index messages_business_idx on public.messages(business_id);

create table public.leads (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  name            text not null default '',
  email           text not null default '',
  phone           text not null default '',
  intent          text not null default '',
  notes           text not null default '',
  status          text not null default 'new'
                  check (status in ('new', 'contacted', 'qualified', 'closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index leads_business_idx on public.leads(business_id, created_at desc);

create trigger leads_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Settings + analytics
-- ----------------------------------------------------------------------------

create table public.business_settings (
  business_id  uuid primary key references public.businesses(id) on delete cascade,
  -- Domains allowed to embed the widget. Empty = allow any (dev-friendly).
  allowed_domains text[] not null default '{}',
  notify_on_lead  boolean not null default true,
  notification_email text not null default '',
  data_retention_days integer not null default 365
    check (data_retention_days between 30 and 3650),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger business_settings_updated_at
  before update on public.business_settings
  for each row execute function public.set_updated_at();

-- Lightweight event stream powering the analytics dashboard.
create table public.usage_events (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  event_type  text not null check (event_type in
    ('widget_loaded', 'conversation_started', 'message_sent',
     'lead_captured', 'voice_used')),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index usage_events_business_idx
  on public.usage_events(business_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- Dashboard users act through the anon/authenticated key and hit these
-- policies. The widget API uses the service role (bypasses RLS) and applies
-- tenant scoping in code — visitors never receive a Supabase key at all.
-- ----------------------------------------------------------------------------

alter table public.businesses         enable row level security;
alter table public.business_members   enable row level security;
alter table public.receptionists      enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks   enable row level security;
alter table public.faqs               enable row level security;
alter table public.conversations      enable row level security;
alter table public.messages           enable row level security;
alter table public.leads              enable row level security;
alter table public.business_settings  enable row level security;
alter table public.usage_events       enable row level security;

create policy "members read business" on public.businesses
  for select using (public.is_business_member(id));
create policy "admins update business" on public.businesses
  for update using (public.is_business_admin(id));

create policy "members read memberships" on public.business_members
  for select using (public.is_business_member(business_id));
create policy "admins manage memberships" on public.business_members
  for all using (public.is_business_admin(business_id));

create policy "members read receptionists" on public.receptionists
  for select using (public.is_business_member(business_id));
create policy "admins write receptionists" on public.receptionists
  for insert with check (public.is_business_admin(business_id));
create policy "admins update receptionists" on public.receptionists
  for update using (public.is_business_admin(business_id));
create policy "admins delete receptionists" on public.receptionists
  for delete using (public.is_business_admin(business_id));

create policy "members read documents" on public.knowledge_documents
  for select using (public.is_business_member(business_id));
create policy "members write documents" on public.knowledge_documents
  for insert with check (public.is_business_member(business_id));
create policy "members update documents" on public.knowledge_documents
  for update using (public.is_business_member(business_id));
create policy "members delete documents" on public.knowledge_documents
  for delete using (public.is_business_member(business_id));

create policy "members read chunks" on public.knowledge_chunks
  for select using (public.is_business_member(business_id));
create policy "members write chunks" on public.knowledge_chunks
  for insert with check (public.is_business_member(business_id));
create policy "members delete chunks" on public.knowledge_chunks
  for delete using (public.is_business_member(business_id));

create policy "members read faqs" on public.faqs
  for select using (public.is_business_member(business_id));
create policy "members write faqs" on public.faqs
  for insert with check (public.is_business_member(business_id));
create policy "members update faqs" on public.faqs
  for update using (public.is_business_member(business_id));
create policy "members delete faqs" on public.faqs
  for delete using (public.is_business_member(business_id));

create policy "members read conversations" on public.conversations
  for select using (public.is_business_member(business_id));
create policy "members read messages" on public.messages
  for select using (public.is_business_member(business_id));

create policy "members read leads" on public.leads
  for select using (public.is_business_member(business_id));
create policy "members update leads" on public.leads
  for update using (public.is_business_member(business_id));
create policy "members delete leads" on public.leads
  for delete using (public.is_business_member(business_id));

create policy "members read settings" on public.business_settings
  for select using (public.is_business_member(business_id));
create policy "admins update settings" on public.business_settings
  for update using (public.is_business_admin(business_id));

create policy "members read usage" on public.usage_events
  for select using (public.is_business_member(business_id));

-- ----------------------------------------------------------------------------
-- Grants
-- Newer Supabase projects no longer auto-grant DML on migration-created
-- tables; RLS is the row filter, but the role still needs table privileges.
-- anon gets nothing: visitors only ever reach data through the service role.
-- ----------------------------------------------------------------------------

grant usage on schema public to authenticated, service_role;
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to service_role, authenticated;

alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to service_role, authenticated;

-- ----------------------------------------------------------------------------
-- Storage bucket for business assets (logos, avatars)
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('business-assets', 'business-assets', true)
on conflict (id) do nothing;

create policy "members upload assets" on storage.objects
  for insert with check (
    bucket_id = 'business-assets'
    and public.is_business_member(((string_to_array(name, '/'))[1])::uuid)
  );

create policy "members update assets" on storage.objects
  for update using (
    bucket_id = 'business-assets'
    and public.is_business_member(((string_to_array(name, '/'))[1])::uuid)
  );

create policy "members delete assets" on storage.objects
  for delete using (
    bucket_id = 'business-assets'
    and public.is_business_member(((string_to_array(name, '/'))[1])::uuid)
  );

create policy "public read assets" on storage.objects
  for select using (bucket_id = 'business-assets');
