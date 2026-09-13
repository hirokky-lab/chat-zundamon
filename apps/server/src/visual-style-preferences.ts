import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RequestUser } from "./request-user.js";
import type { WriteGate } from "./write-gate.js";
import type { UserClientFactory } from "./hosted-repositories.js";

export type VisualStyle = "yui" | "minimal";
export type VisualStylePreference = Readonly<{ style: VisualStyle; revision: number; updatedAt: string }>;

export type VisualStylePreferenceRepository = {
  get(owner: RequestUser): Promise<VisualStylePreference | null>;
  save(owner: RequestUser, style: VisualStyle, expectedRevision: number): Promise<VisualStylePreference>;
};

const requestSchema = z.object({
  style: z.union([z.literal("yui"), z.literal("minimal")]),
  expectedRevision: z.number().int().nonnegative().safe(),
}).strict();

export function createMemoryVisualStylePreferenceRepository(
  now: () => Date = () => new Date(),
): VisualStylePreferenceRepository {
  const byOwner = new Map<string, VisualStylePreference>();
  return {
    async get(owner) {
      return byOwner.get(owner.userId) ?? null;
    },
    async save(owner, style, expectedRevision) {
      const prior = byOwner.get(owner.userId);
      if (prior && prior.revision !== expectedRevision) return prior;
      if (!prior && expectedRevision !== 0) throw new Error("visual_style_preference_unavailable");
      const preference = { style, revision: (prior?.revision ?? 0) + 1, updatedAt: now().toISOString() } as const;
      byOwner.set(owner.userId, preference);
      return preference;
    },
  };
}

export function createSupabaseVisualStylePreferenceRepository(factory: UserClientFactory): VisualStylePreferenceRepository {
  const parse = (value: unknown): VisualStylePreference => {
    if (!Array.isArray(value) || value.length !== 1) throw new Error("visual_style_preference_unavailable");
    const row = value[0] as Record<string, unknown> | null;
    const updatedAt = normalizePostgresTimestamp(row?.updated_at);
    if (!row || Object.keys(row).length !== 3 || (row.style !== "yui" && row.style !== "minimal")
      || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0
      || !updatedAt) throw new Error("visual_style_preference_unavailable");
    return { style: row.style, revision: row.revision, updatedAt };
  };
  return {
    async get(owner) {
      const result = await factory(owner).rpc("get_visual_style_preference", {});
      if (result.error) throw new Error("visual_style_preference_unavailable");
      if (result.data === null || (Array.isArray(result.data) && result.data.length === 0)) return null;
      return parse(result.data);
    },
    async save(owner, style, expectedRevision) {
      const result = await factory(owner).rpc("save_visual_style_preference", { p_style: style, p_expected_revision: expectedRevision });
      if (result.error) throw new Error("visual_style_preference_unavailable");
      return parse(result.data);
    },
  };
}

export function registerVisualStylePreferenceRoutes(
  app: FastifyInstance,
  options: { repository: VisualStylePreferenceRepository; writeGate?: WriteGate },
): void {
  app.get("/api/visual-style-preference", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return reply.send({ preference: await options.repository.get(request.yuiUser) });
    } catch {
      return reply.code(503).send({ error: "visual_style_preference_unavailable" });
    }
  });

  app.put("/api/visual-style-preference", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_visual_style_preference" });
    const lease = options.writeGate?.enter("user_mutation") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    try {
      return reply.send({ preference: await options.repository.save(request.yuiUser, parsed.data.style, parsed.data.expectedRevision) });
    } catch {
      return reply.code(503).send({ error: "visual_style_preference_unavailable" });
    } finally { lease.release(); }
  });
}

function normalizePostgresTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
