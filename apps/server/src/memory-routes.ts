import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryRepository } from "./db.js";
import type { MemoryProcessor } from "./memory-processor.js";
import type { MemoryProcessInput } from "./memory-processor.js";
import { classifySensitivity, containsForbiddenSecret, isTombstoneContentMatch } from "./memory-policy.js";
import { normalizeMemory } from "../../../packages/domain/src/index.js";
import { effectiveMemoryStatus } from "../../../packages/domain/src/memory.js";
import type { WriteGate } from "./write-gate.js";
import type { AutomaticMemorySourceResult } from "./memory-turn-source.js";
import type { RequestUser } from "./request-user.js";

const automaticTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(4_000),
  provenance: z.enum(["context", "authoritative_source"]),
}).strict();

const safeSourceMessageIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !/^(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|eyJ)/u.test(value));

const voiceProcessRequestSchema = z.object({
  sourceMessageId: safeSourceMessageIdSchema,
  sourceOccurredAt: z.string().datetime({ offset: true }),
  sourceOrigin: z.literal("voice"),
  explicitMemoryTargetTurnIndexes: z.array(z.number().int().min(0).max(11)).max(2).optional(),
  turns: z.array(automaticTurnSchema).min(1).max(12),
}).strict().superRefine((value, context) => {
  const authoritative = value.turns.filter((turn) => turn.provenance === "authoritative_source");
  const voiceSourceId = /^voice:[a-f0-9]{64}$/u.test(value.sourceMessageId);
  const validAuthority = authoritative.length >= 1
      && value.turns.every((turn) => turn.role === "user"
        ? turn.provenance === "authoritative_source"
        : turn.provenance === "context")
      && voiceSourceId
      && Array.isArray(value.explicitMemoryTargetTurnIndexes)
      && new Set(value.explicitMemoryTargetTurnIndexes).size === value.explicitMemoryTargetTurnIndexes.length
      && value.explicitMemoryTargetTurnIndexes.every((index) => value.turns[index]?.role === "user" && value.turns[index]?.provenance === "authoritative_source");
  if (!validAuthority) {
    context.addIssue({ code: "custom", message: "invalid authoritative source", path: ["turns"] });
  }
  if (value.turns.reduce((total, turn) => total + turn.text.length, 0) > 12_000) {
    context.addIssue({ code: "custom", message: "turn text budget exceeded", path: ["turns"] });
  }
});

const chatProcessRequestSchema = z.object({
  sourceMessageId: safeSourceMessageIdSchema.refine((value) => !value.startsWith("voice:")),
  sourceOccurredAt: z.string().datetime({ offset: true }),
}).strict();

const memoryIdSchema = z.object({
  id: z.string().uuid(),
}).strict();

const memoryUpdateSchema = z.object({
  content: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
}).strict().refine((patch) => patch.content !== undefined || patch.pinned !== undefined);

const forgetSchema = z.object({ blockRelearning: z.boolean() }).strict();
const emptyBodySchema = z.object({}).strict();

