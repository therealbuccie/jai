begin;
create table public.agent_presence_sessions (
 agent_id uuid not null references public.human_agents(id) on delete cascade,
 session_id uuid not null references auth.sessions(id) on delete cascade,
 ended_at timestamptz,
 primary key(agent_id,session_id)
);
create table public.agent_presence_tabs (
 agent_id uuid not null, session_id uuid not null, tab_id uuid not null,
 heartbeat_at timestamptz not null, activity_at timestamptz,
 primary key(agent_id,session_id,tab_id),
 foreign key(agent_id,session_id) references public.agent_presence_sessions(agent_id,session_id) on delete cascade
);
alter table public.agent_presence_sessions enable row level security;
alter table public.agent_presence_tabs enable row level security;
revoke all on public.agent_presence_sessions,public.agent_presence_tabs from public,anon,authenticated;

create function jai_private.agent_presence(p_agent_id uuid)
returns text language sql stable security definer set search_path='' as $$
 select case when bool_or(t.activity_at > now()-interval '5 minutes') then 'online'
 when count(*)>0 then 'away' else 'offline' end
 from public.agent_presence_tabs t join public.agent_presence_sessions s using(agent_id,session_id)
 where t.agent_id=p_agent_id and s.ended_at is null and t.heartbeat_at>now()-interval '120 seconds';
$$;

create function jai_private.record_agent_presence(p_tab_id uuid,p_activity boolean)
returns text language plpgsql security definer set search_path='' as $$
declare a uuid; sid uuid := (auth.jwt()->>'session_id')::uuid; ended timestamptz;
begin
 select id into a from public.human_agents where auth_user_id=auth.uid();
 if a is null or sid is null or p_tab_id is null or not exists(select 1 from auth.sessions where id=sid and user_id=auth.uid())
 then raise exception 'Agent session required' using errcode='42501'; end if;
 insert into public.agent_presence_sessions(agent_id,session_id) values(a,sid) on conflict do nothing;
 select ended_at into ended from public.agent_presence_sessions where agent_id=a and session_id=sid for update;
 if ended is not null then raise exception 'Presence session ended' using errcode='42501'; end if;
 delete from public.agent_presence_tabs where heartbeat_at<now()-interval '1 day';
 if (select count(*) from public.agent_presence_tabs where agent_id=a)>=100
 and not exists(select 1 from public.agent_presence_tabs where agent_id=a and session_id=sid and tab_id=p_tab_id)
 then raise exception 'Too many presence tabs'; end if;
 insert into public.agent_presence_tabs(agent_id,session_id,tab_id,heartbeat_at,activity_at)
 values(a,sid,p_tab_id,now(),case when p_activity then now() end)
 on conflict(agent_id,session_id,tab_id) do update set heartbeat_at=now(),
 activity_at=case when p_activity then now() else agent_presence_tabs.activity_at end;
 return jai_private.agent_presence(a);
end; $$;
create function public.heartbeat_agent_presence(p_tab_id uuid)
returns text language sql security definer set search_path='' as $$
 select jai_private.record_agent_presence(p_tab_id,false);
$$;
create function public.activity_agent_presence(p_tab_id uuid)
returns text language sql security definer set search_path='' as $$
 select jai_private.record_agent_presence(p_tab_id,true);
$$;
create function public.end_agent_presence(p_tab_id uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare a uuid; sid uuid := (auth.jwt()->>'session_id')::uuid;
begin
 select id into a from public.human_agents where auth_user_id=auth.uid();
 if a is null or sid is null then raise exception 'Agent required' using errcode='42501'; end if;
 -- Serialize with heartbeats, and prevent delayed calls reviving a logged-out session.
 insert into public.agent_presence_sessions(agent_id,session_id) values(a,sid) on conflict do nothing;
 perform 1 from public.agent_presence_sessions where agent_id=a and session_id=sid for update;
 if p_tab_id is null then
 update public.agent_presence_sessions set ended_at=now() where agent_id=a and session_id=sid;
 end if;
 delete from public.agent_presence_tabs where agent_id=a and session_id=sid and (p_tab_id is null or tab_id=p_tab_id);
end; $$;
create function public.list_agent_presence()
returns table(agent_id uuid,presence text) language sql stable security definer set search_path='' as $$
 select a.id,jai_private.agent_presence(a.id) from public.human_agents a
 where jai_private.is_organization_agent(a.organization_id);
$$;
revoke all on function jai_private.agent_presence(uuid),jai_private.record_agent_presence(uuid,boolean) from public,anon,authenticated;
revoke all on function public.heartbeat_agent_presence(uuid),public.activity_agent_presence(uuid),public.end_agent_presence(uuid),public.list_agent_presence() from public,anon,authenticated;
grant execute on function public.heartbeat_agent_presence(uuid),public.activity_agent_presence(uuid),public.end_agent_presence(uuid),public.list_agent_presence() to authenticated;

drop function public.eligible_transfer_agents(uuid);
create function public.eligible_transfer_agents(p_conversation_id uuid)
returns table(id uuid, name text, assignment_id uuid, presence text)
language plpgsql security definer set search_path = '' as $$
begin
  if not jai_private.can_control_conversation(p_conversation_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if exists (select 1 from public.conversations c join public.apps app on app.id=c.app_id
    where c.id=p_conversation_id and c.status='open' and c.handler='human_queue'
      and c.assigned_agent_id is null and jai_private.is_organization_agent(app.organization_id,true)) then
    return query select h.id,h.name,null::uuid,jai_private.agent_presence(h.id) from public.conversations c
      join public.human_agents h on jai_private.can_assign_agent(c.app_id,h.id)
      where c.id=p_conversation_id order by case jai_private.agent_presence(h.id) when 'online' then 0 when 'away' then 1 else 2 end,h.name,h.id;
    return;
  end if;
  return query select h.id, h.name, history.id,jai_private.agent_presence(h.id)
    from public.conversations c
    join public.human_agents h on jai_private.can_assign_agent(c.app_id, h.id)
    cross join lateral (select ca.id from public.conversation_assignments ca
      where ca.conversation_id = c.id and ca.agent_id = c.assigned_agent_id and ca.released_at is null
      order by ca.assigned_at desc, ca.id desc limit 1) history
    where c.id = p_conversation_id and c.handler = 'human_agent' and c.status = 'open'
      and h.id <> c.assigned_agent_id order by case jai_private.agent_presence(h.id) when 'online' then 0 when 'away' then 1 else 2 end,h.name,h.id;
end;
$$;

revoke all on function public.eligible_transfer_agents(uuid) from public,anon,authenticated;
grant execute on function public.eligible_transfer_agents(uuid) to authenticated;
commit;
