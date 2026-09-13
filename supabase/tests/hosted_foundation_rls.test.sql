begin;

create extension if not exists pgtap with schema extensions;
select plan(48);

select has_table('public', 'profiles', 'profiles exists');
select has_table('public', 'memories', 'memories exists');
select has_table('public', 'chat_snapshots', 'chat_snapshots exists');
select has_table('public', 'usage_events', 'usage_events exists');
select has_table('public', 'migration_imports', 'migration_imports exists');
select has_table('public', 'usage_reservations', 'usage_reservations exists');

select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.memories'::regclass), 'memories has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.chat_snapshots'::regclass), 'chat_snapshots has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.usage_events'::regclass), 'usage_events has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.migration_imports'::regclass), 'migration_imports has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.usage_reservations'::regclass), 'usage_reservations has RLS');

select ok(not has_table_privilege('anon', 'public.profiles', 'select'), 'anon cannot read profiles');
select ok(not has_table_privilege('anon', 'public.memories', 'select'), 'anon cannot read memories');
select ok(not has_table_privilege('anon', 'public.chat_snapshots', 'select'), 'anon cannot read chat snapshots');
select ok(not has_table_privilege('anon', 'public.usage_events', 'select'), 'anon cannot read usage');
select ok(not has_table_privilege('anon', 'public.migration_imports', 'select'), 'anon cannot read imports');
select ok(not has_table_privilege('anon', 'public.usage_reservations', 'select'), 'anon cannot read reservations');

insert into auth.users (id, aud, role, email, encrypted_password)
values
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'a@yui.invalid', ''),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'b@yui.invalid', '');

insert into public.profiles (user_id, display_name, addressing_style)
values
  ('00000000-0000-0000-0000-00000000000a', '大輝', 'san'),
  ('00000000-0000-0000-0000-00000000000b', '別の人', 'san');

insert into public.memories
  (user_id, id, kind, content, content_normalized, importance, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'shared', '二人の記憶', '二人の記憶', 4, now(), now()),
  ('00000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-000000000001', 'shared', '他人の記憶', '他人の記憶', 4, now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);

select results_eq(
  $$ select display_name from public.profiles order by display_name $$,
  $$ values ('大輝'::text) $$,
  'user A reads only their profile'
);
select results_eq(
  $$ select content from public.memories order by content $$,
  $$ values ('二人の記憶'::text) $$,
  'user A reads only their memories'
);
select is(
  (select count(*) from public.profiles where user_id = '00000000-0000-0000-0000-00000000000b'),
  0::bigint,
  'user A cannot see user B profile'
);

update public.profiles set display_name = '侵害' where user_id = '00000000-0000-0000-0000-00000000000b';
select is((select count(*) from public.profiles where display_name = '侵害'), 0::bigint, 'user A cannot update user B');

select throws_ok(
  $$ insert into public.profiles (user_id, display_name, addressing_style) values ('00000000-0000-0000-0000-00000000000b', '侵害', 'san') $$,
  '42501',
  null,
  'user A cannot insert user B profile'
);

select ok(has_table_privilege('authenticated', 'public.profiles', 'select'), 'authenticated can read profiles through RLS');
select ok(not has_table_privilege('authenticated', 'public.memories', 'insert'), 'authenticated browser cannot add memories outside the server policy');
select ok(not has_table_privilege('authenticated', 'public.chat_snapshots', 'update'), 'authenticated cannot update snapshots outside server reconciliation');
select ok(has_table_privilege('authenticated', 'public.usage_events', 'insert'), 'authenticated can add usage through RLS');
select ok(has_table_privilege('authenticated', 'public.usage_events', 'update'), 'authenticated can merge same-session usage through RLS');
select ok(has_table_privilege('authenticated', 'public.migration_imports', 'insert'), 'authenticated can add migration receipts through RLS');
select ok(not has_table_privilege('authenticated', 'public.usage_reservations', 'select'), 'authenticated cannot access cost reservations');
select ok(not has_table_privilege('authenticated', 'public.photo_requests', 'select'), 'authenticated cannot read photo requests');
select ok(not has_table_privilege('authenticated', 'public.photo_assets', 'select'), 'authenticated cannot read photo assets');
select ok(not has_table_privilege('authenticated', 'public.photo_deletion_outbox', 'select'), 'authenticated cannot read photo deletion jobs');
select ok(not has_table_privilege('authenticated', 'public.photo_storage_scan_cursors', 'select'), 'authenticated cannot read photo scan cursors');

