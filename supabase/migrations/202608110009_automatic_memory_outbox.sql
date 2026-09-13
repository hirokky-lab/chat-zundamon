create table public.automatic_memory_outbox (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_message_id text not null,
  outbox_ref uuid not null default gen_random_uuid() unique,
  action_plan jsonb not null check (jsonb_typeof(action_plan) = 'array' and jsonb_array_length(action_plan) <= 3),
  usage_started_at timestamptz,
  usage_ended_at timestamptz,
  memory_input_tokens integer check (memory_input_tokens is null or memory_input_tokens >= 0),
  memory_cached_input_tokens integer check (memory_cached_input_tokens is null or memory_cached_input_tokens >= 0),
  memory_cache_write_tokens integer check (memory_cache_write_tokens is null or memory_cache_write_tokens >= 0),
  memory_output_tokens integer check (memory_output_tokens is null or memory_output_tokens >= 0),
  usage_settled boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, source_message_id),
  foreign key (user_id, source_message_id)
    references public.automatic_memory_processing(user_id, source_message_id) on delete cascade,
  check ((usage_started_at is null) = (usage_ended_at is null)),
  check ((usage_started_at is null) = (memory_input_tokens is null)),
  check ((usage_started_at is null) = (memory_cached_input_tokens is null)),
  check ((usage_started_at is null) = (memory_cache_write_tokens is null)),
  check ((usage_started_at is null) = (memory_output_tokens is null))
);

alter table public.automatic_memory_outbox enable row level security;
revoke all on table public.automatic_memory_outbox from public, anon, authenticated;

alter table public.automatic_memory_processing add column outbox_ref uuid;

insert into public.automatic_memory_outbox
  (user_id, source_message_id, action_plan, usage_settled, created_at)
select user_id, source_message_id, action_plan, true, attempted_at
from public.automatic_memory_processing
where action_plan is not null;

update public.automatic_memory_processing receipt
set outbox_ref = outbox.outbox_ref
from public.automatic_memory_outbox outbox
where receipt.user_id = outbox.user_id
  and receipt.source_message_id = outbox.source_message_id;

update public.automatic_memory_processing set action_plan = null where action_plan is not null;
alter table public.automatic_memory_processing drop column action_plan;

drop function public.set_automatic_memory_action_plan(text, jsonb);

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
    'usageSettled', outbox.usage_settled
  );
end;
$$;

create or replace function public.save_automatic_memory_outbox(
  p_source_message_id text,
  p_action_plan jsonb,
  p_usage jsonb
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
    )) then
    raise exception 'invalid automatic memory outbox';
  end if;

  perform 1 from public.automatic_memory_processing
  where user_id = owner_id and source_message_id = p_source_message_id and state = 'pending'
  for update;
  if not found then raise exception 'automatic memory receipt not pending'; end if;

  insert into public.automatic_memory_outbox (
    user_id, source_message_id, action_plan,
    usage_started_at, usage_ended_at, memory_input_tokens,
    memory_cached_input_tokens, memory_cache_write_tokens, memory_output_tokens
  ) values (
    owner_id, p_source_message_id, p_action_plan,
    (p_usage->>'startedAt')::timestamptz, (p_usage->>'endedAt')::timestamptz,
    (p_usage->>'memoryInputTokens')::integer, (p_usage->>'memoryCachedInputTokens')::integer,
    (p_usage->>'memoryCacheWriteTokens')::integer, (p_usage->>'memoryOutputTokens')::integer
  ) on conflict (user_id, source_message_id) do nothing;

  update public.automatic_memory_processing receipt
  set outbox_ref = outbox.outbox_ref
  from public.automatic_memory_outbox outbox
  where receipt.user_id = owner_id
    and receipt.source_message_id = p_source_message_id
    and outbox.user_id = receipt.user_id
    and outbox.source_message_id = receipt.source_message_id;

  return public.get_automatic_memory_outbox(p_source_message_id);
end;
$$;

create or replace function public.mark_automatic_memory_usage_settled(p_source_message_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare owner_id uuid := (select auth.uid());
begin
  if owner_id is null then raise exception 'invalid automatic memory outbox'; end if;
  update public.automatic_memory_outbox set usage_settled = true
  where user_id = owner_id and source_message_id = p_source_message_id;
  if not found then raise exception 'automatic memory outbox not found'; end if;
end;
$$;

create or replace function public.clear_automatic_memory_outbox(p_source_message_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare owner_id uuid := (select auth.uid());
begin
  if owner_id is null then raise exception 'invalid automatic memory outbox'; end if;
  delete from public.automatic_memory_outbox outbox using public.automatic_memory_processing receipt
  where outbox.user_id = owner_id and outbox.source_message_id = p_source_message_id
    and receipt.user_id = outbox.user_id and receipt.source_message_id = outbox.source_message_id
    and receipt.state = 'failed';
  update public.automatic_memory_processing set outbox_ref = null
  where user_id = owner_id and source_message_id = p_source_message_id and state = 'failed';
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
  select * into receipt from public.automatic_memory_processing
  where user_id = owner_id and source_message_id = p_source_message_id for update;
  if not found then raise exception 'automatic memory receipt not found'; end if;
  if receipt.state = 'completed' then
    return pg_catalog.jsonb_build_object('state', receipt.state, 'appliedCount', receipt.applied_count);
  end if;
  if p_state = 'completed' then
    delete from public.automatic_memory_outbox
    where user_id = owner_id and source_message_id = p_source_message_id;
  end if;
  update public.automatic_memory_processing
  set state = p_state,
      applied_count = p_applied_count,
      completed_at = case when p_state = 'completed' then now() else null end,
      outbox_ref = case when p_state = 'completed' then null else outbox_ref end
  where user_id = owner_id and source_message_id = p_source_message_id
  returning * into receipt;
  return pg_catalog.jsonb_build_object('state', receipt.state, 'appliedCount', receipt.applied_count);
end;
$$;

revoke all on function public.get_automatic_memory_outbox(text) from public, anon;
revoke all on function public.save_automatic_memory_outbox(text, jsonb, jsonb) from public, anon;
revoke all on function public.mark_automatic_memory_usage_settled(text) from public, anon;
revoke all on function public.clear_automatic_memory_outbox(text) from public, anon;
grant execute on function public.get_automatic_memory_outbox(text) to authenticated;
grant execute on function public.save_automatic_memory_outbox(text, jsonb, jsonb) to authenticated;
grant execute on function public.mark_automatic_memory_usage_settled(text) to authenticated;
grant execute on function public.clear_automatic_memory_outbox(text) to authenticated;
