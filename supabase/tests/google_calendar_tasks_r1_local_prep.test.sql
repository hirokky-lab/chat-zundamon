begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

select has_table('public', 'google_calendar_tasks_controls', 'Google service control table exists');
select columns_are(
  'public', 'google_calendar_tasks_controls',
  array['owner_id', 'service', 'google_subject', 'enabled', 'home_visible', 'created_at', 'updated_at'],
  'control table has only the approved columns'
);
select is(has_table_privilege('authenticated', 'public.google_calendar_tasks_controls', 'select')::text, 'false', 'browser cannot read controls');
select is(has_table_privilege('service_role', 'public.google_calendar_tasks_controls', 'select')::text, 'false', 'service role uses RPCs rather than direct table access');
select has_function('public', 'get_google_calendar_tasks_status', array['uuid', 'text'], 'owner-scoped status RPC exists');
select has_function('public', 'save_google_calendar_tasks_control', array['uuid', 'text', 'text'], 'owner-scoped save RPC exists');
select has_function('public', 'clear_google_calendar_tasks_service', array['uuid', 'text'], 'service stop RPC exists');
select has_function('public', 'set_google_calendar_tasks_home_visible', array['uuid', 'text', 'boolean'], 'separate Home visibility RPC exists');
select is(has_function_privilege('authenticated', 'public.save_google_calendar_tasks_control(uuid,text,text)', 'execute')::text, 'false', 'browser cannot save connection controls');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  public.get_google_calendar_tasks_status('00000000-0000-0000-0000-0000000000a1', 'calendar'),
  '{"service":"calendar","state":"disconnected","homeVisible":false}'::jsonb,
  'missing Calendar control is disconnected'
);
select is(
  public.save_google_calendar_tasks_control('00000000-0000-0000-0000-0000000000a1', 'calendar', 'sub-a'),
  '{"service":"calendar","state":"connected","homeVisible":false}'::jsonb,
  'new Calendar connection starts hidden'
);
select is(
  public.get_google_calendar_tasks_status('00000000-0000-0000-0000-0000000000a1', 'tasks'),
  '{"service":"tasks","state":"disconnected","homeVisible":false}'::jsonb,
  'Calendar consent does not imply Tasks consent'
);
select is(
  public.set_google_calendar_tasks_home_visible('00000000-0000-0000-0000-0000000000a1', 'calendar', true),
  '{"service":"calendar","state":"connected","homeVisible":true}'::jsonb,
  'Home visibility changes only through its own RPC'
);
select lives_ok(
  $$select public.clear_google_calendar_tasks_service('00000000-0000-0000-0000-0000000000a1', 'tasks')$$,
  'stopping absent Tasks remains service-isolated'
);
select is(
  public.get_google_calendar_tasks_status('00000000-0000-0000-0000-0000000000a1', 'calendar'),
  '{"service":"calendar","state":"connected","homeVisible":true}'::jsonb,
  'stopping Tasks leaves Calendar unchanged'
);
select is(
  public.get_google_calendar_tasks_status('00000000-0000-0000-0000-0000000000b1', 'calendar'),
  '{"service":"calendar","state":"disconnected","homeVisible":false}'::jsonb,
  'another owner cannot see the first owner connection'
);
select lives_ok(
  $$select public.clear_google_calendar_tasks_service('00000000-0000-0000-0000-0000000000a1', 'calendar')$$,
  'Calendar can be stopped independently'
);
select is(
  public.save_google_calendar_tasks_control('00000000-0000-0000-0000-0000000000a1', 'calendar', 'sub-a-new'),
  '{"service":"calendar","state":"connected","homeVisible":false}'::jsonb,
  'reconnected Calendar starts hidden again'
);

select * from finish();
rollback;
