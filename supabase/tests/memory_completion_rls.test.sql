begin;
create extension if not exists pgtap with schema extensions;
select plan(65);

select has_column('public', 'memories', 'scope', 'memory records have a scope');
select ok((select relrowsecurity from pg_catalog.pg_class where oid = 'public.memories'::regclass), 'memory records use RLS');
select ok((select relrowsecurity from pg_catalog.pg_class where oid = 'public.memory_processing'::regclass), 'processing rows use RLS');
select ok((select relrowsecurity from pg_catalog.pg_class where oid = 'public.memory_tombstones'::regclass), 'tombstones use RLS');
select ok((select relrowsecurity from pg_catalog.pg_class where oid = 'public.memory_settings'::regclass), 'memory settings use RLS');
select has_column('public', 'memory_settings', 'voice_memory_enabled', 'memory settings independently gate voice processing');
select has_column('public', 'memory_processing', 'processing_version', 'processing receipts have an atomicity version');
select ok(
  not exists (
    select 1 from public.memory_processing
    where processing_version = 2 and state in ('pending', 'failed')
  ),
  'upgrade leaves no ambiguous version-two receipt eligible for lease recovery'
);

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'a-memory@yui.invalid', ''),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'b-memory@yui.invalid', '');

insert into public.memories (user_id, id, kind, content, content_normalized, importance, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-000000000001', 'preference', 'ブラックコーヒーが好き', 'ブラックコーヒーが好き', 4, now(), now());
insert into public.memory_processing (user_id, source_message_id, state, attempted_at)
values ('00000000-0000-0000-0000-00000000000a', 'message-1', 'pending', now());
insert into public.memory_tombstones (user_id, id, memory_id, normalized_fingerprint, created_at)
values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ブラックコーヒーが好き', now());
insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled)
values ('00000000-0000-0000-0000-00000000000a', false, false);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);

select is((select scope from public.memories), 'shared', 'legacy-shaped memory defaults to shared scope');
select is((select status from public.memories), 'active', 'legacy-shaped memory defaults to active');
select is((select origin from public.memories), 'explicit', 'legacy-shaped memory defaults to explicit');
select is((select sensitivity from public.memories), 'normal', 'legacy-shaped memory defaults to normal');
select ok((select pinned from public.memories), 'legacy-shaped memory defaults to pinned');
select is((select count(*) from public.memory_processing), 1::bigint, 'owner reads processing rows');
select is((select count(*) from public.memory_tombstones), 1::bigint, 'owner reads tombstones');
select is((select automatic_memory_enabled from public.memory_settings), false, 'owner persists automatic-memory stop');
select is((select recall_memory_enabled from public.memory_settings), false, 'owner persists recall stop separately');
select ok(not has_table_privilege('authenticated', 'public.memories', 'delete'), 'authenticated clients cannot directly delete memories');
select ok(
  not has_table_privilege('authenticated', 'public.memory_tombstones', 'insert')
    and not has_table_privilege('authenticated', 'public.memory_tombstones', 'update')
    and not has_table_privilege('authenticated', 'public.memory_tombstones', 'delete'),
  'authenticated clients cannot bypass tombstone RPC mutations'
);
select throws_ok(
  $$ update public.memory_tombstones set released_at = now() where id = '20000000-0000-4000-8000-000000000001' $$,
  '42501', null,
  'direct tombstone release cannot bypass release RPC semantics'
);
select ok(
  (select prosecdef from pg_catalog.pg_proc where oid = 'public.apply_memory_action_once(text,jsonb)'::regprocedure),
  'explicit memory action RPC uses its hardened definer boundary'
);
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
insert into public.memories (user_id, id, kind, content, content_normalized, importance, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-000000000098', 'shared', '明示的に忘れる', '明示的に忘れる', 3, now(), now()),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-000000000099', 'shared', '直接削除を拒否する', '直接削除を拒否する', 3, now(), now());
select lives_ok(
  $$ select public.apply_memory_action_once('explicit-forget', '{"type":"forget","targetMemoryId":"10000000-0000-4000-8000-000000000098","blockRelearning":true}'::jsonb) $$,
  'explicit chat forget remains available only through its hardened action RPC'
);
select is((select count(*) from public.memories where id = '10000000-0000-4000-8000-000000000098'), 0::bigint, 'explicit chat forget removes the owner memory');
select is((select count(*) from public.memory_tombstones where memory_id = '10000000-0000-4000-8000-000000000098'), 1::bigint, 'explicit chat forget atomically creates its relearning block');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select throws_ok(
  $$ delete from public.memories where id = '10000000-0000-4000-8000-000000000099' $$,
  '42501', null,
  'direct table deletion cannot bypass forget semantics'
);
select ok(not has_function_privilege('anon', 'public.forget_memory(uuid,boolean)', 'execute'), 'anon cannot invoke hardened forget');
select ok(not has_function_privilege('anon', 'public.release_memory_tombstone(uuid)', 'execute'), 'anon cannot invoke hardened release');
select ok(not has_function_privilege('anon', 'public.claim_automatic_memory_processing(text)', 'execute'), 'anon cannot claim a voice lease');
select ok(not has_function_privilege('anon', 'public.has_active_voice_memory_processing(timestamptz)', 'execute'), 'anon cannot inspect voice leases');
select ok(not has_function_privilege('anon', 'public.cleanup_stale_voice_memory_processing(timestamptz)', 'execute'), 'anon cannot clean voice leases');
select ok(not has_function_privilege('anon', 'public.fail_voice_automatic_memory_processing(text,smallint)', 'execute'), 'anon cannot atomically fail voice processing');
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select is((public.patch_memory_settings('memory_enabled', false)).memory_enabled, false, 'master toggle disables memory');
select is((public.patch_memory_settings('memory_enabled', true)).memory_enabled, true, 'master toggle enables memory');
select is((select recall_memory_enabled from public.memory_settings where user_id = (select auth.uid())), false, 'master toggle preserves legacy recall state');
select throws_ok($$select public.patch_memory_settings('voice_memory_enabled', true)$$, 'P0001', 'invalid memory settings patch', 'legacy setting names are rejected');
-- Set legacy fixture values explicitly for the independent import scenarios below.
update public.memory_settings set automatic_memory_enabled = false, recall_memory_enabled = true, voice_memory_enabled = true where user_id = (select auth.uid());

