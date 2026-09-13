-- Relearning blocks are enforced at the final database mutation boundary.
-- Every memory/tombstone mutation for one owner shares a transaction lock, so
-- a concurrent save cannot pass a stale application-side tombstone snapshot.

create or replace function public.memory_normalize_content(p_text text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.regexp_replace(normalize(p_text, NFKC), '[、。[:space:]]+', '', 'g')
$$;

create or replace function public.memory_tombstone_canonical(p_text text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.replace(
      pg_catalog.replace(
        pg_catalog.replace(public.memory_normalize_content(p_text), 'お昼ご飯', '昼食'),
        '昼ご飯', '昼食'
      ),
      'ランチ', '昼食'
    ),
    '食べて(き|い)た|食べました|食べてる', '食べた', 'g'
  )
$$;

create or replace function public.memory_tombstone_parts(p_text text)
returns text[]
language sql
immutable
strict
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(part order by part), '{}'::text[])
  from pg_catalog.unnest(pg_catalog.regexp_split_to_array(public.memory_tombstone_canonical(p_text), 'って|とは|から|まで|より|は|が|を|に|で|と|の')) part
  where pg_catalog.length(part) >= 2
$$;

create or replace function public.memory_bigram_dice(p_left text, p_right text)
returns double precision
language sql
immutable
strict
set search_path = ''
as $$
  with
    left_grams as (
      select distinct pg_catalog.substr(p_left, n, 2) gram
      from pg_catalog.generate_series(1, greatest(pg_catalog.length(p_left) - 1, 0)) n
    ),
    right_grams as (
      select distinct pg_catalog.substr(p_right, n, 2) gram
      from pg_catalog.generate_series(1, greatest(pg_catalog.length(p_right) - 1, 0)) n
    ),
    counts as (
      select
        (select count(*) from left_grams)::double precision left_count,
        (select count(*) from right_grams)::double precision right_count,
        (select count(*) from left_grams inner join right_grams using (gram))::double precision overlap_count
    )
  select case when left_count = 0 or right_count = 0 then 0
    else (2 * overlap_count) / (left_count + right_count) end
  from counts
$$;

create or replace function public.memory_tombstone_matches(p_candidate text, p_fingerprint text)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  candidate text := public.memory_tombstone_canonical(p_candidate);
  fingerprint text := public.memory_tombstone_canonical(p_fingerprint);
  candidate_parts text[];
  fingerprint_parts text[];
begin
  if candidate = fingerprint then return true; end if;
  candidate_parts := public.memory_tombstone_parts(candidate);
  fingerprint_parts := public.memory_tombstone_parts(fingerprint);
  if pg_catalog.cardinality(candidate_parts) >= 2
    and pg_catalog.cardinality(candidate_parts) = pg_catalog.cardinality(fingerprint_parts)
    and candidate_parts = fingerprint_parts then return true;
  end if;
  return least(pg_catalog.length(candidate), pg_catalog.length(fingerprint)) >= 6
    and pg_catalog.abs(pg_catalog.length(candidate) - pg_catalog.length(fingerprint))
      <= pg_catalog.ceil(greatest(pg_catalog.length(candidate), pg_catalog.length(fingerprint)) * 0.35)
    and public.memory_bigram_dice(candidate, fingerprint) >= 0.72;
end;
$$;

create or replace function public.lock_memory_owner(p_owner_id uuid)
returns void
language sql
volatile
strict
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 8042026))
$$;

create or replace function public.enforce_memory_tombstone_boundary()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.lock_memory_owner(new.user_id);
  new.content_normalized := public.memory_normalize_content(new.content);
  if new.status = 'active' and exists (
    select 1 from public.memory_tombstones tombstone
    where tombstone.user_id = new.user_id
      and tombstone.released_at is null
      and public.memory_tombstone_matches(new.content, tombstone.normalized_fingerprint)
  ) then
    raise exception 'memory candidate blocked' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.lock_memory_tombstone_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.lock_memory_owner(new.user_id);
  return new;
end;
$$;

drop trigger if exists memories_tombstone_boundary on public.memories;
create trigger memories_tombstone_boundary
before insert or update of user_id, content, content_normalized, status on public.memories
for each row execute function public.enforce_memory_tombstone_boundary();

drop trigger if exists memory_tombstones_owner_lock on public.memory_tombstones;
create trigger memory_tombstones_owner_lock
before insert or update of user_id, normalized_fingerprint, released_at on public.memory_tombstones
for each row execute function public.lock_memory_tombstone_owner();

create or replace function public.forget_memory(p_target_id uuid, p_block_relearning boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target public.memories%rowtype;
begin
  if current_user_id is null or p_target_id is null or p_block_relearning is null then return false; end if;
  perform public.lock_memory_owner(current_user_id);
  select * into target from public.memories
  where user_id = current_user_id and id = p_target_id for update;
  if not found then return false; end if;

  if p_block_relearning then
    insert into public.memory_tombstones (user_id, id, memory_id, normalized_fingerprint, created_at, released_at)
    values (current_user_id, pg_catalog.gen_random_uuid(), target.id, target.content_normalized, pg_catalog.now(), null);
    delete from public.memories memory
    where memory.user_id = current_user_id
      and public.memory_tombstone_matches(memory.content, target.content_normalized);
  else
    delete from public.memories where user_id = current_user_id and id = p_target_id;
  end if;
  return true;
end;
$$;

revoke all on function public.memory_normalize_content(text) from public, anon, authenticated;
revoke all on function public.memory_tombstone_canonical(text) from public, anon, authenticated;
revoke all on function public.memory_tombstone_parts(text) from public, anon, authenticated;
revoke all on function public.memory_bigram_dice(text, text) from public, anon, authenticated;
revoke all on function public.memory_tombstone_matches(text, text) from public, anon, authenticated;
revoke all on function public.lock_memory_owner(uuid) from public, anon, authenticated;
revoke all on function public.enforce_memory_tombstone_boundary() from public, anon, authenticated;
revoke all on function public.lock_memory_tombstone_owner() from public, anon, authenticated;
revoke all on function public.forget_memory(uuid, boolean) from public, anon, authenticated;
grant execute on function public.memory_normalize_content(text) to service_role;
grant execute on function public.memory_tombstone_canonical(text) to service_role;
grant execute on function public.memory_tombstone_parts(text) to service_role;
grant execute on function public.memory_bigram_dice(text, text) to service_role;
grant execute on function public.memory_tombstone_matches(text, text) to service_role;
grant execute on function public.forget_memory(uuid, boolean) to service_role;
