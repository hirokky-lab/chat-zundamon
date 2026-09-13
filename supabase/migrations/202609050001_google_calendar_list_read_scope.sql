-- Preserve legacy connections while admitting only the additional read-only list scope.
-- PostgreSQL may name the original multi-column CHECK differently across installs.
begin;
do $$
declare
  scope_constraint text;
  matched integer;
begin
  select count(*), min(conname::text) into matched, scope_constraint
  from pg_catalog.pg_constraint
  where conrelid = 'public.google_calendar_tasks_connections'::regclass
    and contype = 'c'
    and pg_catalog.pg_get_constraintdef(oid) like '%granted_scopes%';
  if matched <> 1 then raise exception 'Expected one Google scope constraint'; end if;
  execute format('alter table public.google_calendar_tasks_connections drop constraint %I', scope_constraint);
end $$;
alter table public.google_calendar_tasks_connections
  add constraint google_calendar_tasks_read_scopes_check check (
    (service = 'calendar' and granted_scopes in (
      '["openid", "https://www.googleapis.com/auth/calendar.events.readonly"]'::jsonb,
      '["openid", "https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"]'::jsonb
    ))
    or (service = 'tasks' and granted_scopes = '["openid", "https://www.googleapis.com/auth/tasks.readonly"]'::jsonb)
  );
commit;
