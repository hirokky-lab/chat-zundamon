begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select plan(27);

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'server-boundary-a@yui.invalid', ''),
  ('00000000-0000-0000-0000-0000000000c2', 'authenticated', 'authenticated', 'server-boundary-b@yui.invalid', '');

select ok(has_table_privilege('authenticated', 'public.memories', 'select'), 'authenticated owner keeps memory reads');
select ok(
  not has_table_privilege('authenticated', 'public.memories', 'insert')
    and not has_table_privilege('authenticated', 'public.memories', 'update')
    and not has_table_privilege('authenticated', 'public.memories', 'delete'),
  'authenticated browser cannot mutate memories directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.memory_processing', 'insert')
    and not has_table_privilege('authenticated', 'public.memory_processing', 'update')
    and not has_table_privilege('authenticated', 'public.memory_processing', 'delete'),
  'authenticated browser cannot forge explicit processing receipts'
);
select ok(
  not has_table_privilege('authenticated', 'public.memory_settings', 'insert')
    and not has_table_privilege('authenticated', 'public.memory_settings', 'update'),
  'authenticated browser cannot bypass memory stop controls'
);
select ok(not has_function_privilege('authenticated', 'public.apply_memory_action_once(text,jsonb)', 'execute'), 'authenticated browser cannot invoke mutation RPC directly');
select ok(not has_function_privilege('authenticated', 'public.server_memory_rpc(uuid,text,jsonb)', 'execute'), 'authenticated browser cannot invoke server dispatcher');
select ok(has_function_privilege('service_role', 'public.server_memory_rpc(uuid,text,jsonb)', 'execute'), 'service role can invoke server dispatcher');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok(
  $$ insert into public.memories (user_id,id,kind,content,content_normalized,importance,created_at,updated_at)
     values ('00000000-0000-0000-0000-0000000000c1',gen_random_uuid(),'shared','迂回','迂回',3,now(),now()) $$,
  '42501', null, 'direct authenticated mutation is denied'
);
select throws_ok(
  $$ select public.server_memory_rpc('00000000-0000-0000-0000-0000000000c1','claim_memory_processing','{"p_source_message_id":"bypass"}'::jsonb) $$,
  '42501', null, 'authenticated caller cannot impersonate the server'
);

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(
  public.server_memory_rpc(
    '00000000-0000-0000-0000-0000000000c1',
    'apply_memory_action_once',
    '{"p_source_message_id":"server-action","p_action":{"type":"add","candidate":{"kind":"shared","scope":"shared","content":"サーバー経由だけ保存","normalizedContent":"サーバー経由だけ保存","origin":"explicit","sensitivity":"normal","importance":4,"sourceMessageId":"server-action","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}}'::jsonb
  )::text,
  '"applied"',
  'service dispatcher preserves atomic server mutation'
);
select ok(public.memory_tombstone_matches('昼食を友達と食べた', '友達と昼食を食べた'), 'database matcher blocks a reordered Japanese paraphrase');
select ok(public.memory_tombstone_matches('友達と昼ご飯を食べた', '友達と昼食を食べた'), 'database matcher applies the same narrow canonical synonym');
select ok(not public.memory_tombstone_matches('妹は猫が好き', '猫が好き'), 'database matcher preserves a different explicit subject');
select ok(exists(select 1 from pg_catalog.pg_trigger where tgname = 'memories_tombstone_boundary' and not tgisinternal), 'memory mutation trigger is installed');

