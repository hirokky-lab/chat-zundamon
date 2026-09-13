begin;
-- Preserve the existing photo lifecycle validator, extending only message metadata.
do $migration$
declare definition text; original text;
begin
 select pg_get_functiondef('public.assert_photo_snapshot(jsonb)'::regprocedure) into definition;
 original := definition;
 if position('life_card_snapshot_guard_v1' in definition)>0 then return; end if;
 if position('has_reply := item ? ''replyGroupId'' or item ? ''sequence'';' in definition)=0 then
  raise exception 'unsupported snapshot validator';
 end if;
 definition := replace(definition,
  'array[''createdAt'',''delivery'',''flow'',''id'',''origin'',''replyGroupId'',''role'',''search'',''sequence'',''sourcePhotoMessageId'',''text'',''type'']',
  'array[''createdAt'',''delivery'',''flow'',''id'',''lifeCard'',''origin'',''replyGroupId'',''role'',''search'',''sequence'',''sourcePhotoMessageId'',''text'',''type'']');
 if position('''lifeCard'',''origin''' in definition)=0 then raise exception 'unsupported snapshot metadata keys'; end if;
 definition := replace(definition, 'not in (''conversation'',''profile'')', 'not in (''conversation'',''profile'',''external_context'')');
 definition := replace(definition,
  'has_reply := item ? ''replyGroupId'' or item ? ''sequence'';',
  $guard$
      -- life_card_snapshot_guard_v1: backend domain parsing additionally validates nested shape.
      if item ? 'lifeCard' then
        if item->>'role' is distinct from 'assistant'
          or item->>'flow' is distinct from 'external_context'
          or item ? 'origin' or item ? 'sourcePhotoMessageId'
          or not (item ? 'replyGroupId' and item ? 'sequence')
          or jsonb_typeof(item->'lifeCard') is distinct from 'object'
          or octet_length((item->'lifeCard')::text)>262144
          or coalesce(item->'lifeCard'->>'kind','') not in ('google-items','google-operation','weather','maps','home-candidates') then
          raise exception 'invalid life service card' using errcode='22023';
        end if;
      end if;
      has_reply := item ? 'replyGroupId' or item ? 'sequence';
  $guard$);
 execute definition;
end;
$migration$;
commit;
