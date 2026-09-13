create table public.memory_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  automatic_memory_enabled boolean not null default true,
  recall_memory_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.memory_settings enable row level security;
revoke all on table public.memory_settings from public, anon;
grant select, insert, update on table public.memory_settings to authenticated;

create policy memory_settings_select_own on public.memory_settings
  for select to authenticated using (auth.uid() = user_id);
create policy memory_settings_insert_own on public.memory_settings
  for insert to authenticated with check (auth.uid() = user_id);
create policy memory_settings_update_own on public.memory_settings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.forget_memory(p_target_id uuid, p_block_relearning boolean)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  target public.memories%rowtype;
begin
  select * into target
  from public.memories
  where user_id = current_user_id and id = p_target_id
  for update;
  if not found then return false; end if;

  if p_block_relearning then
    insert into public.memory_tombstones (user_id, id, memory_id, normalized_fingerprint, created_at, released_at)
    values (current_user_id, pg_catalog.gen_random_uuid(), target.id, target.content_normalized, pg_catalog.now(), null);
  end if;

  delete from public.memories where user_id = current_user_id and id = p_target_id;
  return found;
end;
$$;

create or replace function public.release_memory_tombstone(p_tombstone_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.memory_tombstones
  set released_at = pg_catalog.now()
  where user_id = auth.uid() and id = p_tombstone_id and released_at is null;
  return found;
end;
$$;

revoke all on function public.forget_memory(uuid, boolean) from public, anon;
revoke all on function public.release_memory_tombstone(uuid) from public, anon;
grant execute on function public.forget_memory(uuid, boolean) to authenticated;
grant execute on function public.release_memory_tombstone(uuid) to authenticated;
