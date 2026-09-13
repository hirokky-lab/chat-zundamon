-- Dedicated Gmail credentials; no authenticated/anon access to encrypted tokens.
create table public.google_gmail_connections (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 generation uuid not null default gen_random_uuid(), payload text,
 updated_at timestamptz not null default now()
);
create table public.google_gmail_attempts (
 state_hash text primary key, owner_id uuid not null references auth.users(id) on delete cascade,
 generation uuid not null, payload text not null, expires_at timestamptz not null
);
alter table public.google_gmail_connections enable row level security;
alter table public.google_gmail_attempts enable row level security;
revoke all on public.google_gmail_connections,public.google_gmail_attempts from public,anon,authenticated,service_role;
create or replace function public.server_gmail_rpc(p_owner_id uuid,p_operation text,p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.google_gmail_connections; a public.google_gmail_attempts;
begin
 if p_operation='consume' then
  delete from public.google_gmail_attempts where state_hash=p_args->>'stateHash' returning * into a;
  if a.owner_id is null or a.expires_at<=now() then return null; end if;
  return jsonb_build_object('ownerId',a.owner_id,'generation',a.generation,'payload',a.payload,'expiresAt',a.expires_at);
 end if;
 if p_owner_id is null then raise exception 'owner required'; end if;
 if p_operation='get' then
  select * into c from public.google_gmail_connections where owner_id=p_owner_id;
  if c.owner_id is null then return null; end if;
  return jsonb_build_object('generation',c.generation,'payload',c.payload);
 elsif p_operation='begin' then
  if length(p_args->>'stateHash')<>64 or length(p_args->>'payload')>16000 or (p_args->>'expiresAt')::timestamptz>now()+interval '6 minutes' then raise exception 'invalid attempt'; end if;
  insert into public.google_gmail_connections(owner_id) values(p_owner_id) on conflict(owner_id) do update set generation=gen_random_uuid(),updated_at=now() returning * into c;
  delete from public.google_gmail_attempts where owner_id=p_owner_id or expires_at<now();
  insert into public.google_gmail_attempts values(p_args->>'stateHash',p_owner_id,c.generation,p_args->>'payload',(p_args->>'expiresAt')::timestamptz);
  return '{}'::jsonb;
 elsif p_operation='save' then
  if length(p_args->>'payload')>16000 then raise exception 'invalid payload'; end if;
  update public.google_gmail_connections set payload=p_args->>'payload',generation=gen_random_uuid(),updated_at=now() where owner_id=p_owner_id and generation=(p_args->>'generation')::uuid;
  if not found then raise exception 'stale connection'; end if;
  return '{}'::jsonb;
 elsif p_operation='disconnect' then
  update public.google_gmail_connections set generation=gen_random_uuid(),payload=null,updated_at=now() where owner_id=p_owner_id;
  delete from public.google_gmail_attempts where owner_id=p_owner_id;
  return '{}'::jsonb;
 end if;
 raise exception 'unsupported operation';
end $$;
revoke all on function public.server_gmail_rpc(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.server_gmail_rpc(uuid,text,jsonb) to service_role;
