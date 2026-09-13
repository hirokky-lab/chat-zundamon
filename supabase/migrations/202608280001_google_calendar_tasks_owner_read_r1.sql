create table public.google_calendar_tasks_oauth_attempts (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  service text not null check (service in ('calendar', 'tasks')),
  state_digest text not null check (state_digest ~ '^sha256:[a-f0-9]{64}$'),
  code_verifier_ciphertext bytea not null,
  code_verifier_iv bytea not null check (pg_catalog.octet_length(code_verifier_iv) = 12),
  code_verifier_tag bytea not null check (pg_catalog.octet_length(code_verifier_tag) = 16),
  key_version text not null check (
    pg_catalog.length(key_version) between 1 and 64
    and key_version = pg_catalog.btrim(key_version)
    and key_version ~ '^[A-Za-z0-9._:-]+$'
  ),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  unique (state_digest),
  constraint google_calendar_tasks_oauth_attempt_expiry_check check (expires_at > created_at),
  constraint google_calendar_tasks_oauth_attempt_consumed_check check (
    consumed_at is null or (consumed_at >= created_at and consumed_at <= expires_at)
  )
);

create table public.google_calendar_tasks_connections (
  owner_id uuid not null references auth.users(id) on delete cascade,
  service text not null check (service in ('calendar', 'tasks')),
  google_subject text not null check (
    pg_catalog.length(google_subject) between 1 and 255
    and google_subject = pg_catalog.btrim(google_subject)
    and google_subject !~ '[[:cntrl:]]'
  ),
  refresh_token_ciphertext bytea not null,
  refresh_token_iv bytea not null check (pg_catalog.octet_length(refresh_token_iv) = 12),
  refresh_token_tag bytea not null check (pg_catalog.octet_length(refresh_token_tag) = 16),
  key_version text not null check (
    pg_catalog.length(key_version) between 1 and 64
    and key_version = pg_catalog.btrim(key_version)
    and key_version ~ '^[A-Za-z0-9._:-]+$'
  ),
  granted_scopes jsonb not null check (
    pg_catalog.jsonb_typeof(granted_scopes) = 'array'
    and granted_scopes = case service
      when 'calendar' then '["openid", "https://www.googleapis.com/auth/calendar.events.readonly"]'::jsonb
      when 'tasks' then '["openid", "https://www.googleapis.com/auth/tasks.readonly"]'::jsonb
    end
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (owner_id, service)
);

alter table public.google_calendar_tasks_oauth_attempts enable row level security;
alter table public.google_calendar_tasks_connections enable row level security;

revoke all on table public.google_calendar_tasks_oauth_attempts from public, anon, authenticated, service_role;
revoke all on table public.google_calendar_tasks_connections from public, anon, authenticated, service_role;