export function registerMemoryRoutes(
  app: FastifyInstance,
  options: {
    memoryRepository: MemoryRepository;
    processor: MemoryProcessor;
    writeGate?: WriteGate;
    automaticChatMemoryMode?: "disabled" | "hosted_authoritative_snapshot";
    memoryTurnSource?: { load(user: RequestUser, input: { sourceMessageId: string; sourceOccurredAt: string }): Promise<AutomaticMemorySourceResult> };
  },
): void {
  app.post("/api/memory/process", async (request, reply) => {
    const voice = voiceProcessRequestSchema.safeParse(request.body);
    const chat = chatProcessRequestSchema.safeParse(request.body);
    if (!voice.success && !chat.success) {
      return reply.code(400).send({ error: "Invalid memory processing request" });
    }
    if (chat.success && options.automaticChatMemoryMode !== "hosted_authoritative_snapshot") {
      return reply.code(404).send({ error: "automatic_chat_memory_disabled" });
    }
    let processInput: MemoryProcessInput;
    if (voice.success) processInput = voice.data;
    else if (chat.success) {
      const chatInput = chat.data;
      if (!options.memoryTurnSource) return reply.code(503).send({ error: "automatic_chat_memory_unavailable" });
      const turns = await options.memoryTurnSource.load(request.yuiUser, chatInput);
      if (turns === "not_found" || turns === "not_eligible") {
        return reply.code(202).send({ sourceMessageId: chatInput.sourceMessageId, state: "completed", appliedCount: 0 });
      }
      processInput = { ...chatInput, turns, sourceContext: { kind: "internal" } };
    } else return reply.code(400).send({ error: "Invalid memory processing request" });
    const lease = options.writeGate?.enter("memory_processing") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortOnResponseClose = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abortOnResponseClose);
    try {
      const receipt = await options.processor.process(request.yuiUser, processInput, controller.signal);
      return reply.code(202).send(receipt);
    } finally {
      lease.release();
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abortOnResponseClose);
    }
  });

  app.get("/api/memories", async (request) => ({
    memories: (await options.memoryRepository.list(request.yuiUser)).map((memory) => ({
      ...memory,
      status: effectiveMemoryStatus(memory),
    })),
  }));

  app.patch("/api/memories/:id", async (request, reply) => {
    const params = memoryIdSchema.safeParse(request.params);
    const body = memoryUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_memory_update" });
    const records = await options.memoryRepository.list(request.yuiUser);
    let target = records.find(({ id }) => id === params.data.id);
    if (!target) return reply.code(404).send({ error: "memory_not_found" });
    if (body.data.content !== undefined) {
      if (containsForbiddenSecret(body.data.content)) return reply.code(400).send({ error: "invalid_memory_update" });
      const normalized = normalizeMemory(body.data.content);
      if (records.some((record) => record.id !== params.data.id && record.normalizedContent === normalized)) {
        return reply.code(400).send({ error: "invalid_memory_update" });
      }
      const tombstones = await options.memoryRepository.listActiveTombstones(request.yuiUser);
      if (tombstones.some((tombstone) => isTombstoneContentMatch(body.data.content!, tombstone.normalizedFingerprint))) {
        return reply.code(400).send({ error: "invalid_memory_update" });
      }
    }
    const lease = options.writeGate?.enter("user_mutation") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    try {
      if (effectiveMemoryStatus(target) === "expired" && target.status === "active") {
        target = await options.memoryRepository.setStatus(request.yuiUser, target.id, "expired");
      }
      const memory = await options.memoryRepository.update(request.yuiUser, target.id, {
        ...body.data,
        ...(body.data.content !== undefined ? { sensitivity: target.sensitivity === "sensitive" ? "sensitive" : classifySensitivity(body.data.content) } : {}),
      });
      return reply.send({ memory });
    } catch {
      return reply.code(503).send({ error: "memory_update_unavailable" });
    } finally {
      lease.release();
    }
  });

  app.post("/api/memories/:id/forget", async (request, reply) => {
    const params = memoryIdSchema.safeParse(request.params);
    const body = forgetSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_memory_forget" });
    const owned = (await options.memoryRepository.list(request.yuiUser)).some(({ id }) => id === params.data.id);
    if (!owned) return reply.code(404).send({ error: "memory_not_found" });
    const lease = options.writeGate?.enter("user_mutation") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    try {
      await options.memoryRepository.forget(request.yuiUser, params.data.id, body.data.blockRelearning);
      return reply.code(204).send();
    } catch {
      return reply.code(503).send({ error: "memory_forget_unavailable" });
    } finally {
      lease.release();
    }
  });

  app.post("/api/memories/:id/keep", async (request, reply) => {
    const params = memoryIdSchema.safeParse(request.params);
    const body = emptyBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_memory_keep" });
    let owned: boolean;
    try {
      owned = (await options.memoryRepository.list(request.yuiUser)).some(({ id }) => id === params.data.id);
    } catch {
      return reply.code(503).send({ error: "memory_keep_unavailable" });
    }
    if (!owned) return reply.code(404).send({ error: "memory_not_found" });
    const lease = options.writeGate?.enter("user_mutation") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    try {
      const memory = await options.memoryRepository.keep(request.yuiUser, params.data.id);
      return reply.send({ memory });
    } catch {
      return reply.code(503).send({ error: "memory_keep_unavailable" });
    } finally {
      lease.release();
    }
  });

  app.get("/api/memory-tombstones", async (request) => ({
    tombstones: (await options.memoryRepository.listActiveTombstones(request.yuiUser)).map(({ id, memoryId, createdAt }) => ({ id, memoryId, createdAt })),
  }));

  app.post("/api/memory-tombstones/:id/release", async (request, reply) => {
    const params = memoryIdSchema.safeParse(request.params);
    const body = emptyBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_memory_tombstone" });
    const owned = (await options.memoryRepository.listActiveTombstones(request.yuiUser)).some(({ id }) => id === params.data.id);
    if (!owned) return reply.code(404).send({ error: "memory_tombstone_not_found" });
    const lease = options.writeGate?.enter("user_mutation") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    try {
      await options.memoryRepository.releaseTombstone(request.yuiUser, params.data.id);
      return reply.code(204).send();
    } catch {
      return reply.code(503).send({ error: "memory_tombstone_unavailable" });
    } finally {
      lease.release();
    }
  });

  app.get("/api/memories/export", async (request, reply) => {
    reply
      .header("Content-Disposition", 'attachment; filename="yui-memories.json"')
      .type("application/json; charset=utf-8");
    return { memories: await options.memoryRepository.list(request.yuiUser) };
  });
}
