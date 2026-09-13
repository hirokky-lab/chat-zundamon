create or replace function public.is_one_time_reminder_time_zone(p_value text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_value is not null
    and pg_catalog.length(p_value) between 1 and 64
    and p_value = pg_catalog.btrim(p_value)
    and p_value !~ '[[:cntrl:]]'
    and exists (select 1 from pg_catalog.pg_timezone_names where name = p_value)
$$;

create or replace function public.is_one_time_reminder_quiet_time(
  p_local timestamp without time zone,
  p_start time without time zone,
  p_end time without time zone
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_local is null or p_start is null or p_end is null or p_start = p_end then false
    when p_start < p_end then p_local::time >= p_start and p_local::time < p_end
    else p_local::time >= p_start or p_local::time < p_end
  end
$$;

create table public.one_time_reminders (
  id uuid primary key check (id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_request_id text not null check (
    pg_catalog.length(client_request_id) between 1 and 128
    and client_request_id = pg_catalog.btrim(client_request_id)
    and client_request_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  state text not null default 'prepared' check (state in ('prepared', 'confirmed', 'cancelled')),
  safe_summary text not null check (
    pg_catalog.length(safe_summary) between 1 and 120
    and safe_summary = pg_catalog.btrim(safe_summary)
    and safe_summary !~ '[[:cntrl:]]'
  ),
  requested_at timestamptz not null,
  scheduled_at timestamptz not null,
  requested_local_datetime timestamp(0) without time zone not null,
  scheduled_local_datetime timestamp(0) without time zone not null,
  time_zone text not null check (public.is_one_time_reminder_time_zone(time_zone)),
  quiet_hours_start time(0) without time zone,
  quiet_hours_end time(0) without time zone,
  quiet_hours_choice text check (quiet_hours_choice is null or quiet_hours_choice in ('requested_time', 'quiet_hours_end')),
  prepared_at timestamptz not null,
  confirmation_expires_at timestamptz not null,
  payload_digest text not null check (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  hmac_key_version text not null check (
    pg_catalog.length(hmac_key_version) between 1 and 64
    and hmac_key_version ~ '^[A-Za-z0-9._:-]+$'
  ),
  signature text not null check (signature ~ '^hmac-sha256:[a-f0-9]{64}$'),
  max_attempts integer not null default 1 check (max_attempts = 1),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  unique (owner_id, client_request_id),
  constraint one_time_reminders_instant_order_check check (
    requested_at > prepared_at
    and scheduled_at >= requested_at
    and confirmation_expires_at > prepared_at
    and confirmation_expires_at <= scheduled_at
  ),
  constraint one_time_reminders_local_time_check check (
    requested_local_datetime = requested_at at time zone time_zone
    and scheduled_local_datetime = scheduled_at at time zone time_zone
  ),
  constraint one_time_reminders_quiet_choice_check check (
    (
      quiet_hours_start is null
      and quiet_hours_end is null
      and quiet_hours_choice is null
    )
    or
    (
      quiet_hours_start is not null
      and quiet_hours_end is not null
      and quiet_hours_start <> quiet_hours_end
      and (
        (
          public.is_one_time_reminder_quiet_time(requested_local_datetime, quiet_hours_start, quiet_hours_end)
          and quiet_hours_choice is not null
          and quiet_hours_choice in ('requested_time', 'quiet_hours_end')
        )
        or
        (
          not public.is_one_time_reminder_quiet_time(requested_local_datetime, quiet_hours_start, quiet_hours_end)
          and quiet_hours_choice is null
        )
      )
    )
  ),
  constraint one_time_reminders_schedule_choice_check check (
    (
      (quiet_hours_choice is null or quiet_hours_choice = 'requested_time')
      and scheduled_at = requested_at
      and scheduled_local_datetime = requested_local_datetime
    )
    or
    (
      quiet_hours_choice = 'quiet_hours_end'
      and scheduled_at > requested_at
      and scheduled_local_datetime::time = quiet_hours_end
      and scheduled_local_datetime::date = case
        when quiet_hours_start > quiet_hours_end
          and requested_local_datetime::time >= quiet_hours_start
        then requested_local_datetime::date + 1
        else requested_local_datetime::date
      end
    )
  ),
  constraint one_time_reminders_state_timestamps_check check (
    (state = 'prepared' and confirmed_at is null and cancelled_at is null)
    or (state = 'confirmed' and confirmed_at is not null and cancelled_at is null)
    or (state = 'cancelled' and cancelled_at is not null)
  ),
  constraint one_time_reminders_event_order_check check (
    (confirmed_at is null or (confirmed_at >= prepared_at and confirmed_at < confirmation_expires_at))
    and (cancelled_at is null or cancelled_at >= prepared_at)
  )
);

alter table public.one_time_reminders enable row level security;
revoke all on table public.one_time_reminders from public, anon, authenticated, service_role;

create or replace function public.assert_one_time_reminder_service_owner(p_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' or p_owner_id is null then
    raise exception 'reminder server operation required' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.prepare_one_time_reminder(
  p_owner_id uuid,
  p_id uuid,
  p_client_request_id text,
  p_safe_summary text,
  p_requested_at timestamptz,
  p_scheduled_at timestamptz,
  p_requested_local_datetime timestamp without time zone,
  p_scheduled_local_datetime timestamp without time zone,
  p_time_zone text,
  p_quiet_hours_start time without time zone,
  p_quiet_hours_end time without time zone,
  p_quiet_hours_choice text,
  p_prepared_at timestamptz,
  p_confirmation_expires_at timestamptz,
  p_payload_digest text,
  p_hmac_key_version text,
  p_signature text
)
returns public.one_time_reminders
language plpgsql
security definer
set search_path = ''
as $$
declare target public.one_time_reminders%rowtype;
begin
  perform public.assert_one_time_reminder_service_owner(p_owner_id);
  insert into public.one_time_reminders (
    id, owner_id, client_request_id, state, safe_summary, requested_at, scheduled_at,
    requested_local_datetime, scheduled_local_datetime, time_zone, quiet_hours_start,
    quiet_hours_end, quiet_hours_choice, prepared_at, confirmation_expires_at,
    payload_digest, hmac_key_version, signature, max_attempts
  ) values (
    p_id, p_owner_id, p_client_request_id, 'prepared', p_safe_summary, p_requested_at, p_scheduled_at,
    p_requested_local_datetime, p_scheduled_local_datetime, p_time_zone, p_quiet_hours_start,
    p_quiet_hours_end, p_quiet_hours_choice, p_prepared_at, p_confirmation_expires_at,
    p_payload_digest, p_hmac_key_version, p_signature, 1
  ) on conflict (owner_id, client_request_id) do nothing;

  select * into target from public.one_time_reminders
  where owner_id = p_owner_id and client_request_id = p_client_request_id for update;
  if target.safe_summary is distinct from p_safe_summary
    or target.requested_at is distinct from p_requested_at
    or target.scheduled_at is distinct from p_scheduled_at
    or target.requested_local_datetime is distinct from p_requested_local_datetime
    or target.scheduled_local_datetime is distinct from p_scheduled_local_datetime
    or target.time_zone is distinct from p_time_zone
    or target.quiet_hours_start is distinct from p_quiet_hours_start
    or target.quiet_hours_end is distinct from p_quiet_hours_end
    or target.quiet_hours_choice is distinct from p_quiet_hours_choice
    or target.confirmation_expires_at is distinct from p_confirmation_expires_at
    or target.payload_digest is distinct from p_payload_digest
    or target.hmac_key_version is distinct from p_hmac_key_version
    or target.signature is distinct from p_signature
    or target.max_attempts <> 1
  then
    raise exception 'reminder request conflict' using errcode = '23505';
  end if;
  return target;
end;
$$;

create or replace function public.get_one_time_reminder(p_owner_id uuid, p_id uuid)
returns public.one_time_reminders
language plpgsql
security definer
set search_path = ''
as $$
declare target public.one_time_reminders%rowtype;
begin
  perform public.assert_one_time_reminder_service_owner(p_owner_id);
  select * into target from public.one_time_reminders where owner_id = p_owner_id and id = p_id;
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  return target;
end;
$$;

create or replace function public.confirm_one_time_reminder(
  p_owner_id uuid,
  p_id uuid,
  p_payload_digest text,
  p_hmac_key_version text,
  p_signature text,
  p_confirmed_at timestamptz
)
returns public.one_time_reminders
language plpgsql
security definer
set search_path = ''
as $$
declare target public.one_time_reminders%rowtype;
begin
  perform public.assert_one_time_reminder_service_owner(p_owner_id);
  select * into target from public.one_time_reminders where owner_id = p_owner_id and id = p_id for update;
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  if target.payload_digest is distinct from p_payload_digest
    or target.hmac_key_version is distinct from p_hmac_key_version
    or target.signature is distinct from p_signature
  then
    raise exception 'invalid reminder confirmation' using errcode = '22023';
  end if;
  if target.state = 'confirmed' then return target; end if;
  if target.state <> 'prepared' then raise exception 'reminder is not confirmable' using errcode = '55000'; end if;
  if p_confirmed_at is null or p_confirmed_at >= target.confirmation_expires_at then
    raise exception 'reminder confirmation expired' using errcode = '55000';
  end if;
  update public.one_time_reminders set state = 'confirmed', confirmed_at = p_confirmed_at
  where owner_id = p_owner_id and id = p_id returning * into target;
  return target;
end;
$$;

create or replace function public.cancel_one_time_reminder(
  p_owner_id uuid,
  p_id uuid,
  p_cancelled_at timestamptz
)
returns public.one_time_reminders
language plpgsql
security definer
set search_path = ''
as $$
declare target public.one_time_reminders%rowtype;
begin
  perform public.assert_one_time_reminder_service_owner(p_owner_id);
  select * into target from public.one_time_reminders where owner_id = p_owner_id and id = p_id for update;
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  if target.state = 'cancelled' then return target; end if;
  if p_cancelled_at is null then raise exception 'invalid reminder cancellation' using errcode = '22023'; end if;
  update public.one_time_reminders set state = 'cancelled', cancelled_at = p_cancelled_at
  where owner_id = p_owner_id and id = p_id returning * into target;
  return target;
end;
$$;

revoke all on function public.is_one_time_reminder_time_zone(text) from public, anon, authenticated;
revoke all on function public.is_one_time_reminder_quiet_time(timestamp without time zone, time without time zone, time without time zone) from public, anon, authenticated;
revoke all on function public.assert_one_time_reminder_service_owner(uuid) from public, anon, authenticated;
revoke all on function public.prepare_one_time_reminder(uuid,uuid,text,text,timestamptz,timestamptz,timestamp without time zone,timestamp without time zone,text,time without time zone,time without time zone,text,timestamptz,timestamptz,text,text,text) from public, anon, authenticated;
revoke all on function public.get_one_time_reminder(uuid,uuid) from public, anon, authenticated;
revoke all on function public.confirm_one_time_reminder(uuid,uuid,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_one_time_reminder(uuid,uuid,timestamptz) from public, anon, authenticated;

grant execute on function public.prepare_one_time_reminder(uuid,uuid,text,text,timestamptz,timestamptz,timestamp without time zone,timestamp without time zone,text,time without time zone,time without time zone,text,timestamptz,timestamptz,text,text,text) to service_role;
grant execute on function public.get_one_time_reminder(uuid,uuid) to service_role;
grant execute on function public.confirm_one_time_reminder(uuid,uuid,text,text,text,timestamptz) to service_role;
grant execute on function public.cancel_one_time_reminder(uuid,uuid,timestamptz) to service_role;
