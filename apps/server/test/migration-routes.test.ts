import { describe, expect, it, vi } from "vitest";
import type { MemoryRepository } from "../src/db";
import type { ProfileRepository } from "../src/profile-db";
import { buildApp } from "../src/app";
import { createSupabaseMigrationImporter } from "../src/migration-routes";

const profile = { displayName: "大輝", addressingStyle: "san" as const, updatedAt: "2026-08-10T00:00:00.000Z" };
const memory = { id: "00000000-0000-4000-8000-000000000001", kind: "shared" as const, content: "ユイと夜に長く話した", importance: 4 as const, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" };
const bundle = { version: 1 as const, profile, memories: [memory] };

function repositories(): { profileRepository: ProfileRepository; memoryRepository: MemoryRepository } {
  return {
    profileRepository: { get: vi.fn(async () => profile), save: vi.fn() },
    memoryRepository: { list: vi.fn(async () => [memory]) },
  };
}

describe("migration routes", () => {
  it("downloads only the local profile and confirmed memories without modifying them", async () => {
    const source = repositories();
    const app = buildApp({ ...source, extractor: { extract: async () => ({ candidates: [] }) }, migrationExport: true });

    const response = await app.inject({ method: "GET", url: "/api/migration/export" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("yui-migration-v1.json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(bundle);
    expect(source.profileRepository.save).not.toHaveBeenCalled();
  });

  it("rejects chat or call data before invoking the hosted importer", async () => {
    const importer = { import: vi.fn() };
    const app = buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, migrationImporter: importer });

    const response = await app.inject({
      method: "POST",
      url: "/api/migration/import",
      payload: { importId: "00000000-0000-4000-8000-000000000099", bundle: { ...bundle, timeline: [{ type: "call" }] } },
    });

    expect(response.statusCode).toBe(400);
    expect(importer.import).not.toHaveBeenCalled();
  });

  it("returns the original receipt when an import id is retried", async () => {
    const receipt = { importedProfile: true as const, importedMemories: 1 };
    const importer = { import: vi.fn(async () => receipt) };
    const app = buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, migrationImporter: importer });
    const payload = { importId: "00000000-0000-4000-8000-000000000099", bundle };

    const first = await app.inject({ method: "POST", url: "/api/migration/import", payload });
    const retry = await app.inject({ method: "POST", url: "/api/migration/import", payload });

    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(importer.import).toHaveBeenNthCalledWith(1, expect.objectContaining({ userId: expect.any(String) }), payload);
  });

  it("calls the migration RPC with the authenticated user's token-scoped client", async () => {
    const rpc = vi.fn(async () => ({ data: [{ imported_profile: true, imported_memories: 1 }], error: null }));
    const factory = vi.fn(() => ({ rpc }));
    const importer = createSupabaseMigrationImporter(factory);
    const user = { userId: "00000000-0000-4000-8000-00000000000a", accessToken: "private-token" };

    await expect(importer.import(user, { importId: "00000000-0000-4000-8000-000000000099", bundle })).resolves.toEqual({ importedProfile: true, importedMemories: 1 });
    expect(factory).toHaveBeenCalledWith(user);
    expect(rpc).toHaveBeenCalledWith("import_profile_memory", { p_import_id: "00000000-0000-4000-8000-000000000099", p_bundle: bundle });
  });
});
