begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

select has_table('public', 'google_calendar_tasks_oauth_attempts', 'OAuth attempt table exists');
select has_table('public', 'google_calendar_tasks_connections', 'encrypted connection table exists');
select columns_are(
  'public', 'google_calendar_tasks_oauth_attempts',
  array['id', 'owner_id', 'service', 'state_digest', 'nonce_digest', 'code_verifier_ciphertext', 'code_verifier_iv', 'code_verifier_tag', 'key_version', 'expires_at', 'consumed_at', 'created_at', 'purpose', 'connection_generation'],
  'attempt table has no plaintext state column'
);
select columns_are(
  'public', 'google_calendar_tasks_connections',
  array['owner_id', 'service', 'google_subject', 'refresh_token_ciphertext', 'refresh_token_iv', 'refresh_token_tag', 'key_version', 'granted_scopes', 'created_at', 'updated_at', 'generation'],
  'connection table has no plaintext refresh token column'
);
select ok(not has_table_privilege('anon', 'public.google_calendar_tasks_oauth_attempts', 'select'), 'anon cannot read attempts');
select ok(not has_table_privilege('authenticated', 'public.google_calendar_tasks_oauth_attempts', 'select'), 'browser cannot read attempts');
select ok(not has_table_privilege('service_role', 'public.google_calendar_tasks_oauth_attempts', 'select'), 'service role uses server RPCs instead of direct attempt reads');
select ok(not has_table_privilege('anon', 'public.google_calendar_tasks_connections', 'select'), 'anon cannot read tokens');
select ok(not has_table_privilege('authenticated', 'public.google_calendar_tasks_connections', 'select'), 'browser cannot read tokens');
select ok(not has_table_privilege('service_role', 'public.google_calendar_tasks_connections', 'select'), 'service role uses server RPCs instead of direct token reads');
select col_hasnt_default('public', 'google_calendar_tasks_oauth_attempts', 'state_digest', 'state digest must originate server-side');
select col_hasnt_default('public', 'google_calendar_tasks_connections', 'refresh_token_ciphertext', 'refresh token must originate server-side');
select has_pk('public', 'google_calendar_tasks_connections', 'connection is unique per owner and service');
select col_is_unique('public', 'google_calendar_tasks_oauth_attempts', 'state_digest', 'state digest is one-time unique');

select * from finish();
rollback;
