-- The authoritative deletion count comes from active assets, not the chat snapshot: uploads can
-- be active before their message commit and must still be blocked by a whole-chat deletion.
-- Leave the legacy RPC signature in place for already-migrated callers; v2 returns the count.
create or replace function public.delete_whole_chat_v2(p_owner_id uuid,p_expected_revision bigint)
returns integer language plpgsql security definer set search_path=''
as $$
declare p uuid; blocked_count integer:=0;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  if not exists(select 1 from public.chat_snapshots where user_id=p_owner_id and revision=p_expected_revision for update) then
    raise exception 'snapshot revision mismatch' using errcode='40001';
  end if;
  for p in select id from public.photo_assets where owner_id=p_owner_id and state='active' loop
    perform public.request_photo_delete(p_owner_id,p,'chat_deleted');
    blocked_count:=blocked_count+1;
  end loop;
  delete from public.chat_snapshots where user_id=p_owner_id;
  return blocked_count;
end;
$$;

revoke all on function public.delete_whole_chat_v2(uuid,bigint) from public,anon,authenticated;
grant execute on function public.delete_whole_chat_v2(uuid,bigint) to service_role;
