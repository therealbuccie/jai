begin;

-- A missing or disabled row is unavailable. This URL is configuration, never
-- an authorization grant; outbound code must still revalidate DNS/IP and TLS.
create table public.jai_connect_read_endpoints (
  app_id uuid primary key references public.apps(id) on delete cascade,
  endpoint_url text not null check (
    length(endpoint_url) between 12 and 2048
    and endpoint_url ~ '^https://([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}(/[A-Za-z0-9._~/%-]*)?$'
  ),
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.jai_connect_read_endpoints enable row level security;
revoke all on public.jai_connect_read_endpoints from public, anon, authenticated, service_role;
grant select on public.jai_connect_read_endpoints to authenticated;
grant insert (app_id, endpoint_url, enabled) on public.jai_connect_read_endpoints to authenticated;
grant update (endpoint_url, enabled) on public.jai_connect_read_endpoints to authenticated;

create policy jai_connect_read_admin_select on public.jai_connect_read_endpoints
for select to authenticated using (exists (
  select 1 from public.apps a where a.id = app_id
    and jai_private.is_organization_agent(a.organization_id, true)
));
create policy jai_connect_read_admin_insert on public.jai_connect_read_endpoints
for insert to authenticated with check (exists (
  select 1 from public.apps a where a.id = app_id
    and jai_private.is_organization_agent(a.organization_id, true)
));
create policy jai_connect_read_admin_update on public.jai_connect_read_endpoints
for update to authenticated using (exists (
  select 1 from public.apps a where a.id = app_id
    and jai_private.is_organization_agent(a.organization_id, true)
)) with check (exists (
  select 1 from public.apps a where a.id = app_id
    and jai_private.is_organization_agent(a.organization_id, true)
));

-- Future server-side clients must resolve through this dual gate using an
-- app_id derived from trusted customer/conversation state, never model input.
create function public.resolve_jai_connect_read_endpoint(p_app_id uuid, p_capability_key text)
returns text language sql stable security definer set search_path = ''
as $$
  select e.endpoint_url from public.jai_connect_read_endpoints e
  where e.app_id = p_app_id and e.enabled
    and p_capability_key in (
      'customer.profile.read', 'customer.subscription.read',
      'billing.payment.read', 'diagnostics.read'
    )
    and public.app_has_capability(p_app_id, p_capability_key)
  limit 1;
$$;
revoke all on function public.resolve_jai_connect_read_endpoint(uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_jai_connect_read_endpoint(uuid, text)
  to service_role;

commit;
