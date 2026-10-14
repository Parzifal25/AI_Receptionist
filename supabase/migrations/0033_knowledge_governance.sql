-- ============================================================================
-- D14 — knowledge governance: tenant-composite ownership, approval,
-- revision history, publication and governed retrieval.
--
-- Additive. 0001–0032 are untouched; existing columns and IDs are kept.
--
-- Model
--   A document or FAQ row is the tenant-owned container and editor working
--   copy. Content is served ONLY through an immutable revision that a tenant
--   owner/admin approved, and only while the container's
--   `published_revision_id` points at it.
--
--   Document revisions:  draft -> pending_review -> approved -> superseded
--                                              \-> rejected   \-> withdrawn
--                        draft/pending_review -> withdrawn (replaced or discarded)
--   FAQ revisions start in pending_review (no indexing step).
--
--   Indexing state (pending/ready/failed) is separate from review state.
--   A document revision can be submitted and approved only once its chunks
--   are fully indexed; its chunks are frozen once it leaves draft.
--
--   Approval atomically supersedes the previous published revision and moves
--   the pointer, under a row lock on the container. A deferred consistency
--   trigger guarantees "approved" <=> "pointed to" at commit for every role.
--
--   Each revision row records who created, submitted, reviewed and retired
--   it and when. The lifecycle is linear, so these columns are the complete
--   transition record; no separate audit table is added (audit_logs is still
--   PENDING under D7). Content, embeddings and query text are never logged.
--
-- Tenant safety
--   Composite (id, business_id) keys tie revisions to their container,
--   chunks to their revision and document, and documents to collections.
--   Editor RPCs derive authority from auth.uid() membership of the row's
--   tenant; a caller-supplied tenant id is only accepted when the caller is
--   a member of it. Approval/withdrawal requires owner/admin. Retrieval
--   RPCs are service-role only, scope every parent by tenant inside the
--   query (before ranking, for both keyword and vector paths) and deny an
--   unknown or foreign collection instead of widening.
--
-- Legacy data
--   Existing documents, chunks and FAQs have no revisions and are therefore
--   NOT served after this migration, whatever their `status`/`is_published`.
--   No approval is inferred. knowledge_backfill_legacy() (service role,
--   dry-run by default, one tenant per call) creates unapproved revisions
--   for human review; knowledge_governance_census() reports orphaned,
--   mismatched and ungoverned rows. Mismatched rows are quarantined (never
--   served), not repaired.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Composite tenant keys on the existing parents, and composite child FKs.
-- ----------------------------------------------------------------------------
alter table public.knowledge_collections
  add constraint knowledge_collections_id_business_key unique (id, business_id);
alter table public.knowledge_documents
  add constraint knowledge_documents_id_business_key unique (id, business_id);
alter table public.faqs
  add constraint faqs_id_business_key unique (id, business_id);

-- NOT VALID: enforced for every new or changed row immediately; existing
-- rows are validated below only when no mismatch exists, so a legacy
-- mismatch never aborts the rollout. Mismatched legacy rows stay
-- quarantined (retrieval checks tenant equality on every parent) and are
-- reported by knowledge_governance_census().
alter table public.knowledge_documents
  add constraint knowledge_documents_collection_tenant_fk
  foreign key (collection_id, business_id)
  references public.knowledge_collections (id, business_id)
  on delete set null (collection_id) not valid;
alter table public.knowledge_chunks
  add constraint knowledge_chunks_document_tenant_fk
  foreign key (document_id, business_id)
  references public.knowledge_documents (id, business_id)
  on delete cascade not valid;

do $$
begin
  if not exists (
    select 1 from public.knowledge_documents d
    join public.knowledge_collections c on c.id = d.collection_id
    where c.business_id <> d.business_id
  ) then
    alter table public.knowledge_documents validate constraint knowledge_documents_collection_tenant_fk;
  else
    raise notice 'knowledge_documents_collection_tenant_fk left NOT VALID: legacy tenant mismatches exist (see knowledge_governance_census)';
  end if;
  if not exists (
    select 1 from public.knowledge_chunks k
    join public.knowledge_documents d on d.id = k.document_id
    where d.business_id <> k.business_id
  ) then
    alter table public.knowledge_chunks validate constraint knowledge_chunks_document_tenant_fk;
  else
    raise notice 'knowledge_chunks_document_tenant_fk left NOT VALID: legacy tenant mismatches exist (see knowledge_governance_census)';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Revision tables.
-- Actor columns hold auth user ids without a foreign key, so the history
-- survives the deletion of a user account.
-- ----------------------------------------------------------------------------
create table public.knowledge_document_revisions (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  document_id    uuid not null,
  revision       integer not null check (revision >= 1),
  title          text not null check (char_length(title) between 1 and 200),
  content        text not null check (char_length(content) between 1 and 100000),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_type    text not null check (source_type in ('manual', 'file', 'url')),
  source_ref     text not null default '' check (char_length(source_ref) <= 500),
  origin         text not null default 'editor' check (origin in ('editor', 'legacy_backfill')),
  state          text not null default 'draft'
                 check (state in ('draft', 'pending_review', 'approved', 'rejected', 'superseded', 'withdrawn')),
  index_status   text not null default 'pending' check (index_status in ('pending', 'ready', 'failed')),
  chunk_count    integer not null default 0 check (chunk_count >= 0),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  submitted_by   uuid,
  submitted_at   timestamptz,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  retired_by     uuid,
  retired_at     timestamptz,

  constraint knowledge_document_revisions_id_business_key unique (id, business_id),
  constraint knowledge_document_revisions_number_key unique (document_id, revision),
  constraint knowledge_document_revisions_document_fk
    foreign key (document_id, business_id)
    references public.knowledge_documents (id, business_id) on delete cascade,
  -- Provenance: a file or URL revision names its source.
  constraint knowledge_document_revisions_provenance check (source_type = 'manual' or source_ref <> ''),
  constraint knowledge_document_revisions_lifecycle check (
    (state = 'draft'
       and submitted_at is null and reviewed_at is null and retired_at is null)
    or (state = 'pending_review'
       and index_status = 'ready' and chunk_count > 0
       and submitted_at is not null and reviewed_at is null and retired_at is null)
    or (state = 'approved'
       and index_status = 'ready' and chunk_count > 0 and submitted_at is not null
       and reviewed_by is not null and reviewed_at is not null and retired_at is null)
    or (state = 'rejected'
       and submitted_at is not null and reviewed_by is not null and reviewed_at is not null and retired_at is null)
    or (state = 'superseded'
       and reviewed_by is not null and reviewed_at is not null and retired_at is not null)
    or (state = 'withdrawn'
       and retired_by is not null and retired_at is not null)
  )
);

