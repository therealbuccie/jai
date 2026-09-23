begin;

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  source_message_id uuid not null unique references public.messages(id) on delete restrict,
  conversation_id uuid not null references public.conversations(id) on delete restrict,
  app_id uuid not null references public.apps(id) on delete restrict,
  state text not null default 'pending'
    check (state in ('pending', 'processing', 'completed', 'failed')),
  retry_count integer not null default 0 check (retry_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  reply_message_id uuid unique references public.messages(id) on delete restrict,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  check ((state = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (state <> 'processing' and lease_token is null and lease_expires_at is null)),
  check ((state = 'completed') = (reply_message_id is not null)),
  check ((state in ('completed', 'failed')) = (finished_at is not null))
);

create index ai_jobs_claimable on public.ai_jobs(state, lease_expires_at, created_at)
  where state in ('pending', 'processing');
create index ai_jobs_conversation on public.ai_jobs(conversation_id);
create index ai_jobs_app on public.ai_jobs(app_id);

alter table public.ai_jobs enable row level security;
revoke all on public.ai_jobs from public, anon, authenticated;
grant select, insert, update on public.ai_jobs to service_role;

-- Validate the source at enqueue time; finalization rechecks under row locks.
create function public.validate_ai_job_source()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if TG_OP = 'UPDATE' then
    if NEW.source_message_id is distinct from OLD.source_message_id
      or NEW.conversation_id is distinct from OLD.conversation_id
      or NEW.app_id is distinct from OLD.app_id then
      raise exception 'AI job source is immutable' using errcode = '23514';
    end if;
  end if;
  if not exists (
    select 1 from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join public.apps a on a.id = c.app_id
    join public.customers u on u.id = c.customer_id
    where m.id = NEW.source_message_id and c.id = NEW.conversation_id
      and a.id = NEW.app_id and u.organization_id = a.organization_id
      and m.sender_type = 'customer' and m.sender_id = c.customer_id
      and m.message_type = 'text'
  ) then
    raise exception 'Invalid AI job source' using errcode = '23514';
  end if;
  return NEW;
end;
$$;

create trigger ai_jobs_validate_source
before insert or update of source_message_id, conversation_id, app_id
on public.ai_jobs for each row execute function public.validate_ai_job_source();

-- Claims one pending job or recovers an expired lease. Failed jobs are terminal;
-- an explicit trusted retry may reset them to pending with finished_at = null.
-- retry_count counts lease acquisitions after the first acquisition.
create function public.claim_ai_job(p_lease_seconds integer default 120)
returns public.ai_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_job public.ai_jobs%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 900 then
    raise exception 'Lease must be between 1 and 900 seconds' using errcode = '22023';
  end if;
  select j.* into selected_job from public.ai_jobs j
  where j.state = 'pending'
     or (j.state = 'processing' and j.lease_expires_at <= clock_timestamp())
  order by j.created_at, j.id
  for update skip locked
  limit 1;
  if not found then return null; end if;

  update public.ai_jobs j
  set state = 'processing',
      retry_count = j.retry_count + case when j.started_at is not null then 1 else 0 end,
      started_at = coalesce(j.started_at, clock_timestamp()),
      lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + p_lease_seconds * interval '1 second',
      updated_at = clock_timestamp(),
      finished_at = null
  where j.id = selected_job.id
  returning j.* into selected_job;
  return selected_job;
end;
$$;

create function public.finalize_ai_job(p_job_id uuid, p_lease_token uuid, p_content text)
returns public.ai_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job public.ai_jobs%rowtype;
  conversation public.conversations%rowtype;
  source_message public.messages%rowtype;
  app_organization_id uuid;
  customer_organization_id uuid;
  reply_id uuid;
  finalized_at timestamptz;
begin
  select j.* into job from public.ai_jobs j where j.id = p_job_id for update;
  if not found then
    raise exception 'AI job not found' using errcode = 'P0002';
  end if;
  -- Retried completion requests are read-only and return the existing result.
  if job.state in ('completed', 'failed') then return job; end if;
  if job.state <> 'processing' or p_lease_token is null
    or job.lease_token is distinct from p_lease_token
    or job.lease_expires_at <= clock_timestamp() then
    raise exception 'Invalid or expired AI job lease' using errcode = 'P0001';
  end if;

  -- This lock serializes reply insertion against escalation, claim and close.
  select c.* into conversation from public.conversations c
  where c.id = job.conversation_id for update;
  select m.* into source_message from public.messages m
  where m.id = job.source_message_id for share;
  select a.organization_id into app_organization_id from public.apps a
  where a.id = job.app_id for share;
  select u.organization_id into customer_organization_id from public.customers u
  where u.id = conversation.customer_id for share;

  -- Check the clock again after all potentially blocking locks.
  if job.lease_expires_at <= clock_timestamp() then
    raise exception 'Expired AI job lease' using errcode = 'P0001';
  end if;
  if conversation.id is null or source_message.id is null
    or conversation.app_id is distinct from job.app_id
    or source_message.conversation_id is distinct from conversation.id
    or source_message.sender_type is distinct from 'customer'
    or source_message.sender_id is distinct from conversation.customer_id
    or source_message.message_type is distinct from 'text'
    or app_organization_id is null or customer_organization_id is null
    or app_organization_id is distinct from customer_organization_id then
    raise exception 'Invalid AI job relationships' using errcode = '23514';
  end if;

  finalized_at := clock_timestamp();
  if conversation.handler <> 'automation' or conversation.status = 'resolved' then
    -- Return normally so cancellation commits; raising would roll it back.
    update public.ai_jobs j set state = 'failed', last_error = 'conversation_ineligible',
      lease_token = null, lease_expires_at = null,
      updated_at = finalized_at, finished_at = finalized_at
    where j.id = job.id returning j.* into job;
    return job;
  end if;
  if p_content is null or length(btrim(p_content)) = 0 then
    raise exception 'Reply content required' using errcode = '22023';
  end if;

  insert into public.messages(conversation_id, sender_type, sender_id, message_type, status, content)
  values (conversation.id, 'automation', null, 'text', 'sent', p_content)
  returning id into reply_id;
  update public.conversations set updated_at = finalized_at where id = conversation.id;
  update public.ai_jobs j set state = 'completed', reply_message_id = reply_id,
    lease_token = null, lease_expires_at = null, last_error = null,
    updated_at = finalized_at, finished_at = finalized_at
  where j.id = job.id returning j.* into job;
  return job;
end;
$$;

revoke all on function public.validate_ai_job_source() from public, anon, authenticated;
revoke all on function public.claim_ai_job(integer) from public, anon, authenticated;
revoke all on function public.finalize_ai_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_ai_job(integer) to service_role;
grant execute on function public.finalize_ai_job(uuid, uuid, text) to service_role;

commit;
