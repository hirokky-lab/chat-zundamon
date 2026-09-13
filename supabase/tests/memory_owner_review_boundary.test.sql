begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-0000000000d1', 'authenticated', 'authenticated', 'owner-review@yui.invalid', '');
insert into public.memories (user_id, id, kind, scope, content, content_normalized, status, origin, sensitivity, importance, pinned, created_at, updated_at)
values ('00000000-0000-0000-0000-0000000000d1', '10000000-0000-4000-8000-0000000000d1', 'preference', 'daily', 'review target', 'reviewtarget', 'active', 'extracted', 'sensitive', 3, false, now(), now());

select has_column('public', 'memories', 'owner_reviewed_at', 'owner review timestamp exists');
select is((select review_state from public.memories where id = '10000000-0000-4000-8000-0000000000d1'), 'needs_review', 'sensitive extracted memory is quarantined');
select has_function('public', 'keep_memory', array['uuid', 'uuid'], 'owner scoped keep exists');
select is(has_function_privilege('authenticated', 'public.keep_memory(uuid,uuid)', 'execute')::text, 'false', 'browser cannot invoke keep directly');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is((public.keep_memory('00000000-0000-0000-0000-0000000000d1', '10000000-0000-4000-8000-0000000000d1')).review_state, 'eligible', 'owner keep makes candidate eligible');
create temporary table first_review as select owner_reviewed_at from public.memories where id = '10000000-0000-4000-8000-0000000000d1';
select is((public.keep_memory('00000000-0000-0000-0000-0000000000d1', '10000000-0000-4000-8000-0000000000d1')).owner_reviewed_at, (select owner_reviewed_at from first_review), 'owner keep is idempotent');
select throws_ok($$select public.keep_memory('00000000-0000-0000-0000-0000000000d2', '10000000-0000-4000-8000-0000000000d1')$$, 'P0002', 'memory not found', 'wrong owner fails closed');
select * from finish();
rollback;
