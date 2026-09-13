revoke delete on table public.memories from authenticated;
revoke insert, update, delete on table public.memory_tombstones from authenticated;

-- This existing atomic action function already derives every row owner from
-- auth.uid(), uses an empty search_path, and fully qualifies persistent
-- objects.  Definer execution keeps explicit chat forget available after
-- direct destructive table privileges are revoked.
alter function public.apply_memory_action_once(text, jsonb) security definer;
alter function public.apply_memory_action_once(text, jsonb) set search_path = '';
revoke all on function public.apply_memory_action_once(text, jsonb) from public, anon;
grant execute on function public.apply_memory_action_once(text, jsonb) to authenticated;

create or replace function public.patch_memory_settings(p_key text, p_enabled boolean)
returns public.memory_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  result public.memory_settings%rowtype;
begin
  if owner_id is null or p_key not in ('automatic_memory_enabled', 'recall_memory_enabled') or p_enabled is null then
    raise exception 'invalid memory settings patch';
  end if;
  insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled, updated_at)
  values (owner_id, true, true, pg_catalog.now())
  on conflict (user_id) do nothing;
  if p_key = 'automatic_memory_enabled' then
    update public.memory_settings set automatic_memory_enabled = p_enabled, updated_at = pg_catalog.now()
    where user_id = owner_id returning * into result;
  else
    update public.memory_settings set recall_memory_enabled = p_enabled, updated_at = pg_catalog.now()
    where user_id = owner_id returning * into result;
  end if;
  return result;
end;
$$;

create or replace function public.forget_memory(p_target_id uuid, p_block_relearning boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target public.memories%rowtype;
begin
  if current_user_id is null or p_target_id is null or p_block_relearning is null then return false; end if;
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
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or p_tombstone_id is null then return false; end if;
  update public.memory_tombstones
  set released_at = pg_catalog.now()
  where user_id = (select auth.uid()) and id = p_tombstone_id and released_at is null;
  return found;
end;
$$;

create or replace function public.apply_automatic_memory_action_once(
  p_source_message_id text,
  p_action_index smallint,
  p_action jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  receipt public.automatic_memory_actions;
  settings public.memory_settings%rowtype;
  inserted boolean := false;
  mutation_state text;
  now_at timestamptz := pg_catalog.now();
begin
  if owner_id is null
    or p_source_message_id is null
    or length(p_source_message_id) = 0
    or length(p_source_message_id) > 128
    or p_action_index not between 0 and 2
    or pg_catalog.jsonb_typeof(p_action) <> 'object' then
    raise exception 'invalid automatic memory action';
  end if;
  perform 1 from public.automatic_memory_processing
  where user_id = owner_id and source_message_id = p_source_message_id and state = 'pending'
  for update;
  if not found then raise exception 'automatic memory receipt not pending'; end if;

  insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled, updated_at)
  values (owner_id, true, true, now_at)
  on conflict (user_id) do nothing;
  select * into settings from public.memory_settings where user_id = owner_id for update;
  if not settings.automatic_memory_enabled then return 'disabled'; end if;

  insert into public.automatic_memory_actions
    (user_id, source_message_id, action_index, state, attempted_at, completed_at)
  values (owner_id, p_source_message_id, p_action_index, 'pending', now_at, null)
  on conflict (user_id, source_message_id, action_index) do nothing
  returning * into receipt;
  inserted := found;
  if not inserted then
    select * into receipt from public.automatic_memory_actions
    where user_id = owner_id and source_message_id = p_source_message_id and action_index = p_action_index
    for update;
    if receipt.state = 'completed' then return 'completed'; end if;
    if receipt.attempted_at > now_at - interval '5 minutes' then return 'pending'; end if;
    update public.automatic_memory_actions set attempted_at = now_at, completed_at = null
    where user_id = owner_id and source_message_id = p_source_message_id and action_index = p_action_index;
  end if;

  mutation_state := public.apply_memory_action_once(
    'automatic-internal:' || pg_catalog.gen_random_uuid()::text,
    p_action
  );
  if mutation_state <> 'applied' then raise exception 'automatic memory mutation unavailable'; end if;
  update public.automatic_memory_actions set state = 'completed', completed_at = now_at
  where user_id = owner_id and source_message_id = p_source_message_id and action_index = p_action_index;
  return 'applied';
end;
$$;

revoke all on function public.patch_memory_settings(text, boolean) from public, anon;
revoke all on function public.forget_memory(uuid, boolean) from public, anon;
revoke all on function public.release_memory_tombstone(uuid) from public, anon;
revoke all on function public.apply_automatic_memory_action_once(text, smallint, jsonb) from public, anon;
grant execute on function public.patch_memory_settings(text, boolean) to authenticated;
grant execute on function public.forget_memory(uuid, boolean) to authenticated;
grant execute on function public.release_memory_tombstone(uuid) to authenticated;
grant execute on function public.apply_automatic_memory_action_once(text, smallint, jsonb) to authenticated;
