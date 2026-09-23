begin;

-- Catalog is migration-managed, never editable by browser identities.
create table public.capabilities (
  key text primary key,
  kind text not null check (kind in ('read', 'diagnostic', 'write', 'action')),
  recommended boolean not null default false,
  available boolean not null default false,
  -- Future write/action definitions may be recorded, but cannot be enabled yet.
  check (kind in ('read', 'diagnostic') or (not available and not recommended)),
  check (not recommended or available)
);

insert into public.capabilities(key, kind, recommended, available) values
  ('knowledge.website.read', 'read', true, true),
  ('customer.profile.read', 'read', true, true),
  ('customer.subscription.read', 'read', true, true),
  ('billing.payment.read', 'read', true, true),
  ('diagnostics.read', 'diagnostic', true, true);

-- No rows are automatically granted. Missing or disabled means denied.
create table public.app_capabilities (
  app_id uuid not null references public.apps(id) on delete cascade,
  capability_key text not null references public.capabilities(key) on delete restrict,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (app_id, capability_key)
);
create index app_capabilities_key on public.app_capabilities(capability_key);

create function jai_private.can_manage_app_capabilities(p_app_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.apps a where a.id = p_app_id
      and jai_private.is_organization_agent(a.organization_id, true)
  );
$$;
revoke all on function jai_private.can_manage_app_capabilities(uuid) from public, anon, authenticated;
grant execute on function jai_private.can_manage_app_capabilities(uuid) to authenticated;

create function jai_private.validate_app_capability()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if NEW.enabled and not exists (
    select 1 from public.capabilities c where c.key = NEW.capability_key
      and c.available and c.kind in ('read', 'diagnostic')
  ) then
    raise exception 'Capability is not available' using errcode = '23514';
  end if;
  NEW.updated_at := clock_timestamp();
  return NEW;
end;
$$;
revoke all on function jai_private.validate_app_capability() from public, anon, authenticated;
create trigger app_capabilities_validate
before insert or update on public.app_capabilities
for each row execute function jai_private.validate_app_capability();

alter table public.capabilities enable row level security;
alter table public.app_capabilities enable row level security;
revoke all on public.capabilities, public.app_capabilities from public, anon, authenticated;
grant select on public.capabilities, public.app_capabilities to authenticated;
grant insert (app_id, capability_key, enabled) on public.app_capabilities to authenticated;
grant update (enabled) on public.app_capabilities to authenticated;
grant select on public.capabilities to service_role;
grant select, insert, update on public.app_capabilities to service_role;

create policy capabilities_catalog_select on public.capabilities
for select to authenticated using (true);
create policy app_capabilities_admin_select on public.app_capabilities
for select to authenticated using (jai_private.can_manage_app_capabilities(app_id));
create policy app_capabilities_admin_insert on public.app_capabilities
for insert to authenticated with check (jai_private.can_manage_app_capabilities(app_id));
create policy app_capabilities_admin_update on public.app_capabilities
for update to authenticated
using (jai_private.can_manage_app_capabilities(app_id))
with check (jai_private.can_manage_app_capabilities(app_id));

-- Future runtime must derive p_app_id from its authorized processing context.
-- This grants no access to external data; every connector must enforce this gate.
create function public.app_has_capability(p_app_id uuid, p_capability_key text)
returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.app_capabilities g
    join public.capabilities c on c.key = g.capability_key
    join public.apps a on a.id = g.app_id
    where g.app_id = p_app_id and g.capability_key = p_capability_key
      and g.enabled and c.available and c.kind in ('read', 'diagnostic')
      and a.status = 'active'
  );
$$;
revoke all on function public.app_has_capability(uuid, text) from public, anon, authenticated;
grant execute on function public.app_has_capability(uuid, text) to service_role;

-- Recommended access is the catalog subset recommended=true, available=true.
-- Future onboarding can upsert that subset for one app in one request, after
-- explicit consent. Individual enabled flags remain independently editable.
commit;
