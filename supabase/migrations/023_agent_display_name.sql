begin;

-- Names are customer-facing; authentication email remains separate.
create function public.set_agent_display_name(p_agent_id uuid, p_name text)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  org_id uuid;
  saved_name text;
begin
  select h.organization_id into org_id from public.human_agents h
    where h.auth_user_id = auth.uid() and h.role = 'admin' for share;
  if org_id is null then
    raise exception 'Organization admin required' using errcode = '42501';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120
    or p_name ~ '[[:cntrl:]@]' then
    raise exception 'Enter a display name, not an email address' using errcode = '22023';
  end if;
  update public.human_agents set name = btrim(p_name)
    where id = p_agent_id and organization_id = org_id
    returning name into saved_name;
  if not found then
    raise exception 'Agent unavailable' using errcode = '42501';
  end if;
  return saved_name;
end;
$$;
revoke all on function public.set_agent_display_name(uuid, text) from public, anon, authenticated;
grant execute on function public.set_agent_display_name(uuid, text) to authenticated;

commit;
