begin;

create function public.assign_conversation(p_conversation_id uuid,p_target_agent_id uuid)
returns public.conversations language plpgsql security definer set search_path='' as $$
declare c public.conversations%rowtype; actor uuid; target_name text;
begin
  actor := jai_private.current_agent_id();
  if auth.uid() is null or actor is null then raise exception 'Admin required' using errcode='42501'; end if;
  select * into c from public.conversations where id=p_conversation_id for update;
  if not found or not jai_private.can_access_conversation(c.id) or not exists (
    select 1 from public.apps app where app.id=c.app_id
    and jai_private.is_organization_agent(app.organization_id,true)) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if c.status<>'open' or c.handler<>'human_queue' or c.assigned_agent_id is not null
    or p_target_agent_id is null or not jai_private.can_assign_agent(c.app_id,p_target_agent_id) then
    raise exception 'Conversation is no longer available to assign' using errcode='P0001';
  end if;
  select h.name into target_name from public.human_agents h where h.id=p_target_agent_id;
  if nullif(btrim(target_name),'') is null then raise exception 'Agent name required'; end if;
  update public.conversations set handler='human_agent',assigned_agent_id=p_target_agent_id,
    updated_at=clock_timestamp() where id=c.id returning * into c;
  insert into public.conversation_assignments(conversation_id,agent_id,assigned_by_agent_id,assignment_type)
    values(c.id,p_target_agent_id,actor,'assigned');
  insert into public.messages(conversation_id,sender_type,sender_id,message_type,status,content)
    values(c.id,'automation',null,'text','sent',target_name || ' joined the conversation');
  return c;
end; $$;
revoke all on function public.assign_conversation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.assign_conversation(uuid,uuid) to authenticated;

create or replace function public.eligible_transfer_agents(p_conversation_id uuid)
returns table(id uuid, name text, assignment_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if not jai_private.can_control_conversation(p_conversation_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if exists (select 1 from public.conversations c join public.apps app on app.id=c.app_id
    where c.id=p_conversation_id and c.status='open' and c.handler='human_queue'
      and c.assigned_agent_id is null and jai_private.is_organization_agent(app.organization_id,true)) then
    return query select h.id,h.name,null::uuid from public.conversations c
      join public.human_agents h on jai_private.can_assign_agent(c.app_id,h.id)
      where c.id=p_conversation_id order by h.name,h.id;
    return;
  end if;
  return query select h.id, h.name, history.id
    from public.conversations c
    join public.human_agents h on jai_private.can_assign_agent(c.app_id, h.id)
    cross join lateral (select ca.id from public.conversation_assignments ca
      where ca.conversation_id = c.id and ca.agent_id = c.assigned_agent_id and ca.released_at is null
      order by ca.assigned_at desc, ca.id desc limit 1) history
    where c.id = p_conversation_id and c.handler = 'human_agent' and c.status = 'open'
      and h.id <> c.assigned_agent_id order by h.name, h.id;
end;
$$;

commit;
