begin;

-- Claim ownership and announce the trusted agent in one transaction.
create or replace function public.claim_conversation(p_conversation_id uuid)
returns public.conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  claiming_agent_id uuid;
  claiming_agent_name text;
  claimed_conversation public.conversations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authenticated human agent required'
      using errcode = '42501';
  end if;

  claiming_agent_id := jai_private.current_agent_id();
  if claiming_agent_id is null then
    raise exception 'Authenticated human agent required'
      using errcode = '42501';
  end if;

  -- Do not disclose whether an inaccessible conversation exists.
  if not jai_private.can_access_conversation(p_conversation_id) then
    raise exception 'Conversation not found or access denied'
      using errcode = '42501';
  end if;

  select a.name into claiming_agent_name
  from public.human_agents as a
  where a.id = claiming_agent_id and a.auth_user_id = auth.uid();
  if not found or nullif(btrim(claiming_agent_name), '') is null then
    raise exception 'Authenticated human agent name required'
      using errcode = '42501';
  end if;

  -- UPDATE locks the row and rechecks these predicates after a competing
  -- update commits. Only one claimant can transition an unassigned queue row.
  update public.conversations as c
  set handler = 'human_agent',
      assigned_agent_id = claiming_agent_id
  where c.id = p_conversation_id
    and c.status <> 'resolved'
    and c.handler = 'human_queue'
    and c.assigned_agent_id is null
    and jai_private.can_access_conversation(c.id)
    and jai_private.can_assign_agent(c.app_id, claiming_agent_id)
  returning c.* into claimed_conversation;

  if not found then
    raise exception 'Conversation is no longer available to claim'
      using errcode = 'P0001';
  end if;

  -- No exception handler: an insert failure rolls back the claim as well.
  insert into public.conversation_assignments (
    conversation_id, agent_id, assigned_by_agent_id, assignment_type
  ) values (
    claimed_conversation.id, claiming_agent_id, claiming_agent_id, 'assigned'
  );

  -- Only a successful guarded transition reaches this insert. Any failure
  -- rolls back ownership, assignment history, and the announcement together.
  insert into public.messages (
    conversation_id, sender_type, sender_id, message_type, status, content
  ) values (
    claimed_conversation.id, 'automation', null, 'text', 'sent',
    claiming_agent_name || ' joined the conversation'
  );

  return claimed_conversation;
end;
$$;

revoke all on function public.claim_conversation(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_conversation(uuid) to authenticated;

commit;
