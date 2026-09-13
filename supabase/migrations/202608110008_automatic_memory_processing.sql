create table public.automatic_memory_processing (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_message_id text not null,
  state text not null check (state in ('pending', 'completed', 'failed')),
  applied_count smallint not null default 0 check (applied_count between 0 and 3),
  attempt_count integer not null default 1 check (attempt_count >= 1),
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  action_plan jsonb check (action_plan is null or (jsonb_typeof(action_plan) = 'array' and jsonb_array_length(action_plan) <= 3)),
  primary key (user_id, source_message_id)
);

create index automatic_memory_processing_user_attempted_idx
  on public.automatic_memory_processing (user_id, attempted_at desc);

alter table public.automatic_memory_processing enable row level security;
revoke all on table public.automatic_memory_processing from public, anon, authenticated;
grant select on table public.automatic_memory_processing to authenticated;

create policy automatic_memory_processing_select_own on public.automatic_memory_processing
  for select to authenticated using ((select auth.uid()) = user_id);

create table public.automatic_memory_actions (
  user_id uuid not null,
  source_message_id text not null,
  action_index smallint not null check (action_index between 0 and 2),
  state text not null check (state in ('pending', 'completed')),
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, source_message_id, action_index),
  foreign key (user_id, source_message_id)
    references public.automatic_memory_processing(user_id, source_message_id) on delete cascade
);

alter table public.automatic_memory_actions enable row level security;
revoke all on table public.automatic_memory_actions from public, anon, authenticated;
grant select on table public.automatic_memory_actions to authenticated;
create policy automatic_memory_actions_select_own on public.automatic_memory_actions
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.claim_automatic_memory_processing(p_source_message_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  receipt public.automatic_memory_processing;
  inserted boolean := false;
begin
  if owner_id is null or p_source_message_id is null or length(p_source_message_id) = 0 or length(p_source_message_id) > 128 then
    raise exception 'invalid automatic memory receipt';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text || ':' || p_source_message_id, 0));
  insert into public.automatic_memory_processing
    (user_id, source_message_id, state, applied_count, attempt_count, attempted_at, completed_at)
  values
    (owner_id, p_source_message_id, 'pending', 0, 1, now(), null)
  on conflict (user_id, source_message_id) do nothing
  returning * into receipt;
  inserted := found;

  if not inserted then
    select * into receipt
    from public.automatic_memory_processing
    where user_id = owner_id and source_message_id = p_source_message_id
    for update;
  end if;

  if inserted then
    return pg_catalog.jsonb_build_object('state', 'claimed', 'appliedCount', 0, 'retry', false);
  end if;
  if receipt.state = 'completed' then
    return pg_catalog.jsonb_build_object('state', 'completed', 'appliedCount', receipt.applied_count, 'retry', false);
  end if;
  if receipt.state = 'pending' and receipt.attempted_at > now() - interval '5 minutes' then
    return pg_catalog.jsonb_build_object('state', 'pending', 'appliedCount', receipt.applied_count, 'retry', false);
  end if;

  update public.automatic_memory_processing
  set state = 'pending', attempt_count = attempt_count + 1, attempted_at = now(), completed_at = null
  where user_id = owner_id and source_message_id = p_source_message_id
  returning * into receipt;
  return pg_catalog.jsonb_build_object('state', 'claimed', 'appliedCount', receipt.applied_count, 'retry', true);
end;
$$;

create or replace function public.set_automatic_memory_action_plan(
  p_source_message_id text,
  p_action_plan jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  stored_plan jsonb;
begin
  if owner_id is null
    or p_source_message_id is null
    or length(p_source_message_id) = 0
    or length(p_source_message_id) > 128
    or jsonb_typeof(p_action_plan) <> 'array'
    or jsonb_array_length(p_action_plan) > 3 then
    raise exception 'invalid automatic memory action plan';
  end if;
  update public.automatic_memory_processing
  set action_plan = coalesce(action_plan, p_action_plan)
  where user_id = owner_id and source_message_id = p_source_message_id and state = 'pending'
  returning action_plan into stored_plan;
  if not found then raise exception 'automatic memory receipt not pending'; end if;
  return stored_plan;
end;
$$;

create or replace function public.finish_automatic_memory_processing(
  p_source_message_id text,
  p_state text,
  p_applied_count smallint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  receipt public.automatic_memory_processing;
begin
  if owner_id is null
    or p_source_message_id is null
    or length(p_source_message_id) = 0
    or length(p_source_message_id) > 128
    or p_state not in ('completed', 'failed')
    or p_applied_count < 0
    or p_applied_count > 3 then
    raise exception 'invalid automatic memory completion';
  end if;

  select * into receipt
  from public.automatic_memory_processing
  where user_id = owner_id and source_message_id = p_source_message_id
  for update;
  if not found then raise exception 'automatic memory receipt not found'; end if;
  if receipt.state = 'completed' then
    return pg_catalog.jsonb_build_object('state', receipt.state, 'appliedCount', receipt.applied_count);
  end if;

  update public.automatic_memory_processing
  set state = p_state,
      applied_count = p_applied_count,
      completed_at = case when p_state = 'completed' then now() else null end,
      action_plan = case when p_state = 'completed' then null else action_plan end
  where user_id = owner_id and source_message_id = p_source_message_id
  returning * into receipt;
  return pg_catalog.jsonb_build_object('state', receipt.state, 'appliedCount', receipt.applied_count);
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
  inserted boolean := false;
  mutation_state text;
  now_at timestamptz := now();
begin
  if owner_id is null
    or p_source_message_id is null
    or length(p_source_message_id) = 0
    or length(p_source_message_id) > 128
    or p_action_index not between 0 and 2
    or jsonb_typeof(p_action) <> 'object' then
    raise exception 'invalid automatic memory action';
  end if;
  perform 1 from public.automatic_memory_processing
  where user_id = owner_id and source_message_id = p_source_message_id and state = 'pending'
  for update;
  if not found then raise exception 'automatic memory receipt not pending'; end if;

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

revoke all on function public.claim_automatic_memory_processing(text) from public, anon;
revoke all on function public.finish_automatic_memory_processing(text, text, smallint) from public, anon;
revoke all on function public.set_automatic_memory_action_plan(text, jsonb) from public, anon;
revoke all on function public.apply_automatic_memory_action_once(text, smallint, jsonb) from public, anon;
grant execute on function public.claim_automatic_memory_processing(text) to authenticated;
grant execute on function public.finish_automatic_memory_processing(text, text, smallint) to authenticated;
grant execute on function public.set_automatic_memory_action_plan(text, jsonb) to authenticated;
grant execute on function public.apply_automatic_memory_action_once(text, smallint, jsonb) to authenticated;
