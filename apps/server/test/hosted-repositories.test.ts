import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseChatStateRepository,
  createSupabaseMemoryRepository,
  createSupabaseMemorySettingsRepository,
  createSupabaseProfileRepository,
  createSupabaseUsageLog,
  HostedRepositoryError,
} from "../src/hosted-repositories";
import type { RequestUser } from "../src/request-user";
import type { MemoryCandidateV2, RemoteChatSnapshot } from "../../../packages/domain/src/index.js";
import { confirmTestMemory } from "./test-memory.js";
import { isAllowedMemoryMutationOperation } from "../src/supabase-client";

const user: RequestUser = {
  userId: "00000000-0000-0000-0000-00000000000a",
  email: "owner@example.com",
  accessToken: "private-access-token",
};

function query(result: unknown) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "in", "order", "upsert", "insert", "update", "delete"]) {
    builder[method] = vi.fn((...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    });
  }
  builder.maybeSingle = vi.fn(async () => result);
  builder.single = vi.fn(async () => result);
  builder.then = vi.fn((resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve));
  return { builder, calls };
}

describe("hosted repositories", () => {
  it("keeps every hosted memory RPC used by repositories on the service allowlist", () => {
    for (const operation of [
      "claim_memory_processing", "get_automatic_memory_outbox", "clear_automatic_memory_outbox",
      "fail_voice_automatic_memory_processing", "has_active_voice_memory_processing",
    ]) expect(isAllowedMemoryMutationOperation(operation)).toBe(true);
  });

  it("saves a user-scoped chat snapshot once and returns the same revision on retry", async () => {
    const timestamp = "2026-08-10T00:00:00.000Z";
    const remote = {
      timeline: [],
      lastOpeningAt: null,
      lastConversationAt: null,
      version: 2 as const,
      revision: 0,
      updatedAt: timestamp,
    };
    const savedRow = {
      user_id: user.userId,
      version: 2,
      revision: 1,
      snapshot: {
        timeline: [],
        lastOpeningAt: null,
        lastConversationAt: null,
      },
      updated_at: timestamp,
    };
    const retryLookup = query({ data: savedRow, error: null });
    let calls = 0;
    const rpc = vi.fn(async () => ++calls === 1
      ? { data: savedRow, error: null }
      : { data: null, error: new Error("snapshot revision mismatch") });
    const repository = createSupabaseChatStateRepository(
      () => ({ from: () => retryLookup.builder, rpc: vi.fn() }),
      () => ({ from: vi.fn(), rpc }),
    );

    const first = await repository.save(user, { expectedRevision: 0, snapshot: remote });
    const retry = await repository.save(user, { expectedRevision: 0, snapshot: remote });

    expect(first).toEqual({ ...remote, revision: 1 });
    expect(retry).toEqual(first);
    expect(rpc).toHaveBeenCalledWith("save_chat_snapshot_reconciled", {
      p_expected_revision: 0,
      p_snapshot: { ...remote, revision: 1 },
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(retryLookup.calls).toContainEqual(["eq", ["user_id", user.userId]]);
  });

  it("creates the first owner-scoped snapshot after the update RPC confirms the row is missing", async () => {
    const timestamp = "2026-08-10T00:00:00.000Z";
    const remote = {
      timeline: [],
      lastOpeningAt: null,
      lastConversationAt: null,
      version: 2 as const,
      revision: 0,
      updatedAt: timestamp,
    };
    const savedRow = {
      user_id: user.userId,
      version: 2,
      revision: 1,
      snapshot: { ...remote, revision: 1 },
      updated_at: timestamp,
    };
    const missing = query({ data: null, error: null });
    const insert = query({ data: savedRow, error: null });
    const rpc = vi.fn(async () => ({ data: null, error: { code: "PT409", message: "snapshot revision mismatch" } }));
    const repository = createSupabaseChatStateRepository(
      () => ({ from: () => missing.builder, rpc: vi.fn() }),
      () => ({ from: () => insert.builder, rpc }),
    );

    await expect(repository.save(user, { expectedRevision: 0, snapshot: remote }))
      .resolves.toEqual({ ...remote, revision: 1 });
    expect(insert.calls).toContainEqual(["insert", [{
      user_id: user.userId,
      version: 2,
      revision: 1,
      snapshot: { ...remote, revision: 1 },
      updated_at: timestamp,
    }]]);
    expect(insert.calls).toContainEqual(["select", ["version,revision,snapshot,updated_at"]]);
  });

  it("falls back to the owner-scoped v2 text update only when the reconciled RPC is absent", async () => {
    const timestamp = "2026-08-10T00:00:00.000Z";
    const message = {
      id: "10000000-0000-4000-8000-000000000001",
      type: "message" as const,
      role: "user" as const,
      text: "動作確認",
      createdAt: timestamp,
      delivery: "sending" as const,
    };
    const currentRow = {
      user_id: user.userId,
      version: 2,
      revision: 7,
      snapshot: { timeline: [], lastOpeningAt: null, lastConversationAt: null },
      updated_at: timestamp,
    };
    const savedRow = {
      ...currentRow,
      revision: 8,
      snapshot: { timeline: [message], lastOpeningAt: null, lastConversationAt: null },
    };
    const read = query({ data: currentRow, error: null });
    const update = query({ data: savedRow, error: null });
    const from = vi.fn()
      .mockReturnValueOnce(read.builder)
      .mockReturnValueOnce(update.builder);
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "PGRST202", message: "schema cache miss" },
    }));
    const repository = createSupabaseChatStateRepository(
      () => ({ from, rpc: vi.fn() }),
      () => ({ from: vi.fn(), rpc }),
    );
    const input: RemoteChatSnapshot = {
      timeline: [message],
      lastOpeningAt: null,
      lastConversationAt: null,
      version: 3,
      revision: 7,
      updatedAt: timestamp,
    };

    await expect(repository.saveReconciled(user, { expectedRevision: 7, snapshot: input }))
      .resolves.toEqual({ ...input, version: 2, revision: 8 });
    expect(update.calls).toContainEqual(["update", [{
      user_id: user.userId,
      version: 2,
      revision: 8,
      snapshot: { timeline: [message], lastOpeningAt: null, lastConversationAt: null },
      updated_at: timestamp,
    }]]);
    expect(update.calls).toContainEqual(["eq", ["user_id", user.userId]]);
    expect(update.calls).toContainEqual(["eq", ["revision", 7]]);
  });

  it("creates an owner-scoped v2 text row when the reconciled RPC is absent before the first turn", async () => {
    const timestamp = "2026-08-10T00:00:00.000Z";
    const message = {
      id: "10000000-0000-4000-8000-000000000001",
      type: "message" as const,
      role: "user" as const,
      text: "最初の動作確認",
      createdAt: timestamp,
      delivery: "sending" as const,
    };
    const input: RemoteChatSnapshot = {
      timeline: [message], lastOpeningAt: null, lastConversationAt: null,
      version: 3, revision: 0, updatedAt: timestamp,
    };
    const savedRow = {
      user_id: user.userId,
      version: 2,
      revision: 1,
      snapshot: { timeline: [message], lastOpeningAt: null, lastConversationAt: null },
      updated_at: timestamp,
    };
    const missing = query({ data: null, error: null });
    const insert = query({ data: savedRow, error: null });
    const from = vi.fn()
      .mockReturnValueOnce(missing.builder)
      .mockReturnValueOnce(insert.builder);
    const repository = createSupabaseChatStateRepository(
      () => ({ from, rpc: vi.fn() }),
      () => ({ from: vi.fn(), rpc: vi.fn(async () => ({
        data: null,
        error: { code: "PGRST202", message: "schema cache miss" },
      })) }),
    );

    await expect(repository.saveReconciled(user, { expectedRevision: 0, snapshot: input }))
      .resolves.toEqual({ ...input, version: 2, revision: 1 });
    expect(insert.calls).toContainEqual(["insert", [savedRow]]);
  });

  it("does not use the legacy text path for unknown RPC failures or photo lineage", async () => {
    const timestamp = "2026-08-13T00:00:00.000Z";
    const ordinary: RemoteChatSnapshot = {
      timeline: [], lastOpeningAt: null, lastConversationAt: null,
      version: 3, revision: 1, updatedAt: timestamp,
    };
    const photo: RemoteChatSnapshot = {
      ...ordinary,
      timeline: [{
        id: "10000000-0000-4000-8000-000000000001",
        type: "photo",
        role: "user",
        photoId: "20000000-0000-4000-8000-000000000001",
        caption: "",
        origin: "photo",
        createdAt: timestamp,
        delivery: "sent",
      }],
    };

    for (const [snapshot, error, expected] of [
      [ordinary, { code: "PGRST500", message: "provider unavailable" }, "unavailable"],
      [photo, { code: "PGRST202", message: "schema cache miss" }, "rejected"],
    ] as const) {
      const read = query({ data: {
        user_id: user.userId,
        version: snapshot.version,
        revision: snapshot.revision,
        snapshot,
        updated_at: timestamp,
      }, error: null });
      const from = vi.fn(() => read.builder);
      const repository = createSupabaseChatStateRepository(
        () => ({ from, rpc: vi.fn() }),
        () => ({ from: vi.fn(), rpc: vi.fn(async () => ({ data: null, error })) }),
      );

      await expect(repository.saveReconciled(user, { expectedRevision: 1, snapshot })).resolves.toBe(expected);
      expect(read.calls.some(([method]) => method === "update" || method === "insert")).toBe(false);
    }
  });

  it("never creates an initial row after an unknown RPC outcome or through generic photo persistence", async () => {
    const timestamp = "2026-08-10T00:00:00.000Z";
    const ordinary: RemoteChatSnapshot = {
      timeline: [], lastOpeningAt: null, lastConversationAt: null,
      version: 2, revision: 0, updatedAt: timestamp,
    };
    const photo: RemoteChatSnapshot = {
      ...ordinary,
      version: 3,
      timeline: [{
        id: "10000000-0000-4000-8000-000000000001",
        type: "photo",
        role: "user",
        photoId: "20000000-0000-4000-8000-000000000001",
        caption: "",
        origin: "photo",
        createdAt: timestamp,
        delivery: "sent",
      }],
    };

    for (const [snapshot, error, expected] of [
      [ordinary, new Error("upstream unavailable"), "unavailable"],
      [photo, new Error("snapshot revision mismatch"), "rejected"],
    ] as const) {
      const missing = query({ data: null, error: null });
      const insert = query({ data: null, error: null });
      const repository = createSupabaseChatStateRepository(
        () => ({ from: () => missing.builder, rpc: vi.fn() }),
        () => ({ from: () => insert.builder, rpc: vi.fn(async () => ({ data: null, error })) }),
      );
      await expect(repository.save(user, { expectedRevision: 0, snapshot })).resolves.toBe(expected);
      expect(insert.calls.some(([method]) => method === "insert")).toBe(false);
    }
  });

  it("normalizes PostgreSQL chat snapshot timestamps returned to the app", async () => {
    const q = query({
      data: {
        version: 1,
        revision: 1,
        snapshot: {
          timeline: [],
          lastOpeningAt: null,
          lastConversationAt: null,
          reviewedLocalDates: [],
        },
        updated_at: "2026-08-10T03:27:26.123456+00:00",
      },
      error: null,
    });
    const repository = createSupabaseChatStateRepository(
      () => ({ from: () => q.builder, rpc: vi.fn() }),
      () => ({ from: vi.fn(), rpc: vi.fn() }),
    );

    await expect(repository.get(user)).resolves.toMatchObject({
      revision: 1,
      updatedAt: "2026-08-10T03:27:26.123Z",
    });
  });

  it("keeps an already committed photo snapshot idempotent and rejects generic photo lineage removal", async () => {
    const timestamp = "2026-08-13T00:00:00.000Z";
    const photoId = "10000000-0000-4000-8000-000000000001";
    const messageId = "20000000-0000-4000-8000-000000000001";
    const committed = {
      timeline: [{ id: messageId, type: "photo" as const, role: "user" as const, photoId, caption: "", origin: "photo" as const, createdAt: timestamp, delivery: "sent" as const }],
      lastOpeningAt: null, lastConversationAt: null, version: 3 as const, revision: 1, updatedAt: timestamp,
    };
    const read = query({ data: { version: 3, revision: 1, snapshot: { timeline: committed.timeline, lastOpeningAt: null, lastConversationAt: null }, updated_at: timestamp }, error: null });
    const rpc = vi.fn(async (name: string) => name === "save_chat_snapshot_reconciled"
      ? { data: null, error: { code: "22023", message: "photo lineage requires dedicated operation" } }
      : { data: null, error: null });
    const repository = createSupabaseChatStateRepository(
      () => ({ from: () => read.builder, rpc: vi.fn() }),
      () => ({ from: vi.fn(), rpc }),
    );
    await expect(repository.commitPhoto(user, { photoId, expectedRevision: 0, snapshot: committed })).resolves.toEqual(committed);
    await expect(repository.saveReconciled(user, { expectedRevision: 1, snapshot: { ...committed, timeline: [] } })).resolves.toBe("rejected");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("reads a profile through a user-token client and explicit user_id filter", async () => {
    const q = query({ data: { display_name: "大輝", addressing_style: "san", updated_at: "2026-08-10T00:00:00.000Z" }, error: null });
    const from = vi.fn(() => q.builder);
    const factory = vi.fn(() => ({ from }));
    const repository = createSupabaseProfileRepository(factory);

    await expect(repository.get(user)).resolves.toMatchObject({ displayName: "大輝" });
    expect(factory).toHaveBeenCalledWith(user);
    expect(from).toHaveBeenCalledWith("profiles");
    expect(q.calls).toContainEqual(["eq", ["user_id", user.userId]]);
  });

  it("normalizes PostgreSQL profile timestamps before domain validation", async () => {
    const q = query({
      data: {
        display_name: "サンプルユーザー",
        addressing_style: "san",
        updated_at: "2026-08-10T03:27:26.123456+00:00",
      },
      error: null,
    });
    const repository = createSupabaseProfileRepository(() => ({ from: () => q.builder }));

    await expect(repository.get(user)).resolves.toEqual({
      displayName: "サンプルユーザー",
      addressingStyle: "san",
      updatedAt: "2026-08-10T03:27:26.123Z",
    });
  });

  it("rejects upstream and invalid rows with one safe error type", async () => {
    for (const result of [
      { data: null, error: { message: "private upstream body" } },
      { data: { display_name: "", addressing_style: "san", updated_at: "bad" }, error: null },
    ]) {
      const q = query(result);
      const repository = createSupabaseProfileRepository(() => ({ from: () => q.builder }));
      await expect(repository.get(user)).rejects.toBeInstanceOf(HostedRepositoryError);
    }
  });

  it("scopes memory confirmation to the authenticated user", async () => {
    const lookup = query({ data: null, error: null });
    const insert = query({
      data: {
        id: "10000000-0000-4000-8000-000000000001", kind: "shared", scope: "shared", content: "二人の記憶", content_normalized: "二人の記憶",
        status: "active", origin: "explicit", sensitivity: "normal", importance: 4, source_message_id: null, source_occurred_at: null,
        valid_from: null, valid_until: null, expires_at: null, pinned: true, supersedes_id: null,
        created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z",
      },
      error: null,
    });
    const queues = [lookup, insert];
    const repository = createSupabaseMemoryRepository(() => ({ from: () => queues.shift()!.builder }));

    const saved = await confirmTestMemory(repository, user, { kind: "shared", content: "二人の記憶", importance: 4 });

    expect(lookup.calls).toContainEqual(["eq", ["user_id", user.userId]]);
    expect(insert.calls).toContainEqual(["insert", [expect.objectContaining({ user_id: user.userId })]]);
    const payload = insert.calls.find(([method]) => method === "insert")?.[1][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "content", "content_normalized", "created_at", "expires_at", "id", "importance", "kind", "origin", "pinned",
      "scope", "sensitivity", "source_message_id", "source_occurred_at", "status", "supersedes_id", "updated_at", "user_id",
      "valid_from", "valid_until",
    ]);
    expect(saved.id).toBe("10000000-0000-4000-8000-000000000001");
  });

  it("reads legacy-compatible v2 records with approved defaults", async () => {
    const q = query({
      data: [{
        id: "10000000-0000-4000-8000-000000000001", kind: "preference", scope: "shared", content: "ブラックコーヒーが好き", content_normalized: "ブラックコーヒーが好き",
        status: "active", origin: "explicit", sensitivity: "normal", importance: 4, source_message_id: null, source_occurred_at: null,
        valid_from: null, valid_until: null, expires_at: null, pinned: true, supersedes_id: null,
        created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z",
      }],
      error: null,
    });
    const repository = createSupabaseMemoryRepository(() => ({ from: () => q.builder }));

    await expect(repository.list(user)).resolves.toEqual([
      expect.objectContaining({ content: "ブラックコーヒーが好き", status: "active", pinned: true }),
    ]);
  });

  it("lists and releases only the authenticated user's active tombstones", async () => {
    const listed = query({
      data: [{
        id: "10000000-0000-4000-8000-000000000010",
        memory_id: "10000000-0000-4000-8000-000000000001",
        normalized_fingerprint: "友達と昼食を食べた",
        created_at: "2026-08-10T00:00:00.000Z",
        released_at: null,
      }],
      error: null,
    });
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const repository = createSupabaseMemoryRepository(() => ({ from: () => listed.builder, rpc }));

    await expect(repository.listActiveTombstones(user)).resolves.toEqual([
      expect.objectContaining({ id: "10000000-0000-4000-8000-000000000010", releasedAt: null }),
    ]);
    await repository.releaseTombstone(user, "10000000-0000-4000-8000-000000000010");

    expect(listed.calls).toContainEqual(["eq", ["user_id", user.userId]]);
    expect(rpc).toHaveBeenCalledWith("release_memory_tombstone", { p_tombstone_id: "10000000-0000-4000-8000-000000000010" });
  });

  it("forgets memories and releases tombstones through owner-scoped atomic RPCs", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const repository = createSupabaseMemoryRepository(() => ({ from: vi.fn(), rpc }));

    await repository.forget(user, "10000000-0000-4000-8000-000000000001", true);
    await repository.releaseTombstone(user, "10000000-0000-4000-8000-000000000010");

    expect(rpc).toHaveBeenNthCalledWith(1, "forget_memory", {
      p_target_id: "10000000-0000-4000-8000-000000000001",
      p_block_relearning: true,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "release_memory_tombstone", {
      p_tombstone_id: "10000000-0000-4000-8000-000000000010",
    });
  });

  it("routes memory mutations through the server-only mutation client", async () => {
    const userRpc = vi.fn();
    const serverRpc = vi.fn(async () => ({ data: true, error: null }));
    const repository = createSupabaseMemoryRepository(
      () => ({ from: vi.fn(), rpc: userRpc }),
      () => ({ from: vi.fn(), rpc: serverRpc }),
    );

    await repository.forget(user, "10000000-0000-4000-8000-000000000001", true);

    expect(userRpc).not.toHaveBeenCalled();
    expect(serverRpc).toHaveBeenCalledWith("forget_memory", expect.any(Object));
  });

  it("persists memory controls with an explicit authenticated-user key", async () => {
    const timestamp = "2026-08-11T00:00:00.000Z";
    const loaded = query({ data: { memory_enabled: true, updated_at: timestamp }, error: null });
    const rpc = vi.fn(async () => ({ data: { memory_enabled: false, updated_at: timestamp }, error: null }));
    const repository = createSupabaseMemorySettingsRepository(() => ({ from: () => loaded.builder, rpc }));

    await expect(repository.get(user)).resolves.toMatchObject({ memoryEnabled: true });
    await expect(repository.patch(user, { memoryEnabled: false })).resolves.toMatchObject({ memoryEnabled: false });

    expect(loaded.calls).toContainEqual(["eq", ["user_id", user.userId]]);
    expect(rpc).toHaveBeenCalledWith("patch_memory_settings", { p_key: "memory_enabled", p_enabled: false });
  });

  it("preserves the hosted disabled result from the atomic automatic action RPC", async () => {
    const rpc = vi.fn(async () => ({ data: "disabled", error: null }));
    const repository = createSupabaseMemoryRepository(() => ({ from: vi.fn(), rpc }));

    await expect(repository.applyPreparedAutomaticAction(user, "paused-source", 0, {
      type: "forget", targetMemoryId: "10000000-0000-4000-8000-000000000001", blockRelearning: true,
    })).resolves.toBe("disabled");
  });

  it("preserves atomic voice-claim OFF and durable lease cleanup results", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { state: "disabled", appliedCount: 0, retry: false }, error: null })
      .mockResolvedValueOnce({ data: { state: "failed", appliedCount: 0 }, error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: 1, error: null });
    const repository = createSupabaseMemoryRepository(() => ({ from: vi.fn(), rpc }));
    const source = `voice:${"e".repeat(64)}`;
    const cutoff = "2026-08-11T00:05:00.000Z";

    await expect(repository.claimAutomaticProcessing(user, source, "voice")).resolves.toEqual({ state: "disabled", appliedCount: 0, retry: false });
    await expect(repository.failAutomaticVoiceProcessing(user, source, 0)).resolves.toBeUndefined();
    await expect(repository.hasActiveVoiceProcessing(user, cutoff)).resolves.toBe(true);
    await expect(repository.cleanupStaleVoiceProcessing(user, cutoff)).resolves.toBe(1);

    expect(rpc).toHaveBeenNthCalledWith(1, "claim_automatic_memory_processing", { p_source_message_id: source });
    expect(rpc).toHaveBeenNthCalledWith(2, "fail_voice_automatic_memory_processing", { p_source_message_id: source, p_applied_count: 0 });
    expect(rpc).toHaveBeenNthCalledWith(3, "has_active_voice_memory_processing", { p_cutoff: cutoff });
    expect(rpc).toHaveBeenNthCalledWith(4, "cleanup_stale_voice_memory_processing", { p_cutoff: cutoff });
  });

  it("claims a durable memory action through the atomic hosted receipt RPC", async () => {
    const rpc = vi.fn(async () => ({ data: "completed", error: null }));
    const repository = createSupabaseMemoryRepository(() => ({ from: vi.fn(), rpc }));

    await expect(repository.claimProcessing(user, "durable-message")).resolves.toBe("completed");
    expect(rpc).toHaveBeenCalledWith("claim_memory_processing", { p_source_message_id: "durable-message" });
  });

  it("claims and completes a separate automatic processing receipt", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { state: "claimed", appliedCount: 1, retry: true }, error: null })
      .mockResolvedValueOnce({ data: { outboxRef: "20000000-0000-4000-8000-000000000001", actions: [{ type: "forget", targetMemoryId: "10000000-0000-4000-8000-000000000001", blockRelearning: false }], usage: null, usageSettled: false, attemptIndex: 1 }, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: "applied", error: null })
      .mockResolvedValueOnce({ data: { state: "completed", appliedCount: 2 }, error: null });
    const repository = createSupabaseMemoryRepository(() => ({ from: vi.fn(), rpc }));

    await expect(repository.claimAutomaticProcessing(user, "automatic-message")).resolves.toEqual({
      state: "claimed",
      appliedCount: 1,
      retry: true,
    });
    await expect(repository.saveAutomaticOutbox(user, "automatic-message", {
      actions: [{ type: "forget", targetMemoryId: "10000000-0000-4000-8000-000000000001", blockRelearning: false }],
      usage: null,
      attemptIndex: 1,
    })).resolves.toMatchObject({ outboxRef: "20000000-0000-4000-8000-000000000001" });
    await repository.markAutomaticOutboxUsageSettled(user, "automatic-message");
    await expect(repository.applyPreparedAutomaticAction(user, "automatic-message", 0, { type: "forget", targetMemoryId: "10000000-0000-4000-8000-000000000001", blockRelearning: false })).resolves.toBe("applied");
    await expect(repository.setAutomaticProcessing(user, "automatic-message", "completed", 2)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenNthCalledWith(1, "claim_automatic_memory_processing", { p_source_message_id: "automatic-message" });
    expect(rpc).toHaveBeenNthCalledWith(2, "save_automatic_memory_outbox", {
      p_source_message_id: "automatic-message",
      p_action_plan: [{ type: "forget", targetMemoryId: "10000000-0000-4000-8000-000000000001", blockRelearning: false }],
      p_usage: null,
      p_attempt_index: 1,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "mark_automatic_memory_usage_settled", { p_source_message_id: "automatic-message" });
    expect(rpc).toHaveBeenNthCalledWith(4, "apply_automatic_memory_action_once", {
      p_source_message_id: "automatic-message",
      p_action_index: 0,
      p_action: { type: "forget", targetMemoryId: "10000000-0000-4000-8000-000000000001", blockRelearning: false },
    });
    expect(rpc).toHaveBeenNthCalledWith(5, "finish_automatic_memory_processing", {
      p_source_message_id: "automatic-message",
      p_state: "completed",
      p_applied_count: 2,
    });
  });

  it("persists only classified metadata for each hosted extraction attempt", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { attemptIndex: 1, state: "prepared" }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const repository = createSupabaseMemoryRepository(() => ({ from: vi.fn(), rpc }));

    await expect(repository.getLatestAutomaticExtractionAttempt(user, "automatic-message")).resolves.toBeNull();
    await expect(repository.prepareAutomaticExtractionAttempt(user, "automatic-message")).resolves.toEqual({ attemptIndex: 1, state: "prepared" });
    await repository.setAutomaticExtractionAttemptState(user, "automatic-message", 1, "dispatched");

    expect(rpc.mock.calls).toEqual([
      ["get_latest_automatic_memory_attempt", { p_source_message_id: "automatic-message" }],
      ["prepare_automatic_memory_attempt", { p_source_message_id: "automatic-message" }],
      ["set_automatic_memory_attempt_state", { p_source_message_id: "automatic-message", p_attempt_index: 1, p_state: "dispatched" }],
    ]);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("朝は紅茶");
  });

  it("commits a hosted memory action through the atomic receipt RPC", async () => {
    const rpc = vi.fn(async () => ({ data: "completed", error: null }));
    const repository = createSupabaseMemoryRepository(() => ({ from: vi.fn(), rpc }));
    const action = {
      type: "forget" as const,
      targetMemoryId: "10000000-0000-4000-8000-000000000001",
      blockRelearning: true,
    };

    await expect(repository.applyPreparedAction(user, "atomic-message", action)).resolves.toBe("completed");
    expect(rpc).toHaveBeenCalledWith("apply_memory_action_once", {
      p_source_message_id: "atomic-message",
      p_action: expect.objectContaining(action),
    });
  });

  it("returns the safe quarantine state for an ambiguous legacy hosted receipt", async () => {
    const rpc = vi.fn(async () => ({ data: "quarantined", error: null }));
    const repository = createSupabaseMemoryRepository(() => ({ from: vi.fn(), rpc }));
    const action = {
      type: "add" as const,
      candidate: {
        kind: "shared" as const, scope: "shared" as const, content: "旧形式の記憶", origin: "explicit" as const,
        sensitivity: "normal" as const, importance: 3 as const, sourceMessageId: "legacy-hosted", sourceOccurredAt: null,
        validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    };

    await expect(repository.applyPreparedAction(user, "legacy-hosted", action)).resolves.toBe("quarantined");
  });

  it("normalizes PostgreSQL memory timestamps returned to the app", async () => {
    const lookup = query({ data: null, error: null });
    const insert = query({
      data: {
        id: "10000000-0000-4000-8000-000000000001",
        kind: "shared",
        scope: "shared",
        content: "二人の記憶",
        content_normalized: "二人の記憶",
        status: "active",
        origin: "explicit",
        sensitivity: "normal",
        importance: 4,
        source_message_id: null,
        source_occurred_at: null,
        valid_from: null,
        valid_until: null,
        expires_at: null,
        pinned: true,
        supersedes_id: null,
        created_at: "2026-08-10T03:27:26.123456+00:00",
        updated_at: "2026-08-10T03:27:27.654321+00:00",
      },
      error: null,
    });
    const queues = [lookup, insert];
    const repository = createSupabaseMemoryRepository(() => ({ from: () => queues.shift()!.builder }));

    await expect(confirmTestMemory(repository, user, { kind: "shared", content: "二人の記憶", importance: 4 })).resolves.toMatchObject({
      createdAt: "2026-08-10T03:27:26.123Z",
      updatedAt: "2026-08-10T03:27:27.654Z",
    });
  });

  it("merges all v2 candidate fields and reactivates normalized duplicates", async () => {
    const existing = query({ data: {
      id: "10000000-0000-4000-8000-000000000001", kind: "event", scope: "daily", content: "金曜に会議", content_normalized: "金曜に会議",
      status: "expired", origin: "extracted", sensitivity: "normal", importance: 2, source_message_id: "message-1", source_occurred_at: "2026-08-10T00:00:00.000Z",
      valid_from: null, valid_until: null, expires_at: null, pinned: false, supersedes_id: null,
      created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z",
    }, error: null });
    const updated = query({ data: {
      id: "10000000-0000-4000-8000-000000000001", kind: "schedule", scope: "work", content: " 金曜に、会議。 ", content_normalized: "金曜に会議",
      status: "active", origin: "manual", sensitivity: "sensitive", importance: 5, source_message_id: "message-2", source_occurred_at: "2026-08-11T00:00:00.000Z",
      valid_from: "2026-08-11T00:00:00.000Z", valid_until: "2026-08-12T00:00:00.000Z", expires_at: "2026-08-20T00:00:00.000Z", pinned: true, supersedes_id: "previous-memory",
      created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z",
    }, error: null });
    const queues = [existing, updated];
    const repository = createSupabaseMemoryRepository(() => ({ from: () => queues.shift()!.builder }));
    const candidate: MemoryCandidateV2 = {
      kind: "schedule", scope: "work", content: " 金曜に、会議。 ", origin: "manual", sensitivity: "sensitive", importance: 5,
      sourceMessageId: "message-2", sourceOccurredAt: "2026-08-11T00:00:00.000Z", validFrom: "2026-08-11T00:00:00.000Z",
      validUntil: "2026-08-12T00:00:00.000Z", expiresAt: "2026-08-20T00:00:00.000Z", pinned: true, supersedesId: "previous-memory",
    };

    await expect(repository.create(user, candidate)).resolves.toMatchObject({ status: "active", kind: "schedule", sourceMessageId: "message-2" });
    expect(updated.calls).toContainEqual(["update", [expect.objectContaining({
      kind: "schedule", scope: "work", content: " 金曜に、会議。 ", content_normalized: "金曜に会議", status: "active", origin: "manual",
      sensitivity: "sensitive", importance: 5, source_message_id: "message-2", pinned: true, supersedes_id: "previous-memory",
    })]]);
  });

  it("uses the atomic replacement RPC instead of separately marking the target past", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "unique conflict" } }));
    const from = vi.fn();
    const repository = createSupabaseMemoryRepository(() => ({ from, rpc }));
    const candidate: MemoryCandidateV2 = {
      kind: "event", scope: "shared", content: "重複する記憶", origin: "manual", sensitivity: "normal", importance: 4,
      sourceMessageId: null, sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: false, supersedesId: null,
    };

    await expect(repository.replace(user, "10000000-0000-4000-8000-000000000001", candidate)).rejects.toBeInstanceOf(HostedRepositoryError);
    expect(rpc).toHaveBeenCalledWith("replace_memory", expect.objectContaining({ p_target_id: "10000000-0000-4000-8000-000000000001" }));
    expect(from).not.toHaveBeenCalled();
  });

  it("stores only allowlisted usage data and never identity secrets or content", async () => {
    const q = query({ data: null, error: null });
    const repository = createSupabaseUsageLog(() => ({ from: () => q.builder }));
    await repository.append(user, {
      sessionId: "chat:one",
      startedAt: "2026-08-10T00:00:00.000Z",
      endedAt: "2026-08-10T00:00:01.000Z",
      chatInputTokens: 12,
      transcript: "保存禁止本文",
    } as never);

    const serialized = JSON.stringify(q.calls);
    expect(serialized).toContain(user.userId);
    expect(serialized).not.toContain(user.email);
    expect(serialized).not.toContain(user.accessToken);
    expect(serialized).not.toContain("保存禁止本文");
  });
});

it("sends explicit personal-detail clears to Supabase without erasing omitted fields", async () => {
  const row = {display_name:"テスト",addressing_style:"san",occupation:"",region:"東京",updated_at:"2026-09-07T00:00:00.000Z"};
  const q = query({data:row,error:null});
  const repo = createSupabaseProfileRepository(() => ({from:()=>q.builder} as never));
  expect(await repo.save(user,{displayName:"テスト",addressingStyle:"san",occupation:""})).toMatchObject({occupation:"",region:"東京"});
  const sent = q.calls.find(([method])=>method==="upsert")![1][0] as Record<string,unknown>;
  expect(sent).toMatchObject({user_id:user.userId,occupation:""});
  expect(sent).not.toHaveProperty("region");
});
