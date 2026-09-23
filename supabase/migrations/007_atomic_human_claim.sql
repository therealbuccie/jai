begin;

-- Routing ownership is writable only through trusted server-side operations.
-- Remove both table-wide and column grants; retain the existing status/close API.
revoke update on public.conversations from public, anon, authenticated;
revoke update (handler, assigned_agent_id)
  on public.conversations from public, anon, authenticated;
grant update (status) on public.conversations to authenticated;

-- SECURITY DEFINER is necessary because authenticated callers can no longer
-- update routing columns. Apply as the trusted table-owning migration role.
create function public.claim_conversation(p_conversation_id uuid)
returns public.conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  claiming_agent_id uuid;
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

  return claimed_conversation;
end;
$$;

revoke all on function public.claim_conversation(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_conversation(uuid) to authenticated;

commit;
