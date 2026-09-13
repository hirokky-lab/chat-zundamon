begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

select has_table('public', 'google_calendar_tasks_quota_usage', 'quota usage table exists');
select has_pk('public', 'google_calendar_tasks_quota_usage', 'quota usage is idempotent per owner, service, and request');
select ok(not has_table_privilege('anon', 'public.google_calendar_tasks_quota_usage', 'select'), 'anon cannot read quota usage');
select ok(not has_table_privilege('authenticated', 'public.google_calendar_tasks_quota_usage', 'select'), 'browser cannot read quota usage');
select ok(not has_table_privilege('service_role', 'public.google_calendar_tasks_quota_usage', 'select'), 'service role uses quota RPCs only');
select ok(not has_function_privilege('anon', 'public.acquire_google_calendar_tasks_quota(uuid,text,text)', 'execute'), 'anon cannot acquire quota');
select ok(not has_function_privilege('authenticated', 'public.acquire_google_calendar_tasks_quota(uuid,text,text)', 'execute'), 'browser cannot acquire quota');
select ok(has_function_privilege('service_role', 'public.acquire_google_calendar_tasks_quota(uuid,text,text)', 'execute'), 'service role can acquire quota');

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-0000000000e1', 'authenticated', 'authenticated', 'quota-owner-a@example.test', ''),
  ('00000000-0000-0000-0000-0000000000e2', 'authenticated', 'authenticated', 'quota-owner-b@example.test', '');

select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'calendar-1'), 'first request acquires');
select ok(not public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'calendar-1'), 'duplicate request fails closed');
select ok(public.commit_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'calendar-1'), 'pending request commits once');
select ok(not public.commit_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'calendar-1'), 'committed request cannot commit twice');
select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'tasks', 'tasks-1'), 'service quota is independent');
select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e2', 'calendar', 'owner-2'), 'owner quota is independent');
select ok(public.release_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'tasks', 'tasks-1'), 'pending request can release');
select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'tasks', 'tasks-1'), 'released request can retry');

select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'minute-2'), 'minute request 2');
select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'minute-3'), 'minute request 3');
select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'minute-4'), 'minute request 4');
select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'minute-5'), 'minute request 5');
select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'minute-6'), 'minute request 6');
select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'minute-7'), 'minute request 7');
select ok(public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'minute-8'), 'minute request 8');
select ok(not public.acquire_google_calendar_tasks_quota('00000000-0000-0000-0000-0000000000e1', 'calendar', 'minute-9'), 'ninth rolling-minute request fails closed');

select * from finish();
rollback;
