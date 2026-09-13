begin;

-- Search replies now include facts, inference and suggestion. Validate those
-- fields without weakening the existing snapshot, URL or photo-lineage guards.
create or replace function public.assert_chat_search_evidence(p_search jsonb, p_source_urls text[])
returns void language plpgsql immutable set search_path = ''
as $$
declare evidence jsonb; fact jsonb; derived jsonb;
begin
  -- Existing snapshots without evidence remain readable/writable.
  if not (p_search ? 'evidence') then return; end if;
  evidence := p_search->'evidence';
  if p_search->>'status' is distinct from 'completed'
    or jsonb_typeof(evidence) is distinct from 'object' then
    raise exception 'invalid search evidence' using errcode='22023';
  end if;
  if (select array_agg(key order by key) from jsonb_object_keys(evidence) key)
      is distinct from array['facts','inference','suggestion']
    or jsonb_typeof(evidence->'facts') is distinct from 'array' then
    raise exception 'invalid search evidence' using errcode='22023';
  end if;
  if jsonb_array_length(evidence->'facts') not between 1 and 3 then
    raise exception 'invalid search evidence' using errcode='22023';
  end if;
  for fact in select value from jsonb_array_elements(evidence->'facts') loop
    if jsonb_typeof(fact) is distinct from 'object' then
      raise exception 'invalid search evidence' using errcode='22023';
    end if;
    if (select array_agg(key order by key) from jsonb_object_keys(fact) key)
        is distinct from array['sourceUrl','text']
      or jsonb_typeof(fact->'text') is distinct from 'string'
      or coalesce(length(btrim(fact->>'text')),0)=0
      or length(fact->>'text')>180 or fact->>'text' ~ '[[:cntrl:]]'
      or jsonb_typeof(fact->'sourceUrl') is distinct from 'string'
      or not coalesce(fact->>'sourceUrl'=any(p_source_urls),false) then
      raise exception 'invalid search evidence' using errcode='22023';
    end if;
  end loop;
  for derived in select value from jsonb_each(evidence) where key in ('inference','suggestion') loop
    if derived <> 'null'::jsonb and (
      jsonb_typeof(derived) is distinct from 'string'
      or coalesce(length(btrim(derived #>> '{}')),0)=0
      or length(derived #>> '{}')>180 or (derived #>> '{}') ~ '[[:cntrl:]]'
    ) then
      raise exception 'invalid search evidence' using errcode='22023';
    end if;
  end loop;
end;
$$;
revoke all on function public.assert_chat_search_evidence(jsonb,text[]) from public,anon,authenticated;
grant execute on function public.assert_chat_search_evidence(jsonb,text[]) to service_role;

do $migration$
declare definition text; old_keys text; new_keys text; anchor text;
begin
  select pg_get_functiondef('public.assert_photo_snapshot(jsonb)'::regprocedure) into definition;
  if position('chat_search_evidence_guard_v1' in definition)>0 then return; end if;
  old_keys := 'jsonb_object_keys(item->''search'') key';
  new_keys := 'jsonb_object_keys((item->''search'') - ''evidence'') key';
  anchor := 'if has_origin and (snapshot_version<>3';
  if position(old_keys in definition)=0 or position(anchor in definition)=0 then
    raise exception 'unsupported snapshot search validator';
  end if;
  definition := replace(definition, old_keys, new_keys);
  definition := replace(definition, anchor, $guard$
        -- chat_search_evidence_guard_v1
        if item ? 'search' then
          perform public.assert_chat_search_evidence(item->'search',source_urls);
        end if;
        if has_origin and (snapshot_version<>3$guard$);
  execute definition;
end;
$migration$;
commit;
