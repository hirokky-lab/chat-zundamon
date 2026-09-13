import type { FastifyInstance } from "fastify";
import { parseRemoteChatSnapshot, type RemoteChatSnapshot } from "../../../packages/domain/src/index.js";
import type { RequestUser } from "./request-user.js";
import type { WriteGate } from "./write-gate.js";

export type ChatStateRepository = {
  get(user: RequestUser): Promise<RemoteChatSnapshot | null>;
  saveReconciled(
    user: RequestUser,
    input: { expectedRevision: number; snapshot: RemoteChatSnapshot },
  ): Promise<RemoteChatSnapshot | "stale" | "rejected" | "unavailable">;
  /** Compatibility alias for in-process repositories; HTTP always uses saveReconciled. */
  save(user: RequestUser, input: { expectedRevision: number; snapshot: RemoteChatSnapshot }): Promise<RemoteChatSnapshot | "stale" | "rejected" | "unavailable">;
  commitPhoto(user: RequestUser, input: { photoId: string; expectedRevision: number; snapshot: RemoteChatSnapshot }): Promise<RemoteChatSnapshot | "stale" | "not_found" | "not_ready" | "blocked" | "unavailable">;
  deletePhoto(user: RequestUser, input: { photoId: string; expectedRevision: number }): Promise<{ kind: "deleted"; snapshot: RemoteChatSnapshot } | { kind: "stale" | "not_found" | "not_ready" | "blocked" | "unavailable" }>;
  deleteWholeChat(user: RequestUser, expectedRevision: number): Promise<{ kind: "deleted"; snapshot: RemoteChatSnapshot; blockedPhotoCount: number } | { kind: "stale" | "not_found" | "unavailable" }>;
};

export const PHOTO_COMMIT_TIMEOUT_MS = 25_000;

function withPhotoCommitDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | "unavailable"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("unavailable"), timeoutMs);
    void work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve("unavailable"); });
  });
}

export function emptyRemoteChatSnapshot(now: string): RemoteChatSnapshot {
  return {
    timeline: [],
    lastOpeningAt: null,
    lastConversationAt: null,
    version: 2,
    revision: 0,
    updatedAt: now,
  };
}

