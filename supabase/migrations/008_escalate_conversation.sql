begin;

-- Server-only foundation for future automation escalation. The trusted backend
-- must derive the target conversation from its authorized processing context;
-- it must not proxy arbitrary browser-supplied conversation IDs with its key.
-- service_role already has privileged database access, so no definer is needed.
create function public.escalate_conversation(p_conversation_id uuid)
returns public.conversations
language plpgsql
security invoker
set search_path = ''
as $$
declare
  escalated_conversation public.conversations%rowtype;
begin
  -- One conditional UPDATE locks the existing row and rechecks eligibility
  -- after concurrent updates. Repeated escalation cannot match human_queue.
  update public.conversations as c
  set handler = 'human_queue',
      assigned_agent_id = null
  where c.id = p_conversation_id
    and c.status <> 'resolved'
    and c.handler = 'automation'
    and c.assigned_agent_id is null
  returning c.* into escalated_conversation;

  if not found then
    raise exception 'Conversation not found or not eligible for escalation'
      using errcode = 'P0001';
  end if;

  return escalated_conversation;
end;
$$;

revoke all on function public.escalate_conversation(uuid)
  from public, anon, authenticated;
grant execute on function public.escalate_conversation(uuid) to service_role;

commit;
