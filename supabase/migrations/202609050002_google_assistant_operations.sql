-- Owner-only operation envelopes; no provider call is retried from executing/unknown.
create table public.google_assistant_operations (
 owner_id uuid not null references auth.users(id) on delete cascade,
 operation_id uuid not null,
 record jsonb not null check (jsonb_typeof(record) = 'object' and octet_length(record::text) <= 40000),
 state text not null check (state in ('prepared','executing','succeeded','cancelled','expired','conflict','unknown')),
 expires_at timestamptz not null,
 updated_at timestamptz not null default now(),
 primary key(owner_id,operation_id)
);
alter table public.google_assistant_operations enable row level security;
revoke all on public.google_assistant_operations from public,anon,authenticated,service_role;
create or replace function public.put_google_assistant_operation(p_owner_id uuid,p_record jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
 if (select auth.role()) <> 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 if p_record->>'ownerId' <> p_owner_id::text or p_record->>'state' <> 'prepared'
 or (p_record->>'expiresAt')::timestamptz <= now() or (p_record->>'expiresAt')::timestamptz > now()+interval '5 minutes 5 seconds'
 or length(p_record->>'signature') <> 43 or length(p_record->>'keyVersion') not between 1 and 100
 then raise exception 'Invalid operation'; end if;
 insert into public.google_assistant_operations(owner_id,operation_id,record,state,expires_at)
 values(p_owner_id,(p_record->>'operationId')::uuid,p_record,'prepared',(p_record->>'expiresAt')::timestamptz);
end;$$;
create or replace function public.get_google_assistant_operation(p_owner_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if (select auth.role()) <> 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 update public.google_assistant_operations set state='expired',updated_at=now() where owner_id=p_owner_id and operation_id=p_operation_id and state='prepared' and expires_at<=now();
 update public.google_assistant_operations set state='unknown',updated_at=now() where owner_id=p_owner_id and operation_id=p_operation_id and state='executing' and updated_at<now()-interval '1 minute';
 select record || jsonb_build_object('state',state) into result from public.google_assistant_operations where owner_id=p_owner_id and operation_id=p_operation_id;
 return result;
end;$$;
create or replace function public.transition_google_assistant_operation(p_owner_id uuid,p_operation_id uuid,p_from text,p_to text,p_result jsonb default null)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if (select auth.role()) <> 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 if not ((p_from='prepared' and p_to in ('executing','cancelled','expired')) or (p_from='executing' and p_to in ('succeeded','conflict','unknown'))) then return false; end if;
 update public.google_assistant_operations set state=p_to,updated_at=now(),record=case when p_result is null then record else record||jsonb_build_object('result',p_result) end
 where owner_id=p_owner_id and operation_id=p_operation_id and state=p_from
 and (p_to<>'executing' or expires_at>now());
 return found;
end;$$;
revoke all on function public.put_google_assistant_operation(uuid,jsonb),public.get_google_assistant_operation(uuid,uuid),public.transition_google_assistant_operation(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.put_google_assistant_operation(uuid,jsonb),public.get_google_assistant_operation(uuid,uuid),public.transition_google_assistant_operation(uuid,uuid,text,text,jsonb) to service_role;

-- Explicit purpose is attached to the one-time encrypted OAuth attempt.
alter table public.google_calendar_tasks_oauth_attempts add column purpose text not null default 'read' check(purpose in ('read','write'));
create or replace function public.create_google_assistant_oauth_attempt(
 p_owner_id uuid,p_service text,p_state_digest text,p_nonce_digest text,p_code_verifier_ciphertext text,p_code_verifier_iv text,p_code_verifier_tag text,p_key_version text,p_expires_at timestamptz,p_purpose text
) returns void language plpgsql security definer set search_path='' as $$
begin
 if (select auth.role()) <> 'service_role' or p_purpose<>'write' then raise exception 'Server required' using errcode='42501'; end if;
 insert into public.google_calendar_tasks_oauth_attempts(id,owner_id,service,state_digest,nonce_digest,code_verifier_ciphertext,code_verifier_iv,code_verifier_tag,key_version,expires_at,purpose)
 values(gen_random_uuid(),p_owner_id,p_service,p_state_digest,p_nonce_digest,decode(p_code_verifier_ciphertext,'base64'),decode(p_code_verifier_iv,'base64'),decode(p_code_verifier_tag,'base64'),p_key_version,p_expires_at,p_purpose);
end;$$;
create or replace function public.consume_google_calendar_tasks_oauth_attempt(p_owner_id uuid,p_state_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare attempt public.google_calendar_tasks_oauth_attempts;
begin
 if (select auth.role()) <> 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 update public.google_calendar_tasks_oauth_attempts set consumed_at=now() where owner_id=p_owner_id and state_digest=p_state_digest and consumed_at is null and expires_at>now() returning * into attempt;
 if not found then return null; end if;
 return jsonb_build_object('ownerId',attempt.owner_id,'service',attempt.service,'stateHash',attempt.state_digest,'nonceHash',attempt.nonce_digest,'codeVerifierCiphertext',encode(attempt.code_verifier_ciphertext,'base64'),'codeVerifierIv',encode(attempt.code_verifier_iv,'base64'),'codeVerifierTag',encode(attempt.code_verifier_tag,'base64'),'expiresAt',attempt.expires_at) || case when attempt.purpose='write' then jsonb_build_object('purpose','write') else '{}'::jsonb end;
end;$$;
revoke all on function public.create_google_assistant_oauth_attempt(uuid,text,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.create_google_assistant_oauth_attempt(uuid,text,text,text,text,text,text,text,timestamptz,text) to service_role;
alter table public.google_calendar_tasks_connections drop constraint google_calendar_tasks_read_scopes_check;
alter table public.google_calendar_tasks_connections add constraint google_calendar_tasks_read_scopes_check check (
 (service='calendar' and granted_scopes in (
 '["openid","https://www.googleapis.com/auth/calendar.events.readonly"]'::jsonb,
 '["openid","https://www.googleapis.com/auth/calendar.events.readonly","https://www.googleapis.com/auth/calendar.calendarlist.readonly"]'::jsonb,
 '["openid","https://www.googleapis.com/auth/calendar.events.readonly","https://www.googleapis.com/auth/calendar.calendarlist.readonly","https://www.googleapis.com/auth/calendar.events"]'::jsonb))
 or (service='tasks' and granted_scopes in (
 '["openid","https://www.googleapis.com/auth/tasks.readonly"]'::jsonb,
 '["openid","https://www.googleapis.com/auth/tasks.readonly","https://www.googleapis.com/auth/tasks"]'::jsonb))
);

-- Credential generations survive disconnect. Attempts capture one generation;
-- saving a callback is CAS, so neither disconnect nor a newer callback can be undone.
create table public.google_assistant_connection_generations (
 owner_id uuid not null references auth.users(id) on delete cascade,
 service text not null check(service in ('calendar','tasks')),
 generation uuid not null default gen_random_uuid(),
 primary key(owner_id,service)
);
alter table public.google_assistant_connection_generations enable row level security;
revoke all on public.google_assistant_connection_generations from public,anon,authenticated,service_role;
alter table public.google_calendar_tasks_connections add column generation uuid not null default gen_random_uuid();
insert into public.google_assistant_connection_generations(owner_id,service,generation) select owner_id,service,generation from public.google_calendar_tasks_connections;
alter table public.google_calendar_tasks_oauth_attempts add column connection_generation uuid;

create or replace function public.create_google_calendar_tasks_oauth_attempt(
 p_owner_id uuid,p_service text,p_state_digest text,p_nonce_digest text,p_code_verifier_ciphertext text,p_code_verifier_iv text,p_code_verifier_tag text,p_key_version text,p_expires_at timestamptz
) returns void language plpgsql security definer set search_path='' as $$
declare current_generation uuid;
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('google-connection:'||p_owner_id::text||':'||p_service,0));
 insert into public.google_assistant_connection_generations(owner_id,service) values(p_owner_id,p_service) on conflict do nothing;
 select generation into current_generation from public.google_assistant_connection_generations where owner_id=p_owner_id and service=p_service;
 insert into public.google_calendar_tasks_oauth_attempts(id,owner_id,service,state_digest,nonce_digest,code_verifier_ciphertext,code_verifier_iv,code_verifier_tag,key_version,expires_at,connection_generation)
 values(gen_random_uuid(),p_owner_id,p_service,p_state_digest,p_nonce_digest,decode(p_code_verifier_ciphertext,'base64'),decode(p_code_verifier_iv,'base64'),decode(p_code_verifier_tag,'base64'),p_key_version,p_expires_at,current_generation);
end;$$;
create or replace function public.create_google_assistant_oauth_attempt(
 p_owner_id uuid,p_service text,p_state_digest text,p_nonce_digest text,p_code_verifier_ciphertext text,p_code_verifier_iv text,p_code_verifier_tag text,p_key_version text,p_expires_at timestamptz,p_purpose text
) returns void language plpgsql security definer set search_path='' as $$
begin
 if (select auth.role()) is distinct from 'service_role' or p_purpose is distinct from 'write' then raise exception 'Server required' using errcode='42501'; end if;
 perform public.create_google_calendar_tasks_oauth_attempt(p_owner_id,p_service,p_state_digest,p_nonce_digest,p_code_verifier_ciphertext,p_code_verifier_iv,p_code_verifier_tag,p_key_version,p_expires_at);
 update public.google_calendar_tasks_oauth_attempts set purpose='write' where owner_id=p_owner_id and state_digest=p_state_digest;
end;$$;
create or replace function public.consume_google_calendar_tasks_oauth_attempt(p_owner_id uuid,p_state_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare attempt public.google_calendar_tasks_oauth_attempts;
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 update public.google_calendar_tasks_oauth_attempts set consumed_at=now() where owner_id=p_owner_id and state_digest=p_state_digest and consumed_at is null and expires_at>now() and connection_generation is not null returning * into attempt;
 if not found then return null; end if;
 return jsonb_build_object('ownerId',attempt.owner_id,'service',attempt.service,'stateHash',attempt.state_digest,'nonceHash',attempt.nonce_digest,'codeVerifierCiphertext',encode(attempt.code_verifier_ciphertext,'base64'),'codeVerifierIv',encode(attempt.code_verifier_iv,'base64'),'codeVerifierTag',encode(attempt.code_verifier_tag,'base64'),'expiresAt',attempt.expires_at,'connectionGeneration',attempt.connection_generation) || case when attempt.purpose='write' then jsonb_build_object('purpose','write') else '{}'::jsonb end;
end;$$;
create or replace function public.save_google_calendar_tasks_oauth_connection(
 p_owner_id uuid,p_service text,p_google_subject text,p_granted_scopes jsonb,p_refresh_token_ciphertext text,p_refresh_token_iv text,p_refresh_token_tag text,p_key_version text
) returns void language plpgsql security definer set search_path='' as $$
declare next_generation uuid := gen_random_uuid();
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('google-connection:'||p_owner_id::text||':'||p_service,0));
 insert into public.google_assistant_connection_generations(owner_id,service,generation) values(p_owner_id,p_service,next_generation) on conflict(owner_id,service) do update set generation=excluded.generation;
 insert into public.google_calendar_tasks_connections(owner_id,service,google_subject,granted_scopes,refresh_token_ciphertext,refresh_token_iv,refresh_token_tag,key_version,generation)
 values(p_owner_id,p_service,p_google_subject,p_granted_scopes,decode(p_refresh_token_ciphertext,'base64'),decode(p_refresh_token_iv,'base64'),decode(p_refresh_token_tag,'base64'),p_key_version,next_generation)
 on conflict(owner_id,service) do update set google_subject=excluded.google_subject,granted_scopes=excluded.granted_scopes,refresh_token_ciphertext=excluded.refresh_token_ciphertext,refresh_token_iv=excluded.refresh_token_iv,refresh_token_tag=excluded.refresh_token_tag,key_version=excluded.key_version,generation=excluded.generation,updated_at=now();
end;$$;
create or replace function public.save_google_assistant_oauth_connection(
 p_owner_id uuid,p_service text,p_google_subject text,p_granted_scopes jsonb,p_refresh_token_ciphertext text,p_refresh_token_iv text,p_refresh_token_tag text,p_key_version text,p_expected_generation uuid
) returns void language plpgsql security definer set search_path='' as $$
declare current_generation uuid;
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('google-connection:'||p_owner_id::text||':'||p_service,0));
 select generation into current_generation from public.google_assistant_connection_generations where owner_id=p_owner_id and service=p_service;
 if current_generation is null or current_generation is distinct from p_expected_generation then raise exception 'Stale OAuth callback' using errcode='40001'; end if;
 perform public.save_google_calendar_tasks_oauth_connection(p_owner_id,p_service,p_google_subject,p_granted_scopes,p_refresh_token_ciphertext,p_refresh_token_iv,p_refresh_token_tag,p_key_version);
end;$$;
create or replace function public.get_google_calendar_tasks_oauth_connection(p_owner_id uuid,p_service text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare connection public.google_calendar_tasks_connections;
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 select * into connection from public.google_calendar_tasks_connections where owner_id=p_owner_id and service=p_service;
 if not found then return null; end if;
 return jsonb_build_object('googleSubject',connection.google_subject,'grantedScopes',connection.granted_scopes,'refreshTokenCiphertext',encode(connection.refresh_token_ciphertext,'base64'),'refreshTokenIv',encode(connection.refresh_token_iv,'base64'),'refreshTokenTag',encode(connection.refresh_token_tag,'base64'),'keyVersion',connection.key_version,'generation',connection.generation);
end;$$;
create or replace function public.clear_google_calendar_tasks_oauth_connection(p_owner_id uuid,p_service text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Server required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('google-connection:'||p_owner_id::text||':'||p_service,0));
 insert into public.google_assistant_connection_generations(owner_id,service) values(p_owner_id,p_service) on conflict(owner_id,service) do update set generation=gen_random_uuid();
 update public.google_calendar_tasks_oauth_attempts set consumed_at=now() where owner_id=p_owner_id and service=p_service and consumed_at is null;
 delete from public.google_calendar_tasks_connections where owner_id=p_owner_id and service=p_service;
 delete from public.google_calendar_tasks_controls where owner_id=p_owner_id and service=p_service;
end;$$;
revoke all on function public.save_google_assistant_oauth_connection(uuid,text,text,jsonb,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.save_google_assistant_oauth_connection(uuid,text,text,jsonb,text,text,text,text,uuid) to service_role;