select results_eq(
  $$ select * from public.import_profile_memory(
    '90000000-0000-4000-8000-000000000010',
    '{"version":1,"profile":{"displayName":"大輝","addressingStyle":"san","updatedAt":"2026-08-10T00:00:00.000Z"},"memories":[{"id":"10000000-0000-4000-8000-000000000010","kind":"ongoing","content":"朝に散歩する","importance":3,"createdAt":"2026-08-09T00:00:00.000Z","updatedAt":"2026-08-10T00:00:00.000Z"}]}'::jsonb
  ) $$,
  $$ values (true, 1) $$,
  'v1 ongoing migration bundle imports successfully'
);
select is((select kind from public.memories where id = '10000000-0000-4000-8000-000000000010'), 'routine', 'v1 ongoing is stored as routine');

insert into public.memories (user_id, id, kind, content, content_normalized, importance, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-000000000020', 'event', '元の記憶', '元の記憶', 3, now(), now()),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-000000000021', 'event', '重複する記憶', '重複する記憶', 3, now(), now());
select throws_ok(
  $$ select public.replace_memory(
    '10000000-0000-4000-8000-000000000020',
    '{"kind":"event","scope":"shared","content":"重複する記憶","content_normalized":"重複する記憶","origin":"manual","sensitivity":"normal","importance":4,"source_message_id":null,"source_occurred_at":null,"valid_from":null,"valid_until":null,"expires_at":null,"pinned":false,"supersedes_id":null,"updated_at":"2026-08-11T00:00:00.000Z"}'::jsonb
  ) $$,
  '23505', null,
  'replacement conflict fails atomically'
);
select is((select status from public.memories where id = '10000000-0000-4000-8000-000000000020'), 'active', 'failed replacement keeps the target active');

select results_eq(
  $$ select public.apply_memory_action_once(
    'atomic-add',
    '{"type":"add","candidate":{"kind":"preference","scope":"shared","content":"原子的に覚える","normalizedContent":"原子的に覚える","origin":"explicit","sensitivity":"normal","importance":4,"sourceMessageId":"atomic-add","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}'::jsonb
  ) $$,
  $$ values ('applied'::text) $$,
  'atomic action applies a memory mutation'
);
select results_eq(
  $$ select public.apply_memory_action_once(
    'atomic-add',
    '{"type":"add","candidate":{"kind":"preference","scope":"shared","content":"原子的に覚える","normalizedContent":"原子的に覚える","origin":"explicit","sensitivity":"normal","importance":4,"sourceMessageId":"atomic-add","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}'::jsonb
  ) $$,
  $$ values ('completed'::text) $$,
  'completed receipt prevents a duplicate mutation'
);
select is((select count(*) from public.memories where content = '原子的に覚える'), 1::bigint, 'atomic retry leaves one memory row');
select is((select state from public.memory_processing where source_message_id = 'atomic-add'), 'completed', 'atomic mutation completes its receipt in the same transaction');
select is((select processing_version from public.memory_processing where source_message_id = 'atomic-add'), 2::smallint, 'new atomic mutation retains version two');

