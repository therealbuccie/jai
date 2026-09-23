begin;

-- The caller supplies a stable request UUID so a retry cannot create two apps.
create function public.create_application(p_app_id uuid, p_name text, p_website_url text)
returns public.apps language plpgsql security definer set search_path = ''
as $$
declare
  org_id uuid;
  result public.apps%rowtype;
begin
  select h.organization_id into org_id from public.human_agents h
    where h.auth_user_id = auth.uid() and h.role = 'admin' for share;
  if org_id is null then raise exception 'Organization admin required' using errcode = '42501'; end if;
  if p_app_id is null or p_name is null or length(btrim(p_name)) not between 1 and 120
    or p_name ~ '[[:cntrl:]]' or p_website_url is null or length(p_website_url) > 2000
    or p_website_url !~ '^https?://[a-z0-9.-]+/' then
    raise exception 'Invalid application details' using errcode = '22023';
  end if;
  -- This saves configuration only. allow-jai performs public DNS validation
  -- before any permissions or website access are granted.
  insert into public.apps(id, organization_id, name, slug, website_url)
    values (p_app_id, org_id, btrim(p_name), 'app-' || p_app_id::text, p_website_url)
    on conflict (id) do nothing;
  select * into result from public.apps where id = p_app_id and organization_id = org_id;
  if not found then raise exception 'Application unavailable' using errcode = '42501'; end if;
  return result;
end;
$$;
revoke all on function public.create_application(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_application(uuid, text, text) to authenticated;

-- Aggregate only: no browser access to crawled text or privileged ingestion.
create function public.application_knowledge_status()
returns table(app_id uuid, ready_pages bigint, failed_pages bigint, pending_pages bigint, last_synced_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select a.id, count(p.id) filter (where p.sync_status = 'ready'),
    count(p.id) filter (where p.sync_status = 'failed'),
    count(p.id) filter (where p.sync_status in ('pending', 'syncing')), max(p.last_synced_at)
  from public.apps a left join public.website_pages p on p.app_id = a.id
  where jai_private.is_organization_agent(a.organization_id, true)
  group by a.id;
$$;
revoke all on function public.application_knowledge_status() from public, anon, authenticated;
grant execute on function public.application_knowledge_status() to authenticated;
commit;
