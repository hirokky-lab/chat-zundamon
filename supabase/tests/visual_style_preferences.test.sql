begin;
select plan(30);

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'style-a@yui.invalid', ''),
  ('00000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'style-b@yui.invalid', '');

select has_table('public', 'visual_style_preferences', 'owner style table exists');
select col_is_pk('public', 'visual_style_preferences', 'user_id', 'owner is the only primary key');
select ok((select relrowsecurity from pg_class where oid = 'public.visual_style_preferences'::regclass), 'row level security is enabled');
select is(has_table_privilege('authenticated', 'public.visual_style_preferences', 'select')::text, 'false', 'browser cannot read style rows directly');
select is(has_table_privilege('authenticated', 'public.visual_style_preferences', 'insert')::text, 'false', 'browser cannot insert style rows directly');
select is(has_table_privilege('authenticated', 'public.visual_style_preferences', 'update')::text, 'false', 'browser cannot update style rows directly');
select is(has_table_privilege('authenticated', 'public.visual_style_preferences', 'delete')::text, 'false', 'browser cannot delete style rows directly');
select has_function('public', 'get_visual_style_preference', array[]::text[], 'owner get RPC exists');
select has_function('public', 'save_visual_style_preference', array['text', 'bigint'], 'owner compare-and-save RPC exists');
select ok(has_function_privilege('authenticated', 'public.get_visual_style_preference()', 'execute'), 'authenticated owner can use get RPC');
select ok(has_function_privilege('authenticated', 'public.save_visual_style_preference(text,bigint)', 'execute'), 'authenticated owner can use save RPC');
select is(has_function_privilege('anon', 'public.get_visual_style_preference()', 'execute')::text, 'false', 'anonymous callers cannot read owner style');
select is(has_function_privilege('anon', 'public.save_visual_style_preference(text,bigint)', 'execute')::text, 'false', 'anonymous callers cannot save owner style');
select ok((select 'search_path=""' = any(proconfig) from pg_proc where oid = 'public.get_visual_style_preference()'::regprocedure), 'get RPC has an empty search path');
select ok((select 'search_path=""' = any(proconfig) from pg_proc where oid = 'public.save_visual_style_preference(text,bigint)'::regprocedure), 'save RPC has an empty search path');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
select is((select revision from public.save_visual_style_preference('minimal', 0)), 1::bigint, 'owner A creates revision one');
select is((select style from public.get_visual_style_preference()), 'minimal', 'owner A reads its style');
select is((select style from public.save_visual_style_preference('yui', 0)), 'minimal', 'a stale owner A write returns the current style');
select is((select revision from public.save_visual_style_preference('yui', 0)), 1::bigint, 'a stale owner A write does not increment revision');
select is((select revision from public.save_visual_style_preference('yui', 1)), 2::bigint, 'the current owner A revision advances atomically');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b1', true);
select is((select count(*) from public.get_visual_style_preference()), 0::bigint, 'owner B cannot read owner A style');
select is((select revision from public.save_visual_style_preference('minimal', 0)), 1::bigint, 'owner B starts an independent revision');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
select is((select style from public.get_visual_style_preference()), 'yui', 'owner A remains isolated from owner B');
select throws_ok(
  $$insert into public.visual_style_preferences (user_id, style, revision) values ('00000000-0000-4000-8000-0000000000a1', 'minimal', 99)$$,
  '42501', null, 'authenticated owner cannot bypass the RPC boundary'
);
select throws_ok(
  $$select public.save_visual_style_preference('unknown', 2)$$,
  'P0001', 'invalid visual style preference', 'unknown style fails closed'
);
select throws_ok(
  $$select public.save_visual_style_preference('minimal', null)$$,
  'P0001', 'invalid visual style preference', 'null expected revision fails closed'
);
select is((select revision from public.get_visual_style_preference()), 2::bigint, 'null expected revision leaves the owner row unchanged');

reset role;
select throws_ok(
  $$update public.visual_style_preferences set revision = 9007199254740992 where user_id = '00000000-0000-4000-8000-0000000000a1'$$,
  '23514', null, 'database rejects revisions outside the JavaScript safe integer range'
);
update public.visual_style_preferences set revision = 9007199254740991 where user_id = '00000000-0000-4000-8000-0000000000a1';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
select throws_ok(
  $$select public.save_visual_style_preference('minimal', 9007199254740991)$$,
  'P0001', 'visual style preference revision limit', 'maximum safe revision cannot overflow'
);
select is((select revision from public.get_visual_style_preference()), 9007199254740991::bigint, 'revision remains at the safe maximum after rejection');

select * from finish();
rollback;
