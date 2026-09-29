begin;
create table public.agent_notification_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 app_id uuid not null references public.apps(id),
 conversation_id uuid not null references public.conversations(id),
 type text not null check(type in ('queue_entered','customer_message','agent_assigned')),
 source_key text not null unique,
 created_at timestamptz not null default now()
);
create table public.agent_notifications (
 id uuid primary key default gen_random_uuid(),
 event_id uuid not null references public.agent_notification_events(id),
 recipient_agent_id uuid not null references public.human_agents(id),
 organization_id uuid not null references public.organizations(id),
 app_id uuid not null references public.apps(id),
 conversation_id uuid not null references public.conversations(id),
 type text not null,
 app_name text not null, title text not null, body text not null,
 created_at timestamptz not null default now(), read_at timestamptz,
 unique(event_id,recipient_agent_id)
);
create index agent_notifications_recipient_time on public.agent_notifications(recipient_agent_id,created_at desc);
alter table public.agent_notification_events enable row level security;
alter table public.agent_notifications enable row level security;
revoke all on public.agent_notification_events,public.agent_notifications from public,anon,authenticated;
grant select on public.agent_notifications to authenticated;
grant update(read_at) on public.agent_notifications to authenticated;
create policy agent_notifications_own_read on public.agent_notifications for select to authenticated
 using(recipient_agent_id=jai_private.current_agent_id() and jai_private.can_access_conversation(conversation_id));
create policy agent_notifications_own_update on public.agent_notifications for update to authenticated
 using(recipient_agent_id=jai_private.current_agent_id() and jai_private.can_access_conversation(conversation_id))
 with check(recipient_agent_id=jai_private.current_agent_id() and jai_private.can_access_conversation(conversation_id));

create function jai_private.emit_agent_notification()
returns trigger language plpgsql security definer set search_path='' as $$
declare c public.conversations%rowtype; kind text; source text; target uuid; v_event_id uuid;
 org uuid; product text; heading text; preview text := ''; episode bigint;
begin
 if TG_TABLE_NAME='conversations' then
   if new.status<>'open' or new.handler<>'human_queue' or new.assigned_agent_id is not null then return new; end if;
   if TG_OP='UPDATE' then
     if old.status='open' and old.handler='human_queue' and old.assigned_agent_id is null then return new; end if;
   end if;
   c := new; kind := 'queue_entered'; heading := 'New customer waiting';
   -- Conversation row locking serializes queue episodes; rolled-back events do not consume one.
   select count(*)+1 into episode from public.agent_notification_events e where e.conversation_id=c.id and e.type=kind;
   source := 'queue:' || c.id::text || ':' || episode::text;
 elsif TG_TABLE_NAME='messages' then
   if new.sender_type<>'customer' or new.message_type<>'text' then return new; end if;
   select * into c from public.conversations where id=new.conversation_id for update;
   if c.status<>'open' or c.handler<>'human_agent' or c.assigned_agent_id is null then return new; end if;
   kind := 'customer_message'; target := c.assigned_agent_id; source := 'message:' || new.id::text;
   heading := 'New message';
   preview := left(regexp_replace(coalesce(new.content,''),'[[:cntrl:][:space:]]+',' ','g'),120);
 else
   select * into c from public.conversations where id=new.conversation_id for update;
   if c.status<>'open' or c.handler<>'human_agent' or c.assigned_agent_id is distinct from new.agent_id
     or new.agent_id=new.assigned_by_agent_id then return new; end if;
   kind := 'agent_assigned'; target := new.agent_id; source := 'assignment:' || new.id::text;
   heading := 'Conversation assigned to you';
 end if;
 select organization_id,name into org,product from public.apps where id=c.app_id;
 insert into public.agent_notification_events(organization_id,app_id,conversation_id,type,source_key)
 values(org,c.app_id,c.id,kind,source) on conflict(source_key) do nothing returning id into v_event_id;
 if v_event_id is null then return new; end if;
 insert into public.agent_notifications(event_id,recipient_agent_id,organization_id,app_id,conversation_id,type,app_name,title,body)
 select v_event_id,h.id,org,c.app_id,c.id,kind,product,heading,preview from public.human_agents h
 where h.organization_id=org and (target is null or h.id=target)
 and (h.role='admin' or exists(select 1 from public.agent_app_access x where x.agent_id=h.id and x.app_id=c.app_id))
 on conflict(event_id,recipient_agent_id) do nothing;
 return new;
end; $$;
revoke all on function jai_private.emit_agent_notification() from public,anon,authenticated;
create trigger conversations_notification after insert or update on public.conversations
 for each row execute function jai_private.emit_agent_notification();
create trigger messages_notification after insert on public.messages
 for each row execute function jai_private.emit_agent_notification();
create trigger assignments_notification after insert on public.conversation_assignments
 for each row execute function jai_private.emit_agent_notification();
do $$ begin
 if not exists(select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='agent_notifications') then
 alter publication supabase_realtime add table public.agent_notifications;
 end if;
end; $$;
commit;
