create or replace function public.fail_voice_automatic_memory_processing(
  p_source_message_id text,
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
    or p_source_message_id !~ '^voice:[a-f0-9]{64}$'
    or p_applied_count < 0
    or p_applied_count > 3 then
    raise exception 'invalid voice memory failure';
  end if;

  select * into receipt from public.automatic_memory_processing
  where user_id = owner_id and source_message_id = p_source_message_id for update;
  if not found then raise exception 'automatic memory receipt not found'; end if;
  if receipt.state = 'completed' then
    return pg_catalog.jsonb_build_object('state', receipt.state, 'appliedCount', receipt.applied_count);
  end if;

  delete from public.automatic_memory_outbox
  where user_id = owner_id and source_message_id = p_source_message_id;
  update public.automatic_memory_processing
  set state = 'failed', applied_count = p_applied_count, completed_at = null, outbox_ref = null
  where user_id = owner_id and source_message_id = p_source_message_id and state <> 'completed'
  returning * into receipt;
  return pg_catalog.jsonb_build_object('state', receipt.state, 'appliedCount', receipt.applied_count);
end;
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

  select pg_catalog.count(*)::integer into cleaned
  from public.automatic_memory_processing receipt
  where receipt.user_id = owner_id
    and receipt.source_message_id like 'voice:%'
    and receipt.attempted_at < p_cutoff
    and (
      receipt.state = 'pending'
      or (receipt.state = 'failed' and (
        receipt.outbox_ref is not null
        or exists (
          select 1 from public.automatic_memory_outbox outbox
          where outbox.user_id = receipt.user_id
            and outbox.source_message_id = receipt.source_message_id
        )
      ))
    );

  delete from public.automatic_memory_outbox outbox using public.automatic_memory_processing receipt
  where outbox.user_id = owner_id and outbox.source_message_id like 'voice:%'
    and receipt.user_id = outbox.user_id and receipt.source_message_id = outbox.source_message_id
    and receipt.state in ('pending', 'failed') and receipt.attempted_at < p_cutoff;
  update public.automatic_memory_processing
  set state = 'failed', completed_at = null, outbox_ref = null
  where user_id = owner_id and state in ('pending', 'failed')
    and source_message_id like 'voice:%' and attempted_at < p_cutoff;
  return cleaned;
end;
$$;

revoke all on function public.fail_voice_automatic_memory_processing(text, smallint) from public, anon;
revoke all on function public.cleanup_stale_voice_memory_processing(timestamptz) from public, anon;
grant execute on function public.fail_voice_automatic_memory_processing(text, smallint) to authenticated;
grant execute on function public.cleanup_stale_voice_memory_processing(timestamptz) to authenticated;
