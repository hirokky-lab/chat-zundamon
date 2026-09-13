-- Private, vrm_owner_id-scoped VRM storage. Model binaries are never part of Git.
create table public.vrm_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  mode text not null default 'live2d' check (mode in ('live2d', 'vrm')),
  model_id uuid,
  file_name text check (length(file_name) between 1 and 255),
  check ((model_id is null) = (file_name is null)),
  check (mode <> 'vrm' or model_id is not null)
);
alter table public.vrm_preferences enable row level security;
revoke all on public.vrm_preferences from public, anon, authenticated;
grant select on public.vrm_preferences to authenticated;
grant all on public.vrm_preferences to service_role;
create policy vrm_preferences_read_own on public.vrm_preferences
  for select to authenticated using (user_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('zundamon-vrm', 'zundamon-vrm', false, 52428800, array['application/octet-stream']);
create policy vrm_read_own on storage.objects for select to authenticated
  using (bucket_id = 'zundamon-vrm' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy vrm_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'zundamon-vrm' and name ~ ('^' || (select auth.uid())::text || '/[a-f0-9-]{36}\.vrm$'));
-- Immutable uploads: replacing a model creates a new object before publishing it.
create policy vrm_delete_unused_own on storage.objects for delete to authenticated
  using (bucket_id = 'zundamon-vrm' and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (select 1 from public.vrm_preferences p where p.user_id = (select auth.uid())
      and name = p.user_id::text || '/' || p.model_id::text || '.vrm'));

create function public.save_vrm_preference(p_revision bigint, p_mode text, p_model_id uuid, p_file_name text)
returns public.vrm_preferences language plpgsql security definer set search_path = '' as $$
declare vrm_owner_id uuid := auth.uid(); saved public.vrm_preferences;
begin
  if vrm_owner_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_revision is null or p_revision < 0 or p_mode is null or p_mode not in ('live2d','vrm')
    or (p_mode = 'vrm' and p_model_id is null)
    or ((p_model_id is null) <> (p_file_name is null))
    or (p_file_name is not null and (length(p_file_name) < 1 or length(p_file_name) > 255))
    then raise exception 'invalid preference' using errcode = '22023'; end if;
  -- Serializes first-save races as well as later updates for this vrm_owner_id only.
  perform pg_advisory_xact_lock(hashtextextended(vrm_owner_id::text, 91));
  select * into saved from public.vrm_preferences where user_id = vrm_owner_id;
  if coalesce(saved.revision, 0) <> p_revision then
    raise sqlstate 'PT409' using message = 'character preference conflict';
  end if;
  if p_model_id is not null and not exists (select 1 from storage.objects
    where bucket_id = 'zundamon-vrm' and name = vrm_owner_id::text || '/' || p_model_id::text || '.vrm') then
    raise exception 'model not found' using errcode = '22023';
  end if;
  insert into public.vrm_preferences (user_id, revision, mode, model_id, file_name)
    values (vrm_owner_id, p_revision + 1, p_mode, p_model_id, p_file_name)
    on conflict (user_id) do update set revision = excluded.revision, mode = excluded.mode,
      model_id = excluded.model_id, file_name = excluded.file_name returning * into saved;
  return saved;
end $$;
revoke all on function public.save_vrm_preference(bigint, text, uuid, text) from public, anon;
grant execute on function public.save_vrm_preference(bigint, text, uuid, text) to authenticated;
