begin;
select plan(62);

select has_table('public', 'automatic_memory_processing', 'automatic receipts use a separate table');
select ok((select relrowsecurity from pg_catalog.pg_class where oid = 'public.automatic_memory_processing'::regclass), 'automatic receipts use RLS');
select has_table('public', 'automatic_memory_actions', 'automatic action receipts use a separate table');
select ok((select relrowsecurity from pg_catalog.pg_class where oid = 'public.automatic_memory_actions'::regclass), 'automatic action receipts use RLS');
select has_table('public', 'automatic_memory_outbox', 'retryable action plans use a governed outbox');
select ok((select relrowsecurity from pg_catalog.pg_class where oid = 'public.automatic_memory_outbox'::regclass), 'automatic outbox uses RLS');
select is(
  (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'automatic_memory_processing' and column_name = 'outbox_ref'),
  'YES',
  'receipt carries only an optional opaque outbox reference'
);
select hasnt_column('public', 'automatic_memory_processing', 'action_plan', 'receipt cannot persist memory content');
select has_table('public', 'automatic_memory_extraction_attempts', 'provider attempts use content-free receipts');
select ok((select relrowsecurity from pg_catalog.pg_class where oid = 'public.automatic_memory_extraction_attempts'::regclass), 'provider attempt receipts use RLS');

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'automatic-owner@yui.invalid', ''),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'automatic-other@yui.invalid', '');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);

select is(
  public.claim_automatic_memory_processing('message-1'),
  '{"state":"claimed","appliedCount":0,"retry":false}'::jsonb,
  'first delivery owns processing'
);
select is(
  public.claim_automatic_memory_processing('message-1'),
  '{"state":"pending","appliedCount":0,"retry":false}'::jsonb,
  'concurrent delivery observes pending work'
);
select is(
  public.prepare_automatic_memory_attempt('message-1'),
  '{"attemptIndex":1,"state":"prepared"}'::jsonb,
  'an attempt receipt exists before provider dispatch'
);
select lives_ok(
  $$select public.set_automatic_memory_attempt_state('message-1', 1, 'dispatched')$$,
  'the content-free attempt is marked dispatched before the provider call'
);
select is(
  public.save_automatic_memory_outbox(
    'message-1',
    '[{"type":"add"}]'::jsonb,
    '{"startedAt":"2026-08-11T00:00:00Z","endedAt":"2026-08-11T00:00:01Z","memoryInputTokens":10,"memoryCachedInputTokens":0,"memoryCacheWriteTokens":0,"memoryOutputTokens":2}'::jsonb,
    1
  )->'actions',
  '[{"type":"add"}]'::jsonb,
  'validated plan and numeric usage are stored durably outside the receipt'
);
select is(
  public.save_automatic_memory_outbox('message-1', '[{"type":"forget"}]'::jsonb, null, 1)->'actions',
  '[{"type":"add"}]'::jsonb,
  'a retry cannot replace the original outbox plan'
);
select ok(
  pg_catalog.strpos((select pg_catalog.to_jsonb(receipt)::text from public.automatic_memory_processing receipt where source_message_id = 'message-1'), '紅茶') = 0,
  'the authenticated receipt projection contains no memory text'
);
select is(public.get_automatic_memory_outbox('message-1')->>'usageSettled', 'false', 'outbox usage starts unsettled');
select public.mark_automatic_memory_usage_settled('message-1');
select is(public.get_automatic_memory_outbox('message-1')->>'usageSettled', 'true', 'usage settlement is resumable and durable');
select lives_ok(
  $$select public.set_automatic_memory_attempt_state('message-1', 1, 'settled')$$,
  'a successful dispatched attempt becomes settled'
);
select is(public.get_latest_automatic_memory_attempt('message-1')->>'state', 'settled', 'settled attempt metadata survives completion');
select is(
  public.apply_automatic_memory_action_once(
    'message-1',
    0::smallint,
    '{"type":"add","candidate":{"kind":"preference","scope":"daily","content":"朝は紅茶が好き","normalizedContent":"朝は紅茶が好き","origin":"extracted","sensitivity":"normal","importance":3,"sourceMessageId":"message-1","sourceOccurredAt":"2026-08-11T00:00:00.000Z","validFrom":null,"validUntil":null,"expiresAt":null,"pinned":false,"supersedesId":null}}'::jsonb
  ),
  'applied'::text,
  'automatic mutation and its dedicated receipt commit atomically'
);
select is(
  public.apply_automatic_memory_action_once(
    'message-1',
    0::smallint,
    '{"type":"add","candidate":{"kind":"preference","scope":"daily","content":"別の内容へ変えない","normalizedContent":"別の内容へ変えない","origin":"extracted","sensitivity":"normal","importance":3,"sourceMessageId":"message-1","sourceOccurredAt":"2026-08-11T00:00:00.000Z","validFrom":null,"validUntil":null,"expiresAt":null,"pinned":false,"supersedesId":null}}'::jsonb
  ),
  'completed'::text,
  'automatic action retry cannot substitute another mutation'
);
select is((select count(*) from public.memories where content = '朝は紅茶が好き'), 1::bigint, 'automatic action is stored exactly once');
select is(
  public.finish_automatic_memory_processing('message-1', 'completed', 2::smallint),
  '{"state":"completed","appliedCount":2}'::jsonb,
  'completion persists the applied count'
);
select is(
  public.get_automatic_memory_outbox('message-1'),
  null::jsonb,
  'completion deletes the temporary outbox'
);
select is(
  public.claim_automatic_memory_processing('message-1'),
  '{"state":"completed","appliedCount":2,"retry":false}'::jsonb,
  'response loss returns the original completed receipt'
);
select is(
  public.finish_automatic_memory_processing('message-1', 'failed', 0::smallint),
  '{"state":"completed","appliedCount":2}'::jsonb,
  'a lost completion response cannot downgrade durable completion'
);

