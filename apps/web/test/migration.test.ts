import { describe, expect, it, vi } from "vitest";
import { createMigrationApi, readMigrationFile } from "../src/migration";

const bundle = {
  version: 1 as const,
  profile: { displayName: "大輝", addressingStyle: "san" as const, updatedAt: "2026-08-10T00:00:00.000Z" },
  memories: [{ id: "00000000-0000-4000-8000-000000000001", kind: "shared" as const, content: "ユイと夜に長く話した", importance: 4 as const, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" }],
};

describe("migration", () => {
  it("parses a strict local file into a private preview", async () => {
    const preview = await readMigrationFile({ name: "yui.json", text: async () => JSON.stringify(bundle) }, () => "00000000-0000-4000-8000-000000000099");
    expect(preview).toEqual({ fileName: "yui.json", importId: "00000000-0000-4000-8000-000000000099", profile: bundle.profile, memoryCount: 1, bundle });
    expect(JSON.stringify(preview)).toContain("ユイと夜に長く話した");
  });

  it("rejects exports containing chat history or call cards", async () => {
    await expect(readMigrationFile({ name: "unsafe.json", text: async () => JSON.stringify({ ...bundle, timeline: [{ type: "call" }] }) })).rejects.toThrow("Invalid migration file");
  });

  it("posts one stable import id and validates the receipt", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ importedProfile: true, importedMemories: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = createMigrationApi(fetchImpl);
    await expect(api.importBundle("00000000-0000-4000-8000-000000000099", bundle)).resolves.toEqual({ importedProfile: true, importedMemories: 1 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/migration/import", expect.objectContaining({ method: "POST", body: JSON.stringify({ importId: "00000000-0000-4000-8000-000000000099", bundle }) }));
  });
});
