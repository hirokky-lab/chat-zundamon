-- The compatibility claim is not atomic with a memory mutation. Keep its
-- receipts legacy so only apply_memory_action_once can create/reclaim v2 work.
create or replace function public.claim_memory_processing(p_source_message_id text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  current_state text;
  current_version smallint;
begin
  if current_user_id is null or p_source_message_id is null or pg_catalog.length(p_source_message_id) = 0 then
    raise exception 'invalid memory processing receipt';
  end if;

  insert into public.memory_processing (user_id, source_message_id, state, attempted_at, completed_at, processing_version)
  values (current_user_id, p_source_message_id, 'pending', pg_catalog.now(), null, 1)
  on conflict (user_id, source_message_id) do nothing;
  if found then return 'claimed'; end if;

  select state, processing_version into current_state, current_version
  from public.memory_processing
  where user_id = current_user_id and source_message_id = p_source_message_id
  for update;

  if current_state = 'completed' then return 'completed'; end if;
  if current_version = 2 and current_state = 'pending' then return 'pending'; end if;
  return 'quarantined';
end;
$$;

revoke all on function public.claim_memory_processing(text) from public, anon;
grant execute on function public.claim_memory_processing(text) to authenticated;
