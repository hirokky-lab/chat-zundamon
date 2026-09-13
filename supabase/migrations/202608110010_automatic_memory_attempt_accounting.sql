alter table public.automatic_memory_outbox
  add column attempt_index integer not null default 1 check (attempt_index >= 1);

create table public.automatic_memory_extraction_attempts (
  user_id uuid not null,
  source_message_id text not null,
  attempt_index integer not null check (attempt_index >= 1),
  state text not null check (state in ('prepared', 'dispatched', 'held', 'settled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source_message_id, attempt_index),
  foreign key (user_id, source_message_id)
    references public.automatic_memory_processing(user_id, source_message_id) on delete cascade
);

alter table public.automatic_memory_extraction_attempts enable row level security;
revoke all on table public.automatic_memory_extraction_attempts from public, anon, authenticated;

insert into public.automatic_memory_extraction_attempts
  (user_id, source_message_id, attempt_index, state, created_at, updated_at)
select user_id, source_message_id, attempt_index,
  case when usage_settled then case when usage_started_at is null then 'held' else 'settled' end else 'dispatched' end,
  created_at, created_at
from public.automatic_memory_outbox;

create or replace function public.get_latest_automatic_memory_attempt(p_source_message_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  attempt public.automatic_memory_extraction_attempts;
begin
  if owner_id is null or p_source_message_id is null or length(p_source_message_id) = 0 or length(p_source_message_id) > 128 then
    raise exception 'invalid automatic memory attempt';
  end if;
  select * into attempt from public.automatic_memory_extraction_attempts
  where user_id = owner_id and source_message_id = p_source_message_id
  order by attempt_index desc limit 1;
  if not found then return null; end if;
  return pg_catalog.jsonb_build_object('attemptIndex', attempt.attempt_index, 'state', attempt.state);
end;
$$;

create or replace function public.prepare_automatic_memory_attempt(p_source_message_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  attempt public.automatic_memory_extraction_attempts;
  next_index integer;
begin
  if owner_id is null or p_source_message_id is null or length(p_source_message_id) = 0 or length(p_source_message_id) > 128 then
    raise exception 'invalid automatic memory attempt';
  end if;
  perform 1 from public.automatic_memory_processing
  where user_id = owner_id and source_message_id = p_source_message_id and state = 'pending'
  for update;
  if not found then raise exception 'automatic memory receipt not pending'; end if;
  select * into attempt from public.automatic_memory_extraction_attempts
  where user_id = owner_id and source_message_id = p_source_message_id
  order by attempt_index desc limit 1 for update;
  if found and attempt.state = 'prepared' then
    return pg_catalog.jsonb_build_object('attemptIndex', attempt.attempt_index, 'state', attempt.state);
  end if;
  next_index := coalesce(attempt.attempt_index, 0) + 1;
  insert into public.automatic_memory_extraction_attempts
    (user_id, source_message_id, attempt_index, state)
  values (owner_id, p_source_message_id, next_index, 'prepared')
  returning * into attempt;
  return pg_catalog.jsonb_build_object('attemptIndex', attempt.attempt_index, 'state', attempt.state);
end;
$$;

create or replace function public.set_automatic_memory_attempt_state(
  p_source_message_id text,
  p_attempt_index integer,
  p_state text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  current_state text;
begin
  if owner_id is null or p_attempt_index < 1 or p_state not in ('dispatched', 'held', 'settled') then
    raise exception 'invalid automatic memory attempt';
  end if;
  select state into current_state from public.automatic_memory_extraction_attempts
  where user_id = owner_id and source_message_id = p_source_message_id and attempt_index = p_attempt_index
  for update;
  if not found then raise exception 'automatic memory attempt not found'; end if;
  if current_state = p_state then return; end if;
  if not (
    (current_state = 'prepared' and p_state = 'dispatched')
    or (current_state = 'dispatched' and p_state in ('held', 'settled'))
  ) then raise exception 'invalid automatic memory attempt transition'; end if;
  update public.automatic_memory_extraction_attempts set state = p_state, updated_at = now()
  where user_id = owner_id and source_message_id = p_source_message_id and attempt_index = p_attempt_index;
end;
$$;

create or replace function public.get_automatic_memory_outbox(p_source_message_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  outbox public.automatic_memory_outbox;
  usage_value jsonb;
begin
  if owner_id is null or p_source_message_id is null or length(p_source_message_id) = 0 or length(p_source_message_id) > 128 then
    raise exception 'invalid automatic memory outbox';
  end if;
  select * into outbox from public.automatic_memory_outbox
  where user_id = owner_id and source_message_id = p_source_message_id;
  if not found then return null; end if;
  usage_value := case when outbox.usage_started_at is null then null else pg_catalog.jsonb_build_object(
    'startedAt', outbox.usage_started_at,
    'endedAt', outbox.usage_ended_at,
    'memoryInputTokens', outbox.memory_input_tokens,
    'memoryCachedInputTokens', outbox.memory_cached_input_tokens,
    'memoryCacheWriteTokens', outbox.memory_cache_write_tokens,
    'memoryOutputTokens', outbox.memory_output_tokens
  ) end;
  return pg_catalog.jsonb_build_object(
    'outboxRef', outbox.outbox_ref,
    'actions', outbox.action_plan,
    'usage', usage_value,
    'usageSettled', outbox.usage_settled,
    'attemptIndex', outbox.attempt_index
  );
end;
$$;

drop function public.save_automatic_memory_outbox(text, jsonb, jsonb);

create function public.save_automatic_memory_outbox(
  p_source_message_id text,
  p_action_plan jsonb,
  p_usage jsonb,
  p_attempt_index integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
begin
  if owner_id is null
    or p_source_message_id is null
    or length(p_source_message_id) = 0
    or length(p_source_message_id) > 128
    or p_attempt_index < 1
    or jsonb_typeof(p_action_plan) <> 'array'
    or jsonb_array_length(p_action_plan) > 3
    or (p_usage is not null and (
      jsonb_typeof(p_usage) <> 'object'
      or (p_usage->>'startedAt')::timestamptz is null
      or (p_usage->>'endedAt')::timestamptz is null
      or (p_usage->>'memoryInputTokens')::integer < 0
      or (p_usage->>'memoryCachedInputTokens')::integer < 0
      or (p_usage->>'memoryCacheWriteTokens')::integer < 0
      or (p_usage->>'memoryOutputTokens')::integer < 0
    )) then raise exception 'invalid automatic memory outbox'; end if;
  perform 1 from public.automatic_memory_processing
  where user_id = owner_id and source_message_id = p_source_message_id and state = 'pending' for update;
  if not found then raise exception 'automatic memory receipt not pending'; end if;
  perform 1 from public.automatic_memory_extraction_attempts
  where user_id = owner_id and source_message_id = p_source_message_id
    and attempt_index = p_attempt_index and state = 'dispatched';
  if not found then raise exception 'automatic memory attempt not dispatched'; end if;
  insert into public.automatic_memory_outbox (
    user_id, source_message_id, action_plan, usage_started_at, usage_ended_at,
    memory_input_tokens, memory_cached_input_tokens, memory_cache_write_tokens,
    memory_output_tokens, attempt_index
  ) values (
    owner_id, p_source_message_id, p_action_plan,
    (p_usage->>'startedAt')::timestamptz, (p_usage->>'endedAt')::timestamptz,
    (p_usage->>'memoryInputTokens')::integer, (p_usage->>'memoryCachedInputTokens')::integer,
    (p_usage->>'memoryCacheWriteTokens')::integer, (p_usage->>'memoryOutputTokens')::integer,
    p_attempt_index
  ) on conflict (user_id, source_message_id) do nothing;
  update public.automatic_memory_processing receipt set outbox_ref = outbox.outbox_ref
  from public.automatic_memory_outbox outbox
  where receipt.user_id = owner_id and receipt.source_message_id = p_source_message_id
    and outbox.user_id = receipt.user_id and outbox.source_message_id = receipt.source_message_id;
  return public.get_automatic_memory_outbox(p_source_message_id);
end;
$$;

revoke all on function public.get_latest_automatic_memory_attempt(text) from public, anon;
revoke all on function public.prepare_automatic_memory_attempt(text) from public, anon;
revoke all on function public.set_automatic_memory_attempt_state(text, integer, text) from public, anon;
revoke all on function public.save_automatic_memory_outbox(text, jsonb, jsonb, integer) from public, anon;
grant execute on function public.get_latest_automatic_memory_attempt(text) to authenticated;
grant execute on function public.prepare_automatic_memory_attempt(text) to authenticated;
grant execute on function public.set_automatic_memory_attempt_state(text, integer, text) to authenticated;
grant execute on function public.save_automatic_memory_outbox(text, jsonb, jsonb, integer) to authenticated;
