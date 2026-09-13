begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

select has_function('public', 'import_profile_memory', array['uuid', 'jsonb'], 'migration RPC exists');
select ok(not has_function_privilege('anon', 'public.import_profile_memory(uuid,jsonb)', 'execute'), 'anon cannot import');
select ok(not has_function_privilege('authenticated', 'public.import_profile_memory(uuid,jsonb)', 'execute'), 'authenticated browser cannot import directly');
select ok(has_function_privilege('service_role', 'public.import_profile_memory(uuid,jsonb)', 'execute'), 'server role can import');

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'a-import@yui.invalid', ''),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'b-import@yui.invalid', '');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);

select results_eq(
  $$ select * from public.import_profile_memory(
    '90000000-0000-4000-8000-000000000001',
    '{"version":1,"profile":{"displayName":"大輝","addressingStyle":"san","updatedAt":"2026-08-10T00:00:00.000Z"},"memories":[{"id":"10000000-0000-4000-8000-000000000001","kind":"shared","content":"ユイと夜に長く話した","importance":4,"createdAt":"2026-08-09T00:00:00.000Z","updatedAt":"2026-08-10T00:00:00.000Z"}]}'::jsonb
  ) $$,
  $$ values (true, 1) $$,
  'imports profile and memories atomically'
);
select is((select display_name from public.profiles), '大輝', 'profile belongs to caller');
select is((select count(*) from public.memories), 1::bigint, 'one memory imported');
select is((select count(*) from public.migration_imports), 1::bigint, 'receipt stored');

select results_eq(
  $$ select * from public.import_profile_memory(
    '90000000-0000-4000-8000-000000000001',
    '{"version":1,"profile":{"displayName":"上書きしない","addressingStyle":"none","updatedAt":"2026-08-10T01:00:00.000Z"},"memories":[]}'::jsonb
  ) $$,
  $$ values (true, 1) $$,
  'duplicate import id returns original receipt'
);
select is((select display_name from public.profiles), '大輝', 'duplicate import does not overwrite original import');

select throws_ok(
  $$ select * from public.import_profile_memory(
    '90000000-0000-4000-8000-000000000002',
    '{"version":1,"profile":{"displayName":"壊れた更新","addressingStyle":"san","updatedAt":"2026-08-10T02:00:00.000Z"},"memories":[{"id":"bad-id","kind":"shared","content":"壊れた記憶","importance":4,"createdAt":"2026-08-09T00:00:00.000Z","updatedAt":"2026-08-10T00:00:00.000Z"}]}'::jsonb
  ) $$,
  null,
  null,
  'invalid memory rolls back the whole call'
);
select is((select display_name from public.profiles), '大輝', 'failed import leaves prior profile intact');

select * from finish();
rollback;
