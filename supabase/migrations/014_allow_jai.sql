begin;

-- Only the trusted endpoint may supply the identity verified by Supabase Auth.
create function public.allow_jai(p_app_id uuid, p_actor_id uuid, p_website_url text)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  target public.apps%rowtype;
  granted text[];
begin
  select a.* into target from public.apps a where a.id = p_app_id for update;
  if not found then
    raise exception 'App not found or access denied' using errcode = '42501';
  end if;
  perform 1 from public.human_agents h
    where h.auth_user_id = p_actor_id and h.organization_id = target.organization_id
      and h.role = 'admin' for share;
  if not found then
    raise exception 'App not found or access denied' using errcode = '42501';
  end if;
  -- Full public-host validation/canonicalization happens in the trusted endpoint.
  if p_website_url is null or length(p_website_url) > 2000
    or p_website_url !~ '^https?://[a-z0-9.-]+/' then
    raise exception 'Invalid website URL' using errcode = '22023';
  end if;
  update public.apps set website_url = p_website_url where id = target.id
    returning * into target;
  with enabled as (
    insert into public.app_capabilities(app_id, capability_key, enabled)
    select target.id, c.key, true from public.capabilities c
      where c.recommended and c.available and c.kind in ('read', 'diagnostic')
    on conflict (app_id, capability_key) do update set enabled = true
    returning capability_key
  ) select coalesce(array_agg(capability_key order by capability_key), '{}'::text[]) into granted from enabled;
  return jsonb_build_object('app', to_jsonb(target), 'granted_capabilities', to_jsonb(granted));
end;
$$;
revoke all on function public.allow_jai(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.allow_jai(uuid, uuid, text) to service_role;
commit;
