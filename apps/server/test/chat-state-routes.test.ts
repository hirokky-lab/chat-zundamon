import { describe, expect, it, vi } from "vitest";
import type { RemoteChatSnapshot } from "@yui/domain";
import Fastify from "fastify";
import { buildApp } from "../src/app";
import { registerChatStateRoutes, type ChatStateRepository } from "../src/chat-state-routes";
import { createWriteGate } from "../src/write-gate";

const now = "2026-08-10T06:30:00.000Z";

function snapshot(revision = 0): RemoteChatSnapshot {
  return {
    timeline: [],
    lastOpeningAt: null,
    lastConversationAt: null,
    version: 2,
    revision,
    updatedAt: now,
  };
}

function repository(initial: RemoteChatSnapshot | null = null): ChatStateRepository {
  let current = initial;
  const saveReconciled: ChatStateRepository["saveReconciled"] = async (_user, input) => {
    if (current) {
      if (
        current.revision === input.expectedRevision + 1 &&
        JSON.stringify({ ...current, revision: input.expectedRevision, updatedAt: input.snapshot.updatedAt }) === JSON.stringify(input.snapshot)
      ) return current;
      if (current.revision !== input.expectedRevision) return "stale";
    } else if (input.expectedRevision !== 0) return "stale";
    current = { ...input.snapshot, revision: input.expectedRevision + 1, updatedAt: now };
    return current;
  };
  return {
    get: async () => current,
    saveReconciled,
    save: saveReconciled,
    commitPhoto: async () => "stale",
    deletePhoto: async () => "stale",
    deleteWholeChat: async () => "stale",
  };
}

