-- ============================================================================
-- Source attribution for retrieval.
--
-- Retrieved snippets previously arrived at the model as anonymous text. The
-- receptionist couldn't say "According to our pricing page…", and the
-- dashboard couldn't show which document answered a question. Both retrieval
-- functions now return a human-readable `title`:
--   • chunks → the parent document's title
--   • FAQs   → the FAQ category, or "FAQ" when uncategorised
--
-- Return signatures change, so the functions are dropped and recreated. Grants
-- are re-applied (0002 locked these down to service_role only).
-- ============================================================================

drop function if exists public.search_knowledge(uuid, text, int);

create function public.search_knowledge(
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
  with q as (select websearch_to_tsquery('english', query) as tsq)
  (
    select 'chunk'::text, kc.id, coalesce(kd.title, 'Document'),
           kc.content, ts_rank(kc.content_tsv, q.tsq) as rank
    from public.knowledge_chunks kc
    join public.knowledge_documents kd on kd.id = kc.document_id
    cross join q
    where kc.business_id = target_business_id
      and kc.content_tsv @@ q.tsq
  )
  union all
  (
    select 'faq'::text, f.id,
           case when f.category = '' then 'FAQ' else f.category end,
           'Q: ' || f.question || E'\nA: ' || f.answer,
           ts_rank(f.content_tsv, q.tsq) as rank
    from public.faqs f
    cross join q
    where f.business_id = target_business_id
      and f.is_published
      and f.content_tsv @@ q.tsq
  )
  order by rank desc
  limit match_limit;
$$;

revoke execute on function public.search_knowledge(uuid, text, int) from public, anon, authenticated;
grant  execute on function public.search_knowledge(uuid, text, int) to service_role;

drop function if exists public.match_knowledge_chunks(uuid, vector, int);

create function public.match_knowledge_chunks(
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
  select kc.id, coalesce(kd.title, 'Document'), kc.content,
         1 - (kc.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks kc
  join public.knowledge_documents kd on kd.id = kc.document_id
  where kc.business_id = target_business_id
    and kc.embedding is not null
  order by kc.embedding <=> query_embedding
  limit match_limit;
$$;

revoke execute on function public.match_knowledge_chunks(uuid, vector, int) from public, anon, authenticated;
grant  execute on function public.match_knowledge_chunks(uuid, vector, int) to service_role;
