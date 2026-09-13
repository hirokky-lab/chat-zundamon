-- A memory mutation and its delivery receipt must commit as one unit.  A
-- completed receipt therefore proves the mutation is already durable.
create or replace function public.apply_memory_action_once(
  p_source_message_id text,
  p_action jsonb
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  receipt_state text;
  receipt_attempted_at timestamptz;
  action_type text;
  target_id uuid;
  candidate jsonb;
  target_count integer;
  distinct_target_count integer;
  now_at timestamptz := pg_catalog.now();
begin
  if current_user_id is null
    or p_source_message_id is null
    or pg_catalog.length(p_source_message_id) = 0
    or jsonb_typeof(p_action) <> 'object'
  then raise exception 'invalid memory action'; end if;

  -- The 5-minute lease is deliberately mirrored by MEMORY_ACTION_LEASE_MS in
  -- the server.  A crash before the mutation rolls this receipt back; an old
  -- pre-atomic pending receipt can be safely reclaimed after this lease.
  insert into public.memory_processing (user_id, source_message_id, state, attempted_at, completed_at)
  values (current_user_id, p_source_message_id, 'pending', now_at, null)
  on conflict (user_id, source_message_id) do nothing;

  if found then
    receipt_state := 'pending';
    receipt_attempted_at := now_at;
  else
    select state, attempted_at into receipt_state, receipt_attempted_at
    from public.memory_processing
    where user_id = current_user_id and source_message_id = p_source_message_id
    for update;

    if receipt_state = 'completed' then return 'completed'; end if;
    if receipt_state = 'pending' and receipt_attempted_at > now_at - interval '5 minutes' then return 'pending'; end if;

    update public.memory_processing
    set state = 'pending', attempted_at = now_at, completed_at = null
    where user_id = current_user_id and source_message_id = p_source_message_id;
  end if;

  action_type := p_action->>'type';
  if action_type not in ('add', 'replace', 'mark_past', 'mark_uncertain', 'forget') then
    raise exception 'invalid memory action';
  end if;

  if action_type in ('add', 'replace') then
    candidate := p_action->'candidate';
  elsif action_type = 'mark_past' then
    candidate := p_action->'replacement';
  end if;

  if candidate is not null and jsonb_typeof(candidate) <> 'null' then
    if jsonb_typeof(candidate) <> 'object'
      or not (candidate ?& array['kind','scope','content','normalizedContent','origin','sensitivity','importance','sourceMessageId','sourceOccurredAt','validFrom','validUntil','expiresAt','pinned','supersedesId'])
      or candidate->>'kind' not in ('preference','person','routine','work','event','schedule','shared')
      or candidate->>'scope' not in ('daily','work','shared')
      or candidate->>'origin' not in ('explicit','extracted','manual','voice')
      or candidate->>'sensitivity' not in ('normal','sensitive')
      or pg_catalog.length(candidate->>'content') not between 1 and 200
      or pg_catalog.length(candidate->>'normalizedContent') not between 1 and 200
      or candidate->>'importance' !~ '^[1-5]$'
      or candidate->>'pinned' not in ('true','false')
    then raise exception 'invalid memory candidate'; end if;
    if exists (
      select 1 from public.memory_tombstones
      where user_id = current_user_id
        and normalized_fingerprint = candidate->>'normalizedContent'
        and released_at is null
    ) then raise exception 'memory candidate blocked'; end if;
  end if;

  if action_type = 'add' then
    if candidate is null or jsonb_typeof(candidate) = 'null' then raise exception 'invalid memory candidate'; end if;
    insert into public.memories (
      user_id, id, kind, scope, content, content_normalized, status, origin, sensitivity, importance,
      source_message_id, source_occurred_at, valid_from, valid_until, expires_at, pinned, supersedes_id, created_at, updated_at
    ) values (
      current_user_id, pg_catalog.gen_random_uuid(), candidate->>'kind', candidate->>'scope', candidate->>'content', candidate->>'normalizedContent',
      'active', candidate->>'origin', candidate->>'sensitivity', (candidate->>'importance')::smallint,
      candidate->>'sourceMessageId', (candidate->>'sourceOccurredAt')::timestamptz, (candidate->>'validFrom')::timestamptz,
      (candidate->>'validUntil')::timestamptz, (candidate->>'expiresAt')::timestamptz, (candidate->>'pinned')::boolean,
      (candidate->>'supersedesId')::uuid, now_at, now_at
    ) on conflict (user_id, content_normalized) do update set
      kind = excluded.kind, scope = excluded.scope, content = excluded.content, status = 'active', origin = excluded.origin,
      sensitivity = excluded.sensitivity, importance = excluded.importance, source_message_id = excluded.source_message_id,
      source_occurred_at = excluded.source_occurred_at, valid_from = excluded.valid_from, valid_until = excluded.valid_until,
      expires_at = excluded.expires_at, pinned = excluded.pinned, supersedes_id = excluded.supersedes_id, updated_at = excluded.updated_at;

  elsif action_type in ('replace', 'mark_past') then
    if not (p_action ? 'targetMemoryId') then raise exception 'invalid memory target'; end if;
    target_id := (p_action->>'targetMemoryId')::uuid;
    perform 1 from public.memories
      where user_id = current_user_id and id = target_id and status in ('active', 'uncertain')
      for update;
    if not found then raise exception 'memory target unavailable'; end if;
    update public.memories set status = 'past', updated_at = now_at
      where user_id = current_user_id and id = target_id;
    if candidate is not null and jsonb_typeof(candidate) <> 'null' then
      insert into public.memories (
        user_id, id, kind, scope, content, content_normalized, status, origin, sensitivity, importance,
        source_message_id, source_occurred_at, valid_from, valid_until, expires_at, pinned, supersedes_id, created_at, updated_at
      ) values (
        current_user_id, pg_catalog.gen_random_uuid(), candidate->>'kind', candidate->>'scope', candidate->>'content', candidate->>'normalizedContent',
        'active', candidate->>'origin', candidate->>'sensitivity', (candidate->>'importance')::smallint,
        candidate->>'sourceMessageId', (candidate->>'sourceOccurredAt')::timestamptz, (candidate->>'validFrom')::timestamptz,
        (candidate->>'validUntil')::timestamptz, (candidate->>'expiresAt')::timestamptz, (candidate->>'pinned')::boolean,
        target_id, now_at, now_at
      );
    elsif action_type = 'replace' then
      raise exception 'invalid memory candidate';
    end if;

  elsif action_type = 'mark_uncertain' then
    if jsonb_typeof(p_action->'targetMemoryIds') <> 'array'
      or jsonb_array_length(p_action->'targetMemoryIds') not between 1 and 3
    then raise exception 'invalid memory targets'; end if;
    select count(*), count(distinct item.value) into target_count, distinct_target_count
    from jsonb_array_elements_text(p_action->'targetMemoryIds') item(value);
    if target_count <> distinct_target_count then
      raise exception 'invalid memory targets';
    end if;
    update public.memories set status = 'uncertain', updated_at = now_at
    where user_id = current_user_id and status in ('active', 'uncertain')
      and id::text in (select value from jsonb_array_elements_text(p_action->'targetMemoryIds') item(value));
    get diagnostics target_count = row_count;
    if target_count <> jsonb_array_length(p_action->'targetMemoryIds') then raise exception 'memory target unavailable'; end if;

  else
    if not (p_action ? 'targetMemoryId') or p_action->>'blockRelearning' not in ('true','false') then
      raise exception 'invalid memory target';
    end if;
    target_id := (p_action->>'targetMemoryId')::uuid;
    perform 1 from public.memories where user_id = current_user_id and id = target_id for update;
    if not found then raise exception 'memory target unavailable'; end if;
    if (p_action->>'blockRelearning')::boolean then
      insert into public.memory_tombstones (user_id, id, memory_id, normalized_fingerprint, created_at, released_at)
      select current_user_id, pg_catalog.gen_random_uuid(), id, content_normalized, now_at, null
      from public.memories where user_id = current_user_id and id = target_id;
    end if;
    delete from public.memories where user_id = current_user_id and id = target_id;
  end if;

  update public.memory_processing
  set state = 'completed', completed_at = now_at
  where user_id = current_user_id and source_message_id = p_source_message_id;
  return 'applied';
end;
$$;

revoke all on function public.apply_memory_action_once(text, jsonb) from public, anon;
grant execute on function public.apply_memory_action_once(text, jsonb) to authenticated;