describe("chat state routes", () => {
  it("ends a photo commit that exceeds the application deadline without claiming success", async () => {
    const photoId = "10000000-0000-4000-8000-000000000001";
    const messageId = "20000000-0000-4000-8000-000000000001";
    const pending = { ...repository(), commitPhoto: async () => await new Promise<never>(() => undefined) };
    const app = Fastify();
    app.addHook("preHandler", async (request) => { (request as never as { yuiUser: unknown }).yuiUser = { userId: "00000000-0000-4000-8000-000000000001" }; });
    registerChatStateRoutes(app, { repository: pending, now: () => new Date(now), writeGate: createWriteGate(), photoCommitTimeoutMs: 1 } as never);
    const response = await app.inject({ method: "POST", url: `/api/photos/${photoId}/commit`, payload: { expectedRevision: 0, snapshot: { ...snapshot(1), version: 3 as const, timeline: [{ id: messageId, type: "photo" as const, role: "user" as const, photoId, caption: "", origin: "photo" as const, createdAt: now, delivery: "sent" as const }] } } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "photo_commit_unavailable" });
  });
  it("keeps the restore gate draining until a timed-out photo commit settles", async () => {
    const photoId = "10000000-0000-4000-8000-000000000002";
    const messageId = "20000000-0000-4000-8000-000000000002";
    let settle: (() => void) | undefined;
    const lateCommit = new Promise<never>((resolve) => { settle = () => resolve(undefined as never); });
    const gate = createWriteGate();
    const pending = { ...repository(), commitPhoto: async () => await lateCommit };
    const app = Fastify();
    app.addHook("preHandler", async (request) => { (request as never as { yuiUser: unknown }).yuiUser = { userId: "00000000-0000-4000-8000-000000000001" }; });
    registerChatStateRoutes(app, { repository: pending, now: () => new Date(now), writeGate: gate, photoCommitTimeoutMs: 1 } as never);

    const response = await app.inject({ method: "POST", url: `/api/photos/${photoId}/commit`, payload: { expectedRevision: 0, snapshot: { ...snapshot(1), version: 3 as const, timeline: [{ id: messageId, type: "photo" as const, role: "user" as const, photoId, caption: "", origin: "photo" as const, createdAt: now, delivery: "sent" as const }] } } });

    expect(response.statusCode).toBe(503);
    let drained = false;
    void gate.waitForDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    settle?.();
    await vi.waitFor(() => expect(drained).toBe(true));
  });
  it("fails setup before registering any chat-state mutation route when writeGate is missing", () => {
    const app = Fastify();
    expect(() => registerChatStateRoutes(app, { repository: repository(), now: () => new Date(now) } as never))
      .toThrow("chat_state_write_gate_required");
    for (const route of [
      { method: "PUT", url: "/api/chat-state" },
      { method: "POST", url: "/api/photos/:id/commit" },
      { method: "DELETE", url: "/api/photos/:id" },
      { method: "DELETE", url: "/api/chat-state" },
    ] as const) expect(app.hasRoute(route)).toBe(false);
  });

  it("returns an empty revision-zero snapshot for a new authenticated user", async () => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      chatStateRepository: repository(),
      now: () => new Date(now),
    });

    const response = await app.inject({ method: "GET", url: "/api/chat-state" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ snapshot: snapshot() });
  });

  it.each([
    ["draft", { ...snapshot(), draft: "端末だけの下書き" }],
    ["unknown nested field", { ...snapshot(), futureField: true }],
    ["another user", { ...snapshot(), userId: "00000000-0000-0000-0000-00000000000b" }],
    ["oversized timeline", { ...snapshot(), timeline: Array.from({ length: 20_001 }, (_, index) => ({ id: `call-${index}`, type: "call", startedAt: now, endedAt: now })) }],
  ])("rejects cloud-unsafe snapshot data: %s", async (_name, unsafeSnapshot) => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      chatStateRepository: repository(),
      now: () => new Date(now),
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/chat-state",
      payload: { expectedRevision: 0, snapshot: unsafeSnapshot },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("returns conflict for a stale revision without overwriting the newer snapshot", async () => {
    const current = {
      ...snapshot(2),
      timeline: [{ id: "call-current", type: "call" as const, startedAt: now, endedAt: now }],
    };
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      chatStateRepository: repository(current),
      now: () => new Date(now),
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/chat-state",
      payload: { expectedRevision: 1, snapshot: snapshot(1) },
    });
    const read = await app.inject({ method: "GET", url: "/api/chat-state" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "chat_state_conflict" });
    expect(read.json()).toEqual({ snapshot: current });
  });

  it("fails closed when the authoritative snapshot backend is unavailable", async () => {
    const unavailable = {
      ...repository(),
      saveReconciled: async () => "unavailable" as const,
      save: async () => "unavailable" as const,
    } as ChatStateRepository;
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      chatStateRepository: unavailable,
      now: () => new Date(now),
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/chat-state",
      payload: { expectedRevision: 0, snapshot: snapshot(0) },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "chat_state_unavailable" });
  });

  it("returns the same saved revision when the identical request is retried", async () => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      chatStateRepository: repository(),
      now: () => new Date(now),
    });
    const payload = { expectedRevision: 0, snapshot: snapshot(0) };

    const first = await app.inject({ method: "PUT", url: "/api/chat-state", payload });
    const retry = await app.inject({ method: "PUT", url: "/api/chat-state", payload });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(first.json()).toEqual(retry.json());
    expect(first.json().snapshot.revision).toBe(1);
  });

  it("keeps conversation reads available while restore closes semantic chat mutations", async () => {
    const gate = createWriteGate();
    gate.closeForRestore();
    const app = buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, chatStateRepository: repository(), now: () => new Date(now), writeGate: gate });

    const read = await app.inject({ method: "GET", url: "/api/chat-state" });
    const write = await app.inject({ method: "PUT", url: "/api/chat-state", payload: { expectedRevision: 0, snapshot: snapshot() } });

    expect(read.statusCode).toBe(200);
    expect(write.statusCode).toBe(503);
    expect(write.json()).toEqual({ error: "maintenance" });
  });

  it("blocks photo commit, photo delete, and whole-chat delete before repository mutation while restore is closed", async () => {
    const gate = createWriteGate();
    gate.closeForRestore();
    const photoId = "10000000-0000-4000-8000-000000000001";
    const messageId = "20000000-0000-4000-8000-000000000001";
    const commitPhoto = vi.fn();
    const deletePhoto = vi.fn();
    const deleteWholeChat = vi.fn();
    const guardedRepository = {
      ...repository(), commitPhoto, deletePhoto, deleteWholeChat,
    } as unknown as ChatStateRepository;
    const app = buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, chatStateRepository: guardedRepository, now: () => new Date(now), writeGate: gate });
    const commitSnapshot = { ...snapshot(1), version: 3 as const, timeline: [{ id: messageId, type: "photo" as const, role: "user" as const, photoId, caption: "", origin: "photo" as const, createdAt: now, delivery: "sent" as const }] };
    const [commit, photoDelete, wholeDelete] = await Promise.all([
      app.inject({ method: "POST", url: `/api/photos/${photoId}/commit`, payload: { expectedRevision: 0, snapshot: commitSnapshot } }),
      app.inject({ method: "DELETE", url: `/api/photos/${photoId}`, payload: { expectedRevision: 0 } }),
      app.inject({ method: "DELETE", url: "/api/chat-state", payload: { expectedRevision: 0 } }),
    ]);
    expect([commit.statusCode, photoDelete.statusCode, wholeDelete.statusCode]).toEqual([503, 503, 503]);
    expect(commitPhoto).not.toHaveBeenCalled();
    expect(deletePhoto).not.toHaveBeenCalled();
    expect(deleteWholeChat).not.toHaveBeenCalled();
  });

  it("uses the photo id path parameter for an idempotent dedicated commit", async () => {
    const photoId = "10000000-0000-4000-8000-000000000001";
    const messageId = "20000000-0000-4000-8000-000000000001";
    const committed = snapshot(1);
    const repository = {
      get: async () => committed,
      saveReconciled: async () => "stale" as const,
      save: async () => "stale" as const,
      commitPhoto: async (_user: unknown, input: { photoId: string }) => input.photoId === photoId ? committed : "stale" as const,
      deletePhoto: async () => ({ kind: "stale" as const }),
      deleteWholeChat: async () => ({ kind: "stale" as const }),
    } as unknown as ChatStateRepository;
    const app = buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, chatStateRepository: repository, now: () => new Date(now) });
    const response = await app.inject({
      method: "POST", url: `/api/photos/${photoId}/commit`,
      payload: { expectedRevision: 0, snapshot: { ...snapshot(1), version: 3, timeline: [{ id: messageId, type: "photo", role: "user", photoId, caption: "", origin: "photo", createdAt: now, delivery: "sent" }] } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ snapshot: committed });
  });

  it("accepts an exact photo delete revision body and returns whole-chat deletion details", async () => {
    const photoId = "10000000-0000-4000-8000-000000000001";
    const repository = {
      get: async () => snapshot(2), saveReconciled: async () => "stale" as const, save: async () => "stale" as const, commitPhoto: async () => "stale" as const,
      deletePhoto: async (_user: unknown, input: { photoId: string; expectedRevision: number }) => input.photoId === photoId && input.expectedRevision === 2 ? { kind: "deleted" as const, snapshot: snapshot(3) } : { kind: "stale" as const },
      deleteWholeChat: async () => ({ kind: "deleted" as const, snapshot: snapshot(), blockedPhotoCount: 1 }),
    } as unknown as ChatStateRepository;
    const app = buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, chatStateRepository: repository, now: () => new Date(now) });
    const deleted = await app.inject({ method: "DELETE", url: `/api/photos/${photoId}`, payload: { expectedRevision: 2 } });
    const whole = await app.inject({ method: "DELETE", url: "/api/chat-state", payload: { expectedRevision: 2 } });
    expect(deleted.statusCode).toBe(200);
    expect(whole.statusCode).toBe(200);
    expect(whole.json()).toEqual({ snapshot: snapshot(), blockedPhotoCount: 1 });
  });

  it("closes profile, memory settings, and automatic memory processing while leaving reads available", async () => {
    const gate = createWriteGate();
    gate.closeForRestore();
    const app = buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, now: () => new Date(now), writeGate: gate });
    const [profile, settings, process, read] = await Promise.all([
      app.inject({ method: "PUT", url: "/api/profile", payload: { displayName: "大輝", addressingStyle: "san" } }),
      app.inject({ method: "PATCH", url: "/api/memory-settings", payload: { memoryEnabled: false } }),
      app.inject({
        method: "POST",
        url: "/api/memory/process",
        payload: {
          sourceMessageId: `voice:${"a".repeat(64)}`,
          sourceOccurredAt: now,
          sourceOrigin: "voice",
          explicitMemoryTargetTurnIndexes: [0],
          turns: [{ role: "user", text: "覚えて", provenance: "authoritative_source" }],
        },
      }),
      app.inject({ method: "GET", url: "/api/profile" }),
    ]);
    expect([profile.statusCode, settings.statusCode, process.statusCode]).toEqual([503, 503, 503]);
    expect(read.statusCode).toBe(200);
  });
});
