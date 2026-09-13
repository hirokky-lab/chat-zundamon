-- Owner review is a separate, fail-closed gate.  This migration deliberately
-- does not change tombstone or relearning behavior.
alter table public.memories
  add column if not exists review_state text not null default 'eligible'
    check (review_state in ('eligible', 'needs_review')),
  add column if not exists owner_reviewed_at timestamptz;

update public.memories
set review_state = 'needs_review'
where review_state = 'eligible'
  and owner_reviewed_at is null
  and sensitivity = 'sensitive'
  and (origin = 'extracted' or (origin = 'voice' and not pinned));

create or replace function public.enforce_memory_review_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.review_state <> 'needs_review'
    and new.owner_reviewed_at is null
    and new.sensitivity = 'sensitive'
    and (new.origin = 'extracted' or (new.origin = 'voice' and not new.pinned)) then
    new.review_state := 'needs_review';
  end if;
  return new;
end;
$$;

drop trigger if exists memories_review_state_boundary on public.memories;
create trigger memories_review_state_boundary
before insert or update of origin, sensitivity, pinned, review_state, owner_reviewed_at on public.memories
for each row execute function public.enforce_memory_review_state();

create or replace function public.keep_memory(p_owner_id uuid, p_target_id uuid)
returns public.memories
language plpgsql
security definer
set search_path = ''
as $$
declare target public.memories%rowtype;
begin
  if (select auth.role()) <> 'service_role' or p_owner_id is null or p_target_id is null then
    raise exception 'server memory keep required' using errcode = '42501';
  end if;
  select * into target from public.memories
  where user_id = p_owner_id and id = p_target_id for update;
  if not found then raise exception 'memory not found' using errcode = 'P0002'; end if;
  if target.review_state = 'needs_review' then
    update public.memories set review_state = 'eligible', owner_reviewed_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where user_id = p_owner_id and id = p_target_id returning * into target;
    return target;
  end if;
  if target.review_state = 'eligible' and target.owner_reviewed_at is not null then return target; end if;
  raise exception 'memory is not awaiting owner review' using errcode = 'P0002';
end;
$$;

revoke all on function public.enforce_memory_review_state() from public, anon, authenticated;
revoke all on function public.keep_memory(uuid, uuid) from public, anon, authenticated;
grant execute on function public.keep_memory(uuid, uuid) to service_role;
