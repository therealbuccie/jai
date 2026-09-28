begin;
create table public.team_invitations (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 email text not null check (email = lower(btrim(email))),
 display_name text not null,
 role text not null default 'agent' check (role = 'agent'),
 inviter_id uuid not null references public.human_agents(id),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default (now() + interval '7 days'),
 accepted_at timestamptz, revoked_at timestamptz, last_sent_at timestamptz,
 accepted_user_id uuid references auth.users(id),
 unique(id, organization_id)
);
create unique index team_invitation_pending on public.team_invitations(organization_id,email)
 where accepted_at is null and revoked_at is null;
alter table public.apps add constraint apps_id_organization_unique unique(id, organization_id);
create table public.team_invitation_apps (
 invitation_id uuid not null, organization_id uuid not null, app_id uuid not null,
 primary key(invitation_id,app_id),
 foreign key(invitation_id,organization_id) references public.team_invitations(id,organization_id) on delete cascade,
 foreign key(app_id,organization_id) references public.apps(id,organization_id)
);
alter table public.team_invitations enable row level security;
alter table public.team_invitation_apps enable row level security;
revoke all on public.team_invitations, public.team_invitation_apps from public,anon,authenticated;

create function public.create_team_invitation(p_email text,p_name text,p_app_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.human_agents%rowtype; invite_id uuid; normalized text := lower(btrim(p_email));
begin
 select * into a from public.human_agents where auth_user_id=auth.uid() and role='admin' for update;
 if not found then raise exception 'Admin required' using errcode='42501'; end if;
 if normalized is null or length(normalized)>254 or normalized !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 or p_name is null or length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]@]'
 or coalesce(cardinality(p_app_ids),0) not between 1 and 100 then raise exception 'Invalid invitation'; end if;
 if exists(select 1 from unnest(p_app_ids) x where x is null or not exists(
 select 1 from public.apps where id=x and organization_id=a.organization_id)) then raise exception 'Invalid apps'; end if;
 if exists(select 1 from public.human_agents where lower(btrim(email))=normalized) then raise exception 'Existing member'; end if;
 update public.team_invitations set revoked_at=now() where organization_id=a.organization_id and email=normalized
 and accepted_at is null and revoked_at is null and expires_at<=now();
 insert into public.team_invitations(organization_id,email,display_name,inviter_id)
 values(a.organization_id,normalized,btrim(p_name),a.id) returning id into invite_id;
 insert into public.team_invitation_apps select distinct invite_id,a.organization_id,x from unnest(p_app_ids) x;
 return invite_id;
end; $$;

create function public.list_team_invitations()
returns table(id uuid,email text,display_name text,expires_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 select organization_id into org from public.human_agents where auth_user_id=auth.uid() and role='admin';
 if org is null then raise exception 'Admin required' using errcode='42501'; end if;
 return query select i.id,i.email,i.display_name,i.expires_at from public.team_invitations i
 where i.organization_id=org and i.accepted_at is null and i.revoked_at is null and i.expires_at>now() order by i.created_at desc;
end; $$;

create function public.revoke_team_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 update public.team_invitations i set revoked_at=now() where i.id=p_invitation_id and i.accepted_at is null and i.revoked_at is null
 and jai_private.is_organization_agent(i.organization_id,true);
 if not found then raise exception 'Invitation unavailable' using errcode='42501'; end if;
end; $$;

-- Email reservation is service-only; actor identity is verified by the Edge Function.
create function public.reserve_team_invitation_email(p_invitation_id uuid,p_actor_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare address text;
begin
 update public.team_invitations i set last_sent_at=now()
 where i.id=p_invitation_id and i.accepted_at is null and i.revoked_at is null and i.expires_at>now()
 and (i.last_sent_at is null or i.last_sent_at<now()-interval '60 seconds')
 and exists(select 1 from public.human_agents a where a.auth_user_id=p_actor_id and a.role='admin' and a.organization_id=i.organization_id)
 returning i.email into address;
 if address is null then raise exception 'Invitation unavailable'; end if;
 return address;
end; $$;

create function public.accept_team_invitation(p_invitation_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare i public.team_invitations%rowtype; verified_email text; new_agent_id uuid;
begin
 -- Lock the Auth user too: concurrent invitations cannot create conflicting memberships.
 select lower(btrim(email)) into verified_email from auth.users
 where id=auth.uid() and email_confirmed_at is not null and coalesce(is_anonymous,false)=false for update;
 if verified_email is null then raise exception 'Verified account required' using errcode='42501'; end if;
 select * into i from public.team_invitations where id=p_invitation_id for update;
 if not found or i.email<>verified_email then raise exception 'Invitation unavailable' using errcode='42501'; end if;
 if i.accepted_at is not null and i.accepted_user_id=auth.uid() then
 select id into new_agent_id from public.human_agents where auth_user_id=auth.uid() and organization_id=i.organization_id;
 if new_agent_id is not null then return new_agent_id; end if;
 end if;
 if i.accepted_at is not null or i.revoked_at is not null or i.expires_at<=now() then raise exception 'Invitation unavailable'; end if;
 if exists(select 1 from public.human_agents where auth_user_id=auth.uid() or lower(btrim(email))=verified_email)
 then raise exception 'Existing membership conflict'; end if;
 if not exists(select 1 from public.team_invitation_apps where invitation_id=i.id) then raise exception 'No apps'; end if;
 insert into public.human_agents(auth_user_id,organization_id,name,email,role)
 values(auth.uid(),i.organization_id,i.display_name,verified_email,'agent') returning id into new_agent_id;
 insert into public.agent_app_access(agent_id,app_id)
 select new_agent_id,ia.app_id from public.team_invitation_apps ia where ia.invitation_id=i.id;
 update public.team_invitations set accepted_at=now(),accepted_user_id=auth.uid() where id=i.id;
 return new_agent_id;
end; $$;

revoke all on function public.create_team_invitation(text,text,uuid[]), public.list_team_invitations(),
 public.revoke_team_invitation(uuid), public.accept_team_invitation(uuid), public.reserve_team_invitation_email(uuid,uuid) from public,anon,authenticated;
grant execute on function public.create_team_invitation(text,text,uuid[]), public.list_team_invitations(),
 public.revoke_team_invitation(uuid), public.accept_team_invitation(uuid) to authenticated;
grant execute on function public.reserve_team_invitation_email(uuid,uuid) to service_role;
commit;
