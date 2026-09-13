alter table public.memories
  add column if not exists scope text not null default 'shared' check (scope in ('daily', 'work', 'shared')),
  add column if not exists status text not null default 'active' check (status in ('active', 'past', 'uncertain', 'expired')),
  add column if not exists origin text not null default 'explicit' check (origin in ('explicit', 'extracted', 'manual', 'voice')),
  add column if not exists sensitivity text not null default 'normal' check (sensitivity in ('normal', 'sensitive')),
  add column if not exists source_message_id text,
  add column if not exists source_occurred_at timestamptz,
  add column if not exists valid_from timestamptz,
  add column if not exists valid_until timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists pinned boolean not null default true,
  add column if not exists supersedes_id uuid;

alter table public.memories drop constraint if exists memories_kind_check;
update public.memories set kind = 'routine' where kind = 'ongoing';
alter table public.memories
  add constraint memories_kind_check check (kind in ('preference', 'person', 'routine', 'work', 'event', 'schedule', 'shared'));

create table public.memory_processing (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_message_id text not null,
  state text not null check (state in ('pending', 'completed', 'failed')),
  attempted_at timestamptz not null,
  completed_at timestamptz,
  primary key (user_id, source_message_id)
);

create table public.memory_tombstones (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  memory_id uuid,
  normalized_fingerprint text not null,
  created_at timestamptz not null,
  released_at timestamptz,
  primary key (user_id, id)
);

create index memories_user_status_priority_idx
  on public.memories (user_id, status, importance desc, updated_at desc);
create index memory_processing_user_attempted_idx
  on public.memory_processing (user_id, attempted_at desc);
create index memory_tombstones_user_fingerprint_idx
  on public.memory_tombstones (user_id, normalized_fingerprint);

alter table public.memory_processing enable row level security;
alter table public.memory_tombstones enable row level security;

revoke all on table public.memories from public, anon, authenticated;
revoke all on table public.memory_processing from public, anon, authenticated;
revoke all on table public.memory_tombstones from public, anon, authenticated;

grant select, insert, update, delete on table public.memories to authenticated;
grant select, insert, update, delete on table public.memory_processing to authenticated;
grant select, insert, update, delete on table public.memory_tombstones to authenticated;

create policy memory_processing_select_own on public.memory_processing
  for select to authenticated using ((select auth.uid()) = user_id);
create policy memory_processing_insert_own on public.memory_processing
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy memory_processing_update_own on public.memory_processing
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy memory_processing_delete_own on public.memory_processing
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy memory_tombstones_select_own on public.memory_tombstones
  for select to authenticated using ((select auth.uid()) = user_id);
create policy memory_tombstones_insert_own on public.memory_tombstones
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy memory_tombstones_update_own on public.memory_tombstones
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy memory_tombstones_delete_own on public.memory_tombstones
  for delete to authenticated using ((select auth.uid()) = user_id);
