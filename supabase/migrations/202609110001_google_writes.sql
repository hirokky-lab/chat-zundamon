begin;
create table public.google_write_confirmations (
 id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
 payload text not null, state text not null default 'prepared' check(state in ('prepared','executing','succeeded','unknown','cancelled','expired')),
 expires_at timestamptz not null, result jsonb, updated_at timestamptz not null default now()
);
alter table public.google_write_confirmations enable row level security;
revoke all on public.google_write_confirmations from public,anon,authenticated,service_role;
create function public.server_google_write_rpc(p_owner_id uuid,p_operation text,p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.google_write_confirmations;
begin
 if p_owner_id is null then raise exception 'owner required'; end if;
 if p_operation='prepare' then
  if length(p_args->>'payload')>180000 or (p_args->>'expiresAt')::timestamptz>now()+interval '6 minutes' or (p_args->>'expiresAt')::timestamptz<=now() then raise exception 'invalid preparation'; end if;
  insert into public.google_write_confirmations(id,owner_id,payload,expires_at) values((p_args->>'id')::uuid,p_owner_id,p_args->>'payload',(p_args->>'expiresAt')::timestamptz) returning * into r;
 else
  select * into r from public.google_write_confirmations where id=(p_args->>'id')::uuid and owner_id=p_owner_id for update;
  if r.id is null then return null; end if;
  if r.state='prepared' and r.expires_at<=now() then update public.google_write_confirmations set state='expired' where id=r.id returning * into r; end if;
  if r.state='executing' and r.updated_at<now()-interval '1 minute' then update public.google_write_confirmations set state='unknown' where id=r.id returning * into r; end if;
  if p_operation='claim' then
   if r.state<>'prepared' then return null; end if;
   update public.google_write_confirmations set state='executing',updated_at=now() where id=r.id returning * into r;
  elsif p_operation='cancel' and r.state='prepared' then
   update public.google_write_confirmations set state='cancelled',updated_at=now() where id=r.id returning * into r;
  elsif p_operation='finish' then
   if r.state<>'executing' or p_args->>'state' not in ('succeeded','unknown') then raise exception 'invalid finish'; end if;
   update public.google_write_confirmations set state=p_args->>'state',result=p_args->'result',updated_at=now() where id=r.id returning * into r;
  elsif p_operation not in ('get','cancel') then raise exception 'unsupported operation'; end if;
 end if;
 return jsonb_build_object('id',r.id,'payload',r.payload,'state',r.state,'expiresAt',r.expires_at,'result',r.result);
end $$;
revoke all on function public.server_google_write_rpc(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.server_google_write_rpc(uuid,text,jsonb) to service_role;
commit;
