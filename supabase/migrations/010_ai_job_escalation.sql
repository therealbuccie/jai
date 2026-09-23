begin;

-- Lease-fenced escalation and job termination must commit together.
-- Keep 007/008/009 unchanged; reuse their routing and relationship guards.
create function public.escalate_ai_job(p_job_id uuid, p_lease_token uuid)
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
    -- rolls back escalation too. NULL content cannot insert a reply.
    job := public.finalize_ai_job(job.id, p_lease_token, null);
    update public.ai_jobs j set last_error = 'escalated_to_human'
      where j.id = job.id returning j.* into job;
  else
    job := public.finalize_ai_job(job.id, p_lease_token, null);
  end if;
  -- 009 requires completed jobs to have a reply. Escalations terminate as failed
  -- with a specific outcome code, never as a fabricated automation message.
  return job;
end;
$$;

revoke all on function public.escalate_ai_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.escalate_ai_job(uuid, uuid) to service_role;

commit;
