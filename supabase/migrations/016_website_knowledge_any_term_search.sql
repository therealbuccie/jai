begin;

create or replace function public.search_website_knowledge(p_app_id uuid, p_query text, p_limit integer default 8)
returns table (chunk_id uuid, page_id uuid, url text, title text, content text, rank real)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  search_query tsquery;
begin
  if not public.app_has_capability(p_app_id, 'knowledge.website.read') then
    raise exception 'Website knowledge permission required' using errcode = '42501';
  end if;
  -- Build an OR query from normalized lexemes, never raw tsquery syntax.
  select to_tsquery('pg_catalog.simple'::regconfig,
    string_agg(quote_literal(term), ' | ')) into search_query
  from unnest(tsvector_to_array(to_tsvector('pg_catalog.simple'::regconfig, left(coalesce(p_query, ''), 1000)))) as terms(term);
  if search_query is null then return; end if;
  return query
    select k.id, p.id, p.url, p.title, k.content,
      ts_rank(k.search_document, search_query)
    from public.website_knowledge_chunks k
    join public.website_pages p on p.id = k.page_id and p.app_id = k.app_id
    where k.app_id = p_app_id and p.sync_status = 'ready'
      and p.content_hash = p.processed_content_hash
      and k.source_content_hash = p.content_hash
      and k.search_document @@ search_query
    order by 6 desc, k.id
    limit greatest(1, least(coalesce(p_limit, 8), 50));
end;
$$;
revoke all on function public.search_website_knowledge(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.search_website_knowledge(uuid, text, integer) to service_role;


commit;
