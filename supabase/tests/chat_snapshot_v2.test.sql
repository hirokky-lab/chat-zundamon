begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'snapshot-a@yui.invalid', ''),
  ('00000000-0000-0000-0000-0000000000c2', 'authenticated', 'authenticated', 'snapshot-b@yui.invalid', '');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);

select lives_ok(
  $$ insert into public.chat_snapshots (user_id, version, revision, snapshot, updated_at)
     values ('00000000-0000-0000-0000-0000000000c1', 2, 0,
       '{"timeline":[],"lastOpeningAt":null,"lastConversationAt":null,"version":2,"revision":0,"updatedAt":"2026-08-12T00:00:00.000Z"}'::jsonb,
       '2026-08-12T00:00:00Z') $$,
  'owner can insert a version-two snapshot'
);
select is((select version from public.chat_snapshots), 2, 'version-two row is stored');

delete from public.chat_snapshots;
select lives_ok(
  $$ insert into public.chat_snapshots (user_id, version, revision, snapshot, updated_at)
     values ('00000000-0000-0000-0000-0000000000c1', 1, 0,
       '{"timeline":[],"lastOpeningAt":null,"lastConversationAt":null,"reviewedLocalDates":["2026-08-11"],"version":1,"revision":0,"updatedAt":"2026-08-12T00:00:00.000Z"}'::jsonb,
       '2026-08-12T00:00:00Z') $$,
  'existing version-one snapshot remains valid'
);
select is((select version from public.chat_snapshots), 1, 'version-one row is preserved before application upgrade');
select is((select snapshot ->> 'version' from public.chat_snapshots), '1', 'version-one JSON is preserved exactly');
select lives_ok(
  $$ update public.chat_snapshots
     set version = 2, revision = 1,
       snapshot = '{"timeline":[],"lastOpeningAt":null,"lastConversationAt":null,"version":2,"revision":1,"updatedAt":"2026-08-12T00:01:00.000Z"}'::jsonb,
       updated_at = '2026-08-12T00:01:00Z'
     where user_id = '00000000-0000-0000-0000-0000000000c1' $$,
  'owner upgrades a version-one snapshot by writing version two'
);
select is((select version from public.chat_snapshots), 2, 'upgraded row is version two');
select is((select snapshot ->> 'reviewedLocalDates' from public.chat_snapshots), null, 'upgraded JSON drops daily-review state');

select lives_ok(
  $$ update public.chat_snapshots set version = 3, revision = 2,
       snapshot = '{"timeline":[],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":2,"updatedAt":"2026-08-12T00:02:00.000Z"}'::jsonb,
       updated_at = '2026-08-12T00:02:00Z' where user_id = '00000000-0000-0000-0000-0000000000c1' $$,
  'service can store snapshot version three'
);
select is((select version from public.chat_snapshots), 3, 'version-three row remains version three');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select is((select count(*) from public.chat_snapshots), 0::bigint, 'another owner cannot read the snapshot');
select throws_ok(
  $$ update public.chat_snapshots set revision = 2 where user_id = '00000000-0000-0000-0000-0000000000c1' $$,
  '42501', null, 'browser mutation is denied before owner filtering'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select is((select revision from public.chat_snapshots), 2::bigint, 'another owner did not change the revision');
select throws_ok(
  $$ update public.chat_snapshots set revision = 3 where user_id = '00000000-0000-0000-0000-0000000000c1' $$,
  '42501', null,
  'browser cannot mutate snapshot version three'
);
select ok(not has_table_privilege('authenticated', 'public.chat_snapshots', 'insert'), 'browser cannot insert snapshots');

select * from finish();
rollback;
