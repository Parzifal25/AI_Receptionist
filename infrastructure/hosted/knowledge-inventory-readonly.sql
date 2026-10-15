-- WS3: aggregate-only, tenant-scoped inventory AFTER 0033. No backfill or approval.
-- Requires separately authorized target reads, verified function definitions and
-- an explicit psql business_id variable. Missing/unknown tenant is an error.
\set ON_ERROR_STOP on
begin transaction isolation level repeatable read read only;
select :'business_id'::uuid as inventory_business_id \gset
select 1 / case when exists(select 1 from public.businesses where id=:'inventory_business_id'::uuid) then 1 else 0 end as tenant_exists;
with d as (select * from public.knowledge_documents where business_id=:'inventory_business_id'::uuid),
f as (select * from public.faqs where business_id=:'inventory_business_id'::uuid),
r as (select * from public.knowledge_document_revisions where business_id=:'inventory_business_id'::uuid),
fr as (select * from public.faq_revisions where business_id=:'inventory_business_id'::uuid),
k as (select * from public.knowledge_chunks where business_id=:'inventory_business_id'::uuid),
legacy as (select * from d where not exists(select 1 from r where r.document_id=d.id)),
counts(category,n) as (
 select 'documents_total',count(*) from d
 union all select 'faqs_total',count(*) from f
 union all select 'documents_unbound',count(*) from d where collection_id is null
 union all select 'documents_missing_or_foreign_collection',count(*) from d left join public.knowledge_collections c on c.id=d.collection_id
   where d.collection_id is not null and (c.id is null or c.business_id<>d.business_id)
 union all select 'legacy_documents',count(*) from legacy
 union all select 'legacy_source_ref_over_500_apply_blocker',count(*) from legacy where char_length(source_ref)>500
 union all select 'legacy_content_unusable',count(*) from legacy where btrim(content)='' or char_length(content)>100000
 union all select 'legacy_missing_source',count(*) from legacy where source_type<>'manual' and source_ref=''
 union all select 'legacy_faq_category_over_100',count(*) from f where char_length(category)>100 and not exists(select 1 from fr where fr.faq_id=f.id)
 union all select 'chunks_missing_or_foreign_document',count(*) from k left join public.knowledge_documents p on p.id=k.document_id
   where p.id is null or p.business_id<>k.business_id
 union all select 'chunks_legacy_null_revision',count(*) from k where revision_id is null
 union all select 'chunks_bad_revision_parent',count(*) from k left join public.knowledge_document_revisions p on p.id=k.revision_id
   where k.revision_id is not null and (p.id is null or p.business_id<>k.business_id or p.document_id<>k.document_id)
 union all select 'chunks_duplicate_revision_index_groups',count(*) from (select revision_id,chunk_index from k where revision_id is not null group by 1,2 having count(*)>1) s
 union all select 'revisions_missing_or_foreign_document',count(*) from r left join public.knowledge_documents p on p.id=r.document_id where p.id is null or p.business_id<>r.business_id
 union all select 'faq_revisions_missing_or_foreign_parent',count(*) from fr left join public.faqs p on p.id=fr.faq_id where p.id is null or p.business_id<>fr.business_id
 union all select 'document_publication_bad_parent',count(*) from d left join public.knowledge_document_revisions p on p.id=d.published_revision_id
   where d.published_revision_id is not null and (p.id is null or p.business_id<>d.business_id or p.document_id<>d.id or p.state<>'approved')
 union all select 'faq_publication_bad_parent',count(*) from f left join public.faq_revisions p on p.id=f.published_revision_id
   where f.published_revision_id is not null and (p.id is null or p.business_id<>f.business_id or p.faq_id<>f.id or p.state<>'approved')
 union all select 'draft_index_failed',count(*) from r where state='draft' and index_status='failed'
 union all select 'draft_index_pending',count(*) from r where state='draft' and index_status='pending'
 union all select 'document_pending_review',count(*) from r where state='pending_review'
 union all select 'faq_pending_review',count(*) from fr where state='pending_review'
 union all select 'approved_chunks_without_embedding',count(*) from k join r on r.id=k.revision_id where r.state='approved' and k.embedding is null
 union all select 'revision_chunk_count_disagreement',count(*) from r where r.index_status='ready' and r.chunk_count<>(select count(*) from k where k.revision_id=r.id)
 union all select 'duplicate_content_hash_groups',count(*) from (select content_sha256 from r group by 1 having count(distinct document_id)>1) s
)
select category,n from counts order by category;
rollback;
