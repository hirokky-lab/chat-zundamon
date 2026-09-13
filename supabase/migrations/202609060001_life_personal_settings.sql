-- Extend owner settings without allowing old clients to erase personal fields.
-- Character limits match JavaScript UTF-16 string length, including emoji.
create function public.life_settings_text_valid(value jsonb, max_length integer, multiline boolean, allow_empty boolean)
returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(value) = 'string'
  and length(value #>> '{}') + length(regexp_replace(value #>> '{}', U&'[\0001-\FFFF]', '', 'g')) <= max_length
  and (allow_empty or (value #>> '{}') !~ '^[[:space:]]*$')
  and (value #>> '{}') !~ case when multiline
   then U&'[\0001-\0009\000B\000C\000E-\001F\007F]'
   else U&'[\0001-\001F\007F]' end;
$$;
revoke all on function public.life_settings_text_valid(jsonb,integer,boolean,boolean) from public,anon,authenticated;

create or replace function public.update_life_settings(p_expected_revision bigint,p_settings jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare current_revision bigint; current_settings jsonb; next_settings jsonb; h jsonb; source jsonb; personal jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991
  or p_settings is null or jsonb_typeof(p_settings) <> 'object' then raise exception 'Invalid settings'; end if;
 if not (p_settings ?& array['revision','home','calendar','tasks'])
  or exists(select 1 from jsonb_object_keys(p_settings) k where k not in ('revision','home','calendar','tasks','personal'))
  or p_settings->'revision' <> to_jsonb(p_expected_revision)
  or octet_length(p_settings::text)>32768 then raise exception 'Invalid settings'; end if;
 h := p_settings->'home';
 if h <> 'null'::jsonb then
  if jsonb_typeof(h)<>'object' then raise exception 'Invalid settings'; end if;
  if (select count(*) from jsonb_object_keys(h))<>6 or not(h ?& array['label','query','latitude','longitude','timezone','precision'])
   or public.life_settings_text_valid(h->'label',160,false,false) is not true
   or public.life_settings_text_valid(h->'query',200,false,false) is not true
   or public.life_settings_text_valid(h->'timezone',80,false,false) is not true
   or not exists(select 1 from pg_catalog.pg_timezone_names where name=h->>'timezone')
   or jsonb_typeof(h->'precision')<>'string' or h->>'precision' not in ('locality','station')
   or jsonb_typeof(h->'latitude')<>'number' or jsonb_typeof(h->'longitude')<>'number'
   then raise exception 'Invalid settings'; end if;
  if abs((h->>'latitude')::numeric)>90 or abs((h->>'longitude')::numeric)>180 then raise exception 'Invalid settings'; end if;
 end if;
 for source in select p_settings->'calendar' union all select p_settings->'tasks' loop
  if source <> 'null'::jsonb then
   if jsonb_typeof(source)<>'object' then raise exception 'Invalid settings'; end if;
   if (select count(*) from jsonb_object_keys(source))<>2 or not(source ?& array['id','title'])
    or public.life_settings_text_valid(source->'id',512,false,false) is not true
    or public.life_settings_text_valid(source->'title',200,false,false) is not true
    then raise exception 'Invalid settings'; end if;
  end if;
 end loop;
 if p_settings ? 'personal' then
  personal := p_settings->'personal';
  if jsonb_typeof(personal)<>'object' then raise exception 'Invalid settings'; end if;
  if (select count(*) from jsonb_object_keys(personal))<>4
   or not(personal ?& array['nickname','occupation','details','responsePreferences'])
   or public.life_settings_text_valid(personal->'nickname',20,false,true) is not true
   or public.life_settings_text_valid(personal->'occupation',120,false,true) is not true
   or public.life_settings_text_valid(personal->'details',2000,true,true) is not true
   or public.life_settings_text_valid(personal->'responsePreferences',1000,true,true) is not true
   then raise exception 'Invalid settings'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,305003));
 select revision,settings into current_revision,current_settings from public.life_settings where owner_id=auth.uid() for update;
 if coalesce(current_revision,0) <> p_expected_revision then return null; end if;
 next_settings := p_settings-'revision';
 if not(p_settings ? 'personal') and current_settings ? 'personal' then
  next_settings := next_settings || jsonb_build_object('personal',current_settings->'personal');
 end if;
 insert into public.life_settings(owner_id,revision,settings) values(auth.uid(),p_expected_revision+1,next_settings)
 on conflict(owner_id) do update set revision=excluded.revision,settings=excluded.settings,updated_at=now();
 return next_settings || jsonb_build_object('revision',p_expected_revision+1);
end $$;
revoke all on function public.update_life_settings(bigint,jsonb) from public,anon;
grant execute on function public.update_life_settings(bigint,jsonb) to authenticated;
