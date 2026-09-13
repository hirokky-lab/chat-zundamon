import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../supabase/migrations/202608280001_google_calendar_tasks_owner_read_r1.sql",
  import.meta.url,
);
const repositoryMigrationUrl = new URL(
  "../../../supabase/migrations/202608280003_google_calendar_tasks_oauth_repository_r1.sql",
  import.meta.url,
);
const nonceMigrationUrl = new URL(
  "../../../supabase/migrations/202608280002_google_calendar_tasks_oauth_nonce.sql",
  import.meta.url,
);

describe("Google Calendar/Tasks owner-read OAuth migration", () => {
  it("keeps OAuth state and refresh tokens behind server-only encrypted records", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("create table public.google_calendar_tasks_oauth_attempts");
    expect(migration).toContain("state_digest text not null check (state_digest ~ '^sha256:[a-f0-9]{64}$')");
    expect(await readFile(nonceMigrationUrl, "utf8")).toContain("add column nonce_digest text not null default 'sha256:0000000000000000000000000000000000000000000000000000000000000000'");
    expect(migration).toContain("code_verifier_ciphertext bytea not null");
    expect(migration).toContain("code_verifier_iv bytea not null check (pg_catalog.octet_length(code_verifier_iv) = 12)");
    expect(migration).toContain("code_verifier_tag bytea not null check (pg_catalog.octet_length(code_verifier_tag) = 16)");
    expect(migration).toContain("create table public.google_calendar_tasks_connections");
    expect(migration).toContain("refresh_token_ciphertext bytea not null");
    expect(migration).toContain("refresh_token_iv bytea not null check (pg_catalog.octet_length(refresh_token_iv) = 12)");
    expect(migration).toContain("refresh_token_tag bytea not null check (pg_catalog.octet_length(refresh_token_tag) = 16)");
    expect(migration).toContain("alter table public.google_calendar_tasks_oauth_attempts enable row level security");
    expect(migration).toContain("alter table public.google_calendar_tasks_connections enable row level security");
    expect(migration).toContain("revoke all on table public.google_calendar_tasks_connections from public, anon, authenticated, service_role");
    expect(migration).not.toMatch(/\bstate\s+text\s+not null/i);
    expect(migration).not.toMatch(/\brefresh_token\s+text\s+not null/i);
  });

  it("exposes only owner-scoped server RPCs for encrypted OAuth persistence", async () => {
    const migration = await readFile(repositoryMigrationUrl, "utf8");

    expect(migration).toContain("create or replace function public.create_google_calendar_tasks_oauth_attempt");
    expect(migration).toContain("create or replace function public.consume_google_calendar_tasks_oauth_attempt");
    expect(migration).toContain("create or replace function public.save_google_calendar_tasks_oauth_connection");
    expect(migration).toContain("create or replace function public.get_google_calendar_tasks_oauth_connection");
    expect(migration).toContain("security definer");
    expect(migration).toContain("(select auth.role()) <> 'service_role'");
    expect(migration).toContain("grant execute on function public.create_google_calendar_tasks_oauth_attempt");
    expect(migration).not.toMatch(/grant execute on function public\.[^(]+\([^)]*\) to (anon|authenticated)/i);
  });
});

it("expands only the Calendar read scope constraint while preserving legacy credentials", async () => {
  const migration = await readFile(new URL("../../../supabase/migrations/202609050001_google_calendar_list_read_scope.sql", import.meta.url), "utf8");
  expect(migration).toContain("if matched <> 1 then raise exception");
  expect(migration).toContain("begin;");
  expect(migration).toContain("commit;");
  expect(migration).toContain(`'["openid", "https://www.googleapis.com/auth/calendar.events.readonly"]'::jsonb`);
  expect(migration).toContain(`'["openid", "https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"]'::jsonb`);
  expect(migration).not.toMatch(/grant |delete from|update public|disable row level|auth\/calendar"/i);
});
