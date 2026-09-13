alter table public.chat_snapshots
  drop constraint if exists chat_snapshots_version_check;

alter table public.chat_snapshots
  add constraint chat_snapshots_version_check check (version in (1, 2));
