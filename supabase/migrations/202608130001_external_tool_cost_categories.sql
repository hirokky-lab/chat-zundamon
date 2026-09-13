alter table public.usage_reservations
  drop constraint usage_reservations_feature_check;

alter table public.usage_reservations
  add constraint usage_reservations_feature_check check (feature in (
    'chat', 'memory', 'transcription', 'realtime',
    'search', 'calendar', 'notification', 'image', 'work', 'avatar', 'storage'
  ));

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
  if p_request_id is null or pg_catalog.length(p_request_id) = 0 or pg_catalog.length(p_request_id) > 128 then
    raise exception 'invalid cost request';
  end if;
  if p_feature not in (
    'chat', 'memory', 'transcription', 'realtime',
    'search', 'calendar', 'notification', 'image', 'work', 'avatar', 'storage'
  ) then
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

  select coalesce(pg_catalog.sum(
    case when state = 'settled' then settled_usd else reserved_usd end
  ), 0) into daily_total
  from public.usage_reservations
  where user_id = p_user_id
    and created_at >= pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC') at time zone 'UTC';

  select coalesce(pg_catalog.sum(
    case when state = 'settled' then settled_usd else reserved_usd end
  ), 0) into monthly_total
  from public.usage_reservations
  where user_id = p_user_id
    and created_at >= pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'UTC') at time zone 'UTC';

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

revoke all on function public.reserve_yui_cost(uuid, text, text, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.reserve_yui_cost(uuid, text, text, numeric, numeric, numeric, numeric)
  to service_role;
