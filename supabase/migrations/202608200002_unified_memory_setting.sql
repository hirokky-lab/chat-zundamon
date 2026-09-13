-- A single owner setting controls all memory use. Existing detail settings are
-- normalized conservatively: only a fully enabled legacy row becomes ON.
alter table public.memory_settings
  add column if not exists memory_enabled boolean;

update public.memory_settings
set memory_enabled = case
  when automatic_memory_enabled is true and recall_memory_enabled is true and voice_memory_enabled is true then true
  else false
end
where memory_enabled is null;

alter table public.memory_settings
  alter column memory_enabled set default true,
  alter column memory_enabled set not null;

create or replace function public.patch_memory_settings(p_key text, p_enabled boolean)
returns public.memory_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  result public.memory_settings%rowtype;
begin
  if owner_id is null or p_key <> 'memory_enabled' or p_enabled is null then
    raise exception 'invalid memory settings patch';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text || ':memory', 0));
  insert into public.memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled, voice_memory_enabled, memory_enabled, updated_at)
  values (owner_id, true, true, true, true, pg_catalog.now())
  on conflict (user_id) do nothing;
  update public.memory_settings set memory_enabled = p_enabled, updated_at = pg_catalog.now()
  where user_id = owner_id returning * into result;
  return result;
end;
$$;

-- The service-side mutation path cannot create a new memory while the master
-- control is OFF. Existing-memory management and tombstones are intact.
create or replace function public.enforce_memory_enabled_for_new_memory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare enabled boolean;
begin
  if new.origin not in ('explicit', 'extracted', 'voice') then return new; end if;
  select memory_enabled into enabled from public.memory_settings where user_id = new.user_id;
  if enabled is false then
    raise exception 'memory is disabled' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists memories_memory_enabled_boundary on public.memories;
create trigger memories_memory_enabled_boundary
before insert on public.memories
for each row execute function public.enforce_memory_enabled_for_new_memory();

revoke all on function public.patch_memory_settings(text, boolean) from public, anon;
grant execute on function public.patch_memory_settings(text, boolean) to service_role;
revoke all on function public.enforce_memory_enabled_for_new_memory() from public, anon, authenticated;
