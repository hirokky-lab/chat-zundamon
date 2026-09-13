\set ON_ERROR_STOP on

create table if not exists public.task5_migration_sentinel (
  id text primary key,
  value text not null
);
insert into public.task5_migration_sentinel(id, value)
values ('preserved', 'before-002')
on conflict (id) do update set value = excluded.value;

do $$
begin
  if not exists (
    select 1 from supabase_migrations.schema_migrations where version = '202608140001'
  ) then
    raise exception 'incremental baseline is missing migration 202608140001';
  end if;
  if to_regprocedure('public.delete_whole_chat(uuid,bigint)') is null then
    raise exception 'incremental baseline is missing the legacy delete_whole_chat';
  end if;
  if to_regprocedure('public.delete_whole_chat_v2(uuid,bigint)') is null then
    raise exception 'incremental baseline is missing the 001 delete_whole_chat_v2';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'photo_deletion_outbox'
      and column_name = 'snapshot_revision'
  ) then
    raise exception 'incremental baseline unexpectedly contains the 002 column';
  end if;
end
$$;
