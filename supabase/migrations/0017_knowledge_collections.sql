-- ============================================================================
-- HALO Phase 1 — knowledge collections (plan §P1.2 "Knowledge scoping",
-- migration 0017).
--
-- A tenant can group its knowledge into collections and bind the right
-- collections to the right agent. This migration is ONLY the scoping
-- abstraction: no multilingual retrieval, no embedding-architecture work
-- (that is Phase 3). `knowledge_documents.collection_id` is NULLABLE — an
-- unbound document keeps today's behaviour (visible to all lookups), so
-- existing knowledge bases are untouched and continue to work verbatim.
-- ============================================================================

create table public.knowledge_collections (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 120),
  language        text not null default 'en',
  -- Phase 3 will drive retrieval from these fields; defaults keep a
  -- collection valid and platform-default today.
  embedding_model text not null default '',
  embedding_dim   int not null default 0 check (embedding_dim >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint knowledge_collections_business_name_unique unique (business_id, name)
);

create index knowledge_collections_business_idx
  on public.knowledge_collections(business_id);

create trigger knowledge_collections_updated_at
  before update on public.knowledge_collections
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Documents gain an optional collection binding (null = legacy, all lookups).
-- ----------------------------------------------------------------------------
alter table public.knowledge_documents
  add column collection_id uuid references public.knowledge_collections(id) on delete set null;

create index knowledge_documents_collection_idx
  on public.knowledge_documents(business_id, collection_id);

-- ----------------------------------------------------------------------------
-- RLS, same migration (plan §2.4 rule 3): members read, admins manage.
-- Documents keep their existing policies; only the new table needs its own.
-- ----------------------------------------------------------------------------
alter table public.knowledge_collections enable row level security;

create policy "members read knowledge collections" on public.knowledge_collections
  for select using (public.is_business_member(business_id));
create policy "admins insert knowledge collections" on public.knowledge_collections
  for insert with check (public.is_business_admin(business_id));
create policy "admins update knowledge collections" on public.knowledge_collections
  for update using (public.is_business_admin(business_id));
create policy "admins delete knowledge collections" on public.knowledge_collections
  for delete using (public.is_business_admin(business_id));