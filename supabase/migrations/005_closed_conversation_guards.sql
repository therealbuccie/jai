begin;

-- Resolved conversations are readable history, but neither customers nor agents
-- may append normal messages until a future explicit reopen feature exists.
drop policy if exists messages_agent_insert on public.messages;
create policy messages_agent_insert on public.messages
for insert to authenticated
with check (
  jai_private.can_access_conversation(conversation_id)
  and exists (
    select 1 from public.conversations c
    where c.id = conversation_id
      and c.status <> 'resolved'
  )
  and sender_type = 'human_agent'
  and sender_id = jai_private.current_agent_id()
);

commit;
