begin;

-- Backend-only sessions. Store only a token hash, never the raw session token.
create table public.customer_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  app_id uuid not null references public.apps(id) on delete cascade,
  session_token_hash text not null unique,
  identity_level text not null default 'anonymous'
    check (identity_level in ('anonymous', 'product_verified', 'whisppr_verified')),
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_customer_sessions_customer on public.customer_sessions(customer_id);
create index idx_customer_sessions_app on public.customer_sessions(app_id);
create index idx_customer_sessions_expires_at on public.customer_sessions(expires_at);

alter table public.customer_sessions enable row level security;
revoke all on table public.customer_sessions from public, anon, authenticated;

-- No client policies: session access is reserved for the trusted backend.
create function public.validate_customer_session_organization()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.customers customer
    join public.apps app on app.id = NEW.app_id
    where customer.id = NEW.customer_id
      and customer.organization_id <> app.organization_id
  ) then
    raise exception 'Customer and app must belong to the same organization'
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

revoke all on function public.validate_customer_session_organization()
  from public, anon, authenticated;

create trigger customer_sessions_validate_organization
before insert or update of customer_id, app_id on public.customer_sessions
for each row execute function public.validate_customer_session_organization();

commit;
