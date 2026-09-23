begin;

-- Single app-owned website configuration; configured by trusted onboarding.
alter table public.apps add column website_url text
  check (website_url is null or (website_url ~ '^https?://' and length(website_url) <= 2000));

create function public.replace_website_page(
  p_app_id uuid, p_website_url text, p_url text, p_title text,
  p_content text, p_chunks text[], p_checked_at timestamptz
) returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  page public.website_pages%rowtype;
  source_hash text;
  part text;
  position integer := 0;
begin
  perform 1 from public.apps a where a.id = p_app_id and a.website_url = p_website_url for share;
  if not found or not public.app_has_capability(p_app_id, 'knowledge.website.read') then
    raise exception 'Website access denied' using errcode = '42501';
  end if;
  if p_content is null or length(btrim(p_content)) = 0 or length(p_content) > 200000
    or p_chunks is null or cardinality(p_chunks) > 200 then
    raise exception 'Invalid website content' using errcode = '22023';
  end if;
  source_hash := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  insert into public.website_pages(app_id, url) values (p_app_id, p_url)
    on conflict (app_id, url) do nothing;
  select * into page from public.website_pages where app_id = p_app_id and url = p_url for update;
  -- A slower concurrent fetch must not overwrite a newer observation.
  if page.last_checked_at > p_checked_at then return 'superseded'; end if;
  if page.processed_content_hash = source_hash and page.content_hash = source_hash then
    update public.website_pages set title = p_title, sync_status = 'ready', last_error = null,
      last_checked_at = p_checked_at where id = page.id;
    return 'unchanged';
  end if;
  if cardinality(p_chunks) < 1 then
    raise exception 'Concurrent content change; retry sync' using errcode = '40001';
  end if;
  delete from public.website_knowledge_chunks where app_id = p_app_id and page_id = page.id;
  foreach part in array p_chunks loop
    if part is null or length(btrim(part)) = 0 or length(part) > 3000 then
      raise exception 'Invalid chunk' using errcode = '22023';
    end if;
    insert into public.website_knowledge_chunks(app_id, page_id, chunk_index, content, content_hash, source_content_hash)
    values (p_app_id, page.id, position, part, encode(sha256(convert_to(part, 'UTF8')), 'hex'), source_hash)
    on conflict (app_id, page_id, content_hash) do nothing;
    position := position + 1;
  end loop;
  update public.website_pages set title = p_title, content = p_content, content_hash = source_hash,
    processed_content_hash = source_hash, sync_status = 'ready', last_error = null,
    last_checked_at = p_checked_at, last_synced_at = clock_timestamp() where id = page.id;
  return 'updated';
end;
$$;
revoke all on function public.replace_website_page(uuid, text, text, text, text, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.replace_website_page(uuid, text, text, text, text, text[], timestamptz) to service_role;
commit;
