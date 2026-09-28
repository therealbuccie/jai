begin;

-- Atomically route to human support, terminate the leased job, and notify
-- the customer. Existing lease, ownership, and conversation guards remain.
create or replace function public.escalate_ai_job(p_job_id uuid, p_lease_token uuid)
returns public.ai_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job public.ai_jobs%rowtype;
  conversation public.conversations%rowtype;
begin
  select j.* into job from public.ai_jobs j where j.id = p_job_id for update;
  if not found then
    raise exception 'AI job not found' using errcode = 'P0002';
  end if;
  if job.state in ('completed', 'failed') then return job; end if;
  select c.* into conversation from public.conversations c
    where c.id = job.conversation_id for update;
  if job.state <> 'processing' or p_lease_token is null
    or job.lease_token is distinct from p_lease_token
    or job.lease_expires_at <= clock_timestamp() then
    raise exception 'Invalid or expired AI job lease' using errcode = 'P0001';
  end if;
  if conversation.handler = 'automation' and conversation.status <> 'resolved' then
    perform public.escalate_conversation(job.conversation_id);
    -- Revalidates all app/customer/source relationships and the lease. Any error
    -- rolls back escalation too. The conversation lock remains held until commit.
    job := public.finalize_ai_job(job.id, p_lease_token, null);
    -- Only this successful automation -> human_queue transition creates a
    -- message. Job/conversation locks serialize retries, other jobs and handoff.
    -- Use the same sender semantics as normal JAI replies; widget polling
    -- already includes automation/text messages. Any failure rolls back all work.
    insert into public.messages(conversation_id, sender_type, sender_id, message_type, status, content)
    values (conversation.id, 'automation', null, 'text', 'sent',
      'I couldn''t complete that request right now. I''ll connect you with a member of our support team. Please hold on for a moment.');
    update public.conversations c set updated_at = clock_timestamp()
      where c.id = conversation.id;
    update public.ai_jobs j set last_error = 'escalated_to_human'
      where j.id = job.id returning j.* into job;
  else
    job := public.finalize_ai_job(job.id, p_lease_token, null);
  end if;
  -- Preserve the existing escalation outcome: failed/escalated_to_human.
  -- reply_message_id stays null as required for a failed job by migration 009.
  -- Terminal retries return above without inserting another handoff message.
  return job;
end;
$$;

revoke all on function public.escalate_ai_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.escalate_ai_job(uuid, uuid) to service_role;

commit;