export function registerChatStateRoutes(
  app: FastifyInstance,
  options: { repository: ChatStateRepository; now: () => Date; writeGate: WriteGate; photoCommitTimeoutMs?: number },
): void {
  if (!options.writeGate || typeof options.writeGate.enter !== "function") throw new Error("chat_state_write_gate_required");
  const withMutation = async <T>(work: () => Promise<T>): Promise<{ accepted: true; value: T } | { accepted: false }> => {
    const lease = options.writeGate.enter("user_mutation");
    if (!lease) return { accepted: false };
    try { return { accepted: true, value: await work() }; } finally { lease.release(); }
  };
  app.get("/api/chat-state", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const stored = await options.repository.get(request.yuiUser);
    return { snapshot: stored ?? emptyRemoteChatSnapshot(options.now().toISOString()) };
  });

  app.put("/api/chat-state", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = request.body;
    if (
      typeof body !== "object" || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 2 || !("expectedRevision" in body) ||
      !("snapshot" in body) || !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 0
    ) {
      return reply.code(400).send({ error: "invalid_chat_state" });
    }
    const snapshot = parseRemoteChatSnapshot(body.snapshot);
    if (!snapshot || snapshot.revision !== body.expectedRevision) {
      return reply.code(400).send({ error: "invalid_chat_state" });
    }
    const mutation = await withMutation(() => options.repository.saveReconciled(request.yuiUser, {
      expectedRevision: body.expectedRevision as number,
      snapshot,
    }));
    if (!mutation.accepted) return reply.code(503).send({ error: "maintenance" });
    const saved = mutation.value;
    if (saved === "stale") {
      return reply.code(409).send({ error: "chat_state_conflict" });
    }
    if (saved === "rejected") return reply.code(409).send({ error: "photo_lifecycle_required" });
    if (saved === "unavailable") return reply.code(503).send({ error: "chat_state_unavailable" });
    if (!saved || typeof saved !== "object") return saved;
    return { snapshot: saved };
  });

  // Photo mutation routes live here. photo.ts owns upload/analysis/content only and must not register duplicates.
  app.post("/api/photos/:id/commit", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const id = (request.params as { id?: unknown }).id;
    const body = request.body;
    if (typeof id !== "string" || !isUuidV4(id) || !validSnapshotBody(body)) return reply.code(400).send({ error: "invalid_photo_commit" });
    const snapshot = parseRemoteChatSnapshot(body.snapshot);
    if (!snapshot || snapshot.version !== 3 || snapshot.revision !== body.expectedRevision + 1) return reply.code(400).send({ error: "invalid_photo_commit" });
    const lease = options.writeGate.enter("user_mutation");
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    const commit = options.repository.commitPhoto(request.yuiUser, { photoId: id, expectedRevision: body.expectedRevision, snapshot });
    const saved = await withPhotoCommitDeadline(commit, options.photoCommitTimeoutMs ?? PHOTO_COMMIT_TIMEOUT_MS);
    if (saved === "unavailable") void commit.then(() => lease.release(), () => lease.release());
    else lease.release();
    if (saved === "stale") return reply.code(409).send({ error: "chat_state_conflict" });
    if (saved === "not_found") return reply.code(404).send({ error: "photo_not_found" });
    if (saved === "not_ready") return reply.code(409).send({ error: "photo_not_ready" });
    if (saved === "blocked") return reply.code(409).send({ error: "photo_blocked" });
    if (saved === "unavailable") return reply.code(503).send({ error: "photo_commit_unavailable" });
    if (!saved || typeof saved !== "object") return saved;
    return { snapshot: saved };
  });

  app.delete("/api/photos/:id", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const id = (request.params as { id?: unknown }).id;
    const body = request.body;
    if (typeof id !== "string" || !isUuidV4(id) || !validExpectedRevision(body)) return reply.code(400).send({ error: "invalid_photo_delete" });
    const mutation = await withMutation(() => options.repository.deletePhoto(request.yuiUser, { photoId: id, expectedRevision: body.expectedRevision }));
    if (!mutation.accepted) return reply.code(503).send({ error: "maintenance" });
    const saved = mutation.value;
    if (saved.kind !== "deleted") {
      if (saved.kind === "stale") return reply.code(409).send({ error: "chat_state_conflict" });
      if (saved.kind === "not_found") return reply.code(404).send({ error: "photo_not_found" });
      if (saved.kind === "not_ready") return reply.code(409).send({ error: "photo_not_ready" });
      if (saved.kind === "blocked") return reply.code(409).send({ error: "photo_blocked" });
      return reply.code(503).send({ error: "photo_delete_unavailable" });
    }
    return { snapshot: saved.snapshot };
  });

  app.delete("/api/chat-state", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = request.body;
    if (!validExpectedRevision(body)) return reply.code(400).send({ error: "invalid_chat_delete" });
    const mutation = await withMutation(() => options.repository.deleteWholeChat(request.yuiUser, (body as { expectedRevision: number }).expectedRevision));
    if (!mutation.accepted) return reply.code(503).send({ error: "maintenance" });
    const result = mutation.value;
    if (result.kind !== "deleted") {
      if (result.kind === "stale") return reply.code(409).send({ error: "chat_state_conflict" });
      if (result.kind === "not_found") return reply.code(404).send({ error: "chat_state_not_found" });
      return reply.code(503).send({ error: "chat_delete_unavailable" });
    }
    return { snapshot: result.snapshot, blockedPhotoCount: result.blockedPhotoCount };
  });
}

function validSnapshotBody(value: unknown): value is { expectedRevision: number; snapshot: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 2 && Number.isSafeInteger((value as { expectedRevision?: unknown }).expectedRevision)
    && (value as { expectedRevision: number }).expectedRevision >= 0 && Object.hasOwn(value, "snapshot");
}

function validExpectedRevision(value: unknown): value is { expectedRevision: number } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && Number.isSafeInteger((value as { expectedRevision?: unknown }).expectedRevision)
    && (value as { expectedRevision: number }).expectedRevision >= 0;
}

function isUuidV4(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
