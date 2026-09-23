begin;

create table public.conversation_feedback (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique references public.conversations(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  app_id uuid not null references public.apps(id) on delete restrict,
  attributed_agent_id uuid references public.human_agents(id) on delete set null,
  rating smallint not null check (rating between 1 and 5),
  review_text text,
  submitted_at timestamptz not null default now()
);

create table public.agent_points (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.human_agents(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  app_id uuid not null references public.apps(id) on delete restrict,
  conversation_id uuid not null references public.conversations(id) on delete restrict,
  feedback_id uuid not null references public.conversation_feedback(id) on delete restrict,
  source_type text not null default 'conversation_feedback',
  points smallint not null check (points > 0),
  created_at timestamptz not null default now(),
  unique (feedback_id, source_type)
);

create index idx_conversation_feedback_customer on public.conversation_feedback(customer_id);
create index idx_conversation_feedback_app on public.conversation_feedback(app_id);
create index idx_agent_points_agent on public.agent_points(agent_id);
create index idx_agent_points_feedback on public.agent_points(feedback_id);

create function public.feedback_points_for_rating(rating smallint)
returns smallint
language sql immutable
set search_path = ''
as $$
  select rating;
$$;

create function public.award_feedback_points()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  organization_id uuid;
begin
  if NEW.attributed_agent_id is null then
    return NEW;
  end if;

  select app.organization_id into organization_id
  from apps app
  where app.id = NEW.app_id;

  insert into agent_points (
    agent_id, organization_id, app_id, conversation_id, feedback_id,
    source_type, points
  )
  values (
    NEW.attributed_agent_id, organization_id, NEW.app_id, NEW.conversation_id,
    NEW.id, 'conversation_feedback', feedback_points_for_rating(NEW.rating)
  )
  on conflict (feedback_id, source_type) do nothing;

  return NEW;
end;
$$;

create trigger conversation_feedback_awards_points
after insert on public.conversation_feedback
for each row execute function public.award_feedback_points();

alter table public.conversation_feedback enable row level security;
alter table public.agent_points enable row level security;

revoke all on table public.conversation_feedback, public.agent_points
from public, anon, authenticated;
grant select on table public.conversation_feedback, public.agent_points to authenticated;

create policy conversation_feedback_agent_select on public.conversation_feedback
for select to authenticated
using (jai_private.can_access_conversation(conversation_id));

create policy agent_points_self_select on public.agent_points
for select to authenticated
using (agent_id = jai_private.current_agent_id());

revoke all on function public.feedback_points_for_rating(smallint) from public, anon, authenticated;
revoke all on function public.award_feedback_points() from public, anon, authenticated;

commit;
