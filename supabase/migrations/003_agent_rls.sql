begin;

-- Keep policy helpers outside the exposed public schema. The migration owner
-- must own the support tables so these read-only helpers bypass their RLS.
create schema jai_private;
revoke all on schema jai_private from public, anon, authenticated;
grant usage on schema jai_private to authenticated;

create function jai_private.current_agent_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select id from public.human_agents where auth_user_id = auth.uid();
$$;

create function jai_private.is_organization_agent(
  organization_id uuid, admin_only boolean default false
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.human_agents a
    where a.auth_user_id = auth.uid()
      and a.organization_id = $1
      and (not $2 or a.role = 'admin')
  );
$$;

create function jai_private.can_access_app(app_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.apps app
    join public.human_agents a on a.organization_id = app.organization_id
    where app.id = $1 and a.auth_user_id = auth.uid()
      and (
        a.role = 'admin'
        or exists (
          select 1 from public.agent_app_access access
          where access.agent_id = a.id and access.app_id = app.id
        )
      )
  );
$$;

create function jai_private.can_access_conversation(conversation_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    join public.apps app on app.id = c.app_id
    join public.customers customer on customer.id = c.customer_id
      and customer.organization_id = app.organization_id
    where c.id = $1 and jai_private.can_access_app(app.id)
  );
$$;

create function jai_private.can_access_customer(customer_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.customers customer
    where customer.id = $1
      and jai_private.is_organization_agent(customer.organization_id)
      and (
        jai_private.is_organization_agent(customer.organization_id, true)
        or exists (
          select 1 from public.conversations c
          join public.apps app on app.id = c.app_id
            and app.organization_id = customer.organization_id
          where c.customer_id = customer.id
            and jai_private.can_access_app(app.id)
        )
      )
  );
$$;

