-- Memory writes are server operations. Browser JWTs keep owner-scoped reads but
-- cannot bypass the application policy, tombstone, receipt, or cost boundaries.
revoke insert, update, delete on table public.memories from authenticated;
revoke insert, update, delete on table public.memory_processing from authenticated;
revoke insert, update, delete on table public.memory_tombstones from authenticated;
revoke insert, update, delete on table public.memory_settings from authenticated;
revoke insert, update, delete on table public.automatic_memory_processing from authenticated;
revoke insert, update, delete on table public.automatic_memory_actions from authenticated;
revoke insert, update, delete on table public.automatic_memory_outbox from authenticated;
revoke insert, update, delete on table public.automatic_memory_extraction_attempts from authenticated;

grant select, insert, update, delete on table public.memories to service_role;
grant select, insert, update, delete on table public.memory_processing to service_role;
grant select, insert, update, delete on table public.memory_tombstones to service_role;
grant select, insert, update, delete on table public.memory_settings to service_role;
grant select, insert, update, delete on table public.automatic_memory_processing to service_role;
grant select, insert, update, delete on table public.automatic_memory_actions to service_role;
grant select, insert, update, delete on table public.automatic_memory_outbox to service_role;
grant select, insert, update, delete on table public.automatic_memory_extraction_attempts to service_role;
grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.migration_imports to service_role;

