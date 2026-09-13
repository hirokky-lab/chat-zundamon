begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'reminder-a@yui.invalid', ''),
  ('00000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'reminder-b@yui.invalid', '');

select has_table('public', 'one_time_reminders', 'one-time reminder table exists');
select columns_are(
  'public', 'one_time_reminders',
  array[
    'id', 'owner_id', 'client_request_id', 'state', 'safe_summary', 'requested_at', 'scheduled_at',
    'requested_local_datetime', 'scheduled_local_datetime', 'time_zone', 'quiet_hours_start',
    'quiet_hours_end', 'quiet_hours_choice', 'prepared_at', 'confirmation_expires_at', 'payload_digest',
    'hmac_key_version', 'signature', 'max_attempts', 'confirmed_at', 'cancelled_at'
  ],
  'table stores only the approved envelope and state fields'
);
select is(has_table_privilege('authenticated', 'public.one_time_reminders', 'select')::text, 'false', 'browser cannot read reminders directly');
select is(has_table_privilege('service_role', 'public.one_time_reminders', 'select')::text, 'false', 'service role uses owner-scoped RPCs');
select has_function('public', 'prepare_one_time_reminder', array[
  'uuid','uuid','text','text','timestamp with time zone','timestamp with time zone',
  'timestamp without time zone','timestamp without time zone','text','time without time zone',
  'time without time zone','text','timestamp with time zone','timestamp with time zone','text','text','text'
], 'owner-scoped prepare RPC exists');
select has_function('public', 'get_one_time_reminder', array['uuid','uuid'], 'owner-scoped get RPC exists');
select has_function('public', 'confirm_one_time_reminder', array['uuid','uuid','text','text','text','timestamp with time zone'], 'owner-scoped confirm RPC exists');
select has_function('public', 'cancel_one_time_reminder', array['uuid','uuid','timestamp with time zone'], 'owner-scoped cancel RPC exists');
select is(has_function_privilege('authenticated', 'public.prepare_one_time_reminder(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,timestamp without time zone,timestamp without time zone,text,time without time zone,time without time zone,text,timestamp with time zone,timestamp with time zone,text,text,text)', 'execute')::text, 'false', 'browser cannot prepare reminders');
select is(has_function_privilege('authenticated', 'public.confirm_one_time_reminder(uuid,uuid,text,text,text,timestamp with time zone)', 'execute')::text, 'false', 'browser cannot confirm reminders');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (public.prepare_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'request-1', '薬を確認する',
    '2026-08-22T01:00:00.000Z', '2026-08-22T01:00:00.000Z', '2026-08-22 10:00:00', '2026-08-22 10:00:00',
    'Asia/Tokyo', null, null, null, '2026-08-21T00:00:00.000Z', '2026-08-21T00:10:00.000Z',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'local-v1',
    'hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  )).state,
  'prepared'::text,
  'valid confirmed-time payload is prepared'
);
select is((public.get_one_time_reminder('00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1')).max_attempts, 1, 'maximum attempts is fixed to one');
select is(
  (public.prepare_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a2', 'request-1', '薬を確認する',
    '2026-08-22T01:00:00.000Z', '2026-08-22T01:00:00.000Z', '2026-08-22 10:00:00', '2026-08-22 10:00:00',
    'Asia/Tokyo', null, null, null, '2026-08-21T00:00:00.000Z', '2026-08-21T00:10:00.000Z',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'local-v1',
    'hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  )).id,
  '10000000-0000-4000-8000-0000000000a1'::uuid,
  'duplicate owner request is idempotent'
);
reset role;
select is((select count(*) from public.one_time_reminders where owner_id = '00000000-0000-4000-8000-0000000000a1'), 1::bigint, 'idempotent prepare stores one row');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok(
  $$select public.prepare_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a2', 'request-1', '別の内容',
    '2026-08-22T01:00:00.000Z', '2026-08-22T01:00:00.000Z', '2026-08-22 10:00:00', '2026-08-22 10:00:00',
    'Asia/Tokyo', null, null, null, '2026-08-21T00:00:00.000Z', '2026-08-21T00:10:00.000Z',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'local-v1',
    'hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')$$,
  '23505', 'reminder request conflict', 'same idempotency key cannot change the payload'
);
select throws_ok(
  $$select public.get_one_time_reminder('00000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000a1')$$,
  'P0002', 'reminder not found', 'another owner cannot read the reminder'
);
select throws_ok(
  $$select public.prepare_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a3', 'request-collision', '静かな時間の確認',
    '2026-08-21T14:30:00.000Z', '2026-08-21T14:30:00.000Z', '2026-08-21 23:30:00', '2026-08-21 23:30:00',
    'Asia/Tokyo', '23:00', '08:00', null, '2026-08-21T00:00:00.000Z', '2026-08-21T00:10:00.000Z',
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'local-v1',
    'hmac-sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')$$,
  '23514', 'new row for relation "one_time_reminders" violates check constraint "one_time_reminders_quiet_choice_check"',
  'quiet-hours collision without an owner choice is unrepresentable'
);
select throws_ok(
  $$select public.prepare_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a4', 'request-wrong-end', '次の静かな時間終了',
    '2026-08-20T16:30:00.000Z', '2026-08-21T23:00:00.000Z', '2026-08-21 01:30:00', '2026-08-22 08:00:00',
    'Asia/Tokyo', '23:00', '08:00', 'quiet_hours_end', '2026-08-20T00:00:00.000Z', '2026-08-20T00:10:00.000Z',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111', 'local-v1',
    'hmac-sha256:2222222222222222222222222222222222222222222222222222222222222222')$$,
  '23514', 'new row for relation "one_time_reminders" violates check constraint "one_time_reminders_schedule_choice_check"',
  'overnight early-hours choice cannot skip to the following day end'
);
select throws_ok(
  $$select public.confirm_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'local-v1',
    'hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '2026-08-21T00:10:00.000Z')$$,
  '55000', 'reminder confirmation expired', 'expiry fails closed'
);
select is(
  (public.confirm_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'local-v1',
    'hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '2026-08-21T00:05:00.000Z')).state,
  'confirmed'::text,
  'matching unexpired confirmation succeeds'
);
select is(
  (public.confirm_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'local-v1',
    'hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '2026-08-21T00:06:00.000Z')).confirmed_at,
  '2026-08-21T00:05:00.000Z'::timestamptz,
  'duplicate confirmation is idempotent'
);
select is(
  (public.cancel_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '2026-08-21T00:07:00.000Z')).state,
  'cancelled'::text,
  'confirmed reminder remains cancellable'
);
select is(
  (public.cancel_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '2026-08-21T00:08:00.000Z')).cancelled_at,
  '2026-08-21T00:07:00.000Z'::timestamptz,
  'duplicate cancellation is idempotent'
);
select throws_ok(
  $$select public.confirm_one_time_reminder(
    '00000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'local-v1',
    'hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '2026-08-21T00:09:00.000Z')$$,
  '55000', 'reminder is not confirmable', 'cancelled reminder cannot be confirmed'
);
select throws_ok(
  $$insert into public.one_time_reminders (
    id, owner_id, client_request_id, state, safe_summary, requested_at, scheduled_at,
    requested_local_datetime, scheduled_local_datetime, time_zone, prepared_at,
    confirmation_expires_at, payload_digest, hmac_key_version, signature
  ) values (
    '10000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-0000000000a1', 'direct', 'prepared', 'direct',
    '2026-08-22T01:00:00Z', '2026-08-22T01:00:00Z', '2026-08-22 10:00:00', '2026-08-22 10:00:00', 'Asia/Tokyo',
    '2026-08-21T00:00:00Z', '2026-08-21T00:10:00Z',
    'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'local-v1',
    'hmac-sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')$$,
  '42501', 'permission denied for table one_time_reminders', 'service role cannot bypass the RPC boundary'
);

reset role;
select is(has_function_privilege('anon', 'public.cancel_one_time_reminder(uuid,uuid,timestamp with time zone)', 'execute')::text, 'false', 'anonymous callers cannot cancel reminders');
select is(has_function_privilege('service_role', 'public.cancel_one_time_reminder(uuid,uuid,timestamp with time zone)', 'execute')::text, 'true', 'server role can use the cancellation RPC');

select * from finish();
rollback;
