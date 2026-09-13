create or replace function public.create_google_calendar_tasks_oauth_attempt(
  p_owner_id uuid, p_service text, p_state_digest text, p_nonce_digest text,
  p_code_verifier_ciphertext text, p_code_verifier_iv text, p_code_verifier_tag text,
  p_key_version text, p_expires_at timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Google OAuth server operation required' using errcode = '42501'; end if;
  insert into public.google_calendar_tasks_oauth_attempts (
    id, owner_id, service, state_digest, nonce_digest, code_verifier_ciphertext, code_verifier_iv, code_verifier_tag, key_version, expires_at
  ) values (
    gen_random_uuid(), p_owner_id, p_service, p_state_digest, p_nonce_digest,
    decode(p_code_verifier_ciphertext, 'base64'), decode(p_code_verifier_iv, 'base64'), decode(p_code_verifier_tag, 'base64'), p_key_version, p_expires_at
  );
end;
$$;

create or replace function public.consume_google_calendar_tasks_oauth_attempt(p_owner_id uuid, p_state_digest text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare attempt public.google_calendar_tasks_oauth_attempts;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Google OAuth server operation required' using errcode = '42501'; end if;
  update public.google_calendar_tasks_oauth_attempts set consumed_at = pg_catalog.now()
  where owner_id = p_owner_id and state_digest = p_state_digest and consumed_at is null and expires_at > pg_catalog.now()
  returning * into attempt;
  if not found then return null; end if;
  return pg_catalog.jsonb_build_object(
    'ownerId', attempt.owner_id, 'service', attempt.service, 'stateHash', attempt.state_digest, 'nonceHash', attempt.nonce_digest,
    'codeVerifierCiphertext', encode(attempt.code_verifier_ciphertext, 'base64'), 'codeVerifierIv', encode(attempt.code_verifier_iv, 'base64'),
    'codeVerifierTag', encode(attempt.code_verifier_tag, 'base64'), 'expiresAt', attempt.expires_at
  );
end;
$$;

create or replace function public.save_google_calendar_tasks_oauth_connection(
  p_owner_id uuid, p_service text, p_google_subject text, p_granted_scopes jsonb,
  p_refresh_token_ciphertext text, p_refresh_token_iv text, p_refresh_token_tag text, p_key_version text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Google OAuth server operation required' using errcode = '42501'; end if;
  insert into public.google_calendar_tasks_connections (
    owner_id, service, google_subject, granted_scopes, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, key_version
  ) values (
    p_owner_id, p_service, p_google_subject, p_granted_scopes,
    decode(p_refresh_token_ciphertext, 'base64'), decode(p_refresh_token_iv, 'base64'), decode(p_refresh_token_tag, 'base64'), p_key_version
  ) on conflict (owner_id, service) do update set
    google_subject = excluded.google_subject, granted_scopes = excluded.granted_scopes,
    refresh_token_ciphertext = excluded.refresh_token_ciphertext, refresh_token_iv = excluded.refresh_token_iv,
    refresh_token_tag = excluded.refresh_token_tag, key_version = excluded.key_version, updated_at = pg_catalog.now();
end;
$$;

create or replace function public.get_google_calendar_tasks_oauth_connection(p_owner_id uuid, p_service text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare connection public.google_calendar_tasks_connections;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Google OAuth server operation required' using errcode = '42501'; end if;
  select * into connection from public.google_calendar_tasks_connections where owner_id = p_owner_id and service = p_service;
  if not found then return null; end if;
  return pg_catalog.jsonb_build_object(
    'googleSubject', connection.google_subject, 'grantedScopes', connection.granted_scopes,
    'refreshTokenCiphertext', encode(connection.refresh_token_ciphertext, 'base64'), 'refreshTokenIv', encode(connection.refresh_token_iv, 'base64'),
    'refreshTokenTag', encode(connection.refresh_token_tag, 'base64'), 'keyVersion', connection.key_version
  );
end;
$$;

create or replace function public.clear_google_calendar_tasks_oauth_connection(p_owner_id uuid, p_service text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Google OAuth server operation required' using errcode = '42501'; end if;
  delete from public.google_calendar_tasks_connections where owner_id = p_owner_id and service = p_service;
  delete from public.google_calendar_tasks_controls where owner_id = p_owner_id and service = p_service;
end;
$$;

revoke all on function public.create_google_calendar_tasks_oauth_attempt(uuid, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_google_calendar_tasks_oauth_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public.save_google_calendar_tasks_oauth_connection(uuid, text, text, jsonb, text, text, text, text) from public, anon, authenticated;
revoke all on function public.get_google_calendar_tasks_oauth_connection(uuid, text) from public, anon, authenticated;
revoke all on function public.clear_google_calendar_tasks_oauth_connection(uuid, text) from public, anon, authenticated;
grant execute on function public.create_google_calendar_tasks_oauth_attempt(uuid, text, text, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.consume_google_calendar_tasks_oauth_attempt(uuid, text) to service_role;
grant execute on function public.save_google_calendar_tasks_oauth_connection(uuid, text, text, jsonb, text, text, text, text) to service_role;
grant execute on function public.get_google_calendar_tasks_oauth_connection(uuid, text) to service_role;
grant execute on function public.clear_google_calendar_tasks_oauth_connection(uuid, text) to service_role;
