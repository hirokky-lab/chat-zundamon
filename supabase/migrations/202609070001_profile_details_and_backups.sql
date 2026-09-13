-- Optional owner profile fields; existing profiles remain compatible.
alter table public.profiles
  add column occupation text check (occupation is null or char_length(occupation) <= 120),
  add column region text check (region is null or char_length(region) <= 120);

-- Encrypted project backups are server-only. No public URL or browser access.
insert into storage.buckets (id, name, public, allowed_mime_types)
values ('zundamon-backups', 'zundamon-backups', false, array['application/json'])
on conflict (id) do update set public = false, allowed_mime_types = excluded.allowed_mime_types;

-- Restrictive policies also block accidental grants from broader object policies.
create policy zundamon_backups_server_only on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'zundamon-backups')
  with check (bucket_id <> 'zundamon-backups');
create policy zundamon_backup_bucket_server_only on storage.buckets
  as restrictive for all to anon, authenticated
  using (id <> 'zundamon-backups')
  with check (id <> 'zundamon-backups');
