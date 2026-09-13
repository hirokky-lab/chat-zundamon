create or replace function public.claim_memory_processing(p_source_message_id text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  current_state text;
begin
  if current_user_id is null or p_source_message_id is null or pg_catalog.length(p_source_message_id) = 0 then
    raise exception 'invalid memory processing receipt';
  end if;

  insert into public.memory_processing (user_id, source_message_id, state, attempted_at, completed_at)
  values (current_user_id, p_source_message_id, 'pending', pg_catalog.now(), null)
  on conflict (user_id, source_message_id) do nothing;

  if found then return 'claimed'; end if;

  select state into current_state
  from public.memory_processing
  where user_id = current_user_id and source_message_id = p_source_message_id
  for update;

  if current_state = 'failed' then
    update public.memory_processing
    set state = 'pending', attempted_at = pg_catalog.now(), completed_at = null
    where user_id = current_user_id and source_message_id = p_source_message_id and state = 'failed';
    return 'claimed';
  end if;

  if current_state in ('pending', 'completed') then return current_state; end if;
  raise exception 'memory processing receipt unavailable';
end;
$$;

revoke all on function public.claim_memory_processing(text) from public, anon;
grant execute on function public.claim_memory_processing(text) to authenticated;
