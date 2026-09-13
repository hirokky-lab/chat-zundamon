alter table public.migration_imports
  add column if not exists imported_profile boolean not null default true,
  add column if not exists imported_memories integer not null default 0 check (imported_memories >= 0);

create or replace function public.import_profile_memory(
  p_import_id uuid,
  p_bundle jsonb
)
returns table(imported_profile boolean, imported_memories integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  memory_count integer;
  existing public.migration_imports;
begin
  if current_user_id is null then raise exception 'authentication required'; end if;
  if p_import_id is null then raise exception 'invalid import id'; end if;
  if jsonb_typeof(p_bundle) <> 'object'
    or not (p_bundle ?& array['version', 'profile', 'memories'])
    or (select count(*) from jsonb_object_keys(p_bundle)) <> 3
    or p_bundle->>'version' <> '1'
    or jsonb_typeof(p_bundle->'profile') <> 'object'
    or not ((p_bundle->'profile') ?& array['displayName', 'addressingStyle', 'updatedAt'])
    or (select count(*) from jsonb_object_keys(p_bundle->'profile')) <> 3
    or jsonb_typeof(p_bundle->'memories') <> 'array'
  then raise exception 'invalid migration bundle'; end if;

  memory_count := jsonb_array_length(p_bundle->'memories');
  if memory_count > 500 then raise exception 'too many memories'; end if;
  if length(p_bundle->'profile'->>'displayName') not between 1 and 20
    or p_bundle->'profile'->>'addressingStyle' not in ('san', 'none')
  then raise exception 'invalid migration profile'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_bundle->'memories') item
    where jsonb_typeof(item) <> 'object'
      or not (item ?& array['id','kind','content','importance','createdAt','updatedAt'])
      or (select count(*) from jsonb_object_keys(item)) <> 6
      or item->>'kind' not in ('preference','event','ongoing','shared')
      or length(item->>'content') not between 1 and 40
      or item->>'content' !~ '[ぁ-んァ-ヶ一-龠]'
      or (item->>'importance')::integer not between 1 and 5
  ) then raise exception 'invalid migration memory'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_user_id::text || ':' || p_import_id::text, 0));
  select * into existing from public.migration_imports
    where user_id = current_user_id and import_id = p_import_id;
  if found then
    return query select existing.imported_profile, existing.imported_memories;
    return;
  end if;

  insert into public.profiles (user_id, display_name, addressing_style, updated_at)
  values (
    current_user_id,
    p_bundle->'profile'->>'displayName',
    p_bundle->'profile'->>'addressingStyle',
    (p_bundle->'profile'->>'updatedAt')::timestamptz
  )
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    addressing_style = excluded.addressing_style,
    updated_at = excluded.updated_at;

  delete from public.memories stored
  using jsonb_to_recordset(p_bundle->'memories') as item(id text, content text)
  where stored.user_id = current_user_id
    and stored.id = item.id::uuid
    and stored.content_normalized <> pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(item.content), '\s+', ' ', 'g'));

  insert into public.memories (user_id, id, kind, content, content_normalized, importance, created_at, updated_at)
  select
    current_user_id,
    item.id::uuid,
    item.kind,
    item.content,
    pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(item.content), '\s+', ' ', 'g')),
    item.importance,
    item."createdAt"::timestamptz,
    item."updatedAt"::timestamptz
  from jsonb_to_recordset(p_bundle->'memories') as item(
    id text, kind text, content text, importance integer, "createdAt" text, "updatedAt" text
  )
  on conflict (user_id, content_normalized) do update set
    kind = excluded.kind,
    content = excluded.content,
    content_normalized = excluded.content_normalized,
    importance = excluded.importance,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;

  insert into public.migration_imports (user_id, import_id, imported_profile, imported_memories)
  values (current_user_id, p_import_id, true, memory_count);
  return query select true, memory_count;
end;
$$;

revoke all on function public.import_profile_memory(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_profile_memory(uuid, jsonb) to authenticated;
