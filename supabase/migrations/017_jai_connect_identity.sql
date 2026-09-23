begin;

-- Public verification keys belong to one JAI app. Private keys stay with the integrator.
create table public.jai_connect_keys (
  app_id uuid not null references public.apps(id) on delete cascade,
  kid uuid not null,
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (app_id, kid)
);
alter table public.jai_connect_keys enable row level security;
revoke all on public.jai_connect_keys from public, anon, authenticated;
grant select on public.jai_connect_keys to authenticated;
grant insert (app_id, kid, public_key, enabled) on public.jai_connect_keys to authenticated;
grant update (enabled) on public.jai_connect_keys to authenticated;
grant select on public.jai_connect_keys to service_role;
create policy jai_connect_keys_admin_select on public.jai_connect_keys
for select to authenticated using (exists (
  select 1 from public.apps a where a.id = app_id
    and jai_private.is_organization_agent(a.organization_id, true)
));
create policy jai_connect_keys_admin_insert on public.jai_connect_keys
for insert to authenticated with check (exists (
  select 1 from public.apps a where a.id = app_id
    and jai_private.is_organization_agent(a.organization_id, true)
));
create policy jai_connect_keys_admin_update on public.jai_connect_keys
for update to authenticated using (exists (
  select 1 from public.apps a where a.id = app_id
    and jai_private.is_organization_agent(a.organization_id, true)
)) with check (exists (
  select 1 from public.apps a where a.id = app_id
    and jai_private.is_organization_agent(a.organization_id, true)
));

-- One stable JAI customer per (app, signed external subject).
create table public.jai_connect_customers (
  app_id uuid not null references public.apps(id) on delete cascade,
  external_subject text not null check (length(external_subject) between 1 and 200),
  customer_id uuid not null unique references public.customers(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (app_id, external_subject)
);
alter table public.jai_connect_customers enable row level security;
revoke all on public.jai_connect_customers from public, anon, authenticated, service_role;

-- A signed assertion can be redeemed only once, including across workers.
create table public.jai_connect_redemptions (
  app_id uuid not null references public.apps(id) on delete cascade,
  jti uuid not null,
  redeemed_at timestamptz not null default now(),
  primary key (app_id, jti)
);
alter table public.jai_connect_redemptions enable row level security;
revoke all on public.jai_connect_redemptions from public, anon, authenticated, service_role;

-- Called only after Edge verifies an app-scoped Ed25519 signature and short expiry.
-- Mapping, replay consumption and session creation commit in one transaction.
create function public.redeem_jai_connect_identity(
  p_app_id uuid, p_kid uuid, p_external_subject text, p_jti uuid,
  p_name text, p_email text, p_session_token_hash text
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  app_org uuid;
  mapped_customer uuid;
begin
  if p_app_id is null or p_kid is null or p_jti is null or p_external_subject is null
    or length(p_external_subject) not between 1 and 200
    or p_external_subject ~ '[[:cntrl:]]'
    or (p_name is not null and (length(p_name) > 200 or p_name ~ '[[:cntrl:]]'))
    or (p_email is not null and (length(p_email) > 254 or p_email ~ '[[:cntrl:]]'))
    or p_session_token_hash is null or p_session_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid verified identity' using errcode = '22023';
  end if;
  select a.organization_id into app_org from public.apps a
    where a.id = p_app_id and a.status = 'active' for share;
  if app_org is null then raise exception 'Active app required' using errcode = '42501'; end if;
  perform 1 from public.jai_connect_keys k where k.app_id = p_app_id
    and k.kid = p_kid and k.enabled for share;
  if not found then raise exception 'Signing key disabled' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_app_id::text || ':' || p_external_subject, 0));
  insert into public.jai_connect_redemptions(app_id, jti) values (p_app_id, p_jti);
  select c.customer_id into mapped_customer from public.jai_connect_customers c
    where c.app_id = p_app_id and c.external_subject = p_external_subject for update;
  if mapped_customer is null then
    insert into public.customers(organization_id, display_name, email)
      values (app_org, p_name, p_email) returning id into mapped_customer;
    insert into public.jai_connect_customers(app_id, external_subject, customer_id)
      values (p_app_id, p_external_subject, mapped_customer);
  else
    if not exists (select 1 from public.customers c
      where c.id = mapped_customer and c.organization_id = app_org) then
      raise exception 'Customer/app mismatch' using errcode = '42501';
    end if;
    update public.customers c set
      display_name = coalesce(p_name, c.display_name),
      email = coalesce(p_email, c.email)
      where c.id = mapped_customer;
  end if;
  insert into public.customer_sessions(
    customer_id, app_id, session_token_hash, identity_level, expires_at
  ) values (
    mapped_customer, p_app_id, p_session_token_hash, 'product_verified',
    pg_catalog.clock_timestamp() + interval '1 day'
  );
  return mapped_customer;
end;
$$;
revoke all on function public.redeem_jai_connect_identity(uuid, uuid, text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.redeem_jai_connect_identity(uuid, uuid, text, uuid, text, text, text)
  to service_role;

commit;
