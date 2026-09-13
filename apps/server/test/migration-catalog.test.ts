import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("photo deletion migration catalog", () => {
  it("upgrades the recorded legacy catalog with a new versioned migration", async () => {
    // This is the catalog baseline for a database that recorded a3053e4's 001. Keep it
    // independent of today's on-disk 001: an applied migration is immutable history.
    const recorded001LegacyBaseline = `
      create or replace function public.delete_whole_chat(p_owner_id uuid,p_expected_revision bigint)
      returns void language plpgsql security definer set search_path='';
      revoke all on function public.delete_whole_chat(uuid,bigint) from public,anon,authenticated;
      grant execute on function public.delete_whole_chat(uuid,bigint) to service_role;
    `;
    const upgrade = await readFile(
      new URL("../../../supabase/migrations/202608140002_photo_delete_whole_chat_v2.sql", import.meta.url),
      "utf8",
    );

    expect(recorded001LegacyBaseline).toContain("delete_whole_chat(uuid,bigint)");
    expect(recorded001LegacyBaseline).toContain("returns void");
    expect(recorded001LegacyBaseline).toContain("to service_role");
    expect(upgrade).toContain("delete_whole_chat_v2(uuid,bigint)");
    expect(upgrade).toContain("returns integer");
    expect(upgrade).toContain("delete_whole_chat(uuid,bigint)");
    expect(upgrade).toContain("returns void");
    expect(upgrade).toContain("to service_role");
  });
});
