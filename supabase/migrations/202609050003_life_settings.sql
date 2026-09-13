-- Owner-synced region and source selections. No service-role or anonymous access.
create table public.life_settings (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 revision bigint not null default 0 check(revision >= 0),
 settings jsonb not null default '{"home":null,"calendar":null,"tasks":null}'::jsonb,
 updated_at timestamptz not null default now()
);
alter table public.life_settings enable row level security;
create policy life_settings_owner_read on public.life_settings for select to authenticated using(owner_id=auth.uid());
revoke all on public.life_settings from anon,authenticated;
grant select on public.life_settings to authenticated;
create function public.get_life_settings() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 select settings || jsonb_build_object('revision',revision) into result from public.life_settings where owner_id=auth.uid();
 return coalesce(result,'{"revision":0,"home":null,"calendar":null,"tasks":null}'::jsonb);
end $$;
create function public.update_life_settings(p_expected_revision bigint,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare current_revision bigint; result jsonb; h jsonb; source jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_expected_revision < 0 or p_expected_revision is null or p_settings is null or jsonb_typeof(p_settings) <> 'object'
 or (select count(*) from jsonb_object_keys(p_settings)) <> 4
 or not (p_settings ?& array['revision','home','calendar','tasks'])
 or p_settings->'revision' <> to_jsonb(p_expected_revision)
 or octet_length(p_settings::text)>8192 then raise exception 'Invalid settings'; end if;
 h := p_settings->'home';
 if h <> 'null'::jsonb then
  if jsonb_typeof(h)<>'object' then raise exception 'Invalid settings'; end if;
  if (select count(*) from jsonb_object_keys(h))<>6 or not(h ?& array['label','query','latitude','longitude','timezone','precision'])
   or jsonb_typeof(h->'label')<>'string' or length(h->>'label') not between 1 and 160
   or jsonb_typeof(h->'query')<>'string' or length(h->>'query') not between 1 and 200
   or jsonb_typeof(h->'timezone')<>'string' or not exists(select 1 from pg_catalog.pg_timezone_names where name=h->>'timezone')
   or h->>'precision' not in ('locality','station')
   or jsonb_typeof(h->'latitude')<>'number' or jsonb_typeof(h->'longitude')<>'number'
   then raise exception 'Invalid settings'; end if;
  if abs((h->>'latitude')::numeric)>90 or abs((h->>'longitude')::numeric)>180 then raise exception 'Invalid settings'; end if;
 end if;
 for source in select p_settings->'calendar' union all select p_settings->'tasks' loop
  if source <> 'null'::jsonb then
   if jsonb_typeof(source)<>'object' then raise exception 'Invalid settings'; end if;
   if (select count(*) from jsonb_object_keys(source))<>2 or not(source ?& array['id','title'])
    or jsonb_typeof(source->'id')<>'string' or length(source->>'id') not between 1 and 512
    or jsonb_typeof(source->'title')<>'string' or length(source->>'title') not between 1 and 200
    then raise exception 'Invalid settings'; end if;
  end if;
 end loop;
 -- Serialize initial insert and every revision change for this owner.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,305003));
 select revision into current_revision from public.life_settings where owner_id=auth.uid() for update;
 if coalesce(current_revision,0) <> p_expected_revision then return null; end if;
 insert into public.life_settings(owner_id,revision,settings) values(auth.uid(),p_expected_revision+1,p_settings-'revision')
 on conflict(owner_id) do update set revision=excluded.revision,settings=excluded.settings,updated_at=now();
 return (p_settings-'revision') || jsonb_build_object('revision',p_expected_revision+1);
end $$;
create table public.life_weather_quota (
 owner_id uuid not null references auth.users(id) on delete cascade,
 acquired_at timestamptz not null default clock_timestamp()
);
create index life_weather_quota_owner_time on public.life_weather_quota(owner_id,acquired_at);
alter table public.life_weather_quota enable row level security;
revoke all on public.life_weather_quota from anon,authenticated;
create function public.acquire_life_weather_quota() returns boolean language plpgsql security definer set search_path='' as $$
declare minute_count integer; day_count integer;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,305004));
 delete from public.life_weather_quota where owner_id=auth.uid() and acquired_at < now()-interval '1 day';
 select count(*),count(*) filter(where acquired_at>=now()-interval '1 minute') into day_count,minute_count
 from public.life_weather_quota where owner_id=auth.uid();
 if day_count>=50 or minute_count>=8 then return false; end if;
 insert into public.life_weather_quota(owner_id) values(auth.uid());return true;
end $$;
revoke all on function public.get_life_settings() from public,anon;
revoke all on function public.update_life_settings(bigint,jsonb) from public,anon;
revoke all on function public.acquire_life_weather_quota() from public,anon;
grant execute on function public.get_life_settings() to authenticated;
grant execute on function public.update_life_settings(bigint,jsonb) to authenticated;
grant execute on function public.acquire_life_weather_quota() to authenticated;