create index knowledge_document_revisions_document_idx
  on public.knowledge_document_revisions (document_id, revision desc);
create index knowledge_document_revisions_review_idx
  on public.knowledge_document_revisions (business_id, state);
-- At most one approved (= published) revision per document.
create unique index knowledge_document_revisions_one_approved
  on public.knowledge_document_revisions (document_id) where state = 'approved';

create table public.faq_revisions (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  faq_id         uuid not null,
  revision       integer not null check (revision >= 1),
  question       text not null check (char_length(question) between 1 and 500),
  answer         text not null check (char_length(answer) between 1 and 4000),
  category       text not null default '' check (char_length(category) <= 100),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_tsv    tsvector generated always as (to_tsvector('english', question || ' ' || answer)) stored,
  origin         text not null default 'editor' check (origin in ('editor', 'legacy_backfill')),
  state          text not null default 'pending_review'
                 check (state in ('pending_review', 'approved', 'rejected', 'superseded', 'withdrawn')),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  retired_by     uuid,
  retired_at     timestamptz,

  constraint faq_revisions_id_business_key unique (id, business_id),
  constraint faq_revisions_number_key unique (faq_id, revision),
  constraint faq_revisions_faq_fk
    foreign key (faq_id, business_id) references public.faqs (id, business_id) on delete cascade,
  constraint faq_revisions_lifecycle check (
    (state = 'pending_review' and reviewed_at is null and retired_at is null)
    or (state = 'approved' and reviewed_by is not null and reviewed_at is not null and retired_at is null)
    or (state = 'rejected' and reviewed_by is not null and reviewed_at is not null and retired_at is null)
    or (state = 'superseded' and reviewed_by is not null and reviewed_at is not null and retired_at is not null)
    or (state = 'withdrawn' and retired_by is not null and retired_at is not null)
  )
);

create index faq_revisions_faq_idx on public.faq_revisions (faq_id, revision desc);
create index faq_revisions_review_idx on public.faq_revisions (business_id, state);
create index faq_revisions_tsv_idx on public.faq_revisions using gin (content_tsv);
create unique index faq_revisions_one_approved on public.faq_revisions (faq_id) where state = 'approved';

-- ----------------------------------------------------------------------------
-- 3. Publication pointers and revision-bound chunks.
-- ----------------------------------------------------------------------------
alter table public.knowledge_documents add column published_revision_id uuid;
alter table public.knowledge_documents
  add constraint knowledge_documents_published_revision_fk
  foreign key (published_revision_id, business_id)
  references public.knowledge_document_revisions (id, business_id);

alter table public.faqs add column published_revision_id uuid;
alter table public.faqs
  add constraint faqs_published_revision_fk
  foreign key (published_revision_id, business_id)
  references public.faq_revisions (id, business_id);
-- New FAQs are never published by default. Existing values are left as
-- they were; retrieval no longer reads is_published (a display mirror the
-- governance functions maintain).
alter table public.faqs alter column is_published set default false;

alter table public.knowledge_chunks add column revision_id uuid;
alter table public.knowledge_chunks
  add constraint knowledge_chunks_revision_fk
  foreign key (revision_id, business_id)
  references public.knowledge_document_revisions (id, business_id) on delete cascade;
-- Every NEW chunk belongs to a revision. Legacy chunks (null) are kept but
-- never served; NOT VALID leaves them in place.
alter table public.knowledge_chunks
  add constraint knowledge_chunks_revision_required check (revision_id is not null) not valid;
create index knowledge_chunks_revision_idx on public.knowledge_chunks (revision_id);

-- ----------------------------------------------------------------------------
-- 4. Integrity triggers (hold for every role, including the service role).
-- ----------------------------------------------------------------------------
create or replace function public.knowledge_content_sha256(value text)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(sha256(convert_to(value, 'UTF8')), 'hex')
$$;

