\set ON_ERROR_STOP on

do $$
declare
  legacy_return text;
  versioned_return text;
begin
  select p.prorettype::regtype::text into legacy_return
  from pg_proc p where p.oid = to_regprocedure('public.delete_whole_chat(uuid,bigint)');
  select p.prorettype::regtype::text into versioned_return
  from pg_proc p where p.oid = to_regprocedure('public.delete_whole_chat_v2(uuid,bigint)');

  if legacy_return <> 'void' then
    raise exception 'legacy delete_whole_chat return changed: %', legacy_return;
  end if;
  if versioned_return <> 'integer' then
    raise exception 'delete_whole_chat_v2 return mismatch: %', versioned_return;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'photo_deletion_outbox'
      and column_name = 'snapshot_revision' and data_type = 'bigint' and is_nullable = 'NO'
  ) then
    raise exception 'snapshot_revision was not added incrementally';
  end if;
  if (select value from public.task5_migration_sentinel where id = 'preserved') <> 'before-002' then
    raise exception 'pre-existing data changed during incremental migration';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '202608140002') <> 1 then
    raise exception 'migration 202608140002 was not recorded exactly once';
  end if;
  if has_function_privilege('authenticated', 'public.delete_whole_chat(uuid,bigint)', 'execute')
    or has_function_privilege('authenticated', 'public.delete_whole_chat_v2(uuid,bigint)', 'execute') then
    raise exception 'authenticated retained photo deletion execute privilege';
  end if;
  if not has_function_privilege('service_role', 'public.delete_whole_chat(uuid,bigint)', 'execute')
    or not has_function_privilege('service_role', 'public.delete_whole_chat_v2(uuid,bigint)', 'execute') then
    raise exception 'service_role is missing photo deletion execute privilege';
  end if;
end
$$;

drop table public.task5_migration_sentinel;
