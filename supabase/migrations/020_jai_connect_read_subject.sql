begin;

-- Read-only access to the existing verified mapping; no direct table grant.
create function public.resolve_jai_connect_read_subject(p_app_id uuid, p_customer_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select m.external_subject
  from public.jai_connect_customers m
  join public.apps a on a.id = m.app_id and a.status = 'active'
  join public.customers c on c.id = m.customer_id
    and c.organization_id = a.organization_id
  where m.app_id = p_app_id and m.customer_id = p_customer_id;
$$;
revoke all on function public.resolve_jai_connect_read_subject(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_jai_connect_read_subject(uuid, uuid)
  to service_role;

commit;
