create table public.google_calendar_tasks_controls (
  owner_id uuid not null,
  service text not null check (service in ('calendar', 'tasks')),
  google_subject text not null check (
    pg_catalog.length(google_subject) between 1 and 255
    and google_subject = pg_catalog.btrim(google_subject)
    and google_subject !~ '[[:cntrl:]]'
  ),
  enabled boolean not null default true,
  home_visible boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (owner_id, service)
);

alter table public.google_calendar_tasks_controls enable row level security;
revoke all on table public.google_calendar_tasks_controls from public, anon, authenticated, service_role;

create or replace function public.get_google_calendar_tasks_status(p_owner_id uuid, p_service text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  control public.google_calendar_tasks_controls;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Google connection server operation required' using errcode = '42501';
  end if;
  if p_owner_id is null or p_service not in ('calendar', 'tasks') then
    raise exception 'Invalid Google connection status request' using errcode = '22023';
  end if;
  select * into control
  from public.google_calendar_tasks_controls
  where owner_id = p_owner_id and service = p_service;
  if not found then
    return pg_catalog.jsonb_build_object('service', p_service, 'state', 'disconnected', 'homeVisible', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'service', p_service,
    'state', case when control.enabled then 'connected' else 'disabled' end,
    'homeVisible', case when control.enabled then control.home_visible else false end
  );
end;
$$;

create or replace function public.save_google_calendar_tasks_control(
  p_owner_id uuid,
  p_service text,
  p_google_subject text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Google connection server operation required' using errcode = '42501';
  end if;
  if p_owner_id is null
    or p_service not in ('calendar', 'tasks')
    or p_google_subject is null
    or pg_catalog.length(p_google_subject) not between 1 and 255
    or p_google_subject <> pg_catalog.btrim(p_google_subject)
    or p_google_subject ~ '[[:cntrl:]]'
  then
    raise exception 'Invalid Google connection control' using errcode = '22023';
  end if;

  insert into public.google_calendar_tasks_controls (
    owner_id, service, google_subject, enabled, home_visible, created_at, updated_at
  ) values (
    p_owner_id, p_service, p_google_subject, true, false, pg_catalog.now(), pg_catalog.now()
  )
  on conflict (owner_id, service) do update
  set google_subject = excluded.google_subject,
      enabled = true,
      home_visible = false,
      updated_at = pg_catalog.now();

  return public.get_google_calendar_tasks_status(p_owner_id, p_service);
end;
$$;

create or replace function public.clear_google_calendar_tasks_service(p_owner_id uuid, p_service text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Google connection server operation required' using errcode = '42501';
  end if;
  if p_owner_id is null or p_service not in ('calendar', 'tasks') then
    raise exception 'Invalid Google connection clear request' using errcode = '22023';
  end if;
  delete from public.google_calendar_tasks_controls
  where owner_id = p_owner_id and service = p_service;
end;
$$;

create or replace function public.set_google_calendar_tasks_home_visible(
  p_owner_id uuid,
  p_service text,
  p_visible boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Google connection server operation required' using errcode = '42501';
  end if;
  if p_owner_id is null or p_service not in ('calendar', 'tasks') or p_visible is null then
    raise exception 'Invalid Google Home visibility request' using errcode = '22023';
  end if;
  update public.google_calendar_tasks_controls
  set home_visible = p_visible, updated_at = pg_catalog.now()
  where owner_id = p_owner_id and service = p_service and enabled;
  if not found then
    raise exception 'Google connection not found' using errcode = 'P0002';
  end if;
  return public.get_google_calendar_tasks_status(p_owner_id, p_service);
end;
$$;

revoke all on function public.get_google_calendar_tasks_status(uuid, text) from public, anon, authenticated;
revoke all on function public.save_google_calendar_tasks_control(uuid, text, text) from public, anon, authenticated;
revoke all on function public.clear_google_calendar_tasks_service(uuid, text) from public, anon, authenticated;
revoke all on function public.set_google_calendar_tasks_home_visible(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.get_google_calendar_tasks_status(uuid, text) to service_role;
grant execute on function public.save_google_calendar_tasks_control(uuid, text, text) to service_role;
grant execute on function public.clear_google_calendar_tasks_service(uuid, text) to service_role;
grant execute on function public.set_google_calendar_tasks_home_visible(uuid, text, boolean) to service_role;
