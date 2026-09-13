begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(13);

create function pg_temp.search_snapshot(search_override jsonb default null) returns jsonb
language sql as $$
  select jsonb_build_object('version',3,'revision',1,'updatedAt','2026-09-12T00:00:00.000Z',
    'lastOpeningAt',null,'lastConversationAt',null,'timeline',jsonb_build_array(jsonb_build_object(
      'id','search-reply:0','type','message','role','assistant','text','検索結果です。',
      'createdAt','2026-09-12T00:00:00.000Z','delivery','sent','replyGroupId','search-reply','sequence',0,
      'search',coalesce(search_override,'{"status":"completed","searchedAt":"2026-09-12T00:00:00.000Z","sources":[{"title":"Example","url":"https://example.com/"}],"evidence":{"facts":[{"text":"確認できた事実。","sourceUrl":"https://example.com/"}],"inference":"考えられること。","suggestion":"提案。"}}'::jsonb))));
$$;
create function pg_temp.check_search(candidate jsonb) returns void language sql as $$
  select public.assert_photo_snapshot(pg_temp.search_snapshot(candidate));
$$;

select lives_ok($$select public.assert_photo_snapshot(pg_temp.search_snapshot())$$,'structured search evidence is accepted');
select lives_ok($$select pg_temp.check_search((pg_temp.search_snapshot()#>'{timeline,0,search}')-'evidence')$$,'legacy search metadata remains accepted');
select lives_ok($$select pg_temp.check_search('{"status":"failed","searchedAt":"2026-09-12T00:00:00.000Z","sources":[]}')$$,'failed search without evidence remains accepted');
select lives_ok($$select pg_temp.check_search(jsonb_set(jsonb_set(pg_temp.search_snapshot()#>'{timeline,0,search}','{evidence,inference}','null'),'{evidence,suggestion}','null'))$$,'nullable derived claims are accepted');
select throws_ok($$select pg_temp.check_search(jsonb_set(pg_temp.search_snapshot()#>'{timeline,0,search}','{evidence,facts,0,sourceUrl}','"https://unlisted.example/"'))$$,'22023','invalid search evidence','facts must cite a listed source');
select throws_ok($$select pg_temp.check_search(jsonb_set(pg_temp.search_snapshot()#>'{timeline,0,search}','{evidence,facts}','[]'))$$,'22023','invalid search evidence','empty facts are rejected');
select throws_ok($$select pg_temp.check_search(jsonb_set(pg_temp.search_snapshot()#>'{timeline,0,search}','{evidence,facts,0,text}','""'))$$,'22023','invalid search evidence','blank facts are rejected');
select throws_ok($$select pg_temp.check_search(jsonb_set(pg_temp.search_snapshot()#>'{timeline,0,search}','{evidence,facts,0,text}',to_jsonb(repeat('a',181))))$$,'22023','invalid search evidence','long facts are rejected');
select throws_ok($$select pg_temp.check_search(jsonb_set(pg_temp.search_snapshot()#>'{timeline,0,search}','{evidence,suggestion}','false'))$$,'22023','invalid search evidence','non-text derived claims are rejected');
select throws_ok($$select pg_temp.check_search(jsonb_set(pg_temp.search_snapshot()#>'{timeline,0,search}','{evidence,inference}',to_jsonb(E'bad\ntext'::text)))$$,'22023','invalid search evidence','control characters are rejected');
select throws_ok($$select pg_temp.check_search(jsonb_set(pg_temp.search_snapshot()#>'{timeline,0,search}','{evidence,extra}','true'))$$,'22023','invalid search evidence','unknown evidence keys are rejected');
select throws_ok($$select pg_temp.check_search('{"status":"failed","searchedAt":"2026-09-12T00:00:00.000Z","sources":[],"evidence":{}}')$$,'22023','invalid search evidence','failed search cannot carry evidence');
select ok(not has_function_privilege('authenticated','public.assert_chat_search_evidence(jsonb,text[])','execute'),'browser cannot call the validator directly');
select * from finish();
rollback;