insert into public.memories (user_id, id, kind, content, content_normalized, importance, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-000000000030', 'shared', '旧pendingで既に反映', '旧pendingで既に反映', 3, now(), now());
insert into public.memory_processing (user_id, source_message_id, state, attempted_at)
values ('00000000-0000-0000-0000-00000000000a', 'legacy-applied', 'pending', now() - interval '1 hour');
select results_eq(
  $$ select public.apply_memory_action_once('legacy-applied', '{"type":"add","candidate":{"kind":"shared","scope":"shared","content":"旧pendingの二重追加","normalizedContent":"旧pendingの二重追加","origin":"explicit","sensitivity":"normal","importance":3,"sourceMessageId":"legacy-applied","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}'::jsonb) $$,
  $$ values ('quarantined'::text) $$,
  'legacy pending receipt with a possible committed mutation is quarantined'
);
select is((select count(*) from public.memories where content = '旧pendingの二重追加'), 0::bigint, 'legacy pending receipt never duplicates its mutation');

insert into public.memory_processing (user_id, source_message_id, state, attempted_at)
values ('00000000-0000-0000-0000-00000000000a', 'legacy-empty', 'pending', now() - interval '1 hour');
select results_eq(
  $$ select public.apply_memory_action_once('legacy-empty', '{"type":"add","candidate":{"kind":"shared","scope":"shared","content":"旧pending未適用","normalizedContent":"旧pending未適用","origin":"explicit","sensitivity":"normal","importance":3,"sourceMessageId":"legacy-empty","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}'::jsonb) $$,
  $$ values ('quarantined'::text) $$,
  'legacy pending receipt without a visible mutation is still not guessed'
);
select is((select count(*) from public.memories where content = '旧pending未適用'), 0::bigint, 'legacy pending without mutation is not replayed');

insert into public.memory_processing (user_id, source_message_id, state, attempted_at)
values ('00000000-0000-0000-0000-00000000000a', 'legacy-failed', 'failed', now() - interval '1 hour');
select results_eq(
  $$ select public.apply_memory_action_once('legacy-failed', '{"type":"add","candidate":{"kind":"shared","scope":"shared","content":"旧failed未確定","normalizedContent":"旧failed未確定","origin":"explicit","sensitivity":"normal","importance":3,"sourceMessageId":"legacy-failed","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}'::jsonb) $$,
  $$ values ('quarantined'::text) $$,
  'legacy failed receipt is quarantined because its commit is unknown'
);
select is((select count(*) from public.memories where content = '旧failed未確定'), 0::bigint, 'legacy failed receipt is not replayed');

select results_eq(
  $$ select public.claim_memory_processing('compat-stale') $$,
  $$ values ('claimed'::text) $$,
  'non-atomic compatibility claim is accepted once'
);
select is((select state from public.memory_processing where source_message_id = 'compat-stale'), 'pending', 'non-atomic compatibility claim starts pending');
select is((select processing_version from public.memory_processing where source_message_id = 'compat-stale'), 1::smallint, 'non-atomic compatibility claim stays legacy version one');
update public.memory_processing set attempted_at = now() - interval '6 minutes' where source_message_id = 'compat-stale';
select results_eq(
  $$ select public.apply_memory_action_once('compat-stale', '{"type":"add","candidate":{"kind":"shared","scope":"shared","content":"non-atomicでは追加しない","normalizedContent":"non-atomicでは追加しない","origin":"explicit","sensitivity":"normal","importance":3,"sourceMessageId":"compat-stale","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}'::jsonb) $$,
  $$ values ('quarantined'::text) $$,
  'stale non-atomic compatibility claim is quarantined instead of reclaimed'
);
select is((select count(*) from public.memories where content = 'non-atomicでは追加しない'), 0::bigint, 'stale non-atomic compatibility claim never mutates memory');

insert into public.memory_processing (user_id, source_message_id, state, attempted_at, processing_version)
values ('00000000-0000-0000-0000-00000000000a', 'atomic-stale', 'pending', now() - interval '6 minutes', 2);
select results_eq(
  $$ select public.apply_memory_action_once('atomic-stale', '{"type":"add","candidate":{"kind":"shared","scope":"shared","content":"v2期限切れ再試行","normalizedContent":"v2期限切れ再試行","origin":"explicit","sensitivity":"normal","importance":3,"sourceMessageId":"atomic-stale","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":true,"supersedesId":null}}'::jsonb) $$,
  $$ values ('applied'::text) $$,
  'stale version-two pending receipt is safely reclaimed'
);
select is((select state from public.memory_processing where source_message_id = 'atomic-stale'), 'completed', 'reclaimed version-two receipt completes with its mutation');

insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled)
values ('00000000-0000-0000-0000-00000000000b', true, true);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select is((select count(*) from public.memories), 0::bigint, 'another user cannot read memory records');
select is((select count(*) from public.memory_processing), 0::bigint, 'another user cannot read processing rows');
select is((select count(*) from public.memory_tombstones), 0::bigint, 'another user cannot read tombstones');
select is((select count(*) from public.memory_settings where user_id = '00000000-0000-0000-0000-00000000000a'), 0::bigint, 'another user cannot read the first user settings');
select ok(not has_function_privilege('authenticated', 'public.forget_memory(uuid,boolean)', 'execute'), 'another browser user cannot invoke forget RPC');
select ok(not has_function_privilege('authenticated', 'public.release_memory_tombstone(uuid)', 'execute'), 'another browser user cannot invoke release RPC');
select is((select automatic_memory_enabled from public.memory_settings), true, 'one user stopping memory does not stop another user');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select is((select automatic_memory_enabled from public.memory_settings), false, 'the first user stop remains independently persisted');

select * from finish();
rollback;