select is(
  public.claim_automatic_memory_processing('message-2'),
  '{"state":"claimed","appliedCount":0,"retry":false}'::jsonb,
  'another source can start'
);
select public.finish_automatic_memory_processing('message-2', 'failed', 1::smallint);
select is(
  public.claim_automatic_memory_processing('message-2'),
  '{"state":"claimed","appliedCount":1,"retry":true}'::jsonb,
  'failed work can retry without losing partial count'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select is((select count(*) from public.automatic_memory_processing), 0::bigint, 'another user cannot read receipts');
select is((select count(*) from public.automatic_memory_actions), 0::bigint, 'another user cannot read action receipts');
select ok(not has_function_privilege('authenticated', 'public.get_automatic_memory_outbox(text)', 'execute'), 'another user cannot fetch an outbox through a browser RPC');

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select is(
  public.claim_automatic_memory_processing('message-3'),
  '{"state":"claimed","appliedCount":0,"retry":false}'::jsonb,
  'a disposable source can start'
);
select public.prepare_automatic_memory_attempt('message-3');
select public.set_automatic_memory_attempt_state('message-3', 1, 'dispatched');
select lives_ok(
  $$select public.save_automatic_memory_outbox('message-3', '[]'::jsonb, null, 1)$$,
  'a disposable outbox can be stored'
);
select lives_ok(
  $$select public.finish_automatic_memory_processing('message-3', 'failed', 0::smallint)$$,
  'failed work retains an explicitly governed outbox'
);
select lives_ok(
  $$select public.clear_automatic_memory_outbox('message-3')$$,
  'failed outbox can be explicitly cleared'
);
select is(public.get_automatic_memory_outbox('message-3'), null::jsonb, 'explicit clear removes the pending content');

select is(
  public.claim_automatic_memory_processing('message-paused')->>'state',
  'claimed',
  'a source can be claimed before another tab pauses automatic memory'
);
insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled)
values ('00000000-0000-0000-0000-00000000000a', false, true)
on conflict (user_id) do update set automatic_memory_enabled = false;
select is(
  public.apply_automatic_memory_action_once(
    'message-paused',
    0::smallint,
    '{"type":"add","candidate":{"kind":"preference","scope":"daily","content":"停止後は覚えない","normalizedContent":"停止後は覚えない","origin":"extracted","sensitivity":"normal","importance":3,"sourceMessageId":"message-paused","sourceOccurredAt":null,"validFrom":null,"validUntil":null,"expiresAt":null,"pinned":false,"supersedesId":null}}'::jsonb
  ),
  'disabled'::text,
  'the atomic mutation gate observes the persisted OFF setting'
);
select is((select count(*) from public.memories where content = '停止後は覚えない'), 0::bigint, 'paused atomic work stores no memory');

