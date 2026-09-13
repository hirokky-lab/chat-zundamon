alter table public.memory_settings
  add column if not exists voice_memory_enabled boolean not null default true;

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
  if owner_id is null or p_key not in ('automatic_memory_enabled', 'recall_memory_enabled', 'voice_memory_enabled') or p_enabled is null then
    raise exception 'invalid memory settings patch';
  end if;
  if p_key = 'voice_memory_enabled' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text || ':voice-memory', 0));
  end if;
  insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled, voice_memory_enabled, updated_at)
  values (owner_id, true, true, true, pg_catalog.now())
  on conflict (user_id) do nothing;
  if p_key = 'automatic_memory_enabled' then
    update public.memory_settings set automatic_memory_enabled = p_enabled, updated_at = pg_catalog.now()
    where user_id = owner_id returning * into result;
  elsif p_key = 'recall_memory_enabled' then
    update public.memory_settings set recall_memory_enabled = p_enabled, updated_at = pg_catalog.now()
    where user_id = owner_id returning * into result;
  else
    update public.memory_settings set voice_memory_enabled = p_enabled, updated_at = pg_catalog.now()
    where user_id = owner_id returning * into result;
  end if;
  return result;
end;
$$;

create or replace function public.claim_automatic_memory_processing(p_source_message_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  receipt public.automatic_memory_processing;
  settings public.memory_settings%rowtype;
  inserted boolean := false;
begin
  if owner_id is null or p_source_message_id is null or length(p_source_message_id) = 0 or length(p_source_message_id) > 128 then
    raise exception 'invalid automatic memory receipt';
  end if;
  if p_source_message_id like 'voice:%' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text || ':voice-memory', 0));
    insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled, voice_memory_enabled, updated_at)
    values (owner_id, true, true, true, pg_catalog.now())
    on conflict (user_id) do nothing;
    select * into settings from public.memory_settings where user_id = owner_id;
    if not settings.voice_memory_enabled then
      return pg_catalog.jsonb_build_object('state', 'disabled', 'appliedCount', 0, 'retry', false);
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text || ':' || p_source_message_id, 0));
  insert into public.automatic_memory_processing
    (user_id, source_message_id, state, applied_count, attempt_count, attempted_at, completed_at)
  values (owner_id, p_source_message_id, 'pending', 0, 1, pg_catalog.now(), null)
  on conflict (user_id, source_message_id) do nothing
  returning * into receipt;
  inserted := found;
  if not inserted then
    select * into receipt from public.automatic_memory_processing
    where user_id = owner_id and source_message_id = p_source_message_id for update;
  end if;
  if inserted then
    return pg_catalog.jsonb_build_object('state', 'claimed', 'appliedCount', 0, 'retry', false);
  end if;
  if receipt.state = 'completed' then
    return pg_catalog.jsonb_build_object('state', 'completed', 'appliedCount', receipt.applied_count, 'retry', false);
  end if;
  if receipt.state = 'pending' and receipt.attempted_at > pg_catalog.now() - interval '5 minutes' then
    return pg_catalog.jsonb_build_object('state', 'pending', 'appliedCount', receipt.applied_count, 'retry', false);
  end if;
  update public.automatic_memory_processing
  set state = 'pending', attempt_count = attempt_count + 1, attempted_at = pg_catalog.now(), completed_at = null
  where user_id = owner_id and source_message_id = p_source_message_id
  returning * into receipt;
  return pg_catalog.jsonb_build_object('state', 'claimed', 'appliedCount', receipt.applied_count, 'retry', true);
end;
$$;

create or replace function public.has_active_voice_memory_processing(p_cutoff timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when (select auth.uid()) is null or p_cutoff is null then false else exists (
    select 1 from public.automatic_memory_processing
    where user_id = (select auth.uid()) and state = 'pending'
      and source_message_id like 'voice:%' and attempted_at >= p_cutoff
  ) end
$$;

create or replace function public.cleanup_stale_voice_memory_processing(p_cutoff timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  cleaned integer := 0;
begin
  if owner_id is null or p_cutoff is null then raise exception 'invalid voice cleanup'; end if;
  delete from public.automatic_memory_outbox outbox using public.automatic_memory_processing receipt
  where outbox.user_id = owner_id and outbox.source_message_id like 'voice:%'
    and receipt.user_id = outbox.user_id and receipt.source_message_id = outbox.source_message_id
    and receipt.state = 'pending' and receipt.attempted_at < p_cutoff;
  update public.automatic_memory_processing
  set state = 'failed', completed_at = null, outbox_ref = null
  where user_id = owner_id and state = 'pending'
    and source_message_id like 'voice:%' and attempted_at < p_cutoff;
  get diagnostics cleaned = row_count;
  return cleaned;
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

  insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled, voice_memory_enabled, updated_at)
  values (owner_id, true, true, true, now_at)
  on conflict (user_id) do nothing;
  select * into settings from public.memory_settings where user_id = owner_id for update;
  if p_source_message_id like 'voice:%' then
    if not settings.voice_memory_enabled then return 'disabled'; end if;
  elsif not settings.automatic_memory_enabled then
    return 'disabled';
  end if;

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
revoke all on function public.claim_automatic_memory_processing(text) from public, anon;
revoke all on function public.has_active_voice_memory_processing(timestamptz) from public, anon;
revoke all on function public.cleanup_stale_voice_memory_processing(timestamptz) from public, anon;
revoke all on function public.apply_automatic_memory_action_once(text, smallint, jsonb) from public, anon;
grant execute on function public.patch_memory_settings(text, boolean) to authenticated;
grant execute on function public.claim_automatic_memory_processing(text) to authenticated;
grant execute on function public.has_active_voice_memory_processing(timestamptz) to authenticated;
grant execute on function public.cleanup_stale_voice_memory_processing(timestamptz) to authenticated;
grant execute on function public.apply_automatic_memory_action_once(text, smallint, jsonb) to authenticated;
