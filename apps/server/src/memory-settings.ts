import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MEMORY_ACTION_LEASE_MS, type MemoryRepositoryV2 } from "./db.js";
import type { RequestUser } from "./request-user.js";
import type { VoiceMemoryCoordinator } from "./voice-memory-coordinator.js";
import type { WriteGate } from "./write-gate.js";

export type MemorySettings = {
  memoryEnabled: boolean;
  updatedAt: string | null;
};

export type MemorySettingsRepository = {
  get(user: RequestUser): Promise<MemorySettings>;
  patch(user: RequestUser, settings: MemorySettingsPatch): Promise<MemorySettings>;
};

export type MemorySettingsPatch = { memoryEnabled: boolean };

const defaults: MemorySettings = {
  memoryEnabled: true,
  updatedAt: null,
};

const settingsSchema = z.union([
  z.object({ memoryEnabled: z.boolean() }).strict(),
]);

export function createMemorySettingsRepository(
  databasePath: string,
  now: () => Date = () => new Date(),
): MemorySettingsRepository {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_settings (
      user_id TEXT PRIMARY KEY,
      automatic_memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (automatic_memory_enabled IN (0, 1)),
      recall_memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (recall_memory_enabled IN (0, 1)),
      voice_memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (voice_memory_enabled IN (0, 1)),
      memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (memory_enabled IN (0, 1)),
      updated_at TEXT NOT NULL
    )
  `);
  const columns = database.prepare("PRAGMA table_info(memory_settings)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "voice_memory_enabled")) {
    database.exec("ALTER TABLE memory_settings ADD COLUMN voice_memory_enabled INTEGER NOT NULL DEFAULT 0 CHECK (voice_memory_enabled IN (0, 1));");
  }
  if (!columns.some((column) => column.name === "memory_enabled")) {
    database.exec("ALTER TABLE memory_settings ADD COLUMN memory_enabled INTEGER;");
    database.exec("UPDATE memory_settings SET memory_enabled = CASE WHEN automatic_memory_enabled = 1 AND recall_memory_enabled = 1 AND voice_memory_enabled = 1 THEN 1 ELSE 0 END WHERE memory_enabled IS NULL;");
  }
  return {
    async get(user) {
      const row = database.prepare(`
        SELECT memory_enabled, updated_at
        FROM memory_settings WHERE user_id = ?
      `).get(user.userId) as { memory_enabled: number | null; updated_at: string } | undefined;
      return row ? {
        memoryEnabled: row.memory_enabled === 1,
        updatedAt: row.updated_at,
      } : defaults;
    },
    async patch(user, settings) {
      const updatedAt = now().toISOString();
      database.prepare(`
        INSERT INTO memory_settings (user_id, automatic_memory_enabled, recall_memory_enabled, voice_memory_enabled, memory_enabled, updated_at)
        VALUES (?, 1, 1, 1, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          memory_enabled = excluded.memory_enabled,
          updated_at = excluded.updated_at
      `).run(user.userId, settings.memoryEnabled ? 1 : 0, updatedAt);
      return this.get(user);
    },
  };
}

export function registerMemorySettingsRoutes(
  app: FastifyInstance,
  options: {
    repository: MemorySettingsRepository;
    memoryRepository?: Pick<MemoryRepositoryV2, "hasActiveVoiceProcessing" | "cleanupStaleVoiceProcessing">;
    voiceCoordinator?: VoiceMemoryCoordinator;
    now?: () => Date;
    wait?: () => Promise<void>;
    writeGate?: WriteGate;
  },
): void {
  app.get("/api/memory-settings", async (request, reply) => reply
    .header("Cache-Control", "no-store")
    .send({ settings: await options.repository.get(request.yuiUser) }));

  app.patch("/api/memory-settings", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_memory_settings" });
    const lease = options.writeGate?.enter("user_mutation") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    const stoppingMemory = !parsed.data.memoryEnabled;
    if (stoppingMemory) options.voiceCoordinator?.blockAndAbort(request.yuiUser);
    try {
      const settings = await options.repository.patch(request.yuiUser, parsed.data);
      if (parsed.data.memoryEnabled) {
        options.voiceCoordinator?.unblock(request.yuiUser);
      }
      if (stoppingMemory) {
        await options.voiceCoordinator?.waitForLocalIdle(request.yuiUser);
        if (options.memoryRepository) {
          while (true) {
            const now = options.now?.() ?? new Date();
            const cutoff = new Date(now.getTime() - MEMORY_ACTION_LEASE_MS).toISOString();
            await options.memoryRepository.cleanupStaleVoiceProcessing(request.yuiUser, cutoff);
            if (!(await options.memoryRepository.hasActiveVoiceProcessing(request.yuiUser, cutoff))) break;
            await (options.wait?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 25)));
          }
        }
      }
      return reply.send({ settings });
    } catch {
      if (stoppingMemory) options.voiceCoordinator?.unblock(request.yuiUser);
      return reply.code(503).send({ error: "memory_settings_unavailable" });
    } finally {
      lease.release();
    }
  });
}