select is(
  public.server_memory_rpc(
    '00000000-0000-0000-0000-0000000000c1', 'apply_memory_action_once',
    '{"p_source_message_id":"atomic-source","p_action":{"type":"add","candidate":{"kind":"event","scope":"daily","content":"友達と昼食を食べた","normalizedContent":"友達と昼食を食べた","origin":"explicit","sensitivity":"normal","importance":3,"sourceMessageId":"atomic-source","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}}'::jsonb
  )::text,
  '"applied"', 'atomic source memory is created'
);
select is(
  public.server_memory_rpc(
    '00000000-0000-0000-0000-0000000000c1', 'apply_memory_action_once',
    jsonb_build_object('p_source_message_id','atomic-forget','p_action',jsonb_build_object(
      'type','forget','targetMemoryId',(select id from public.memories where user_id = '00000000-0000-0000-0000-0000000000c1' and content = '友達と昼食を食べた'),
      'blockRelearning',true
    ))
  )::text,
  '"applied"', 'forget creates the database relearning boundary'
);
select throws_ok(
  $$ select public.server_memory_rpc(
    '00000000-0000-0000-0000-0000000000c1', 'apply_memory_action_once',
    '{"p_source_message_id":"atomic-relearn","p_action":{"type":"add","candidate":{"kind":"event","scope":"daily","content":"昼食を友達と食べた","normalizedContent":"昼食を友達と食べた","origin":"explicit","sensitivity":"normal","importance":3,"sourceMessageId":"atomic-relearn","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}}'::jsonb
  ) $$,
  '23514', 'memory candidate blocked', 'explicit RPC cannot race around an approximate tombstone'
);
select lives_ok(
  $$ insert into public.memories(user_id,id,kind,scope,content,content_normalized,importance,created_at,updated_at)
    values('00000000-0000-0000-0000-0000000000c1',gen_random_uuid(),'preference','daily','妹は猫が好き','偽の正規化値',3,now(),now()) $$,
  'an unrelated subject remains writable and the trigger owns normalization'
);
select is((select content_normalized from public.memories where content = '妹は猫が好き'), '妹は猫が好き', 'trigger replaces caller-supplied normalized content');
select throws_ok(
  $$ update public.memories set content = '友達と昼ご飯を食べた' where user_id = '00000000-0000-0000-0000-0000000000c1' and content = '妹は猫が好き' $$,
  '23514', 'memory candidate blocked', 'PATCH-style direct update cannot race around an approximate tombstone'
);
select is(
  public.server_memory_rpc(
    '00000000-0000-0000-0000-0000000000c1', 'release_memory_tombstone',
    jsonb_build_object('p_tombstone_id',(select id from public.memory_tombstones where user_id = '00000000-0000-0000-0000-0000000000c1' and released_at is null order by created_at desc limit 1))
  )::text,
  'true', 'released tombstone reopens the mutation boundary'
);
select lives_ok(
  $$ insert into public.memories(user_id,id,kind,scope,content,content_normalized,importance,created_at,updated_at)
    values('00000000-0000-0000-0000-0000000000c1',gen_random_uuid(),'event','daily','昼食を友達と食べた','昼食を友達と食べた',3,now(),now()) $$,
  'released paraphrase can be saved again'
);

-- Two independent database sessions prove that a save which began while
-- forget held the owner lock re-checks the newly committed tombstone.
-- Use the same TCP endpoint as this test session; loopback trust auth cannot satisfy dblink credential checks.
reset role;
select extensions.dblink_connect('forget_lock', format('host=%s port=%s dbname=%s user=postgres password=postgres', inet_server_addr(), current_setting('port'), current_database()));
select extensions.dblink_connect('relearn_save', format('host=%s port=%s dbname=%s user=postgres password=postgres', inet_server_addr(), current_setting('port'), current_database()));
select extensions.dblink_exec('forget_lock', $remote$
  insert into auth.users(id,aud,role,email,encrypted_password)
  values('00000000-0000-0000-0000-0000000000c3','authenticated','authenticated','atomic-race@yui.invalid','');
  insert into public.memories(user_id,id,kind,scope,content,content_normalized,importance,created_at,updated_at)
  values('00000000-0000-0000-0000-0000000000c3','10000000-0000-4000-8000-0000000000c3','event','daily','友達と昼食を食べた','友達と昼食を食べた',3,now(),now())
$remote$);
select extensions.dblink_exec('forget_lock', 'begin; set role service_role; set request.jwt.claim.role = ''service_role''; set request.jwt.claim.sub = ''00000000-0000-0000-0000-0000000000c3''');
select extensions.dblink_send_query('forget_lock', $$ select public.forget_memory('10000000-0000-4000-8000-0000000000c3', true) $$);
select is(
  (select forgot from extensions.dblink_get_result('forget_lock') as result(forgot boolean)),
  true,
  'forget transaction creates the tombstone while retaining its owner lock'
);
select count(*) from extensions.dblink_get_result('forget_lock') as drained(forgot boolean);
select extensions.dblink_exec('relearn_save', 'begin; set role service_role; set request.jwt.claim.role = ''service_role''; set request.jwt.claim.sub = ''00000000-0000-0000-0000-0000000000c3''');
select extensions.dblink_send_query('relearn_save', $remote$
  insert into public.memories(user_id,id,kind,scope,content,content_normalized,importance,created_at,updated_at)
  values('00000000-0000-0000-0000-0000000000c3',gen_random_uuid(),'event','daily','昼食を友達と食べた','昼食を友達と食べた',3,now(),now())
$remote$);
select is(extensions.dblink_is_busy('relearn_save'), 1, 'concurrent paraphrase save waits on the owner transaction lock');
select extensions.dblink_exec('forget_lock', 'commit');
select throws_ok(
  $$ select * from extensions.dblink_get_result('relearn_save') as result(status text) $$,
  '23514', 'memory candidate blocked',
  'concurrent paraphrase save rechecks the committed tombstone and fails closed'
);
select count(*) from extensions.dblink_get_result('relearn_save') as drained(status text);
select extensions.dblink_exec('relearn_save', 'rollback');
select extensions.dblink_exec('forget_lock', 'reset role; delete from auth.users where id = ''00000000-0000-0000-0000-0000000000c3''');
select extensions.dblink_disconnect('relearn_save');
select extensions.dblink_disconnect('forget_lock');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select is((select count(*) from public.memories where content = 'サーバー経由だけ保存'), 1::bigint, 'owner reads the server-created memory');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select is((select count(*) from public.memories), 0::bigint, 'RLS still isolates another owner');

select * from finish();
rollback;
