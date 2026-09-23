begin;

-- 244 bits of randomness from two PostgreSQL v4 UUIDs. Only the SHA-256
-- digest is retained; the plaintext is returned by the admin RPC once.
create table public.jai_connect_credentials (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  app_id uuid not null references public.apps(id) on delete cascade,
  secret_hash bytea not null unique check (pg_catalog.octet_length(secret_hash) = 32),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index jai_connect_credentials_app on public.jai_connect_credentials(app_id, created_at desc);
alter table public.jai_connect_credentials enable row level security;
revoke all on public.jai_connect_credentials from public, anon, authenticated, service_role;

create table public.jai_connect_identity_codes (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  app_id uuid not null references public.apps(id) on delete cascade,
  credential_id uuid not null references public.jai_connect_credentials(id) on delete cascade,
  external_subject text not null check (length(external_subject) between 1 and 200),
  display_name text,
  email text,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);
create index jai_connect_identity_codes_expiry on public.jai_connect_identity_codes(expires_at);
alter table public.jai_connect_identity_codes enable row level security;
revoke all on public.jai_connect_identity_codes from public, anon, authenticated, service_role;

create function public.generate_jai_connect_key(p_app_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_secret text;
  v_id uuid;
  v_created_at timestamptz;
begin
  if not exists (select 1 from public.apps a where a.id = p_app_id and a.status = 'active'
    and jai_private.is_organization_agent(a.organization_id, true)) then
    raise exception 'Organization admin access required' using errcode = '42501';
  end if;
  v_secret := 'jai_live_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  insert into public.jai_connect_credentials(app_id, secret_hash)
    values (p_app_id, pg_catalog.sha256(pg_catalog.convert_to(v_secret, 'UTF8')))
    returning id, created_at into v_id, v_created_at;
  return pg_catalog.jsonb_build_object('id', v_id, 'secret', v_secret, 'created_at', v_created_at);
end;
$$;
revoke all on function public.generate_jai_connect_key(uuid) from public, anon, service_role;
grant execute on function public.generate_jai_connect_key(uuid) to authenticated;

create function public.list_jai_connect_credentials(p_app_id uuid)
returns table (id uuid, created_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.apps a where a.id = p_app_id
    and jai_private.is_organization_agent(a.organization_id, true)) then
    raise exception 'Organization admin access required' using errcode = '42501';
  end if;
  return query select c.id, c.created_at, c.revoked_at
    from public.jai_connect_credentials c where c.app_id = p_app_id
    order by c.created_at desc;
end;
$$;
revoke all on function public.list_jai_connect_credentials(uuid) from public, anon, service_role;
grant execute on function public.list_jai_connect_credentials(uuid) to authenticated;

create function public.revoke_jai_connect_key(p_app_id uuid, p_credential_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.apps a where a.id = p_app_id
    and jai_private.is_organization_agent(a.organization_id, true)) then
    raise exception 'Organization admin access required' using errcode = '42501';
  end if;
  update public.jai_connect_credentials c set revoked_at = coalesce(c.revoked_at, now())
    where c.app_id = p_app_id and c.id = p_credential_id;
  return found;
end;
$$;
revoke all on function public.revoke_jai_connect_key(uuid, uuid) from public, anon, service_role;
grant execute on function public.revoke_jai_connect_key(uuid, uuid) to authenticated;

-- Only the Edge worker can issue a one-use code after receiving the secret
-- from the integrating application's authenticated backend.
create function public.issue_jai_connect_identity(
  p_app_id uuid, p_secret text, p_external_subject text, p_name text,
  p_email text, p_code_hash text
) returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare
  v_credential_id uuid;
  v_expires_at timestamptz;
begin
  if p_app_id is null or p_secret is null or p_secret !~ '^jai_live_[a-f0-9]{64}$'
    or p_external_subject is null or length(p_external_subject) not between 1 and 200
    or p_external_subject ~ '[[:cntrl:]]'
    or (p_name is not null and (length(p_name) > 200 or p_name ~ '[[:cntrl:]]'))
    or (p_email is not null and (length(p_email) > 254 or p_email ~ '[[:cntrl:]]'))
    or p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid identity request' using errcode = '22023';
  end if;
  if not exists (select 1 from public.apps a where a.id = p_app_id and a.status = 'active') then
    raise exception 'Active app required' using errcode = '42501';
  end if;
  select c.id into v_credential_id from public.jai_connect_credentials c
    where c.app_id = p_app_id and c.revoked_at is null
      and c.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'))
    for share;
  if v_credential_id is null then
    raise exception 'Invalid credential' using errcode = '42501';
  end if;
  insert into public.jai_connect_identity_codes(
    code_hash, app_id, credential_id, external_subject, display_name, email, expires_at
  ) values (
    p_code_hash, p_app_id, v_credential_id, p_external_subject, p_name, p_email,
    pg_catalog.clock_timestamp() + interval '5 minutes'
  ) returning expires_at into v_expires_at;
  return v_expires_at;
end;
$$;
revoke all on function public.issue_jai_connect_identity(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.issue_jai_connect_identity(uuid, text, text, text, text, text)
  to service_role;

-- Consuming the code, mapping the customer and creating a verified session
-- happen in one transaction. A row lock makes duplicate redemption fail.
create function public.redeem_jai_connect_code(
  p_app_id uuid, p_code_hash text, p_session_token_hash text
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_code public.jai_connect_identity_codes%rowtype;
  v_app_org uuid;
  v_customer uuid;
begin
  if p_app_id is null or p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$'
    or p_session_token_hash is null or p_session_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid identity code' using errcode = '22023';
  end if;
  select c.* into v_code from public.jai_connect_identity_codes c
    where c.code_hash = p_code_hash and c.app_id = p_app_id for update;
  if not found or v_code.redeemed_at is not null or v_code.expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'Identity code unavailable' using errcode = '42501';
  end if;
  select a.organization_id into v_app_org from public.apps a
    where a.id = p_app_id and a.status = 'active' for share;
  if v_app_org is null then raise exception 'Active app required' using errcode = '42501'; end if;
  perform 1 from public.jai_connect_credentials c where c.id = v_code.credential_id
    and c.app_id = p_app_id and c.revoked_at is null for share;
  if not found then raise exception 'Credential revoked' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_app_id::text || ':' || v_code.external_subject, 0));
  update public.jai_connect_identity_codes c set redeemed_at = pg_catalog.clock_timestamp()
    where c.code_hash = p_code_hash;
  select c.customer_id into v_customer from public.jai_connect_customers c
    where c.app_id = p_app_id and c.external_subject = v_code.external_subject for update;
  if v_customer is null then
    insert into public.customers(organization_id, display_name, email)
      values (v_app_org, v_code.display_name, v_code.email) returning id into v_customer;
    insert into public.jai_connect_customers(app_id, external_subject, customer_id)
      values (p_app_id, v_code.external_subject, v_customer);
  else
    if not exists (select 1 from public.customers c
      where c.id = v_customer and c.organization_id = v_app_org) then
      raise exception 'Customer/app mismatch' using errcode = '42501';
    end if;
    update public.customers c set
      display_name = coalesce(v_code.display_name, c.display_name),
      email = coalesce(v_code.email, c.email)
      where c.id = v_customer;
  end if;
  insert into public.customer_sessions(
    customer_id, app_id, session_token_hash, identity_level, expires_at
  ) values (
    v_customer, p_app_id, p_session_token_hash, 'product_verified',
    pg_catalog.clock_timestamp() + interval '1 day'
  );
  return v_customer;
end;
$$;
revoke all on function public.redeem_jai_connect_code(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.redeem_jai_connect_code(uuid, text, text)
  to service_role;

commit;