create or replace function public.is_knowledge_approver(target_business_id uuid, actor uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select actor is not null and exists (
    select 1 from public.business_members
    where business_id = target_business_id and user_id = actor and role in ('owner', 'admin')
  );
$$;

create or replace function public.enforce_knowledge_document_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' or new.index_status <> 'pending' or new.chunk_count <> 0
       or new.submitted_by is not null or new.reviewed_by is not null or new.retired_by is not null then
      raise exception 'knowledge revisions are inserted as unindexed drafts';
    end if;
    new.content_sha256 := public.knowledge_content_sha256(new.content);
    return new;
  end if;

  if (new.id, new.business_id, new.document_id, new.revision, new.title, new.content, new.content_sha256,
      new.source_type, new.source_ref, new.origin, new.created_by, new.created_at)
     is distinct from
     (old.id, old.business_id, old.document_id, old.revision, old.title, old.content, old.content_sha256,
      old.source_type, old.source_ref, old.origin, old.created_by, old.created_at) then
    raise exception 'knowledge revision % content and identity are immutable', old.id;
  end if;

  -- Indexing state changes only while the revision is a draft.
  if (new.index_status, new.chunk_count) is distinct from (old.index_status, old.chunk_count) then
    if old.state <> 'draft' or new.state <> 'draft' then
      raise exception 'knowledge revision % is no longer a draft; its index is frozen', old.id;
    end if;
  end if;

  if new.state is distinct from old.state then
    if not (
      (old.state = 'draft' and new.state in ('pending_review', 'withdrawn'))
      or (old.state = 'pending_review' and new.state in ('approved', 'rejected', 'withdrawn'))
      or (old.state = 'approved' and new.state in ('superseded', 'withdrawn'))
    ) then
      raise exception 'knowledge revision % cannot move from % to %', old.id, old.state, new.state;
    end if;
    if new.state = 'approved' and not public.is_knowledge_approver(new.business_id, new.reviewed_by) then
      raise exception 'knowledge revision % must be approved by an owner or admin of its business', old.id;
    end if;
  end if;

  -- Transition stamps are written once, at their transition.
  if old.submitted_at is not null and (new.submitted_by, new.submitted_at) is distinct from (old.submitted_by, old.submitted_at)
     or old.reviewed_at is not null and (new.reviewed_by, new.reviewed_at) is distinct from (old.reviewed_by, old.reviewed_at)
     or old.retired_at is not null and (new.retired_by, new.retired_at) is distinct from (old.retired_by, old.retired_at) then
    raise exception 'knowledge revision % transition records are immutable', old.id;
  end if;
  return new;
end;
$$;

create trigger knowledge_document_revisions_integrity
  before insert or update on public.knowledge_document_revisions
  for each row execute function public.enforce_knowledge_document_revision();

create or replace function public.enforce_faq_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'pending_review' or new.reviewed_by is not null or new.retired_by is not null then
      raise exception 'faq revisions are inserted pending review';
    end if;
    new.content_sha256 := public.knowledge_content_sha256(new.question || E'\n' || new.answer || E'\n' || new.category);
    return new;
  end if;

  if (new.id, new.business_id, new.faq_id, new.revision, new.question, new.answer, new.category,
      new.content_sha256, new.origin, new.created_by, new.created_at)
     is distinct from
     (old.id, old.business_id, old.faq_id, old.revision, old.question, old.answer, old.category,
      old.content_sha256, old.origin, old.created_by, old.created_at) then
    raise exception 'faq revision % content and identity are immutable', old.id;
  end if;

  if new.state is distinct from old.state then
    if not (
      (old.state = 'pending_review' and new.state in ('approved', 'rejected', 'withdrawn'))
      or (old.state = 'approved' and new.state in ('superseded', 'withdrawn'))
    ) then
      raise exception 'faq revision % cannot move from % to %', old.id, old.state, new.state;
    end if;
    if new.state = 'approved' and not public.is_knowledge_approver(new.business_id, new.reviewed_by) then
      raise exception 'faq revision % must be approved by an owner or admin of its business', old.id;
    end if;
  end if;

  if old.reviewed_at is not null and (new.reviewed_by, new.reviewed_at) is distinct from (old.reviewed_by, old.reviewed_at)
     or old.retired_at is not null and (new.retired_by, new.retired_at) is distinct from (old.retired_by, old.retired_at) then
    raise exception 'faq revision % transition records are immutable', old.id;
  end if;
  return new;
end;
$$;

create trigger faq_revisions_integrity
  before insert or update on public.faq_revisions
  for each row execute function public.enforce_faq_revision();

-- Chunks: a new chunk must belong to a draft revision of the same document
-- and tenant that is still being indexed. Chunks of a revision that left
-- draft are frozen (no update, no delete except through a cascade).
create or replace function public.enforce_knowledge_chunk()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rev record;
begin
  if tg_op = 'UPDATE' then
    raise exception 'knowledge chunks are immutable; re-index the draft revision instead';
  end if;
  if tg_op = 'DELETE' then
    if old.revision_id is null or pg_trigger_depth() > 1 then
      return old;
    end if;
    select state into rev from public.knowledge_document_revisions where id = old.revision_id;
    if found and rev.state <> 'draft' then
      raise exception 'chunks of a submitted or published knowledge revision cannot be deleted';
    end if;
    return old;
  end if;

  select r.document_id, r.business_id, r.state, r.index_status into rev
  from public.knowledge_document_revisions r where r.id = new.revision_id;
  if not found or rev.document_id <> new.document_id or rev.business_id <> new.business_id then
    raise exception 'knowledge chunk must belong to a revision of the same document and business';
  end if;
  if rev.state <> 'draft' or rev.index_status = 'ready' then
    raise exception 'knowledge chunks can only be added to a draft revision that is being indexed';
  end if;
  return new;
end;
$$;

create trigger knowledge_chunks_integrity
  before insert or update or delete on public.knowledge_chunks
  for each row execute function public.enforce_knowledge_chunk();

-- Containers: the pointer can only name an approved revision of the same
-- container; a member cannot move published content to another collection.
create or replace function public.enforce_knowledge_document()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.published_revision_id is not null then
    raise exception 'knowledge documents are created unpublished';
  end if;
  if tg_op = 'UPDATE' then
    if new.business_id <> old.business_id then
      raise exception 'knowledge document % cannot change business', old.id;
    end if;
    if new.collection_id is distinct from old.collection_id and old.published_revision_id is not null
       and auth.uid() is not null and not public.is_business_admin(old.business_id) then
      raise exception 'only an owner or admin can change the collection of published knowledge';
    end if;
  end if;
  if new.published_revision_id is not null and (tg_op = 'INSERT' or new.published_revision_id is distinct from old.published_revision_id) then
    if not exists (
      select 1 from public.knowledge_document_revisions r
      where r.id = new.published_revision_id and r.document_id = new.id
        and r.business_id = new.business_id and r.state = 'approved'
    ) then
      raise exception 'knowledge document % can only publish one of its own approved revisions', new.id;
    end if;
  end if;
  return new;
end;
$$;

create trigger knowledge_documents_governance
  before insert or update on public.knowledge_documents
  for each row execute function public.enforce_knowledge_document();

create or replace function public.enforce_faq()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.published_revision_id is not null then
    raise exception 'faqs are created unpublished';
  end if;
  if tg_op = 'UPDATE' and new.business_id <> old.business_id then
    raise exception 'faq % cannot change business', old.id;
  end if;
  if new.published_revision_id is not null and (tg_op = 'INSERT' or new.published_revision_id is distinct from old.published_revision_id) then
    if not exists (
      select 1 from public.faq_revisions r
      where r.id = new.published_revision_id and r.faq_id = new.id
        and r.business_id = new.business_id and r.state = 'approved'
    ) then
      raise exception 'faq % can only publish one of its own approved revisions', new.id;
    end if;
  end if;
  return new;
end;
$$;

create trigger faqs_governance
  before insert or update on public.faqs
  for each row execute function public.enforce_faq();

-- Commit-time consistency: a revision is approved exactly when its
-- container points at it. Deferred, so the publish sequence inside one
-- transaction is free to order its writes.
create or replace function public.check_knowledge_publication()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'knowledge_document_revisions' then
    if exists (
      select 1 from public.knowledge_document_revisions r
      join public.knowledge_documents d on d.id = r.document_id
      where r.document_id = new.document_id
        and ((r.state = 'approved') <> (d.published_revision_id is not distinct from r.id))
    ) then
      raise exception 'knowledge document % publication pointer and approved revision disagree', new.document_id;
    end if;
  elsif tg_table_name = 'knowledge_documents' then
    if exists (select 1 from public.knowledge_documents where id = new.id) and (
      (new.published_revision_id is not null and not exists (
        select 1 from public.knowledge_document_revisions r
        where r.id = new.published_revision_id and r.document_id = new.id and r.state = 'approved'))
      or (new.published_revision_id is null and exists (
        select 1 from public.knowledge_document_revisions r
        where r.document_id = new.id and r.state = 'approved'))
    ) then
      raise exception 'knowledge document % publication pointer and approved revision disagree', new.id;
    end if;
  elsif tg_table_name = 'faq_revisions' then
    if exists (
      select 1 from public.faq_revisions r
      join public.faqs f on f.id = r.faq_id
      where r.faq_id = new.faq_id
        and ((r.state = 'approved') <> (f.published_revision_id is not distinct from r.id))
    ) then
      raise exception 'faq % publication pointer and approved revision disagree', new.faq_id;
    end if;
  elsif tg_table_name = 'faqs' then
    if exists (select 1 from public.faqs where id = new.id) and (
      (new.published_revision_id is not null and not exists (
        select 1 from public.faq_revisions r
        where r.id = new.published_revision_id and r.faq_id = new.id and r.state = 'approved'))
      or (new.published_revision_id is null and exists (
        select 1 from public.faq_revisions r where r.faq_id = new.id and r.state = 'approved'))
    ) then
      raise exception 'faq % publication pointer and approved revision disagree', new.id;
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger knowledge_document_revisions_publication
  after insert or update on public.knowledge_document_revisions
  deferrable initially deferred
  for each row execute function public.check_knowledge_publication();
create constraint trigger knowledge_documents_publication
  after update on public.knowledge_documents
  deferrable initially deferred
  for each row execute function public.check_knowledge_publication();
create constraint trigger faq_revisions_publication
  after insert or update on public.faq_revisions
  deferrable initially deferred
  for each row execute function public.check_knowledge_publication();
create constraint trigger faqs_publication
  after update on public.faqs
  deferrable initially deferred
  for each row execute function public.check_knowledge_publication();

-- ----------------------------------------------------------------------------
-- 5. Editor and reviewer RPCs (authenticated). Authority comes from
-- auth.uid() membership of the row's own tenant, never from an argument.
-- ----------------------------------------------------------------------------
create or replace function public.knowledge_require_member(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or target_business_id is null or not public.is_business_member(target_business_id) then
    raise exception 'knowledge access denied' using errcode = '42501';
  end if;
  return actor;
end;
$$;

create or replace function public.knowledge_require_approver(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or target_business_id is null or not public.is_knowledge_approver(target_business_id, actor) then
    raise exception 'knowledge approval requires an owner or admin of this business' using errcode = '42501';
  end if;
  return actor;
end;
$$;

-- Creates a document (p_document_id null) or a new draft revision of an
-- existing one. Older open drafts/pending revisions of the document are
-- withdrawn: an edit invalidates any review in progress. The published
-- revision is untouched and keeps serving until a newer one is approved.
create or replace function public.knowledge_create_document_revision(
  p_business_id uuid,
  p_document_id uuid,
  p_title text,
  p_content text,
  p_source_type text default 'manual',
  p_source_ref text default '',
  p_collection_id uuid default null
)
returns table (document_id uuid, revision_id uuid, revision integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := public.knowledge_require_member(p_business_id);
  doc public.knowledge_documents;
  next_revision integer;
  new_revision uuid;
begin
  if p_collection_id is not null and not exists (
    select 1 from public.knowledge_collections c where c.id = p_collection_id and c.business_id = p_business_id
  ) then
    raise exception 'knowledge collection not found' using errcode = '42501';
  end if;

  if p_document_id is null then
    insert into public.knowledge_documents (business_id, title, content, source_type, source_ref, status, collection_id)
    values (p_business_id, p_title, p_content, coalesce(p_source_type, 'manual'), coalesce(p_source_ref, ''), 'processing', p_collection_id)
    returning * into doc;
  else
    select * into doc from public.knowledge_documents d
    where d.id = p_document_id and d.business_id = p_business_id
    for update;
    if not found then
      raise exception 'knowledge document not found' using errcode = '42501';
    end if;
    update public.knowledge_documents d
       set title = p_title, content = p_content,
           source_type = coalesce(p_source_type, 'manual'), source_ref = coalesce(p_source_ref, ''),
           status = 'processing',
           collection_id = case when p_collection_id is null then d.collection_id else p_collection_id end
     where d.id = doc.id;
    update public.knowledge_document_revisions r
       set state = 'withdrawn', retired_by = actor, retired_at = now()
     where r.document_id = doc.id and r.state in ('draft', 'pending_review');
  end if;

  select coalesce(max(r.revision), 0) + 1 into next_revision
  from public.knowledge_document_revisions r where r.document_id = doc.id;

  insert into public.knowledge_document_revisions
    (business_id, document_id, revision, title, content, content_sha256, source_type, source_ref, origin, created_by)
  values
    (p_business_id, doc.id, next_revision, p_title, p_content, repeat('0', 64),
     coalesce(p_source_type, 'manual'), coalesce(p_source_ref, ''), 'editor', actor)
  returning id into new_revision;

  return query select doc.id, new_revision, next_revision;
end;
$$;

create or replace function public.knowledge_submit_revision(p_revision_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rev public.knowledge_document_revisions;
  actor uuid;
begin
  select * into rev from public.knowledge_document_revisions where id = p_revision_id for update;
  if not found then
    raise exception 'knowledge revision not found' using errcode = '42501';
  end if;
  actor := public.knowledge_require_member(rev.business_id);
  if rev.state <> 'draft' or rev.index_status <> 'ready' then
    raise exception 'only a fully indexed draft can be submitted for review';
  end if;
  update public.knowledge_document_revisions
     set state = 'pending_review', submitted_by = actor, submitted_at = now()
   where id = rev.id;
end;
$$;

-- Approve (publish) or reject. Approval locks the document, refuses a
-- revision older than the one already published, supersedes the current
-- published revision and moves the pointer in the same transaction.
create or replace function public.knowledge_review_revision(p_revision_id uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  rev public.knowledge_document_revisions;
  doc public.knowledge_documents;
  current_rev public.knowledge_document_revisions;
  actor uuid;
begin
  select * into rev from public.knowledge_document_revisions where id = p_revision_id;
  if not found then
    raise exception 'knowledge revision not found' using errcode = '42501';
  end if;
  actor := public.knowledge_require_approver(rev.business_id);

  select * into doc from public.knowledge_documents
   where id = rev.document_id and business_id = rev.business_id for update;
  select * into rev from public.knowledge_document_revisions where id = p_revision_id for update;
  if rev.state <> 'pending_review' then
    raise exception 'knowledge revision is not pending review (state %)', rev.state;
  end if;

  if not coalesce(p_approve, false) then
    update public.knowledge_document_revisions
       set state = 'rejected', reviewed_by = actor, reviewed_at = now()
     where id = rev.id;
    return 'rejected';
  end if;

  if rev.index_status <> 'ready' or rev.chunk_count < 1
     or rev.chunk_count <> (select count(*) from public.knowledge_chunks k
                            where k.revision_id = rev.id and k.business_id = rev.business_id
                              and k.document_id = rev.document_id) then
    raise exception 'knowledge revision is not completely indexed';
  end if;

  if doc.published_revision_id is not null then
    select * into current_rev from public.knowledge_document_revisions where id = doc.published_revision_id for update;
    if current_rev.revision > rev.revision then
      raise exception 'a newer revision (%) is already published', current_rev.revision;
    end if;
    update public.knowledge_document_revisions
       set state = 'superseded', retired_by = actor, retired_at = now()
     where id = current_rev.id;
  end if;

  update public.knowledge_document_revisions
     set state = 'approved', reviewed_by = actor, reviewed_at = now()
   where id = rev.id;
  update public.knowledge_documents
     set published_revision_id = rev.id
   where id = doc.id;
  return 'approved';
end;
$$;

-- Withdraw: the published revision stops serving immediately.
create or replace function public.knowledge_withdraw_document(p_document_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  doc public.knowledge_documents;
  actor uuid;
begin
  select * into doc from public.knowledge_documents where id = p_document_id;
  if not found then
    raise exception 'knowledge document not found' using errcode = '42501';
  end if;
  actor := public.knowledge_require_approver(doc.business_id);
  select * into doc from public.knowledge_documents where id = p_document_id for update;
  if doc.published_revision_id is null then
    return false;
  end if;
  update public.knowledge_documents set published_revision_id = null where id = doc.id;
  update public.knowledge_document_revisions
     set state = 'withdrawn', retired_by = actor, retired_at = now()
   where id = doc.published_revision_id;
  return true;
end;
$$;

create or replace function public.faq_create_revision(
  p_business_id uuid,
  p_faq_id uuid,
  p_question text,
  p_answer text,
  p_category text default ''
)
returns table (faq_id uuid, revision_id uuid, revision integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := public.knowledge_require_member(p_business_id);
  item public.faqs;
  next_revision integer;
  new_revision uuid;
begin
  if p_faq_id is null then
    insert into public.faqs (business_id, question, answer, category, is_published)
    values (p_business_id, p_question, p_answer, coalesce(p_category, ''), false)
    returning * into item;
  else
    select * into item from public.faqs f
    where f.id = p_faq_id and f.business_id = p_business_id
    for update;
    if not found then
      raise exception 'faq not found' using errcode = '42501';
    end if;
    update public.faqs f
       set question = p_question, answer = p_answer, category = coalesce(p_category, '')
     where f.id = item.id;
    update public.faq_revisions r
       set state = 'withdrawn', retired_by = actor, retired_at = now()
     where r.faq_id = item.id and r.state = 'pending_review';
  end if;

  select coalesce(max(r.revision), 0) + 1 into next_revision from public.faq_revisions r where r.faq_id = item.id;
  insert into public.faq_revisions (business_id, faq_id, revision, question, answer, category, content_sha256, origin, created_by)
  values (p_business_id, item.id, next_revision, p_question, p_answer, coalesce(p_category, ''), repeat('0', 64), 'editor', actor)
  returning id into new_revision;
  return query select item.id, new_revision, next_revision;
end;
$$;

create or replace function public.faq_review_revision(p_revision_id uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  rev public.faq_revisions;
  item public.faqs;
  current_rev public.faq_revisions;
  actor uuid;
begin
  select * into rev from public.faq_revisions where id = p_revision_id;
  if not found then
    raise exception 'faq revision not found' using errcode = '42501';
  end if;
  actor := public.knowledge_require_approver(rev.business_id);
  select * into item from public.faqs where id = rev.faq_id and business_id = rev.business_id for update;
  select * into rev from public.faq_revisions where id = p_revision_id for update;
  if rev.state <> 'pending_review' then
    raise exception 'faq revision is not pending review (state %)', rev.state;
  end if;

  if not coalesce(p_approve, false) then
    update public.faq_revisions set state = 'rejected', reviewed_by = actor, reviewed_at = now() where id = rev.id;
    return 'rejected';
  end if;

  if item.published_revision_id is not null then
    select * into current_rev from public.faq_revisions where id = item.published_revision_id for update;
    if current_rev.revision > rev.revision then
      raise exception 'a newer revision (%) is already published', current_rev.revision;
    end if;
    update public.faq_revisions set state = 'superseded', retired_by = actor, retired_at = now() where id = current_rev.id;
  end if;
  update public.faq_revisions set state = 'approved', reviewed_by = actor, reviewed_at = now() where id = rev.id;
  update public.faqs set published_revision_id = rev.id, is_published = true where id = item.id;
  return 'approved';
end;
$$;

create or replace function public.faq_withdraw(p_faq_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.faqs;
  actor uuid;
begin
  select * into item from public.faqs where id = p_faq_id;
  if not found then
    raise exception 'faq not found' using errcode = '42501';
  end if;
  actor := public.knowledge_require_approver(item.business_id);
  select * into item from public.faqs where id = p_faq_id for update;
  if item.published_revision_id is null then
    update public.faqs set is_published = false where id = item.id;
    return false;
  end if;
  update public.faqs set published_revision_id = null, is_published = false where id = item.id;
  update public.faq_revisions set state = 'withdrawn', retired_by = actor, retired_at = now()
   where id = item.published_revision_id;
  return true;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Indexing RPCs (service role). Every call names the tenant, document and
-- revision; all three must agree. Indexing never publishes anything.
-- ----------------------------------------------------------------------------
create or replace function public.knowledge_begin_indexing(p_business_id uuid, p_document_id uuid, p_revision_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rev public.knowledge_document_revisions;
begin
  -- Lock order everywhere: document, then revision.
  perform 1 from public.knowledge_documents where id = p_document_id and business_id = p_business_id for update;
  select * into rev from public.knowledge_document_revisions
   where id = p_revision_id and document_id = p_document_id and business_id = p_business_id
   for update;
  if not found then
    raise exception 'knowledge revision not found for this business and document' using errcode = '42501';
  end if;
  if rev.state <> 'draft' then
    raise exception 'only a draft revision can be indexed';
  end if;
  delete from public.knowledge_chunks where revision_id = rev.id;
  update public.knowledge_document_revisions set index_status = 'pending', chunk_count = 0 where id = rev.id;
  update public.knowledge_documents set status = 'processing' where id = p_document_id and business_id = p_business_id;
end;
$$;

-- Marks the draft ready only when exactly p_expected_chunks nonblank chunks
-- of this revision exist; otherwise failed. Returns the resulting status.
create or replace function public.knowledge_finish_indexing(
  p_business_id uuid, p_document_id uuid, p_revision_id uuid, p_expected_chunks integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  rev public.knowledge_document_revisions;
  actual integer;
  outcome text;
begin
  perform 1 from public.knowledge_documents where id = p_document_id and business_id = p_business_id for update;
  select * into rev from public.knowledge_document_revisions
   where id = p_revision_id and document_id = p_document_id and business_id = p_business_id
   for update;
  if not found then
    raise exception 'knowledge revision not found for this business and document' using errcode = '42501';
  end if;
  if rev.state <> 'draft' then
    raise exception 'only a draft revision can be indexed';
  end if;
  select count(*) into actual from public.knowledge_chunks k
   where k.revision_id = rev.id and k.document_id = p_document_id and k.business_id = p_business_id
     and btrim(k.content) <> '';
  outcome := case when p_expected_chunks is not null and p_expected_chunks > 0 and actual = p_expected_chunks
                  and actual = (select count(*) from public.knowledge_chunks k where k.revision_id = rev.id)
             then 'ready' else 'failed' end;
  update public.knowledge_document_revisions
     set index_status = outcome, chunk_count = case when outcome = 'ready' then actual else 0 end
   where id = rev.id;
  -- The container's status reflects its newest revision only.
  if rev.revision = (select max(r.revision) from public.knowledge_document_revisions r where r.document_id = p_document_id) then
    update public.knowledge_documents set status = case when outcome = 'ready' then 'ready' else 'error' end
     where id = p_document_id and business_id = p_business_id;
  end if;
  return outcome;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Governed retrieval (service role). Approved, published, fully indexed,
-- tenant-consistent content only; scope enforced inside the query.
--   allowed_collection_ids = '{}'  -> all approved content of the tenant
--                                     (bound and unbound documents, FAQs)
--   nonempty                      -> only documents bound to those
--                                     collections; unbound documents and
--                                     FAQs are excluded
--   any unknown/foreign id, null  -> error (deny, never widen)
-- ----------------------------------------------------------------------------
create or replace function public.knowledge_assert_scope(target_business_id uuid, allowed_collection_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if target_business_id is null or allowed_collection_ids is null then
    raise exception 'knowledge retrieval requires a tenant and an explicit collection scope' using errcode = '42501';
  end if;
  if exists (
    select 1 from unnest(allowed_collection_ids) as wanted(id)
    where wanted.id is null or not exists (
      select 1 from public.knowledge_collections c where c.id = wanted.id and c.business_id = target_business_id)
  ) then
    raise exception 'knowledge collection scope names an unknown collection' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.search_governed_knowledge(
  target_business_id uuid,
  query text,
  allowed_collection_ids uuid[],
  match_limit int default 6
)
returns table (source text, ref_id uuid, revision_id uuid, business_id uuid, title text, content text, rank real)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  perform public.knowledge_assert_scope(target_business_id, allowed_collection_ids);
  return query
  with q as (select websearch_to_tsquery('english', query) as tsq)
  select * from (
    (
      select 'chunk'::text as src, kc.id as ref, r.id as rev, kc.business_id as biz, r.title as label,
             kc.content as body, ts_rank(kc.content_tsv, q.tsq) as score
      from public.knowledge_chunks kc
      join public.knowledge_document_revisions r
        on r.id = kc.revision_id and r.business_id = kc.business_id and r.document_id = kc.document_id
      join public.knowledge_documents d
        on d.id = r.document_id and d.business_id = r.business_id and d.published_revision_id = r.id
      cross join q
      where kc.business_id = target_business_id
        and r.state = 'approved' and r.index_status = 'ready'
        and (cardinality(allowed_collection_ids) = 0 or d.collection_id = any (allowed_collection_ids))
        and (d.collection_id is null or exists (
          select 1 from public.knowledge_collections c where c.id = d.collection_id and c.business_id = d.business_id))
        and kc.content_tsv @@ q.tsq
    )
    union all
    (
      select 'faq'::text, fr.id, fr.id, fr.business_id,
             case when fr.category = '' then 'FAQ' else fr.category end,
             'Q: ' || fr.question || E'\nA: ' || fr.answer,
             ts_rank(fr.content_tsv, q.tsq)
      from public.faq_revisions fr
      join public.faqs f on f.id = fr.faq_id and f.business_id = fr.business_id and f.published_revision_id = fr.id
      cross join q
      where fr.business_id = target_business_id
        and fr.state = 'approved'
        and cardinality(allowed_collection_ids) = 0
        and fr.content_tsv @@ q.tsq
    )
  ) governed
  order by governed.score desc
  limit greatest(least(coalesce(match_limit, 6), 50), 0);
end;
$$;

create or replace function public.match_governed_knowledge_chunks(
  target_business_id uuid,
  query_embedding vector(768),
  allowed_collection_ids uuid[],
  match_limit int default 6
)
returns table (ref_id uuid, revision_id uuid, business_id uuid, title text, content text, similarity float)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  perform public.knowledge_assert_scope(target_business_id, allowed_collection_ids);
  return query
  select kc.id, r.id, kc.business_id, r.title, kc.content,
         (1 - (kc.embedding <=> query_embedding))::float as similarity
  from public.knowledge_chunks kc
  join public.knowledge_document_revisions r
    on r.id = kc.revision_id and r.business_id = kc.business_id and r.document_id = kc.document_id
  join public.knowledge_documents d
    on d.id = r.document_id and d.business_id = r.business_id and d.published_revision_id = r.id
  where kc.business_id = target_business_id
    and kc.embedding is not null
    and r.state = 'approved' and r.index_status = 'ready'
    and (cardinality(allowed_collection_ids) = 0 or d.collection_id = any (allowed_collection_ids))
    and (d.collection_id is null or exists (
      select 1 from public.knowledge_collections c where c.id = d.collection_id and c.business_id = d.business_id))
  order by kc.embedding <=> query_embedding
  limit greatest(least(coalesce(match_limit, 6), 50), 0);
end;
$$;

-- The pre-D14 RPCs keep their signatures (an older application build may
-- still call them) but now return governed content only, tenant-wide.
create or replace function public.search_knowledge(
  target_business_id uuid,
  query text,
  match_limit int default 6
)
returns table (source text, ref_id uuid, title text, content text, rank real)
language sql
security definer
set search_path = public
stable
as $$
  select g.source, g.ref_id, g.title, g.content, g.rank
  from public.search_governed_knowledge(target_business_id, query, '{}'::uuid[], match_limit) g;
$$;

create or replace function public.match_knowledge_chunks(
  target_business_id uuid,
  query_embedding vector(768),
  match_limit int default 6
)
returns table (ref_id uuid, title text, content text, similarity float)
language sql
security definer
set search_path = public
stable
as $$
  select g.ref_id, g.title, g.content, g.similarity
  from public.match_governed_knowledge_chunks(target_business_id, query_embedding, '{}'::uuid[], match_limit) g;
$$;

-- ----------------------------------------------------------------------------
-- 8. Legacy census and backfill (service role). Never approves anything.
-- ----------------------------------------------------------------------------
create or replace function public.knowledge_governance_census(p_business_id uuid default null)
returns table (business_id uuid, check_name text, row_count bigint)
language sql
security definer
set search_path = public
stable
as $$
  select b.id, c.check_name, c.row_count
  from public.businesses b
  cross join lateral (
    select 'documents_without_revision'::text,
           (select count(*) from public.knowledge_documents d
             where d.business_id = b.id
               and not exists (select 1 from public.knowledge_document_revisions r where r.document_id = d.id))
    union all
    select 'faqs_without_revision',
           (select count(*) from public.faqs f
             where f.business_id = b.id
               and not exists (select 1 from public.faq_revisions r where r.faq_id = f.id))
    union all
    select 'legacy_faqs_marked_published_but_unapproved',
           (select count(*) from public.faqs f
             where f.business_id = b.id and f.is_published and f.published_revision_id is null)
    union all
    select 'legacy_chunks_without_revision',
           (select count(*) from public.knowledge_chunks k where k.business_id = b.id and k.revision_id is null)
    union all
    select 'chunks_with_foreign_document',
           (select count(*) from public.knowledge_chunks k join public.knowledge_documents d on d.id = k.document_id
             where k.business_id = b.id and d.business_id <> k.business_id)
    union all
    select 'documents_with_foreign_collection',
           (select count(*) from public.knowledge_documents d join public.knowledge_collections c on c.id = d.collection_id
             where d.business_id = b.id and c.business_id <> d.business_id)
    union all
    select 'empty_legacy_documents',
           (select count(*) from public.knowledge_documents d
             where d.business_id = b.id and btrim(d.content) = ''
               and not exists (select 1 from public.knowledge_document_revisions r where r.document_id = d.id))
    union all
    select 'revisions_pending_review',
           (select count(*) from public.knowledge_document_revisions r where r.business_id = b.id and r.state = 'pending_review')
           + (select count(*) from public.faq_revisions r where r.business_id = b.id and r.state = 'pending_review')
  ) as c(check_name, row_count)
  where p_business_id is null or b.id = p_business_id
  order by b.id, c.check_name;
$$;

-- Dry run by default. Creates, for ONE tenant, an unapproved revision for
-- every governable legacy item: a draft (index pending) per document with
-- content and a tenant-consistent collection, and a pending_review revision
-- per FAQ. Empty or tenant-mismatched documents are reported as
-- quarantined and left alone. Idempotent: items that already have a
-- revision are skipped. Deterministic order.
create or replace function public.knowledge_backfill_legacy(p_business_id uuid, p_apply boolean default false)
returns table (item_kind text, item_id uuid, action text)
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.knowledge_documents;
  f public.faqs;
begin
  if p_business_id is null or not exists (select 1 from public.businesses where id = p_business_id) then
    raise exception 'knowledge backfill requires an existing business id';
  end if;

  for d in
    select * from public.knowledge_documents x
    where x.business_id = p_business_id
      and not exists (select 1 from public.knowledge_document_revisions r where r.document_id = x.id)
    order by x.created_at, x.id
  loop
    if btrim(d.content) = '' or char_length(d.content) > 100000 then
      item_kind := 'document'; item_id := d.id; action := 'quarantined_unusable_content'; return next;
    elsif d.collection_id is not null and not exists (
      select 1 from public.knowledge_collections c where c.id = d.collection_id and c.business_id = d.business_id) then
      item_kind := 'document'; item_id := d.id; action := 'quarantined_foreign_collection'; return next;
    elsif d.source_type <> 'manual' and d.source_ref = '' then
      item_kind := 'document'; item_id := d.id; action := 'quarantined_missing_source'; return next;
    else
      if p_apply then
        insert into public.knowledge_document_revisions
          (business_id, document_id, revision, title, content, content_sha256, source_type, source_ref, origin, created_by)
        values (d.business_id, d.id, 1, d.title, d.content, repeat('0', 64), d.source_type, d.source_ref, 'legacy_backfill', null);
        update public.knowledge_documents set status = 'processing' where id = d.id;
      end if;
      item_kind := 'document'; item_id := d.id;
      action := case when p_apply then 'draft_created_needs_indexing' else 'would_create_draft' end;
      return next;
    end if;
  end loop;

  for f in
    select * from public.faqs x
    where x.business_id = p_business_id
      and not exists (select 1 from public.faq_revisions r where r.faq_id = x.id)
    order by x.created_at, x.id
  loop
    if char_length(f.category) > 100 then
      item_kind := 'faq'; item_id := f.id; action := 'quarantined_unusable_content'; return next;
    else
      if p_apply then
        insert into public.faq_revisions (business_id, faq_id, revision, question, answer, category, content_sha256, origin, created_by)
        values (f.business_id, f.id, 1, f.question, f.answer, f.category, repeat('0', 64), 'legacy_backfill', null);
      end if;
      item_kind := 'faq'; item_id := f.id;
      action := case when p_apply then 'pending_review_created' else 'would_create_pending_review' end;
      return next;
    end if;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. RLS, grants and policies.
-- ----------------------------------------------------------------------------
alter table public.knowledge_document_revisions enable row level security;
alter table public.faq_revisions enable row level security;

create policy knowledge_document_revisions_read on public.knowledge_document_revisions
  for select to authenticated using (public.is_business_member(business_id));
create policy faq_revisions_read on public.faq_revisions
  for select to authenticated using (public.is_business_member(business_id));

-- Revisions are written only through the SECURITY DEFINER functions above.
revoke all on public.knowledge_document_revisions from public, anon, authenticated, service_role;
revoke all on public.faq_revisions from public, anon, authenticated, service_role;
grant select on public.knowledge_document_revisions to authenticated, service_role;
grant select on public.faq_revisions to authenticated, service_role;

-- Containers: members read; all edits go through the RPCs; an owner/admin
-- may delete an unpublished container (which removes its history).
revoke insert, update on public.knowledge_documents from anon, authenticated;
revoke insert, update on public.faqs from anon, authenticated;
drop policy if exists "members write documents" on public.knowledge_documents;
drop policy if exists "members update documents" on public.knowledge_documents;
drop policy if exists "members delete documents" on public.knowledge_documents;
drop policy if exists "members write faqs" on public.faqs;
drop policy if exists "members update faqs" on public.faqs;
drop policy if exists "members delete faqs" on public.faqs;
create policy "admins delete unpublished documents" on public.knowledge_documents
  for delete to authenticated
  using (public.is_business_admin(business_id) and published_revision_id is null);
create policy "admins delete unpublished faqs" on public.faqs
  for delete to authenticated
  using (public.is_business_admin(business_id) and published_revision_id is null);

-- Chunks are written only by the service-role indexer.
revoke insert, update, delete on public.knowledge_chunks from anon, authenticated;
revoke update on public.knowledge_chunks from service_role;
drop policy if exists "members write chunks" on public.knowledge_chunks;
drop policy if exists "members delete chunks" on public.knowledge_chunks;

-- Functions: PUBLIC holds EXECUTE on new functions by default; revoke it.
revoke execute on function public.knowledge_content_sha256(text) from public, anon, authenticated;
revoke execute on function public.is_knowledge_approver(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.enforce_knowledge_document_revision() from public, anon, authenticated;
revoke execute on function public.enforce_faq_revision() from public, anon, authenticated;
revoke execute on function public.enforce_knowledge_chunk() from public, anon, authenticated;
revoke execute on function public.enforce_knowledge_document() from public, anon, authenticated;
revoke execute on function public.enforce_faq() from public, anon, authenticated;
revoke execute on function public.check_knowledge_publication() from public, anon, authenticated;
revoke execute on function public.knowledge_require_member(uuid) from public, anon, authenticated;
revoke execute on function public.knowledge_require_approver(uuid) from public, anon, authenticated;

revoke execute on function public.knowledge_create_document_revision(uuid, uuid, text, text, text, text, uuid) from public, anon;
revoke execute on function public.knowledge_submit_revision(uuid) from public, anon;
revoke execute on function public.knowledge_review_revision(uuid, boolean) from public, anon;
revoke execute on function public.knowledge_withdraw_document(uuid) from public, anon;
revoke execute on function public.faq_create_revision(uuid, uuid, text, text, text) from public, anon;
revoke execute on function public.faq_review_revision(uuid, boolean) from public, anon;
revoke execute on function public.faq_withdraw(uuid) from public, anon;
grant execute on function public.knowledge_create_document_revision(uuid, uuid, text, text, text, text, uuid) to authenticated;
grant execute on function public.knowledge_submit_revision(uuid) to authenticated;
grant execute on function public.knowledge_review_revision(uuid, boolean) to authenticated;
grant execute on function public.knowledge_withdraw_document(uuid) to authenticated;
grant execute on function public.faq_create_revision(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.faq_review_revision(uuid, boolean) to authenticated;
grant execute on function public.faq_withdraw(uuid) to authenticated;

revoke execute on function public.knowledge_begin_indexing(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.knowledge_finish_indexing(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.knowledge_assert_scope(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.search_governed_knowledge(uuid, text, uuid[], int) from public, anon, authenticated;
revoke execute on function public.match_governed_knowledge_chunks(uuid, vector, uuid[], int) from public, anon, authenticated;
revoke execute on function public.search_knowledge(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.match_knowledge_chunks(uuid, vector, int) from public, anon, authenticated;
revoke execute on function public.knowledge_governance_census(uuid) from public, anon, authenticated;
revoke execute on function public.knowledge_backfill_legacy(uuid, boolean) from public, anon, authenticated;
grant execute on function public.knowledge_begin_indexing(uuid, uuid, uuid) to service_role;
grant execute on function public.knowledge_finish_indexing(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.search_governed_knowledge(uuid, text, uuid[], int) to service_role;
grant execute on function public.match_governed_knowledge_chunks(uuid, vector, uuid[], int) to service_role;
grant execute on function public.search_knowledge(uuid, text, int) to service_role;
grant execute on function public.match_knowledge_chunks(uuid, vector, int) to service_role;
grant execute on function public.knowledge_governance_census(uuid) to service_role;
grant execute on function public.knowledge_backfill_legacy(uuid, boolean) to service_role;
