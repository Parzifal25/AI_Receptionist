-- WS3 K1: owner-authorized local implementation (Final Closure prompt).
-- Prerequisite: 0033 knowledge governance; apply after 0034 in ledger order.
-- Legacy source_ref is unbounded; immutable revisions require <=500 characters.
-- Share the same quarantine branch in dry-run and apply, leaving invalid
-- provenance unchanged while valid items proceed. No automatic approval.
-- CREATE OR REPLACE preserves function identity, owner and existing ACLs:
-- service_role only, SECURITY DEFINER with fixed public search_path.
-- No table, constraint, RLS policy, publication or retrieval change.
-- Run in the migration runner's transaction with its ledger entry. A failure
-- rolls back the entire tenant call; callers still serialize per tenant.
-- Idempotent function replacement; no data transformation during migration.
-- No hosted/shared application is authorized by this implementation approval.

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
    elsif char_length(d.source_ref) > 500 then
      item_kind := 'document'; item_id := d.id; action := 'quarantined_source_ref_too_long'; return next;
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