select ok(not has_function_privilege('anon', 'public.reserve_yui_cost(uuid,text,text,numeric,numeric,numeric,numeric)', 'execute'), 'anon cannot reserve cost');
select ok(not has_function_privilege('authenticated', 'public.reserve_yui_cost(uuid,text,text,numeric,numeric,numeric,numeric)', 'execute'), 'authenticated cannot reserve cost');
select ok(has_function_privilege('service_role', 'public.reserve_yui_cost(uuid,text,text,numeric,numeric,numeric,numeric)', 'execute'), 'service role can reserve cost');
select ok(not has_function_privilege('authenticated', 'public.settle_yui_cost(uuid,text,numeric,boolean)', 'execute'), 'authenticated cannot settle cost');
select ok(has_function_privilege('service_role', 'public.settle_yui_cost(uuid,text,numeric,boolean)', 'execute'), 'service role can settle cost');

reset role;
set local role service_role;

select is(
  (public.reserve_yui_cost('00000000-0000-0000-0000-00000000000a', 'request-main', 'chat', 0.10, 0.20, 0.20, 0.20)).state,
  'reserved'::text,
  'service role reserves cost'
);
select lives_ok(
  $$ select public.reserve_yui_cost('00000000-0000-0000-0000-00000000000a', 'request-main', 'chat', 0.10, 0.20, 0.20, 0.20) $$,
  'repeating a request ID returns the existing reservation'
);
reset role;
select is(
  (select count(*) from public.usage_reservations where user_id = '00000000-0000-0000-0000-00000000000a' and request_id = 'request-main'),
  1::bigint,
  'repeating a request ID creates only one row'
);
set local role service_role;
select throws_ok(
  $$ select public.reserve_yui_cost('00000000-0000-0000-0000-00000000000a', 'request-over', 'chat', 0.21, 0.20, 1.00, 1.00) $$,
  'P0001', 'request cost limit exceeded', 'per-request ceiling rejects before insertion'
);
select throws_ok(
  $$ select public.reserve_yui_cost('00000000-0000-0000-0000-00000000000a', 'request-daily', 'chat', 0.11, 0.20, 0.20, 1.00) $$,
  'P0001', 'daily cost limit exceeded', 'daily ceiling includes active reservations'
);
select throws_ok(
  $$ select public.reserve_yui_cost('00000000-0000-0000-0000-00000000000a', 'request-monthly', 'chat', 0.11, 0.20, 1.00, 0.20) $$,
  'P0001', 'monthly cost limit exceeded', 'monthly ceiling includes active reservations'
);
select is(
  (public.settle_yui_cost('00000000-0000-0000-0000-00000000000a', 'request-main', 0.04, true)).state,
  'settled'::text,
  'successful requests settle their reservation'
);
reset role;
select is(
  (select settled_usd from public.usage_reservations where user_id = '00000000-0000-0000-0000-00000000000a' and request_id = 'request-main'),
  0.04::numeric,
  'settlement records actual cost'
);
set local role service_role;
select is(
  (public.settle_yui_cost(
    '00000000-0000-0000-0000-00000000000a',
    'request-held',
    0,
    false
  )).state,
  'held'::text,
  'failed upstream requests keep their reservation held'
)
from (
  select public.reserve_yui_cost(
    '00000000-0000-0000-0000-00000000000a',
    'request-held',
    'memory',
    0.05,
    0.20,
    0.20,
    0.20
  )
) reserved;

select * from finish();
rollback;
