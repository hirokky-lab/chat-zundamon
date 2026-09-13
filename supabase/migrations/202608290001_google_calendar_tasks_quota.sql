create table public.google_calendar_tasks_quota_usage (
  owner_id uuid not null references auth.users(id) on delete cascade,
  service text not null check (service in ('calendar', 'tasks')),
  request_id text not null check (
    pg_catalog.length(request_id) between 1 and 128
    and request_id ~ '^[A-Za-z0-9:_-]+$'
  ),
  state text not null check (state in ('pending', 'committed')),
  occurred_at timestamptz not null default pg_catalog.now(),
  primary key (owner_id, service, request_id)
);

alter table public.google_calendar_tasks_quota_usage enable row level security;
revoke all on table public.google_calendar_tasks_quota_usage from public, anon, authenticated, service_role;

create or replace function public.acquire_google_calendar_tasks_quota(
  p_owner_id uuid,
  p_service text,
  p_request_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  minute_total integer;
  day_total integer;
begin
  if p_service not in ('calendar', 'tasks')
    or p_request_id is null
    or pg_catalog.length(p_request_id) not between 1 and 128
    or p_request_id !~ '^[A-Za-z0-9:_-]+$'
  then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner_id::text || ':' || p_service, 0)
  );

  if exists (
    select 1 from public.google_calendar_tasks_quota_usage
    where owner_id = p_owner_id and service = p_service and request_id = p_request_id
  ) then
    return false;
  end if;

  select pg_catalog.count(*) into minute_total
  from public.google_calendar_tasks_quota_usage
  where owner_id = p_owner_id and service = p_service
    and occurred_at > pg_catalog.now() - interval '60 seconds';

  select pg_catalog.count(*) into day_total
  from public.google_calendar_tasks_quota_usage
  where owner_id = p_owner_id and service = p_service
    and occurred_at >= pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC') at time zone 'UTC';

  if minute_total >= 8 or day_total >= 50 then
    return false;
  end if;

  insert into public.google_calendar_tasks_quota_usage (owner_id, service, request_id, state)
  values (p_owner_id, p_service, p_request_id, 'pending');
  return true;
end;
$$;

create or replace function public.commit_google_calendar_tasks_quota(
  p_owner_id uuid,
  p_service text,
  p_request_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.google_calendar_tasks_quota_usage
  set state = 'committed'
  where owner_id = p_owner_id and service = p_service and request_id = p_request_id and state = 'pending';
  return found;
end;
$$;

create or replace function public.release_google_calendar_tasks_quota(
  p_owner_id uuid,
  p_service text,
  p_request_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.google_calendar_tasks_quota_usage
  where owner_id = p_owner_id and service = p_service and request_id = p_request_id and state = 'pending';
  return found;
end;
$$;

revoke all on function public.acquire_google_calendar_tasks_quota(uuid, text, text) from public, anon, authenticated;
revoke all on function public.commit_google_calendar_tasks_quota(uuid, text, text) from public, anon, authenticated;
revoke all on function public.release_google_calendar_tasks_quota(uuid, text, text) from public, anon, authenticated;
grant execute on function public.acquire_google_calendar_tasks_quota(uuid, text, text) to service_role;
grant execute on function public.commit_google_calendar_tasks_quota(uuid, text, text) to service_role;
grant execute on function public.release_google_calendar_tasks_quota(uuid, text, text) to service_role;
