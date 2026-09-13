import { parseDisplayName } from "../../../packages/domain/src/index.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProfileRepository } from "./profile-db.js";
import type { WriteGate } from "./write-gate.js";

const requestSchema = z.object({
  displayName: z.string(),
  occupation: z.string().max(120).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u).optional(),
  region: z.string().max(120).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u).optional(),
  addressingStyle: z.union([z.literal("san"), z.literal("none")]),
}).strict();

export function registerProfileRoutes(
  app: FastifyInstance,
  options: { profileRepository: ProfileRepository; writeGate?: WriteGate },
): void {
  app.get("/api/profile", async (request, reply) => reply
    .header("Cache-Control", "no-store")
    .send({ profile: await options.profileRepository.get(request.yuiUser) }));

  app.put("/api/profile", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_profile" });
    }
    const displayName = parseDisplayName(parsed.data.displayName);
    if (!displayName) {
      return reply.code(400).send({ error: "invalid_profile" });
    }
    const lease = options.writeGate?.enter("user_mutation") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    try {
      return reply.send({ profile: await options.profileRepository.save(request.yuiUser, { ...parsed.data, displayName }) });
    } finally { lease.release(); }
  });
}
