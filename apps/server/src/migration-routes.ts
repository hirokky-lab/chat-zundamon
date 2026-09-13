import { parseMigrationBundle, type LegacyMemory, type MigrationBundle } from "../../../packages/domain/src/index.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryRepository } from "./db.js";
import type { ProfileRepository } from "./profile-db.js";
import type { RequestUser } from "./request-user.js";
import type { WriteGate } from "./write-gate.js";

export type MigrationReceipt = { importedProfile: true; importedMemories: number };
export type MigrationImporter = {
  import(user: RequestUser, input: { importId: string; bundle: MigrationBundle }): Promise<MigrationReceipt>;
};

type RpcClientFactory = (user: RequestUser) => {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
};

const importIdSchema = z.string().uuid();

function receipt(value: unknown): MigrationReceipt | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const source = row as Record<string, unknown>;
  if (source.imported_profile !== true || !Number.isSafeInteger(source.imported_memories) || (source.imported_memories as number) < 0) return null;
  return { importedProfile: true, importedMemories: source.imported_memories as number };
}

export function createSupabaseMigrationImporter(factory: RpcClientFactory): MigrationImporter {
  return {
    async import(user, input) {
      const result = await factory(user).rpc("import_profile_memory", {
        p_import_id: input.importId,
        p_bundle: input.bundle,
      });
      const parsed = result.error ? null : receipt(result.data);
      if (!parsed) throw new Error("Migration import unavailable");
      return parsed;
    },
  };
}

export function registerMigrationExportRoute(app: FastifyInstance, repositories: { profileRepository: ProfileRepository; memoryRepository: MemoryRepository }) {
  app.get("/api/migration/export", async (request, reply) => {
    const [profile, memories] = await Promise.all([
      repositories.profileRepository.get(request.yuiUser),
      repositories.memoryRepository.list(request.yuiUser),
    ]);
    if (!profile) return reply.header("Cache-Control", "no-store").code(404).send({ error: "migration_source_unavailable" });
    const legacyMemories = memories.map(({ id, kind, content, importance, createdAt, updatedAt }) => ({
      id,
      kind: kind === "routine" ? "ongoing" as const : kind,
      content,
      importance,
      createdAt,
      updatedAt,
    }));
    if (legacyMemories.some((memory) => !["preference", "event", "ongoing", "shared"].includes(memory.kind))) {
      return reply.header("Cache-Control", "no-store").code(409).send({ error: "migration_source_unavailable" });
    }
    const migrationMemories = legacyMemories as LegacyMemory[];
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", 'attachment; filename="yui-migration-v1.json"')
      .send({ version: 1, profile, memories: migrationMemories } satisfies MigrationBundle);
  });
}

export function registerMigrationImportRoute(app: FastifyInstance, importer: MigrationImporter, writeGate?: WriteGate) {
  app.post("/api/migration/import", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const importId = body && importIdSchema.safeParse(body.importId);
    const bundle = body && parseMigrationBundle(body.bundle);
    if (!body || Object.keys(body).some((key) => key !== "importId" && key !== "bundle") || !importId?.success || !bundle) {
      return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid_migration" });
    }
    const lease = writeGate?.enter("user_mutation") ?? (writeGate ? null : { release() {} });
    if (!lease) return reply.header("Cache-Control", "no-store").code(503).send({ error: "maintenance" });
    try {
      const result = await importer.import(request.yuiUser, { importId: importId.data, bundle });
      return reply.header("Cache-Control", "no-store").send(result);
    } catch {
      return reply.header("Cache-Control", "no-store").code(502).send({ error: "migration_unavailable" });
    } finally {
      lease.release();
    }
  });
}