select is(
  public.claim_automatic_memory_processing('voice:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')->>'state',
  'claimed',
  'a voice source can be claimed before another tab pauses telephone memory'
);
update public.memory_settings
set automatic_memory_enabled = true, voice_memory_enabled = false
where user_id = (select auth.uid());
select is(
  public.apply_automatic_memory_action_once(
    'voice:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    0::smallint,
    '{"type":"add","candidate":{"kind":"preference","scope":"daily","content":"電話停止後は覚えない","normalizedContent":"電話停止後は覚えない","origin":"voice","sensitivity":"normal","importance":3,"sourceMessageId":"voice:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceOccurredAt":"2026-08-12T00:00:00.000Z","validFrom":null,"validUntil":null,"expiresAt":null,"pinned":false,"supersedesId":null}}'::jsonb
  ),
  'disabled'::text,
  'the atomic mutation gate observes telephone memory OFF independently'
);
select is((select count(*) from public.memories where content = '電話停止後は覚えない'), 0::bigint, 'paused telephone work stores no memory');
select public.finish_automatic_memory_processing('voice:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'failed', 0::smallint);

-- Exercise the retained legacy voice gate directly; public PATCH now accepts only memory_enabled.
update public.memory_settings set voice_memory_enabled = false where user_id = (select auth.uid());
select is(
  public.claim_automatic_memory_processing('voice:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  '{"state":"disabled","appliedCount":0,"retry":false}'::jsonb,
  'telephone OFF atomically refuses a claim'
);
select is((select count(*) from public.automatic_memory_processing where source_message_id like 'voice:b%'), 0::bigint, 'disabled claim creates no receipt');
-- Exercise the retained legacy voice gate directly; public PATCH now accepts only memory_enabled.
update public.memory_settings set voice_memory_enabled = true where user_id = (select auth.uid());
select is(
  public.claim_automatic_memory_processing('voice:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')->>'state',
  'claimed',
  'telephone ON can own a durable lease'
);
select public.prepare_automatic_memory_attempt('voice:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
select public.set_automatic_memory_attempt_state('voice:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1, 'dispatched');
select lives_ok(
  $$select public.save_automatic_memory_outbox('voice:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', '[{"type":"add"}]'::jsonb, null, 1)$$,
  'a crash-stale voice plan exists only in the governed outbox'
);
select ok(public.has_active_voice_memory_processing(pg_catalog.now() - interval '5 minutes'), 'fresh voice lease is active');
select is(public.cleanup_stale_voice_memory_processing(pg_catalog.now() + interval '1 second'), 1, 'TTL cleanup marks the stale voice lease failed');
select is(public.get_automatic_memory_outbox('voice:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'), null::jsonb, 'TTL cleanup deletes the voice plan');
select results_eq(
  $$select state, outbox_ref from public.automatic_memory_processing where source_message_id = 'voice:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'$$,
  $$values ('failed'::text, null::uuid)$$,
  'TTL cleanup retains only a content-free failed receipt'
);
select ok(not public.has_active_voice_memory_processing(pg_catalog.now() - interval '5 minutes'), 'cleaned voice lease is inactive');

select is(
  public.claim_automatic_memory_processing('voice:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')->>'state',
  'claimed',
  'an atomic-failure voice source can start'
);
select public.prepare_automatic_memory_attempt('voice:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
select public.set_automatic_memory_attempt_state('voice:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 1, 'dispatched');
select public.save_automatic_memory_outbox('voice:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', '[{"type":"add"}]'::jsonb, null, 1);
select is(
  public.fail_voice_automatic_memory_processing('voice:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 0::smallint),
  '{"state":"failed","appliedCount":0}'::jsonb,
  'voice failure atomically marks the receipt and clears its plan'
);
select is(public.get_automatic_memory_outbox('voice:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'), null::jsonb, 'atomic voice failure leaves no outbox');
select results_eq(
  $$select state, outbox_ref from public.automatic_memory_processing where source_message_id = 'voice:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'$$,
  $$values ('failed'::text, null::uuid)$$,
  'atomic voice failure retains only a content-free failed receipt'
);

select public.claim_automatic_memory_processing('voice:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
select public.prepare_automatic_memory_attempt('voice:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
select public.set_automatic_memory_attempt_state('voice:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 1, 'dispatched');
select public.save_automatic_memory_outbox('voice:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '[{"type":"add"}]'::jsonb, null, 1);
select lives_ok(
  $$select public.finish_automatic_memory_processing('voice:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'failed', 0::smallint)$$,
  'a split legacy failure can leave a failed receipt with an outbox'
);
select isnt(public.get_automatic_memory_outbox('voice:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), null::jsonb, 'age guard retains a fresh split-failed plan');
select is(public.cleanup_stale_voice_memory_processing(pg_catalog.now() - interval '5 minutes'), 0, 'sweeper does not delete a fresh failed plan');
reset role;
update public.automatic_memory_processing set attempted_at = pg_catalog.now() - interval '10 minutes'
where user_id = '00000000-0000-0000-0000-00000000000a' and source_message_id = 'voice:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select is(public.cleanup_stale_voice_memory_processing(pg_catalog.now() - interval '5 minutes'), 1, 'sweeper deletes an old split-failed plan');
select is(public.get_automatic_memory_outbox('voice:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), null::jsonb, 'sweeper leaves no old failed plan');

select * from finish();
rollback;