create or replace function public.server_memory_rpc(
  p_owner_id uuid,
  p_operation text,
  p_args jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if (select auth.role()) <> 'service_role' or p_owner_id is null or p_args is null then
    raise exception 'server memory mutation required' using errcode = '42501';
  end if;
  perform set_config('request.jwt.claim.sub', p_owner_id::text, true);

  case p_operation
    when 'replace_memory' then
      select to_jsonb(public.replace_memory((p_args->>'p_target_id')::uuid, p_args->'p_candidate')) into result;
    when 'release_memory_tombstone' then
      result := to_jsonb(public.release_memory_tombstone((p_args->>'p_tombstone_id')::uuid));
    when 'forget_memory' then
      result := to_jsonb(public.forget_memory((p_args->>'p_target_id')::uuid, (p_args->>'p_block_relearning')::boolean));
    when 'claim_memory_processing' then
      result := to_jsonb(public.claim_memory_processing(p_args->>'p_source_message_id'));
    when 'apply_memory_action_once' then
      result := to_jsonb(public.apply_memory_action_once(p_args->>'p_source_message_id', p_args->'p_action'));
    when 'claim_automatic_memory_processing' then
      result := public.claim_automatic_memory_processing(p_args->>'p_source_message_id');
    when 'get_automatic_memory_outbox' then
      result := public.get_automatic_memory_outbox(p_args->>'p_source_message_id');
    when 'save_automatic_memory_outbox' then
      result := public.save_automatic_memory_outbox(
        p_args->>'p_source_message_id', p_args->'p_action_plan', p_args->'p_usage', (p_args->>'p_attempt_index')::integer
      );
    when 'mark_automatic_memory_usage_settled' then
      perform public.mark_automatic_memory_usage_settled(p_args->>'p_source_message_id'); result := 'null'::jsonb;
    when 'clear_automatic_memory_outbox' then
      perform public.clear_automatic_memory_outbox(p_args->>'p_source_message_id'); result := 'null'::jsonb;
    when 'get_latest_automatic_memory_attempt' then
      result := public.get_latest_automatic_memory_attempt(p_args->>'p_source_message_id');
    when 'prepare_automatic_memory_attempt' then
      result := public.prepare_automatic_memory_attempt(p_args->>'p_source_message_id');
    when 'set_automatic_memory_attempt_state' then
      perform public.set_automatic_memory_attempt_state(
        p_args->>'p_source_message_id', (p_args->>'p_attempt_index')::integer, p_args->>'p_state'
      ); result := 'null'::jsonb;
    when 'apply_automatic_memory_action_once' then
      result := to_jsonb(public.apply_automatic_memory_action_once(
        p_args->>'p_source_message_id', (p_args->>'p_action_index')::smallint, p_args->'p_action'
      ));
    when 'finish_automatic_memory_processing' then
      result := public.finish_automatic_memory_processing(
        p_args->>'p_source_message_id', p_args->>'p_state', (p_args->>'p_applied_count')::smallint
      );
    when 'fail_voice_automatic_memory_processing' then
      result := public.fail_voice_automatic_memory_processing(
        p_args->>'p_source_message_id', (p_args->>'p_applied_count')::smallint
      );
    when 'has_active_voice_memory_processing' then
      result := to_jsonb(public.has_active_voice_memory_processing((p_args->>'p_cutoff')::timestamptz));
    when 'cleanup_stale_voice_memory_processing' then
      result := to_jsonb(public.cleanup_stale_voice_memory_processing((p_args->>'p_cutoff')::timestamptz));
    when 'patch_memory_settings' then
      select to_jsonb(public.patch_memory_settings(p_args->>'p_key', (p_args->>'p_enabled')::boolean)) into result;
    when 'import_profile_memory' then
      select to_jsonb(imported) into result from public.import_profile_memory(
        (p_args->>'p_import_id')::uuid, p_args->'p_bundle'
      ) imported;
    else
      raise exception 'unsupported server memory operation' using errcode = '22023';
  end case;
  return result;
end;
$$;

revoke all on function public.server_memory_rpc(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.server_memory_rpc(uuid, text, jsonb) to service_role;

revoke execute on function public.replace_memory(uuid, jsonb) from authenticated;
revoke execute on function public.release_memory_tombstone(uuid) from authenticated;
revoke execute on function public.forget_memory(uuid, boolean) from authenticated;
revoke execute on function public.claim_memory_processing(text) from authenticated;
revoke execute on function public.apply_memory_action_once(text, jsonb) from authenticated;
revoke execute on function public.claim_automatic_memory_processing(text) from authenticated;
revoke execute on function public.get_automatic_memory_outbox(text) from authenticated;
revoke execute on function public.save_automatic_memory_outbox(text, jsonb, jsonb, integer) from authenticated;
revoke execute on function public.mark_automatic_memory_usage_settled(text) from authenticated;
revoke execute on function public.clear_automatic_memory_outbox(text) from authenticated;
revoke execute on function public.get_latest_automatic_memory_attempt(text) from authenticated;
revoke execute on function public.prepare_automatic_memory_attempt(text) from authenticated;
revoke execute on function public.set_automatic_memory_attempt_state(text, integer, text) from authenticated;
revoke execute on function public.apply_automatic_memory_action_once(text, smallint, jsonb) from authenticated;
revoke execute on function public.finish_automatic_memory_processing(text, text, smallint) from authenticated;
revoke execute on function public.fail_voice_automatic_memory_processing(text, smallint) from authenticated;
revoke execute on function public.has_active_voice_memory_processing(timestamptz) from authenticated;
revoke execute on function public.cleanup_stale_voice_memory_processing(timestamptz) from authenticated;
revoke execute on function public.patch_memory_settings(text, boolean) from authenticated;
revoke execute on function public.import_profile_memory(uuid, jsonb) from authenticated;

grant execute on function public.replace_memory(uuid, jsonb) to service_role;
grant execute on function public.release_memory_tombstone(uuid) to service_role;
grant execute on function public.forget_memory(uuid, boolean) to service_role;
grant execute on function public.claim_memory_processing(text) to service_role;
grant execute on function public.apply_memory_action_once(text, jsonb) to service_role;
grant execute on function public.claim_automatic_memory_processing(text) to service_role;
grant execute on function public.get_automatic_memory_outbox(text) to service_role;
grant execute on function public.save_automatic_memory_outbox(text, jsonb, jsonb, integer) to service_role;
grant execute on function public.mark_automatic_memory_usage_settled(text) to service_role;
grant execute on function public.clear_automatic_memory_outbox(text) to service_role;
grant execute on function public.get_latest_automatic_memory_attempt(text) to service_role;
grant execute on function public.prepare_automatic_memory_attempt(text) to service_role;
grant execute on function public.set_automatic_memory_attempt_state(text, integer, text) to service_role;
grant execute on function public.apply_automatic_memory_action_once(text, smallint, jsonb) to service_role;
grant execute on function public.finish_automatic_memory_processing(text, text, smallint) to service_role;
grant execute on function public.fail_voice_automatic_memory_processing(text, smallint) to service_role;
grant execute on function public.has_active_voice_memory_processing(timestamptz) to service_role;
grant execute on function public.cleanup_stale_voice_memory_processing(timestamptz) to service_role;
grant execute on function public.patch_memory_settings(text, boolean) to service_role;
grant execute on function public.import_profile_memory(uuid, jsonb) to service_role;
