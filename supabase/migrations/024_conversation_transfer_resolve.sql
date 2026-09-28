begin;

revoke update on public.conversations from public, anon, authenticated;
revoke update (status, handler, assigned_agent_id) on public.conversations from public, anon, authenticated;
-- History is now written only by guarded operations.
revoke insert on public.conversation_assignments from public, anon, authenticated;

create function jai_private.can_control_conversation(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.conversations c join public.apps a on a.id = c.app_id
    where c.id = p_id and jai_private.can_access_conversation(c.id)
    and (c.assigned_agent_id = jai_private.current_agent_id()
      or jai_private.is_organization_agent(a.organization_id, true)));
$$;
revoke all on function jai_private.can_control_conversation(uuid) from public, anon, authenticated;

create function public.eligible_transfer_agents(p_conversation_id uuid)
returns table(id uuid, name text, assignment_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if not jai_private.can_control_conversation(p_conversation_id) then
    raise exception 'Access denied' using errcode = '42501';
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

create function public.transfer_conversation(p_conversation_id uuid, p_target_agent_id uuid, p_assignment_id uuid)
returns public.conversations language plpgsql security definer set search_path = '' as $$
declare
  c public.conversations%rowtype;
  current_assignment uuid;
  target_name text;
begin
  select * into c from public.conversations where id = p_conversation_id for update;
  if not found or not jai_private.can_control_conversation(p_conversation_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  select ca.id into current_assignment from public.conversation_assignments ca
    where ca.conversation_id = c.id and ca.agent_id = c.assigned_agent_id and ca.released_at is null
    order by ca.assigned_at desc, ca.id desc limit 1 for update;
  if c.status <> 'open' or c.handler <> 'human_agent' or c.assigned_agent_id is null
    or current_assignment is null or current_assignment is distinct from p_assignment_id
    or p_target_agent_id is null or p_target_agent_id = c.assigned_agent_id
    or not jai_private.can_assign_agent(c.app_id, p_target_agent_id) then
    raise exception 'Conversation cannot be transferred' using errcode = 'P0001';
  end if;
  select h.name into target_name from public.human_agents h where h.id = p_target_agent_id;
  if nullif(btrim(target_name), '') is null then raise exception 'Agent name required'; end if;
  update public.conversation_assignments set released_at = clock_timestamp()
    where conversation_id = c.id and released_at is null;
  update public.conversations set assigned_agent_id = p_target_agent_id,
    handler = 'human_agent', status = 'open', updated_at = clock_timestamp()
    where id = c.id returning * into c;
  insert into public.conversation_assignments (conversation_id, agent_id, assigned_by_agent_id, assignment_type)
    values (c.id, p_target_agent_id, jai_private.current_agent_id(), 'transferred');
  insert into public.messages (conversation_id, sender_type, sender_id, message_type, status, content)
    values (c.id, 'automation', null, 'text', 'sent', target_name || ' joined the conversation');
  return c;
end;
$$;

create function public.resolve_conversation(p_conversation_id uuid, p_expected_agent_id uuid)
returns public.conversations language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype;
begin
  select * into c from public.conversations where id = p_conversation_id for update;
  if not found or not jai_private.can_control_conversation(p_conversation_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if c.assigned_agent_id is distinct from p_expected_agent_id then
    raise exception 'Assignment changed' using errcode = 'P0001';
  end if;
  if c.status = 'resolved' then return c; end if;
  update public.conversations set status = 'resolved', updated_at = clock_timestamp()
    where id = c.id returning * into c;
  return c;
end;
$$;

-- The same row lock serializes all message pathways with guarded resolution.
create function jai_private.guard_message_conversation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype;
begin
  select * into c from public.conversations where id = new.conversation_id for update;
  if not found or c.status = 'resolved' then
    raise exception 'Conversation is closed' using errcode = '23514';
  end if;
  -- Recheck human ownership after waiting for a concurrent transfer.
  if new.sender_type = 'human_agent' and auth.role() = 'authenticated'
    and not jai_private.can_control_conversation(c.id) then
    raise exception 'Conversation is not assigned to you' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function jai_private.guard_message_conversation() from public, anon, authenticated;
create trigger messages_guard_conversation before insert on public.messages
  for each row execute function jai_private.guard_message_conversation();

revoke all on function public.eligible_transfer_agents(uuid) from public, anon, authenticated;
revoke all on function public.transfer_conversation(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.resolve_conversation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.eligible_transfer_agents(uuid) to authenticated;
grant execute on function public.transfer_conversation(uuid, uuid, uuid) to authenticated;
grant execute on function public.resolve_conversation(uuid, uuid) to authenticated;
commit;