create function jai_private.can_assign_agent(app_id uuid, agent_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select jai_private.can_access_app($1) and exists (
    select 1 from public.human_agents a
    join public.apps app on app.organization_id = a.organization_id
    where app.id = $1 and a.id = $2
      and (
        a.role = 'admin'
        or exists (
          select 1 from public.agent_app_access access
          where access.agent_id = a.id and access.app_id = app.id
        )
      )
  );
$$;

create function jai_private.can_manage_app_access(agent_id uuid, app_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.human_agents a
    join public.apps app on app.organization_id = a.organization_id
    where a.id = $1 and app.id = $2
      and jai_private.is_organization_agent(app.organization_id, true)
  );
$$;

revoke all on all functions in schema jai_private from public, anon, authenticated;
-- Grant execution only to the helpers referenced by the agent policies below.
grant execute on function
  jai_private.current_agent_id(),
  jai_private.is_organization_agent(uuid, boolean),
  jai_private.can_access_app(uuid),
  jai_private.can_access_conversation(uuid),
  jai_private.can_access_customer(uuid),
  jai_private.can_assign_agent(uuid, uuid),
  jai_private.can_manage_app_access(uuid, uuid)
to authenticated;

alter table public.organizations enable row level security;
alter table public.apps enable row level security;
alter table public.customers enable row level security;
alter table public.human_agents enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_assignments enable row level security;
alter table public.customer_identities enable row level security;
alter table public.notification_devices enable row level security;
alter table public.domain_events enable row level security;
alter table public.agent_app_access enable row level security;

-- Remove broad default API privileges. RLS does not restrict editable columns.
revoke all on table
  public.organizations, public.apps, public.customers, public.human_agents,
  public.conversations, public.messages, public.conversation_assignments,
  public.customer_identities, public.notification_devices, public.domain_events,
  public.agent_app_access
from public, anon, authenticated;

grant select on table
  public.organizations, public.apps, public.customers, public.human_agents,
  public.conversations, public.messages, public.conversation_assignments,
  public.customer_identities, public.notification_devices, public.domain_events,
  public.agent_app_access
to authenticated;

grant update (status, handler, assigned_agent_id)
  on public.conversations to authenticated;
grant insert on public.messages, public.conversation_assignments to authenticated;
grant insert, delete on public.agent_app_access to authenticated;
grant update (agent_id, app_id) on public.agent_app_access to authenticated;

create policy organizations_agent_select on public.organizations
for select to authenticated
using (jai_private.is_organization_agent(id));

create policy apps_agent_select on public.apps
for select to authenticated
using (jai_private.can_access_app(id));

create policy customers_agent_select on public.customers
for select to authenticated
using (jai_private.can_access_customer(id));

-- Same-organization directory for transfers; no administrative writes.
create policy human_agents_agent_select on public.human_agents
for select to authenticated
using (jai_private.is_organization_agent(organization_id));

create policy conversations_agent_select on public.conversations
for select to authenticated
using (jai_private.can_access_conversation(id));

create policy conversations_agent_update on public.conversations
for update to authenticated
using (jai_private.can_access_conversation(id))
with check (
  jai_private.can_access_conversation(id)
  and (
    assigned_agent_id is null
    or jai_private.can_assign_agent(app_id, assigned_agent_id)
  )
);

-- All message reads, including internal notes, require an authenticated agent.
create policy messages_agent_select on public.messages
for select to authenticated
using (jai_private.can_access_conversation(conversation_id));

-- Agents cannot impersonate customers, automation, system, or other agents.
create policy messages_agent_insert on public.messages
for insert to authenticated
with check (
  jai_private.can_access_conversation(conversation_id)
  and sender_type = 'human_agent'
  and sender_id = jai_private.current_agent_id()
);

create policy conversation_assignments_agent_select
on public.conversation_assignments
for select to authenticated
using (jai_private.can_access_conversation(conversation_id));

create policy conversation_assignments_agent_insert
on public.conversation_assignments
for insert to authenticated
with check (
  jai_private.can_access_conversation(conversation_id)
  and assigned_by_agent_id = jai_private.current_agent_id()
  and exists (
    select 1 from public.conversations c
    where c.id = conversation_id
      and jai_private.can_assign_agent(c.app_id, agent_id)
  )
);

create policy agent_app_access_agent_select on public.agent_app_access
for select to authenticated
using (
  jai_private.can_manage_app_access(agent_id, app_id)
  or (
    agent_id = jai_private.current_agent_id()
    and jai_private.can_access_app(app_id)
  )
);

create policy agent_app_access_admin_insert on public.agent_app_access
for insert to authenticated
with check (jai_private.can_manage_app_access(agent_id, app_id));

create policy agent_app_access_admin_update on public.agent_app_access
for update to authenticated
using (jai_private.can_manage_app_access(agent_id, app_id))
with check (jai_private.can_manage_app_access(agent_id, app_id));

create policy agent_app_access_admin_delete on public.agent_app_access
for delete to authenticated
using (jai_private.can_manage_app_access(agent_id, app_id));

-- Ancillary support data is admin-readable only, with no API write policies.
create policy customer_identities_admin_select on public.customer_identities
for select to authenticated
using (exists (
  select 1 from public.customers c
  where c.id = customer_id
    and jai_private.is_organization_agent(c.organization_id, true)
));

create policy notification_devices_admin_select on public.notification_devices
for select to authenticated
using (
  (owner_type = 'customer' and exists (
    select 1 from public.customers c
    where c.id = owner_id
      and jai_private.is_organization_agent(c.organization_id, true)
  ))
  or (owner_type = 'agent' and exists (
    select 1 from public.human_agents a
    where a.id = owner_id
      and jai_private.is_organization_agent(a.organization_id, true)
  ))
);

-- Events without a conversation cannot be attributed to a tenant: deny reads.
create policy domain_events_admin_select on public.domain_events
for select to authenticated
using (exists (
  select 1 from public.conversations c
  join public.apps app on app.id = c.app_id
  where c.id = conversation_id
    and jai_private.is_organization_agent(app.organization_id, true)
));

commit;
