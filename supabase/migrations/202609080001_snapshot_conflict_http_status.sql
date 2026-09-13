-- Optimistic revision conflicts are not transaction serialization failures.
-- Return HTTP 409 so PostgREST does not retry the same stale revision.
do $$
declare definition text;
begin
  select pg_get_functiondef('public.save_chat_snapshot_reconciled(uuid,bigint,jsonb)'::regprocedure)
    into definition;
  execute replace(definition, 'errcode=''40001''', 'errcode=''PT409''');
end;
$$;
