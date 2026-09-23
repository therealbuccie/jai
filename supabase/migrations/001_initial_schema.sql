-- Jai Initial Database Schema
-- Database structure only. RLS, realtime and automation come later.

create extension if not exists pgcrypto;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table apps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  name text not null,
  slug text not null,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  display_name text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

create table human_agents (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  organization_id uuid not null references organizations(id) on delete restrict,
  name text not null,
  email text not null,
  role text not null default 'agent'
    check (role in ('admin', 'agent')),
  status text not null default 'offline'
    check (status in ('online', 'offline', 'away')),
  created_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references apps(id) on delete restrict,
  customer_id uuid not null references customers(id) on delete restrict,

  channel text not null
    check (channel in ('widget', 'product_app', 'whisppr')),

  status text not null default 'open'
    check (status in ('open', 'pending', 'resolved')),

  handler text not null default 'automation'
    check (handler in ('automation', 'human_queue', 'human_agent')),

  assigned_agent_id uuid references human_agents(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),

  conversation_id uuid not null
    references conversations(id) on delete restrict,

  sender_type text not null
    check (
      sender_type in (
        'customer',
        'automation',
        'human_agent',
        'system'
      )
    ),

  sender_id uuid,

  message_type text not null default 'text'
    check (
      message_type in (
        'text',
        'attachment',
        'system',
        'internal_note'
      )
    ),

  status text not null default 'sent'
    check (status in ('sent', 'delivered', 'read')),

  content text,
  attachment_url text,
  created_at timestamptz not null default now()
);

create table conversation_assignments (
  id uuid primary key default gen_random_uuid(),

  conversation_id uuid not null
    references conversations(id) on delete restrict,

  agent_id uuid not null
    references human_agents(id) on delete restrict,

  assigned_by_agent_id uuid
    references human_agents(id) on delete set null,

  assignment_type text not null default 'assigned'
    check (
      assignment_type in (
        'assigned',
        'transferred'
      )
    ),

  transfer_reason text,

  assigned_at timestamptz not null default now(),
  released_at timestamptz
);

-- Validate agent ownership when assigning or changing an assignment.
create function validate_agent_assignment_organization()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  conversation_organization_id uuid;
  agent_ids uuid[];
begin
  if TG_TABLE_NAME = 'conversations' then
    select organization_id into conversation_organization_id
    from apps where id = NEW.app_id;

    agent_ids := array[NEW.assigned_agent_id];
  else
    select a.organization_id into conversation_organization_id
    from conversations c
    join apps a on a.id = c.app_id
    where c.id = NEW.conversation_id;

    agent_ids := array[NEW.agent_id, NEW.assigned_by_agent_id];
  end if;

  if exists (
    select 1 from human_agents
    where id = any(agent_ids)
      and organization_id is distinct from conversation_organization_id
  ) then
    raise exception 'Assigned agents must belong to the conversation app organization'
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

create trigger conversations_validate_agent_organization
before insert or update of app_id, assigned_agent_id on conversations
for each row execute function validate_agent_assignment_organization();

create trigger conversation_assignments_validate_agent_organization
before insert or update of conversation_id, agent_id, assigned_by_agent_id
on conversation_assignments
for each row execute function validate_agent_assignment_organization();

create table customer_identities (
  id uuid primary key default gen_random_uuid(),

  customer_id uuid not null
    references customers(id) on delete restrict,

  provider text not null,
  external_id text not null,

  verified boolean not null default false,

  created_at timestamptz not null default now(),

  unique (provider, external_id)
);

create table notification_devices (
  id uuid primary key default gen_random_uuid(),

  owner_type text not null
    check (owner_type in ('customer', 'agent')),

  owner_id uuid not null,

  platform text not null
    check (
      platform in (
        'ios',
        'android',
        'web',
        'desktop'
      )
    ),

  push_token text not null unique,
  device_id text,

  presence_status text not null default 'offline'
    check (
      presence_status in (
        'online',
        'idle',
        'offline'
      )
    ),

  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table domain_events (
  id uuid primary key default gen_random_uuid(),

  event_type text not null,

  conversation_id uuid
    references conversations(id) on delete restrict,

  payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);


-- INDEXES

create index idx_apps_organization
  on apps(organization_id);

create index idx_customers_organization
  on customers(organization_id);

create index idx_conversations_app
  on conversations(app_id);

create index idx_conversations_customer
  on conversations(customer_id);

create index idx_conversations_agent
  on conversations(assigned_agent_id);

create index idx_conversations_status
  on conversations(status);

create index idx_messages_conversation_created
  on messages(conversation_id, created_at);

create index idx_assignments_conversation
  on conversation_assignments(conversation_id);

create index idx_assignments_agent
  on conversation_assignments(agent_id);

create index idx_customer_identities_customer
  on customer_identities(customer_id);

create index idx_notification_owner
  on notification_devices(owner_type, owner_id);

create index idx_domain_events_type
  on domain_events(event_type);

create index idx_domain_events_conversation
  on domain_events(conversation_id);