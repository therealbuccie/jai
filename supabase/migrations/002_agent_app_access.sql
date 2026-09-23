create table agent_app_access (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references human_agents(id) on delete cascade,
  app_id uuid not null references apps(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (agent_id, app_id)
);

create index idx_agent_app_access_agent
  on agent_app_access(agent_id);

create index idx_agent_app_access_app
  on agent_app_access(app_id);

create function validate_agent_app_access_organization()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1
    from human_agents agent
    join apps app on app.id = NEW.app_id
    where agent.id = NEW.agent_id
      and agent.organization_id <> app.organization_id
  ) then
    raise exception 'Agent and app must belong to the same organization'
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

create trigger agent_app_access_validate_organization
before insert or update of agent_id, app_id on agent_app_access
for each row execute function validate_agent_app_access_organization();
