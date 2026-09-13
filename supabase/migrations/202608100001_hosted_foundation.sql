create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  addressing_style text not null check (addressing_style in ('san', 'none')),
  updated_at timestamptz not null default now()
);

create table public.memories (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  kind text not null check (kind in ('preference', 'event', 'ongoing', 'shared')),
  content text not null,
  content_normalized text not null,
  importance smallint not null check (importance between 1 and 5),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (user_id, id),
  unique (user_id, content_normalized)
);

create table public.chat_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version integer not null check (version = 1),
  revision bigint not null check (revision >= 0),
  snapshot jsonb not null,
  updated_at timestamptz not null
);

create table public.usage_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, session_id)
);

create table public.migration_imports (
  user_id uuid not null references auth.users(id) on delete cascade,
  import_id uuid not null,
  imported_at timestamptz not null default now(),
  primary key (user_id, import_id)
);

create table public.usage_reservations (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null,
  feature text not null check (feature in ('chat', 'memory', 'transcription', 'realtime')),
  reserved_usd numeric(12, 6) not null check (reserved_usd >= 0),
  settled_usd numeric(12, 6),
  state text not null check (state in ('reserved', 'settled', 'held')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (user_id, request_id)
);

create index memories_user_priority_idx
  on public.memories (user_id, importance desc, updated_at desc);
create index usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);
create index usage_reservations_user_created_idx
  on public.usage_reservations (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.memories enable row level security;
alter table public.chat_snapshots enable row level security;
alter table public.usage_events enable row level security;
alter table public.migration_imports enable row level security;
alter table public.usage_reservations enable row level security;

revoke all on table public.profiles from public, anon, authenticated;
revoke all on table public.memories from public, anon, authenticated;
revoke all on table public.chat_snapshots from public, anon, authenticated;
revoke all on table public.usage_events from public, anon, authenticated;
revoke all on table public.migration_imports from public, anon, authenticated;
revoke all on table public.usage_reservations from public, anon, authenticated;

grant select, insert, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.memories to authenticated;
grant select, insert, update, delete on table public.chat_snapshots to authenticated;
grant select, insert, update on table public.usage_events to authenticated;
grant select, insert on table public.migration_imports to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated using ((select auth.uid()) = user_id);
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy profiles_delete_own on public.profiles
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy memories_select_own on public.memories
  for select to authenticated using ((select auth.uid()) = user_id);
create policy memories_insert_own on public.memories
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy memories_update_own on public.memories
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy memories_delete_own on public.memories
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy chat_snapshots_select_own on public.chat_snapshots
  for select to authenticated using ((select auth.uid()) = user_id);
create policy chat_snapshots_insert_own on public.chat_snapshots
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy chat_snapshots_update_own on public.chat_snapshots
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy chat_snapshots_delete_own on public.chat_snapshots
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy usage_events_insert_own on public.usage_events
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy usage_events_select_own on public.usage_events
  for select to authenticated using ((select auth.uid()) = user_id);
create policy usage_events_update_own on public.usage_events
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy migration_imports_select_own on public.migration_imports
  for select to authenticated using ((select auth.uid()) = user_id);
create policy migration_imports_insert_own on public.migration_imports
  for insert to authenticated with check ((select auth.uid()) = user_id);

create or replace function public.reserve_yui_cost(
  p_user_id uuid,
  p_request_id text,
  p_feature text,
  p_reserved_usd numeric,
  p_request_max_usd numeric,
  p_daily_max_usd numeric,
  p_monthly_max_usd numeric
)
returns public.usage_reservations
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.usage_reservations;
  daily_total numeric;
  monthly_total numeric;
  created public.usage_reservations;
begin
  if p_request_id is null or length(p_request_id) = 0 or length(p_request_id) > 128 then
    raise exception 'invalid cost request';
  end if;
  if p_feature not in ('chat', 'memory', 'transcription', 'realtime') then
    raise exception 'invalid cost feature';
  end if;
  if p_reserved_usd < 0 or p_reserved_usd > p_request_max_usd then
    raise exception 'request cost limit exceeded';
  end if;
  if p_request_max_usd <= 0 or p_daily_max_usd <= 0 or p_monthly_max_usd <= 0 then
    raise exception 'invalid cost limit';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  select * into existing
  from public.usage_reservations
  where user_id = p_user_id and request_id = p_request_id;
  if found then
    return existing;
  end if;

  select coalesce(sum(
    case when state = 'settled' then settled_usd else reserved_usd end
  ), 0) into daily_total
  from public.usage_reservations
  where user_id = p_user_id
    and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';

  select coalesce(sum(
    case when state = 'settled' then settled_usd else reserved_usd end
  ), 0) into monthly_total
  from public.usage_reservations
  where user_id = p_user_id
    and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';

  if daily_total + p_reserved_usd > p_daily_max_usd then
    raise exception 'daily cost limit exceeded';
  end if;
  if monthly_total + p_reserved_usd > p_monthly_max_usd then
    raise exception 'monthly cost limit exceeded';
  end if;

  insert into public.usage_reservations
    (user_id, request_id, feature, reserved_usd, state)
  values
    (p_user_id, p_request_id, p_feature, p_reserved_usd, 'reserved')
  returning * into created;
  return created;
end;
$$;

create or replace function public.settle_yui_cost(
  p_user_id uuid,
  p_request_id text,
  p_actual_usd numeric,
  p_succeeded boolean
)
returns public.usage_reservations
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.usage_reservations;
begin
  select * into reservation
  from public.usage_reservations
  where user_id = p_user_id and request_id = p_request_id
  for update;
  if not found then
    raise exception 'cost reservation not found';
  end if;
  if reservation.state <> 'reserved' then
    return reservation;
  end if;
  if p_actual_usd < 0 or p_actual_usd > reservation.reserved_usd then
    raise exception 'invalid settled cost';
  end if;

  update public.usage_reservations
  set settled_usd = case when p_succeeded then p_actual_usd else null end,
      state = case when p_succeeded then 'settled' else 'held' end,
      settled_at = now()
  where user_id = p_user_id and request_id = p_request_id
  returning * into reservation;
  return reservation;
end;
$$;

revoke all on function public.reserve_yui_cost(uuid, text, text, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.settle_yui_cost(uuid, text, numeric, boolean)
  from public, anon, authenticated;
grant execute on function public.reserve_yui_cost(uuid, text, text, numeric, numeric, numeric, numeric)
  to service_role;
grant execute on function public.settle_yui_cost(uuid, text, numeric, boolean)
  to service_role;
