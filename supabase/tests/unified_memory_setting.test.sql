begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-0000000000d3', 'authenticated', 'authenticated', 'memory-on@yui.invalid', ''),
  ('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'authenticated', 'memory-off@yui.invalid', '');
insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled, voice_memory_enabled, memory_enabled, updated_at) values
  ('00000000-0000-0000-0000-0000000000d3', true, true, true, true, now()),
  ('00000000-0000-0000-0000-0000000000d4', true, false, true, false, now());

select has_column('public', 'memory_settings', 'memory_enabled', 'single memory setting exists');
select is((select memory_enabled from public.memory_settings where user_id = '00000000-0000-0000-0000-0000000000d3'), true, 'fully enabled legacy state stays on');
select is((select memory_enabled from public.memory_settings where user_id = '00000000-0000-0000-0000-0000000000d4'), false, 'mixed legacy state is fail-closed off');
select has_function('public', 'patch_memory_settings', array['text', 'boolean'], 'single setting patch exists');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok(
  $$insert into public.memories (user_id, id, kind, scope, content, content_normalized, status, origin, sensitivity, importance, pinned, created_at, updated_at)
    values ('00000000-0000-0000-0000-0000000000d4', '10000000-0000-4000-8000-0000000000d4', 'preference', 'daily', 'off target', 'offtarget', 'active', 'explicit', 'normal', 3, true, now(), now())$$,
  '55000', 'memory is disabled', 'OFF rejects a new explicit memory');
select throws_ok(
  $$insert into public.memories (user_id, id, kind, scope, content, content_normalized, status, origin, sensitivity, importance, pinned, created_at, updated_at)
    values ('00000000-0000-0000-0000-0000000000d4', '20000000-0000-4000-8000-0000000000d4', 'preference', 'daily', 'off automatic', 'offautomatic', 'active', 'extracted', 'normal', 3, false, now(), now())$$,
  '55000', 'memory is disabled', 'OFF rejects a new automatic memory');
select lives_ok(
  $$insert into public.memories (user_id, id, kind, scope, content, content_normalized, status, origin, sensitivity, importance, pinned, created_at, updated_at)
    values ('00000000-0000-0000-0000-0000000000d3', '10000000-0000-4000-8000-0000000000d3', 'preference', 'daily', 'on target', 'ontarget', 'active', 'explicit', 'normal', 3, true, now(), now())$$,
  'ON permits an explicit memory');
select * from finish();
rollback;
