begin;
create extension if not exists pgtap with schema extensions;
select plan(111);

select has_table('public', 'photo_requests', 'photo requests exist');
select has_table('public', 'photo_assets', 'photo assets exist');
select has_table('public', 'photo_deletion_outbox', 'photo deletion outbox exists');
select has_table('public', 'photo_storage_scan_cursors', 'photo scan cursors exist');

select ok(not has_table_privilege('authenticated', 'public.photo_requests', 'select'), 'browser cannot read receipts');
select ok(not has_table_privilege('authenticated', 'public.photo_assets', 'select'), 'browser cannot read photo assets');
select ok(not has_table_privilege('authenticated', 'public.photo_deletion_outbox', 'select'), 'browser cannot read deletion jobs');
select ok(not has_table_privilege('authenticated', 'public.photo_storage_scan_cursors', 'select'), 'browser cannot read scan cursors');

select is((select public from storage.buckets where id = 'yui-photo'), false, 'photo bucket is private');
select is((select file_size_limit from storage.buckets where id = 'yui-photo'), 5242880::bigint, 'photo bucket is five MiB');
select is((select allowed_mime_types from storage.buckets where id = 'yui-photo'), array['image/jpeg']::text[], 'photo bucket accepts JPEG only');
select is((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and (qual like '%yui-photo%' or with_check like '%yui-photo%')), 0::bigint, 'photo bucket has no browser storage policy');

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-0000000000b1', 'authenticated', 'authenticated', 'photo-a@yui.invalid', ''),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'photo-b@yui.invalid', '');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select throws_ok(
  $$ select public.claim_photo_request('00000000-0000-0000-0000-0000000000b2', '11111111-1111-4111-8111-111111111111', 'caption-a', 'jpeg-a', 'worker-a') $$,
  '42501', null, 'browser cannot claim another owner photo request'
);

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"m","type":"message","role":"owner","text":"x","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent"}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects invalid message roles');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"m","type":"message","role":"user","text":"x","createdAt":"2026-08-13T00:00:00.000Z","delivery":"done"}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects invalid delivery states');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"m","type":"message","role":"user","text":"x","createdAt":"2026-08-13T00:00:00Z","delivery":"sent"}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects noncanonical item timestamps');
select lives_ok($$ select public.assert_photo_snapshot(jsonb_build_object('timeline',jsonb_build_array(jsonb_build_object('id','m','type','message','role','user','text',E'allowed\ntext','createdAt','2026-08-13T00:00:00.000Z','delivery','sent')),'lastOpeningAt',null,'lastConversationAt',null,'version',3,'revision',0,'updatedAt','2026-08-13T00:00:00.000Z')) $$, 'ordinary message parser keeps control-bearing text for legacy compatibility');
select lives_ok($$ select public.assert_photo_snapshot(jsonb_build_object('timeline',jsonb_build_array(jsonb_build_object('id',repeat('m',201),'type','message','role','user','text','','createdAt','2026-08-13T00:00:00.000Z','delivery','sent')),'lastOpeningAt',null,'lastConversationAt',null,'version',3,'revision',0,'updatedAt','2026-08-13T00:00:00.000Z')) $$, 'ordinary message parser accepts long IDs and empty text like domain');
select lives_ok($$ select public.assert_photo_snapshot(jsonb_build_object('timeline',jsonb_build_array(jsonb_build_object('id','large','type','message','role','user','text',repeat('x',5000),'createdAt','2026-08-13T00:00:00.000Z','delivery','sent')),'lastOpeningAt',null,'lastConversationAt',null,'version',3,'revision',0,'updatedAt','2026-08-13T00:00:00.000Z')) $$, 'ordinary message parser adds no SQL-only text length cap');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"r:0","type":"message","role":"assistant","text":"x","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent","replyGroupId":"r","sequence":0,"origin":"photo_analysis"}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects incomplete photo lineage');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"wrong:0","type":"message","role":"assistant","text":"x","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent","replyGroupId":"r","sequence":0}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects inconsistent reply IDs');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"11111111-1111-4111-8111-111111111111","type":"photo","role":"user","photoId":"22222222-2222-4222-8222-222222222222","caption":"a","origin":"photo","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent"},{"id":"33333333-3333-4333-8333-333333333333","type":"photo","role":"user","photoId":"22222222-2222-4222-8222-222222222222","caption":"b","origin":"photo","createdAt":"2026-08-13T00:00:01.000Z","delivery":"sent"}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:01.000Z"}') $$, '22023', null, 'snapshot rejects duplicate photo IDs');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"11111111-1111-4111-8111-111111111111","type":"photo","role":"user","photoId":"22222222-2222-4222-8222-222222222222","caption":"a","origin":"photo","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent"}],"lastOpeningAt":null,"lastConversationAt":null,"version":2,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects photos before v3');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"m","type":"message","role":"user","text":"x","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent","secret":"no"}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects unknown nested fields');
select lives_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"s:0","type":"message","role":"assistant","text":"ok","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent","replyGroupId":"s","sequence":0,"search":{"status":"completed","searchedAt":"2026-08-13T00:00:00.000Z","sources":[{"title":"Source","url":"https://example.com/path"}]}}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, 'snapshot accepts a canonical credential-free HTTPS search URL');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"s:0","type":"message","role":"assistant","text":"ok","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent","replyGroupId":"s","sequence":0,"search":{"status":"completed","searchedAt":"2026-08-13T00:00:00.000Z","sources":[{"title":"Source","url":"https://user:pass@example.com/path"}]}}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects credential-bearing search URLs');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"s:0","type":"message","role":"assistant","text":"ok","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent","replyGroupId":"s","sequence":0,"search":{"status":"completed","searchedAt":"2026-08-13T00:00:00.000Z","sources":[{"title":"Source","url":"https://Example.com/path"}]}}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects a URL whose parsed canonical host differs');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"s:0","type":"message","role":"assistant","text":"ok","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent","replyGroupId":"s","sequence":0,"search":{"status":"completed","searchedAt":"2026-08-13T00:00:00.000Z","sources":[{"title":"One","url":"https://example.com/path"},{"title":"Two","url":"https://example.com/path"}]}}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects duplicate search URLs');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"s:0.5","type":"message","role":"assistant","text":"no","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent","replyGroupId":"s","sequence":0.5}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects fractional assistant sequence');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[],"lastOpeningAt":null,"lastConversationAt":null,"reviewedLocalDates":["2026-02-30"],"version":1,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'v1 snapshot rejects nonexistent reviewed dates');
select lives_ok($$ select public.assert_photo_snapshot('{"timeline":[],"lastOpeningAt":null,"lastConversationAt":null,"reviewedLocalDates":["2024-02-29"],"version":1,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, 'v1 snapshot accepts a canonical real leap date');
select throws_ok($$ select public.assert_photo_snapshot('{"timeline":[{"id":"s:0","type":"message","role":"assistant","text":"ok","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent","replyGroupId":"s","sequence":0,"search":{"status":"completed","searchedAt":"2026-08-13T00:00:00.000Z","sources":[{"title":"Source","url":"https://127.1/path"}]}}],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":0,"updatedAt":"2026-08-13T00:00:00.000Z"}') $$, '22023', null, 'snapshot rejects an IPv4 shorthand URL normalized by the domain URL parser');

select throws_ok(
  $$ select public.claim_photo_request('00000000-0000-0000-0000-0000000000b1', '0198a900-0000-7000-8000-000000000001', repeat('a',64), repeat('b',64), 'worker-a') $$,
  '22023', null, 'photo claims require UUIDv4 client IDs'
);
select throws_ok(
  $$ select public.claim_photo_request('00000000-0000-0000-0000-0000000000b1', '11111111-1111-4111-8111-111111111111', 'short', repeat('b',64), 'worker-a') $$,
  '22023', null, 'caption digest must be canonical SHA-256 hex'
);
select throws_ok(
  $$ select public.claim_photo_request('00000000-0000-0000-0000-0000000000b1', '11111111-1111-4111-8111-111111111111', repeat('A',64), repeat('b',64), 'worker-a') $$,
  '22023', null, 'uppercase digest is not canonical'
);
select lives_ok(
  $$ select public.claim_photo_request('00000000-0000-0000-0000-0000000000b1', '11111111-1111-4111-8111-111111111111', encode(digest('これ見て','sha256'),'hex'), repeat('b',64), 'worker-a') $$,
  'service claims a photo request'
);
select is((select count(*) from public.photo_requests), 1::bigint, 'one claim creates one request');
select lives_ok(
  $$ select public.claim_photo_request('00000000-0000-0000-0000-0000000000b1', '11111111-1111-4111-8111-111111111111', encode(digest('これ見て','sha256'),'hex'), repeat('b',64), 'worker-a') $$,
  'matching retry returns the durable request'
);
select is((select count(*) from public.photo_requests), 1::bigint, 'matching retry does not duplicate');
select throws_ok(
  $$ select public.claim_photo_request('00000000-0000-0000-0000-0000000000b1', '11111111-1111-4111-8111-111111111111', repeat('c',64), repeat('b',64), 'worker-a') $$,
  '22023', null, 'caption digest mismatch is rejected'
);
select throws_ok(
  $$ select public.claim_photo_request('00000000-0000-0000-0000-0000000000b1', '11111111-1111-4111-8111-111111111111', encode(digest('これ見て','sha256'),'hex'), repeat('c',64), 'worker-a') $$,
  '22023', null, 'JPEG digest mismatch is rejected'
);
select is((public.begin_photo_upload('00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111','worker-a')).request_state, 'uploading'::text, 'claim transitions to uploading under its lease');
select throws_ok(
  $$ select public.complete_photo_upload('00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111','worker-b','00000000-0000-0000-0000-0000000000b1/'||(select photo_id from public.photo_requests)::text||'.jpg',1000) $$,
  '42501', null, 'another worker cannot complete upload'
);
update public.photo_requests set lease_expires_at=now()-interval '1 second';
select lives_ok(
  $$ select public.claim_photo_request('00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111',encode(digest('これ見て','sha256'),'hex'),repeat('b',64),'worker-b') $$,
  'expired pre-dispatch upload lease is reclaimable'
);
select is((public.complete_photo_upload('00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111','worker-b','00000000-0000-0000-0000-0000000000b1/'||(select photo_id from public.photo_requests)::text||'.jpg',1000)).request_state, 'uploaded'::text, 'reclaimed upload completes once');
select is((select count(*) from public.photo_assets),1::bigint,'upload completion creates one durable asset');
select ok((select root_data_id=id and parent_data_ids='{}'::uuid[] and purpose='conversation' and storage_bucket='yui-photo' and content_type='image/jpeg' and byte_size=1000 and state='active' from public.photo_assets),'created asset has authoritative conversation metadata');
select lives_ok($$ select public.complete_photo_upload('00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111','worker-b','00000000-0000-0000-0000-0000000000b1/'||(select photo_id from public.photo_requests)::text||'.jpg',1000) $$,'matching upload completion retry is idempotent');
select is((select count(*) from public.photo_assets),1::bigint,'matching upload completion does not duplicate asset');
select throws_ok($$ select public.complete_photo_upload('00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111','worker-b','00000000-0000-0000-0000-0000000000b1/33333333-3333-4333-8333-333333333333.jpg',1000) $$,'22023',null,'upload completion rejects a non-authoritative storage path');
select throws_ok($$ select public.complete_photo_upload('00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111','worker-b','00000000-0000-0000-0000-0000000000b1/'||(select photo_id from public.photo_requests)::text||'.jpg',1001) $$,'22023',null,'upload completion rejects asset metadata mismatch');
select is(public.register_orphan_photo('00000000-0000-0000-0000-0000000000b1',(select photo_id from public.photo_requests),(select storage_path from public.photo_assets)),false,'atomic orphan registration preserves an existing request and asset in every state');
insert into public.photo_requests(owner_id,client_message_id,photo_id,caption_digest,jpeg_digest,request_state,analysis_state,lease_owner,lease_expires_at)
values('00000000-0000-0000-0000-0000000000b2','66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777',repeat('a',64),repeat('b',64),'analyzing','dispatched','analysis-orphan-check',now()+interval '120 seconds');
select is(public.register_orphan_photo('00000000-0000-0000-0000-0000000000b2','77777777-7777-4777-8777-777777777777','00000000-0000-0000-0000-0000000000b2/77777777-7777-4777-8777-777777777777.jpg'),false,'atomic orphan registration preserves an analyzing request even before an asset exists');
delete from public.photo_requests where owner_id='00000000-0000-0000-0000-0000000000b2' and photo_id='77777777-7777-4777-8777-777777777777';
insert into public.photo_assets(id,owner_id,root_data_id,parent_data_ids,purpose,storage_bucket,storage_path,content_type,byte_size,state)
values('77777777-7777-4777-8777-777777777777','00000000-0000-0000-0000-0000000000b2','77777777-7777-4777-8777-777777777777','{}','conversation','yui-photo','00000000-0000-0000-0000-0000000000b2/77777777-7777-4777-8777-777777777777.jpg','image/jpeg',1,'active');
select is(public.register_orphan_photo('00000000-0000-0000-0000-0000000000b2','77777777-7777-4777-8777-777777777777','00000000-0000-0000-0000-0000000000b2/77777777-7777-4777-8777-777777777777.jpg'),false,'atomic orphan registration preserves an asset even without a request');
delete from public.photo_assets where owner_id='00000000-0000-0000-0000-0000000000b2' and id='77777777-7777-4777-8777-777777777777';
delete from public.photo_deletion_outbox where owner_id='00000000-0000-0000-0000-0000000000b2' and photo_id='77777777-7777-4777-8777-777777777777';
select is(public.register_orphan_photo('00000000-0000-0000-0000-0000000000b1','44444444-4444-4444-8444-444444444444','00000000-0000-0000-0000-0000000000b1/44444444-4444-4444-8444-444444444444.jpg'),true,'atomic orphan registration inserts only an unreferenced owner path');
select throws_ok($$ select public.register_orphan_photo('00000000-0000-0000-0000-0000000000b1','55555555-5555-4555-8555-555555555555','00000000-0000-0000-0000-0000000000b2/55555555-5555-4555-8555-555555555555.jpg') $$,'22023',null,'atomic orphan registration rejects a foreign path');
delete from public.photo_deletion_outbox where photo_id='44444444-4444-4444-8444-444444444444';
select lives_ok(
  $$ select public.claim_photo_analysis('00000000-0000-0000-0000-0000000000b1', '11111111-1111-4111-8111-111111111111', 'analysis-a') $$,
  'one worker dispatches analysis'
);
select is((select analysis_state from public.photo_requests), 'dispatched'::text, 'analysis is durably dispatched');
select throws_ok(
  $$ select public.claim_photo_analysis('00000000-0000-0000-0000-0000000000b1', '11111111-1111-4111-8111-111111111111', 'analysis-b') $$,
  '55000', null, 'second worker cannot redispatch'
);
update public.photo_requests set lease_expires_at = now() - interval '1 second';
select lives_ok(
  $$ select public.claim_photo_analysis('00000000-0000-0000-0000-0000000000b1', '11111111-1111-4111-8111-111111111111', 'analysis-b') $$,
  'expired dispatch closes as ambiguous without redispatch'
);
select is((select analysis_state from public.photo_requests), 'ambiguous'::text, 'expired dispatch becomes ambiguous');

insert into public.photo_requests(owner_id,client_message_id,photo_id,caption_digest,jpeg_digest,request_state,analysis_state,lease_owner,lease_expires_at)
values('00000000-0000-0000-0000-0000000000b2','88888888-8888-4888-8888-888888888888','99999999-9999-4999-8999-999999999999',repeat('a',64),repeat('b',64),'analyzing','dispatched','analysis-x',now()+interval '120 seconds');
select throws_ok($$ select public.complete_photo_analysis('00000000-0000-0000-0000-0000000000b2','88888888-8888-4888-8888-888888888888','analysis-x','{"bubbles":["unsafe"]}'::jsonb,'{}'::jsonb) $$, '22023', null, 'analysis completion rejects a receipt without authoritative metadata');
select lives_ok($$ select public.complete_photo_analysis('00000000-0000-0000-0000-0000000000b2','88888888-8888-4888-8888-888888888888','analysis-x','{"photo":{"id":"88888888-8888-4888-8888-888888888888","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent"},"replyGroupId":"receipt","bubbles":[{"id":"receipt:0","text":"ok","createdAt":"2026-08-13T00:00:01.000Z","sequence":0,"delivery":"sent","origin":"photo_analysis","sourcePhotoMessageId":"88888888-8888-4888-8888-888888888888"}]}'::jsonb,'{}'::jsonb) $$, 'analysis completion accepts the complete authoritative receipt');
delete from public.photo_requests where owner_id='00000000-0000-0000-0000-0000000000b2' and client_message_id='88888888-8888-4888-8888-888888888888';

update public.photo_requests set request_state='succeeded', analysis_state='succeeded', receipt='{"photo":{"id":"11111111-1111-4111-8111-111111111111","createdAt":"2026-08-13T00:00:00.000Z","delivery":"sent"},"replyGroupId":"reply","bubbles":[{"id":"reply:0","text":"きれいだね","createdAt":"2026-08-13T00:00:01.000Z","sequence":0,"delivery":"sent","origin":"photo_analysis","sourcePhotoMessageId":"11111111-1111-4111-8111-111111111111"}]}'::jsonb, usage='{"input":1}'::jsonb, lease_owner=null, lease_expires_at=null;
select is((public.get_active_photo('00000000-0000-0000-0000-0000000000b1',(select photo_id from public.photo_requests))).storage_path,(select storage_path from public.photo_assets),'active content lookup returns only the bound owner asset');
select ok(public.get_active_photo('00000000-0000-0000-0000-0000000000b2',(select photo_id from public.photo_requests)) is null,'active content lookup hides another owner asset');
select throws_ok(
  $$ insert into public.photo_assets (id,owner_id,root_data_id,parent_data_ids,purpose,storage_bucket,storage_path,content_type,byte_size,state)
     select photo_id,owner_id,photo_id,array[]::uuid[],'conversation','yui-photo','duplicate.jpg','image/jpeg',1,'active' from public.photo_requests $$,
  '23505', null, 'one request photo ID is owner-unique'
);

select throws_ok($$
  select public.commit_photo_exchange(
    '00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111',0,
    jsonb_build_object('timeline',jsonb_build_array(
      jsonb_build_object('id','unrelated','type','message','role','user','text','混入','createdAt','2026-08-13T00:00:00.000Z','delivery','sent'),
      jsonb_build_object('id','11111111-1111-4111-8111-111111111111','type','photo','role','user','photoId',(select photo_id from public.photo_requests)::text,'caption','これ見て','origin','photo','createdAt','2026-08-13T00:00:00.000Z','delivery','sent'),
      jsonb_build_object('id','reply:0','type','message','role','assistant','text','きれいだね','createdAt','2026-08-13T00:00:01.000Z','delivery','sent','replyGroupId','reply','sequence',0,'origin','photo_analysis','sourcePhotoMessageId','11111111-1111-4111-8111-111111111111')
    ),'lastOpeningAt',null,'lastConversationAt','2026-08-13T00:00:01.000Z','version',3,'revision',1,'updatedAt','2026-08-13T00:00:01.000Z'))
$$, '22023', null, 'photo commit cannot add unrelated timeline content');
select throws_ok($$
  select public.commit_photo_exchange(
    '00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111',0,
    jsonb_build_object('timeline',jsonb_build_array(
      jsonb_build_object('id','77777777-7777-4777-8777-777777777777','type','photo','role','user','photoId',(select photo_id from public.photo_requests)::text,'caption','これ見て','origin','photo','createdAt','2026-08-13T00:00:00.000Z','delivery','sent'),
      jsonb_build_object('id','reply:0','type','message','role','assistant','text','きれいだね','createdAt','2026-08-13T00:00:01.000Z','delivery','sent','replyGroupId','reply','sequence',0,'origin','photo_analysis','sourcePhotoMessageId','77777777-7777-4777-8777-777777777777')
    ),'lastOpeningAt',null,'lastConversationAt','2026-08-13T00:00:01.000Z','version',3,'revision',1,'updatedAt','2026-08-13T00:00:01.000Z'))
$$, '22023', null, 'photo message ID must equal durable client message ID');

select throws_ok($$
  select public.commit_photo_exchange(
    '00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111',0,
    jsonb_build_object('timeline',jsonb_build_array(
      jsonb_build_object('id','11111111-1111-4111-8111-111111111111','type','photo','role','user','photoId',(select photo_id from public.photo_requests)::text,'caption','これ見て','origin','photo','createdAt','2026-08-13T00:00:00.001Z','delivery','sent'),
      jsonb_build_object('id','reply:0','type','message','role','assistant','text','きれいだね','createdAt','2026-08-13T00:00:01.000Z','delivery','sent','replyGroupId','reply','sequence',0,'origin','photo_analysis','sourcePhotoMessageId','11111111-1111-4111-8111-111111111111')
    ),'lastOpeningAt',null,'lastConversationAt','2026-08-13T00:00:01.000Z','version',3,'revision',1,'updatedAt','2026-08-13T00:00:01.000Z'))
$$, '22023', null, 'photo commit rejects tampered photo timestamp');
select throws_ok($$
  select public.commit_photo_exchange(
    '00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111',0,
    jsonb_build_object('timeline',jsonb_build_array(
      jsonb_build_object('id','11111111-1111-4111-8111-111111111111','type','photo','role','user','photoId',(select photo_id from public.photo_requests)::text,'caption','これ見て','origin','photo','createdAt','2026-08-13T00:00:00.000Z','delivery','sent'),
      jsonb_build_object('id','reply:0','type','message','role','assistant','text','きれいだね','createdAt','2026-08-13T00:00:01.001Z','delivery','sent','replyGroupId','reply','sequence',0,'origin','photo_analysis','sourcePhotoMessageId','11111111-1111-4111-8111-111111111111')
    ),'lastOpeningAt',null,'lastConversationAt','2026-08-13T00:00:01.001Z','version',3,'revision',1,'updatedAt','2026-08-13T00:00:01.001Z'))
$$, '22023', null, 'photo commit rejects tampered reply metadata');

select lives_ok($$
  select public.commit_photo_exchange(
    '00000000-0000-0000-0000-0000000000b1',
    '11111111-1111-4111-8111-111111111111',
    0,
    jsonb_build_object(
      'timeline', jsonb_build_array(
        jsonb_build_object('id','11111111-1111-4111-8111-111111111111','type','photo','role','user','photoId',(select photo_id from public.photo_requests)::text,'caption','これ見て','origin','photo','createdAt','2026-08-13T00:00:00.000Z','delivery','sent'),
        jsonb_build_object('id','reply:0','type','message','role','assistant','text','きれいだね','createdAt','2026-08-13T00:00:01.000Z','delivery','sent','replyGroupId','reply','sequence',0,'origin','photo_analysis','sourcePhotoMessageId','11111111-1111-4111-8111-111111111111')
      ), 'lastOpeningAt',null,'lastConversationAt','2026-08-13T00:00:01.000Z','version',3,'revision',1,'updatedAt','2026-08-13T00:00:01.000Z'
    )
  )
$$, 'successful receipt commits a v3 exchange');
select is((select version from public.chat_snapshots), 3, 'committed snapshot is v3');
select is((select attached_message_id from public.photo_assets), '11111111-1111-4111-8111-111111111111'::uuid, 'asset attaches to photo message');
select throws_ok(
  $$ insert into public.photo_assets(id,owner_id,root_data_id,parent_data_ids,purpose,storage_bucket,storage_path,content_type,byte_size,state,attached_message_id)
     values('66666666-6666-4666-8666-666666666666','00000000-0000-0000-0000-0000000000b1','66666666-6666-4666-8666-666666666666','{}','conversation','yui-photo','second.jpg','image/jpeg',1,'active','11111111-1111-4111-8111-111111111111') $$,
  '23505', null, 'one photo message cannot attach to two live assets'
);

select throws_ok($$
  select public.commit_photo_exchange(
    '00000000-0000-0000-0000-0000000000b1','11111111-1111-4111-8111-111111111111',1,
    jsonb_set((select snapshot from public.chat_snapshots),'{timeline}',
      (select jsonb_agg(value) from (
        select value from jsonb_array_elements((select snapshot->'timeline' from public.chat_snapshots))
        union all select '{"id":"unrelated","type":"message","role":"user","text":"混入","createdAt":"2026-08-13T00:00:02.000Z","delivery":"sent"}'::jsonb
      ) x))
  )
$$, '40001', null, 'a completed photo request cannot be committed again at a stale revision');

select throws_ok($$
  select public.save_chat_snapshot_reconciled('00000000-0000-0000-0000-0000000000b1', 1,
    '{"timeline":[],"lastOpeningAt":null,"lastConversationAt":null,"version":3,"revision":2,"updatedAt":"2026-08-13T00:00:02.000Z"}'::jsonb)
$$, '22023', null, 'generic snapshot save cannot remove a photo');
select lives_ok($$
  select public.save_chat_snapshot_reconciled('00000000-0000-0000-0000-0000000000b1', 1,
    jsonb_set((select snapshot from public.chat_snapshots), '{revision}', '2'::jsonb))
$$, 'later text save preserves the photo reference set');

select throws_ok($$
  select public.delete_photo_message('00000000-0000-0000-0000-0000000000b1',(select photo_id from public.photo_requests),2,
    jsonb_build_object('timeline',jsonb_build_array(
      jsonb_build_object('id','reply:0','type','message','role','assistant','text','改ざん','createdAt','2026-08-13T00:00:01.000Z','delivery','sent','replyGroupId','reply','sequence',0,'origin','photo_analysis','sourcePhotoMessageId','11111111-1111-4111-8111-111111111111')
    ),'lastOpeningAt',null,'lastConversationAt','2026-08-13T00:00:01.000Z','version',3,'revision',3,'updatedAt','2026-08-13T00:00:03.000Z'))
$$, '22023', null, 'photo delete cannot alter the retained reply');

select lives_ok($$
  select public.delete_photo_message('00000000-0000-0000-0000-0000000000b1', (select photo_id from public.photo_requests), 2,
    jsonb_build_object('timeline', jsonb_build_array(
      jsonb_build_object('id','reply:0','type','message','role','assistant','text','きれいだね','createdAt','2026-08-13T00:00:01.000Z','delivery','sent','replyGroupId','reply','sequence',0,'origin','photo_analysis','sourcePhotoMessageId','11111111-1111-4111-8111-111111111111')
    ),'lastOpeningAt',null,'lastConversationAt','2026-08-13T00:00:01.000Z','version',3,'revision',3,'updatedAt','2026-08-13T00:00:03.000Z'))
$$, 'dedicated delete removes only the photo item');
select is((select jsonb_array_length(snapshot->'timeline') from public.chat_snapshots), 1, 'visible analysis reply remains');
select ok((select caption is null and caption_digest is null and jpeg_digest is null and receipt is null and usage is null and lease_owner is null and lease_expires_at is null from public.photo_requests), 'sensitive duplicate request fields are scrubbed');
select is((select analysis_state from public.photo_requests), 'scrubbed'::text, 'analysis state is scrubbed');
select is((select deletion_state from public.photo_requests), 'blocked_from_use'::text, 'request is blocked from use');
select is((select state from public.photo_deletion_outbox), 'requested'::text, 'deletion outbox is created');

select is((select count(*) from public.claim_photo_cleanup_batch('cleanup-a', 50, 120000)), 1::bigint, 'first cleanup worker claims the job');
select is((select count(*) from public.claim_photo_cleanup_batch('cleanup-b', 50, 120000)), 0::bigint, 'second cleanup worker cannot claim the live lease');
select throws_ok($$ select public.complete_photo_delete((select id from public.photo_deletion_outbox), 'cleanup-b', false) $$, '42501', null, 'wrong lease cannot complete delete');
select lives_ok($$ select public.complete_photo_delete((select id from public.photo_deletion_outbox), 'cleanup-a', false) $$, 'remove completion records deleted');
select is((select state from public.photo_deletion_outbox), 'deleted'::text, 'job is deleted before read-back');
select ok((select deleted_at is not null and verified_at is null from public.photo_deletion_outbox), 'deleted and verified timestamps are distinct');
select ok((select next_attempt_at between now()+interval '59 seconds' and now()+interval '61 seconds' from public.photo_deletion_outbox), 'first incomplete verification retries after one minute');
update public.photo_deletion_outbox set next_attempt_at=now();
select is((select count(*) from public.claim_photo_cleanup_batch('cleanup-backoff-2',50,120000)),1::bigint,'second cleanup attempt becomes claimable at its boundary');
select lives_ok($$ select public.complete_photo_delete((select id from public.photo_deletion_outbox),'cleanup-backoff-2',false) $$,'second incomplete verification remains retryable');
select ok((select next_attempt_at between now()+interval '119 seconds' and now()+interval '121 seconds' from public.photo_deletion_outbox), 'second incomplete verification retries after two minutes');
update public.photo_deletion_outbox set next_attempt_at=now();
do $$ begin
  perform * from public.claim_photo_cleanup_batch('cleanup-backoff-4',50,120000);
  perform public.complete_photo_delete((select id from public.photo_deletion_outbox),'cleanup-backoff-4',false);
end $$;
select ok((select next_attempt_at between now()+interval '239 seconds' and now()+interval '241 seconds' from public.photo_deletion_outbox), 'third incomplete verification retries after four minutes');
update public.photo_deletion_outbox set next_attempt_at=now();
do $$ begin
  perform * from public.claim_photo_cleanup_batch('cleanup-backoff-8',50,120000);
  perform public.complete_photo_delete((select id from public.photo_deletion_outbox),'cleanup-backoff-8',false);
end $$;
select ok((select next_attempt_at between now()+interval '479 seconds' and now()+interval '481 seconds' from public.photo_deletion_outbox), 'fourth incomplete verification retries after eight minutes');
update public.photo_deletion_outbox set next_attempt_at=now();
do $$ begin
  perform * from public.claim_photo_cleanup_batch('cleanup-backoff-cap',50,120000);
  perform public.complete_photo_delete((select id from public.photo_deletion_outbox),'cleanup-backoff-cap',false);
end $$;
select ok((select next_attempt_at between now()+interval '479 seconds' and now()+interval '481 seconds' from public.photo_deletion_outbox), 'later incomplete verification stays capped at eight minutes');
update public.photo_deletion_outbox set next_attempt_at=now();
select is((select count(*) from public.claim_photo_cleanup_batch('cleanup-c',50,120000) where state='deleted'), 1::bigint, 'deleted job is reclaimable after remove crash');
select lives_ok($$ select public.complete_photo_delete((select id from public.photo_deletion_outbox), 'cleanup-c', true) $$, 'reclaimed deleted job verifies absence without another remove');
select is((select state from public.photo_deletion_outbox), 'verified'::text, 'job reaches verified only after absence');
select ok((select r.verified_at = a.verified_at and a.verified_at = o.verified_at
  from public.photo_requests r
  join public.photo_assets a on a.owner_id=r.owner_id and a.id=r.photo_id
  join public.photo_deletion_outbox o on o.owner_id=r.owner_id and o.photo_id=r.photo_id), 'request asset and outbox share verified time');

select lives_ok($$ select public.save_photo_scan_cursor('00000000-0000-0000-0000-0000000000b1','opaque==') $$, 'owner scan cursor is saved');
select is(public.get_photo_scan_cursor('00000000-0000-0000-0000-0000000000b1'), 'opaque=='::text, 'opaque scan cursor round-trips');
select is(public.get_photo_scan_cursor('00000000-0000-0000-0000-0000000000b2'), null, 'scan cursor is owner separated');
select lives_ok($$ select public.save_photo_scan_cursor('00000000-0000-0000-0000-0000000000b1',null) $$, 'null cursor records wrap');
select is(public.get_photo_scan_cursor('00000000-0000-0000-0000-0000000000b1'), null, 'null cursor round-trips');

insert into public.photo_requests(owner_id,client_message_id,photo_id,caption,caption_digest,jpeg_digest,request_state,analysis_state)
values('00000000-0000-0000-0000-0000000000b2','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','消える写真',repeat('c',64),repeat('d',64),'succeeded','succeeded');
insert into public.photo_assets(id,owner_id,root_data_id,parent_data_ids,purpose,storage_bucket,storage_path,content_type,byte_size,state)
values('55555555-5555-4555-8555-555555555555','00000000-0000-0000-0000-0000000000b2','55555555-5555-4555-8555-555555555555','{}','conversation','yui-photo','00000000-0000-0000-0000-0000000000b2/55555555-5555-4555-8555-555555555555.jpg','image/jpeg',10,'active');
reset role;
select lives_ok($$ delete from auth.users where id='00000000-0000-0000-0000-0000000000b2' $$, 'account cascade creates a standalone deletion job');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is((select state from public.photo_deletion_outbox where photo_id='55555555-5555-4555-8555-555555555555'), 'requested'::text, 'account deletion job survives owner and asset cascade');
select is((select count(*) from public.claim_photo_cleanup_batch('account-cleanup',50,120000) where photo_id='55555555-5555-4555-8555-555555555555'), 1::bigint, 'standalone account job remains claimable');
select lives_ok($$ select public.complete_photo_delete((select id from public.photo_deletion_outbox where photo_id='55555555-5555-4555-8555-555555555555'),'account-cleanup',false) $$, 'account job records Storage removal');
update public.photo_deletion_outbox set next_attempt_at=now() where photo_id='55555555-5555-4555-8555-555555555555';
do $$ begin perform * from public.claim_photo_cleanup_batch('account-verify',50,120000) where photo_id='55555555-5555-4555-8555-555555555555'; end $$;
select lives_ok($$ select public.complete_photo_delete((select id from public.photo_deletion_outbox where photo_id='55555555-5555-4555-8555-555555555555'),'account-verify',true) $$, 'account job verifies absence after cascade under the new lease');

select * from finish();
rollback;
