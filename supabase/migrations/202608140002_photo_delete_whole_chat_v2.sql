-- 202608140001 is already catalogued by some local databases. Do not rewrite it: retain its
-- void legacy RPC for those callers and add the counted RPC under a new identity.
alter table public.photo_deletion_outbox
  add column if not exists snapshot_revision bigint not null default 0 check (snapshot_revision >= 0);

create or replace function public.delete_whole_chat(p_owner_id uuid,p_expected_revision bigint)
returns void language plpgsql security definer set search_path=''
as $$
declare p uuid;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  if not exists(select 1 from public.chat_snapshots where user_id=p_owner_id and revision=p_expected_revision for update) then
    raise exception 'snapshot revision mismatch' using errcode='40001';
  end if;
  for p in select id from public.photo_assets where owner_id=p_owner_id and state='active' loop
    perform public.request_photo_delete(p_owner_id,p,'chat_deleted');
    update public.photo_deletion_outbox set snapshot_revision=p_expected_revision+1
      where owner_id=p_owner_id and photo_id=p and state<>'verified';
  end loop;
  delete from public.chat_snapshots where user_id=p_owner_id;
end;
$$;

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
    update public.photo_deletion_outbox set snapshot_revision=p_expected_revision+1
      where owner_id=p_owner_id and photo_id=p and state<>'verified';
    blocked_count:=blocked_count+1;
  end loop;
  delete from public.chat_snapshots where user_id=p_owner_id;
  return blocked_count;
end;
$$;

revoke all on function public.delete_whole_chat(uuid,bigint) from public,anon,authenticated;
revoke all on function public.delete_whole_chat_v2(uuid,bigint) from public,anon,authenticated;
grant execute on function public.delete_whole_chat(uuid,bigint) to service_role;
grant execute on function public.delete_whole_chat_v2(uuid,bigint) to service_role;
