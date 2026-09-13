alter table public.google_calendar_tasks_oauth_attempts
  add column nonce_digest text not null default 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  check (nonce_digest ~ '^sha256:[a-f0-9]{64}$');

alter table public.google_calendar_tasks_oauth_attempts
  alter column nonce_digest drop default;
