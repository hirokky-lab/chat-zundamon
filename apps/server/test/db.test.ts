import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createMemoryRepository, makeTestRepository, MEMORY_ACTION_LEASE_MS } from "../src/db";
import { createMemorySettingsRepository } from "../src/memory-settings";
import { LOCAL_USER, type RequestUser } from "../src/request-user";
import type { MemoryCandidateV2 } from "../../../packages/domain/src/index.js";
import { confirmTestMemory } from "./test-memory.js";

const userA: RequestUser = { userId: "00000000-0000-0000-0000-00000000000a", email: "a@yui.invalid", accessToken: "a" };
const userB: RequestUser = { userId: "00000000-0000-0000-0000-00000000000b", email: "b@yui.invalid", accessToken: "b" };

describe("memory repository", () => {
  it("stores only confirmed memories until an explicit forget operation", async () => {
    const repo = makeTestRepository();
    const saved = await confirmTestMemory(repo, userA, { kind: "event", content: "会議が不安", importance: 3 });

    expect(await repo.list(userA)).toHaveLength(1);
    await repo.forget(userA, saved.id, false);
    expect(await repo.list(userA)).toEqual([]);
  });

  it("checks the durable automatic setting inside the same transaction as mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-atomic-setting-"));
    const path = join(directory, "memory.sqlite");
    const repo = createMemoryRepository(path);
    const settings = createMemorySettingsRepository(path);
    await settings.patch(userA, { memoryEnabled: false });

    const result = await repo.applyPreparedAutomaticAction(userA, "paused-source", 0, {
      type: "add",
      candidate: {
        kind: "preference", scope: "shared", content: "原子的に止める", origin: "extracted", sensitivity: "normal", importance: 3,
        sourceMessageId: "paused-source", sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: false, supersedesId: null,
      },
    });

    expect(result).toBe("disabled");
    expect(await repo.list(userA)).toEqual([]);
    expect(await repo.getAutomaticActionProcessing(userA, "paused-source", 0)).toBeNull();
  });

  it("checks the durable setting inside an explicit new-memory transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-explicit-setting-"));
    const path = join(directory, "memory.sqlite");
    const repo = createMemoryRepository(path);
    const settings = createMemorySettingsRepository(path);
    await settings.patch(userA, { memoryEnabled: false });

    const result = await repo.applyPreparedAction(userA, "paused-explicit-source", {
      type: "add",
      candidate: {
        kind: "preference", scope: "shared", content: "別タブで止める", origin: "explicit", sensitivity: "normal", importance: 3,
        sourceMessageId: "paused-explicit-source", sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    });

    expect(result).toBe("disabled");
    expect(await repo.list(userA)).toEqual([]);
    expect(await repo.getProcessing(userA, "paused-explicit-source")).toBeNull();
  });

  it("atomically refuses a voice claim after YUI memory is switched off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-voice-claim-setting-"));
    const path = join(directory, "memory.sqlite");
    const repo = createMemoryRepository(path);
    const settings = createMemorySettingsRepository(path);
    const source = `voice:${"b".repeat(64)}`;
    await settings.patch(userA, { memoryEnabled: true });
    await expect(repo.claimAutomaticProcessing(userA, source, "voice")).resolves.toMatchObject({ state: "claimed" });
    await repo.setAutomaticProcessing(userA, source, "failed", 0);
    await settings.patch(userA, { memoryEnabled: false });

    const nextSource = `voice:${"c".repeat(64)}`;
    await expect(repo.claimAutomaticProcessing(userA, nextSource, "voice")).resolves.toEqual({ state: "disabled", appliedCount: 0, retry: false });
    await expect(repo.getAutomaticProcessing(userA, nextSource)).resolves.toBeNull();
  });

  it("expires only stale voice plans while retaining content-free receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-stale-voice-plan-"));
    const path = join(directory, "memory.sqlite");
    const repo = createMemoryRepository(path);
    const source = `voice:${"d".repeat(64)}`;
    await repo.claimAutomaticProcessing(userA, source, "voice");
    const attempt = await repo.prepareAutomaticExtractionAttempt(userA, source);
    await repo.setAutomaticExtractionAttemptState(userA, source, attempt.attemptIndex, "dispatched");
    await repo.saveAutomaticOutbox(userA, source, { actions: [{ type: "add" }], usage: null, attemptIndex: attempt.attemptIndex });
    const observer = new DatabaseSync(path);
    observer.prepare("UPDATE automatic_memory_processing SET attempted_at = ? WHERE user_id = ? AND source_message_id = ?")
      .run("2026-08-11T00:00:00.000Z", userA.userId, source);
    observer.close();

    await expect(repo.cleanupStaleVoiceProcessing(userA, "2026-08-11T00:05:00.001Z")).resolves.toBe(1);
    await expect(repo.getAutomaticOutbox(userA, source)).resolves.toBeNull();
    await expect(repo.getAutomaticProcessing(userA, source)).resolves.toEqual({ state: "failed", appliedCount: 0, outboxRef: null });
    await expect(repo.hasActiveVoiceProcessing(userA, "2026-08-11T00:05:00.001Z")).resolves.toBe(false);
  });

  it("fails a voice receipt and removes its temporary plan in one transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-atomic-voice-failure-"));
    const path = join(directory, "memory.sqlite");
    const repo = createMemoryRepository(path);
    const source = `voice:${"e".repeat(64)}`;
    await repo.claimAutomaticProcessing(userA, source, "voice");
    const attempt = await repo.prepareAutomaticExtractionAttempt(userA, source);
    await repo.setAutomaticExtractionAttemptState(userA, source, attempt.attemptIndex, "dispatched");
    await repo.saveAutomaticOutbox(userA, source, { actions: [{ type: "add" }], usage: null, attemptIndex: attempt.attemptIndex });

    await repo.failAutomaticVoiceProcessing(userA, source, 0);

    await expect(repo.getAutomaticOutbox(userA, source)).resolves.toBeNull();
    await expect(repo.getAutomaticProcessing(userA, source)).resolves.toEqual({ state: "failed", appliedCount: 0, outboxRef: null });
  });

  it("rolls back a split voice failure and lets the age-guarded sweeper recover it later", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-crashed-voice-failure-"));
    const path = join(directory, "memory.sqlite");
    const repo = createMemoryRepository(path);
    const source = `voice:${"f".repeat(64)}`;
    await repo.claimAutomaticProcessing(userA, source, "voice");
    const attempt = await repo.prepareAutomaticExtractionAttempt(userA, source);
    await repo.setAutomaticExtractionAttemptState(userA, source, attempt.attemptIndex, "dispatched");
    await repo.saveAutomaticOutbox(userA, source, { actions: [{ type: "add" }], usage: null, attemptIndex: attempt.attemptIndex });
    const observer = new DatabaseSync(path);
    observer.exec("CREATE TRIGGER abort_voice_plan_delete BEFORE DELETE ON automatic_memory_outbox BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;");

    await expect(repo.failAutomaticVoiceProcessing(userA, source, 0)).rejects.toThrow("simulated crash");
    await expect(repo.getAutomaticProcessing(userA, source)).resolves.toMatchObject({ state: "pending" });
    await expect(repo.getAutomaticOutbox(userA, source)).resolves.not.toBeNull();
    observer.exec("DROP TRIGGER abort_voice_plan_delete;");
    observer.prepare("UPDATE automatic_memory_processing SET attempted_at = ? WHERE user_id = ? AND source_message_id = ?")
      .run("2026-08-11T00:00:00.000Z", userA.userId, source);

    await expect(repo.cleanupStaleVoiceProcessing(userA, "2026-08-11T00:05:00.001Z")).resolves.toBe(1);
    await expect(repo.getAutomaticOutbox(userA, source)).resolves.toBeNull();
    await expect(repo.getAutomaticProcessing(userA, source)).resolves.toEqual({ state: "failed", appliedCount: 0, outboxRef: null });
    observer.close();
  });

  it("sweeps only old failed voice plans left by a split legacy failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-split-failed-plan-"));
    const path = join(directory, "memory.sqlite");
    const repo = createMemoryRepository(path);
    const source = `voice:${"1".repeat(64)}`;
    await repo.claimAutomaticProcessing(userA, source, "voice");
    const attempt = await repo.prepareAutomaticExtractionAttempt(userA, source);
    await repo.setAutomaticExtractionAttemptState(userA, source, attempt.attemptIndex, "dispatched");
    await repo.saveAutomaticOutbox(userA, source, { actions: [{ type: "add" }], usage: null, attemptIndex: attempt.attemptIndex });
    await repo.setAutomaticProcessing(userA, source, "failed", 0);

    await expect(repo.cleanupStaleVoiceProcessing(userA, "2000-01-01T00:00:00.000Z")).resolves.toBe(0);
    await expect(repo.getAutomaticOutbox(userA, source)).resolves.not.toBeNull();
    const observer = new DatabaseSync(path);
    observer.prepare("UPDATE automatic_memory_processing SET attempted_at = ? WHERE user_id = ? AND source_message_id = ?")
      .run("2026-08-11T00:00:00.000Z", userA.userId, source);
    observer.close();

    await expect(repo.cleanupStaleVoiceProcessing(userA, "2026-08-11T00:05:00.001Z")).resolves.toBe(1);
    await expect(repo.getAutomaticOutbox(userA, source)).resolves.toBeNull();
    await expect(repo.getAutomaticProcessing(userA, source)).resolves.toEqual({ state: "failed", appliedCount: 0, outboxRef: null });
  });

  it("merges normalized v2 duplicates for the same user", async () => {
    const repo = makeTestRepository();
    const first = await confirmTestMemory(repo, userA, { kind: "event", content: "会議が不安", importance: 2 });
    const updated = await confirmTestMemory(repo, userA, { kind: "ongoing", content: " 会議が、不安。 ", importance: 5 });

    expect(updated.id).toBe(first.id);
    expect(await repo.list(userA)).toEqual([
      expect.objectContaining({
        id: first.id,
        kind: "routine",
        content: " 会議が、不安。 ",
        importance: 5,
      }),
    ]);
  });

  it("keeps identical normalized content independent across users", async () => {
    const repo = makeTestRepository();
    const first = await confirmTestMemory(repo, userA, { kind: "event", content: "会議が不安", importance: 2 });
    const second = await confirmTestMemory(repo, userB, { kind: "event", content: "会議が不安", importance: 5 });

    expect(second.id).not.toBe(first.id);
    expect(await repo.list(userA)).toEqual([expect.objectContaining({ id: first.id, importance: 2 })]);
    expect(await repo.list(userB)).toEqual([expect.objectContaining({ id: second.id, importance: 5 })]);
  });

  it("migrates existing local memories to the fixed local user without exposing them to another user", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-migration-"));
    const databasePath = join(directory, "yui.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        content_normalized TEXT NOT NULL UNIQUE,
        importance INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO memories VALUES (
        'legacy-memory', 'shared', '以前の思い出', '以前の思い出', 4,
        '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
      );
    `);
    legacy.close();

    const repository = createMemoryRepository(databasePath);

    expect(await repository.list(LOCAL_USER)).toEqual([
      expect.objectContaining({
        id: "legacy-memory",
        content: "以前の思い出",
        scope: "shared",
        status: "active",
        origin: "explicit",
        sensitivity: "normal",
        pinned: true,
      }),
    ]);
    expect(await repository.list(userA)).toEqual([]);
  });

  it("keeps legacy memory identity and text while adding v2 defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-v2-migration-"));
    const databasePath = join(directory, "yui.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE memories (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        content_normalized TEXT NOT NULL,
        importance INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      );
      INSERT INTO memories VALUES (
        '${userA.userId}', 'legacy-v1', 'preference', 'ブラックコーヒーが好き', 'ブラックコーヒーが好き', 4,
        '2026-08-09T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      );
    `);
    legacy.close();

    const repository = createMemoryRepository(databasePath);

    await expect(repository.list(userA)).resolves.toEqual([
      expect.objectContaining({
        id: "legacy-v1",
        content: "ブラックコーヒーが好き",
        scope: "shared",
        status: "active",
        pinned: true,
      }),
    ]);
    await expect(repository.list(userB)).resolves.toEqual([]);
  });

  it("supports v2 record lifecycle operations without crossing user boundaries", async () => {
    const repo = makeTestRepository();
    const candidate: MemoryCandidateV2 = {
      kind: "preference",
      scope: "shared",
      content: "ブラックコーヒーが好き",
      origin: "explicit",
      sensitivity: "normal",
      importance: 4,
      sourceMessageId: null,
      sourceOccurredAt: null,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
      pinned: true,
      supersedesId: null,
    };

    const created = await repo.create(userA, candidate);
    const replaced = await repo.replace(userA, created.id, { ...candidate, content: "ミルク入りコーヒーが好き", pinned: false });
    const expired = await repo.setStatus(userA, replaced.id, "expired");
    const updated = await repo.update(userA, expired.id, { content: "カフェラテが好き", pinned: true });

    expect(updated).toMatchObject({ id: replaced.id, status: "expired", content: "カフェラテが好き", pinned: true });
    await expect(repo.list(userA, { statuses: ["expired"] })).resolves.toEqual([expect.objectContaining({ id: replaced.id })]);
    await expect(repo.list(userB)).resolves.toEqual([]);
    await expect(repo.getProcessing(userA, "message-1")).resolves.toBeNull();
    await repo.setProcessing(userA, "message-1", "pending");
    await expect(repo.getProcessing(userA, "message-1")).resolves.toBe("pending");
    await repo.forget(userA, updated.id, true);
    await expect(repo.list(userA)).resolves.toEqual([expect.objectContaining({ id: created.id, status: "past" })]);
    const [tombstone] = await repo.listActiveTombstones(userA);
    expect(tombstone).toMatchObject({ memoryId: updated.id, normalizedFingerprint: "カフェラテが好き", releasedAt: null });
    await repo.releaseTombstone(userA, tombstone.id);
    await expect(repo.listActiveTombstones(userA)).resolves.toEqual([]);
    await expect(repo.releaseTombstone(userB, tombstone.id)).rejects.toThrow();
  });

  it("checks approximate tombstones inside SQLite create, update, explicit, and automatic mutation transactions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-tombstone-atomic-"));
    const repo = createMemoryRepository(join(directory, "memory.sqlite"));
    const base: MemoryCandidateV2 = {
      kind: "event", scope: "daily", content: "友達と昼食を食べた", origin: "explicit", sensitivity: "normal", importance: 3,
      sourceMessageId: null, sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
    };
    const forgotten = await repo.create(userA, base);
    await repo.forget(userA, forgotten.id, true);
    const unrelated = await repo.create(userA, { ...base, content: "妹は猫が好き" });

    await expect(repo.create(userA, { ...base, content: "昼食を友達と食べた" })).rejects.toThrow("tombstoned");
    await expect(repo.update(userA, unrelated.id, { content: "友達と昼ご飯を食べた" })).rejects.toThrow("tombstoned");
    await expect(repo.applyPreparedAction(userA, "explicit-paraphrase", { type: "add", candidate: { ...base, content: "友達と昼ご飯を食べた" } })).rejects.toThrow("tombstoned");
    await repo.claimAutomaticProcessing(userA, "automatic-paraphrase");
    await expect(repo.applyPreparedAutomaticAction(userA, "automatic-paraphrase", 0, { type: "add", candidate: { ...base, origin: "extracted", pinned: false, content: "昼食を友達と食べた" } })).rejects.toThrow("tombstoned");

    const [tombstone] = await repo.listActiveTombstones(userA);
    await repo.releaseTombstone(userA, tombstone!.id);
    await expect(repo.create(userA, { ...base, content: "昼食を友達と食べた" })).resolves.toMatchObject({ content: "昼食を友達と食べた" });
  });

  it("serializes a SQLite forget against a concurrently requested paraphrase save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-tombstone-race-"));
    const path = join(directory, "memory.sqlite");
    const forgettingRepository = createMemoryRepository(path);
    const savingRepository = createMemoryRepository(path);
    const candidate: MemoryCandidateV2 = {
      kind: "event", scope: "daily", content: "友達と昼食を食べた", origin: "explicit", sensitivity: "normal", importance: 3,
      sourceMessageId: null, sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
    };
    const target = await forgettingRepository.create(userA, candidate);

    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(workerData.path);
      database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
      database.prepare("INSERT INTO memory_tombstones (user_id, id, memory_id, normalized_fingerprint, created_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)")
        .run(workerData.userId, workerData.tombstoneId, workerData.memoryId, workerData.fingerprint, new Date().toISOString());
      database.prepare("DELETE FROM memories WHERE user_id = ? AND id = ?").run(workerData.userId, workerData.memoryId);
      parentPort.postMessage("forget-mutated");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      database.exec("COMMIT;");
      parentPort.postMessage("forget-committed");
      database.close();
    `, {
      eval: true,
      workerData: {
        path,
        userId: userA.userId,
        memoryId: target.id,
        tombstoneId: "20000000-0000-4000-8000-00000000000a",
        fingerprint: target.normalizedContent,
      },
    });
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
    });

    await expect(savingRepository.create(userA, { ...candidate, content: "昼食を友達と食べた" }))
      .rejects.toThrow("Memory candidate is tombstoned");
    await new Promise<void>((resolve, reject) => {
      worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`forget worker exited ${code}`)));
      worker.once("error", reject);
    });
    await expect(forgettingRepository.list(userA)).resolves.toEqual([]);
  });

  it("claims legacy-compatible processing once and quarantines ambiguous retries", async () => {
    const repo = makeTestRepository();

    const first = await repo.claimProcessing(userA, "durable-message");
    const concurrent = await repo.claimProcessing(userA, "durable-message");
    await repo.setProcessing(userA, "durable-message", "completed");
    const completed = await repo.claimProcessing(userA, "durable-message");
    await repo.setProcessing(userA, "retryable-message", "failed");
    const retried = await repo.claimProcessing(userA, "retryable-message");

    expect(first).toBe("claimed");
    expect(concurrent).toBe("quarantined");
    expect(completed).toBe("completed");
    expect(retried).toBe("quarantined");
  });

  it("commits a memory mutation and its receipt together", async () => {
    const repo = makeTestRepository();
    const action = {
      type: "add" as const,
      candidate: {
        kind: "preference" as const, scope: "shared" as const, content: "カフェラテが好き", origin: "explicit" as const,
        sensitivity: "normal" as const, importance: 4 as const, sourceMessageId: "atomic-message", sourceOccurredAt: null,
        validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    };

    const first = await repo.applyPreparedAction(userA, "atomic-message", action);
    const retry = await repo.applyPreparedAction(userA, "atomic-message", action);

    expect(first).toBe("applied");
    expect(retry).toBe("completed");
    await expect(repo.list(userA)).resolves.toEqual([expect.objectContaining({ content: "カフェラテが好き" })]);
  });

  it("keeps a fresh atomic v2 receipt pending and safely reclaims its expired lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-lease-"));
    const databasePath = join(directory, "yui.sqlite");
    const repo = createMemoryRepository(databasePath);
    const action = {
      type: "add" as const,
      candidate: {
        kind: "preference" as const, scope: "shared" as const, content: "期限付きの再試行", origin: "explicit" as const,
        sensitivity: "normal" as const, importance: 4 as const, sourceMessageId: "lease-message", sourceOccurredAt: null,
        validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    };
    const database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO memory_processing (user_id, source_message_id, state, attempted_at, completed_at, processing_version) VALUES (?, ?, 'pending', ?, NULL, 2)")
      .run(userA.userId, "lease-message", new Date().toISOString());
    database.prepare("UPDATE memory_processing SET attempted_at = ? WHERE user_id = ? AND source_message_id = ?")
      .run(new Date(Date.now() - MEMORY_ACTION_LEASE_MS + 1_000).toISOString(), userA.userId, "lease-message");
    expect(await repo.applyPreparedAction(userA, "lease-message", action)).toBe("pending");
    database.prepare("UPDATE memory_processing SET attempted_at = ? WHERE user_id = ? AND source_message_id = ?")
      .run(new Date(Date.now() - MEMORY_ACTION_LEASE_MS - 1_000).toISOString(), userA.userId, "lease-message");
    expect(await repo.applyPreparedAction(userA, "lease-message", action)).toBe("applied");
    database.close();
    await expect(repo.list(userA)).resolves.toEqual([expect.objectContaining({ content: "期限付きの再試行" })]);
  });

  it("keeps a non-atomic compatibility claim legacy and quarantines it after the atomic lease window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-compat-claim-"));
    const databasePath = join(directory, "yui.sqlite");
    const repo = createMemoryRepository(databasePath);
    const action = {
      type: "add" as const,
      candidate: {
        kind: "preference" as const, scope: "shared" as const, content: "非atomicでは追加しない", origin: "explicit" as const,
        sensitivity: "normal" as const, importance: 4 as const, sourceMessageId: "compat-stale", sourceOccurredAt: null,
        validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    };

    expect(await repo.claimProcessing(userA, "compat-stale")).toBe("claimed");
    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT state, processing_version FROM memory_processing WHERE user_id = ? AND source_message_id = ?")
      .get(userA.userId, "compat-stale")).toEqual({ state: "pending", processing_version: 1 });
    database.prepare("UPDATE memory_processing SET attempted_at = ? WHERE user_id = ? AND source_message_id = ?")
      .run(new Date(Date.now() - MEMORY_ACTION_LEASE_MS - 1_000).toISOString(), userA.userId, "compat-stale");

    expect(await repo.applyPreparedAction(userA, "compat-stale", action)).toBe("quarantined");
    database.close();
    await expect(repo.list(userA)).resolves.toEqual([]);
  });

  it("quarantines a pre-upgrade v2 pending receipt whose mutation may already be applied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-v2-pending-upgrade-"));
    const databasePath = join(directory, "yui.sqlite");
    const beforeUpgrade = createMemoryRepository(databasePath);
    const memory = await beforeUpgrade.create(userA, {
      kind: "preference", scope: "shared", content: "移行前に反映された記憶", origin: "explicit", sensitivity: "normal", importance: 4,
      sourceMessageId: "pre-upgrade-pending", sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
    });
    const preUpgrade = new DatabaseSync(databasePath);
    preUpgrade.prepare("UPDATE memories SET status = 'uncertain', updated_at = ? WHERE user_id = ? AND id = ?")
      .run("2026-08-11T00:00:00.000Z", userA.userId, memory.id);
    preUpgrade.prepare("INSERT INTO memory_processing (user_id, source_message_id, state, attempted_at, completed_at, processing_version) VALUES (?, ?, 'pending', ?, NULL, 2)")
      .run(userA.userId, "pre-upgrade-pending", new Date(Date.now() - MEMORY_ACTION_LEASE_MS - 1_000).toISOString());
    preUpgrade.close();

    const upgraded = createMemoryRepository(databasePath);
    const observer = new DatabaseSync(databasePath);
    expect(observer.prepare("SELECT state, processing_version FROM memory_processing WHERE user_id = ? AND source_message_id = ?")
      .get(userA.userId, "pre-upgrade-pending")).toEqual({ state: "pending", processing_version: 1 });
    expect(await upgraded.applyPreparedAction(userA, "pre-upgrade-pending", { type: "mark_uncertain", targetMemoryIds: [memory.id] })).toBe("quarantined");
    expect(observer.prepare("SELECT status, updated_at FROM memories WHERE user_id = ? AND id = ?")
      .get(userA.userId, memory.id)).toEqual({ status: "uncertain", updated_at: "2026-08-11T00:00:00.000Z" });
    observer.close();
  });

  it("quarantines a pre-upgrade v2 failed receipt whose commit outcome is unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-v2-failed-upgrade-"));
    const databasePath = join(directory, "yui.sqlite");
    createMemoryRepository(databasePath);
    const preUpgrade = new DatabaseSync(databasePath);
    preUpgrade.prepare("INSERT INTO memory_processing (user_id, source_message_id, state, attempted_at, completed_at, processing_version) VALUES (?, ?, 'failed', ?, NULL, 2)")
      .run(userA.userId, "pre-upgrade-failed", "2026-08-11T00:00:00.000Z");
    preUpgrade.close();

    const upgraded = createMemoryRepository(databasePath);
    const observer = new DatabaseSync(databasePath);
    expect(observer.prepare("SELECT state, processing_version FROM memory_processing WHERE user_id = ? AND source_message_id = ?")
      .get(userA.userId, "pre-upgrade-failed")).toEqual({ state: "failed", processing_version: 1 });
    expect(await upgraded.applyPreparedAction(userA, "pre-upgrade-failed", {
      type: "add",
      candidate: {
        kind: "shared", scope: "shared", content: "commit結果不明の記憶", origin: "explicit", sensitivity: "normal", importance: 3,
        sourceMessageId: "pre-upgrade-failed", sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    })).toBe("quarantined");
    observer.close();
    await expect(upgraded.list(userA)).resolves.toEqual([]);
  });

  it("keeps a pre-upgrade completed v2 receipt as an atomic duplicate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-v2-completed-upgrade-"));
    const databasePath = join(directory, "yui.sqlite");
    createMemoryRepository(databasePath);
    const preUpgrade = new DatabaseSync(databasePath);
    preUpgrade.prepare("INSERT INTO memory_processing (user_id, source_message_id, state, attempted_at, completed_at, processing_version) VALUES (?, ?, 'completed', ?, ?, 2)")
      .run(userA.userId, "pre-upgrade-completed", "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:01.000Z");
    preUpgrade.close();

    const upgraded = createMemoryRepository(databasePath);
    const observer = new DatabaseSync(databasePath);
    expect(observer.prepare("SELECT state, processing_version FROM memory_processing WHERE user_id = ? AND source_message_id = ?")
      .get(userA.userId, "pre-upgrade-completed")).toEqual({ state: "completed", processing_version: 2 });
    expect(await upgraded.applyPreparedAction(userA, "pre-upgrade-completed", {
      type: "add",
      candidate: {
        kind: "shared", scope: "shared", content: "完了済みなので追加しない", origin: "explicit", sensitivity: "normal", importance: 3,
        sourceMessageId: "pre-upgrade-completed", sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    })).toBe("completed");
    observer.close();
    await expect(upgraded.list(userA)).resolves.toEqual([]);
  });

  it("writes new atomic receipts as completed v2 work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-new-v2-receipt-"));
    const databasePath = join(directory, "yui.sqlite");
    const repo = createMemoryRepository(databasePath);

    expect(await repo.applyPreparedAction(userA, "new-atomic-v2", {
      type: "add",
      candidate: {
        kind: "shared", scope: "shared", content: "新しいatomic記憶", origin: "explicit", sensitivity: "normal", importance: 3,
        sourceMessageId: "new-atomic-v2", sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    })).toBe("applied");
    const observer = new DatabaseSync(databasePath);
    expect(observer.prepare("SELECT state, processing_version FROM memory_processing WHERE user_id = ? AND source_message_id = ?")
      .get(userA.userId, "new-atomic-v2")).toEqual({ state: "completed", processing_version: 2 });
    observer.close();
  });

  it("quarantines a legacy pending receipt after its mutation may have committed", async () => {
    const repo = makeTestRepository();
    const action = {
      type: "add" as const,
      candidate: {
        kind: "preference" as const, scope: "shared" as const, content: "既に反映された記憶", origin: "explicit" as const,
        sensitivity: "normal" as const, importance: 4 as const, sourceMessageId: "legacy-applied", sourceOccurredAt: null,
        validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    };
    await repo.create(userA, action.candidate);
    await repo.setProcessing(userA, "legacy-applied", "pending");

    expect(await repo.applyPreparedAction(userA, "legacy-applied", action)).toBe("quarantined");
    await expect(repo.list(userA)).resolves.toEqual([expect.objectContaining({ content: "既に反映された記憶" })]);
  });

  it.each(["pending", "failed"] as const)("quarantines a legacy %s receipt without guessing whether it mutated", async (state) => {
    const repo = makeTestRepository();
    const action = {
      type: "add" as const,
      candidate: {
        kind: "preference" as const, scope: "shared" as const, content: `不明な旧受領記録-${state}`, origin: "explicit" as const,
        sensitivity: "normal" as const, importance: 4 as const, sourceMessageId: `legacy-${state}`, sourceOccurredAt: null,
        validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    };
    await repo.setProcessing(userA, `legacy-${state}`, state);

    expect(await repo.applyPreparedAction(userA, `legacy-${state}`, action)).toBe("quarantined");
    await expect(repo.list(userA)).resolves.toEqual([]);
  });

  it("treats a legacy completed receipt as an already-applied duplicate", async () => {
    const repo = makeTestRepository();
    const action = {
      type: "add" as const,
      candidate: {
        kind: "preference" as const, scope: "shared" as const, content: "完了済みの旧記憶", origin: "explicit" as const,
        sensitivity: "normal" as const, importance: 4 as const, sourceMessageId: "legacy-completed", sourceOccurredAt: null,
        validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    };
    await repo.setProcessing(userA, "legacy-completed", "completed");

    expect(await repo.applyPreparedAction(userA, "legacy-completed", action)).toBe("completed");
    await expect(repo.list(userA)).resolves.toEqual([]);
  });

  it("allows concurrent delivery attempts to commit one mutation only", async () => {
    const repo = makeTestRepository();
    const action = {
      type: "add" as const,
      candidate: {
        kind: "preference" as const, scope: "shared" as const, content: "一度だけ覚える", origin: "explicit" as const,
        sensitivity: "normal" as const, importance: 4 as const, sourceMessageId: "concurrent-message", sourceOccurredAt: null,
        validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
      },
    };
    const results = await Promise.all([
      repo.applyPreparedAction(userA, "concurrent-message", action),
      repo.applyPreparedAction(userA, "concurrent-message", action),
    ]);

    expect(results).toEqual(["applied", "completed"]);
    await expect(repo.list(userA)).resolves.toEqual([expect.objectContaining({ content: "一度だけ覚える" })]);
  });

  it("merges every v2 candidate field and reactivates a normalized duplicate", async () => {
    const repo = makeTestRepository();
    const first = await repo.create(userA, {
      kind: "event", scope: "daily", content: "金曜に会議", origin: "extracted", sensitivity: "normal", importance: 2,
      sourceMessageId: "message-1", sourceOccurredAt: "2026-08-10T00:00:00.000Z", validFrom: null, validUntil: null,
      expiresAt: "2026-08-13T00:00:00.000Z", pinned: false, supersedesId: null,
    });
    await repo.setStatus(userA, first.id, "expired");

    const merged = await repo.create(userA, {
      kind: "schedule", scope: "work", content: " 金曜に、会議。 ", origin: "manual", sensitivity: "sensitive", importance: 5,
      sourceMessageId: "message-2", sourceOccurredAt: "2026-08-11T00:00:00.000Z", validFrom: "2026-08-11T00:00:00.000Z",
      validUntil: "2026-08-12T00:00:00.000Z", expiresAt: "2026-08-20T00:00:00.000Z", pinned: true, supersedesId: "previous-memory",
    });

    expect(merged).toMatchObject({
      id: first.id, kind: "schedule", scope: "work", content: " 金曜に、会議。 ", status: "active", origin: "manual",
      sensitivity: "sensitive", importance: 5, sourceMessageId: "message-2", sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      validFrom: "2026-08-11T00:00:00.000Z", validUntil: "2026-08-12T00:00:00.000Z", expiresAt: "2026-08-20T00:00:00.000Z",
      pinned: true, supersedesId: "previous-memory",
    });
  });

  it("rolls back a replacement when its new record conflicts", async () => {
    const repo = makeTestRepository();
    const target = await repo.create(userA, {
      kind: "event", scope: "shared", content: "元の記憶", origin: "explicit", sensitivity: "normal", importance: 3,
      sourceMessageId: null, sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
    });
    await repo.create(userA, {
      kind: "event", scope: "shared", content: "重複する記憶", origin: "explicit", sensitivity: "normal", importance: 3,
      sourceMessageId: null, sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
    });

    await expect(repo.replace(userA, target.id, {
      kind: "event", scope: "shared", content: "重複する記憶", origin: "manual", sensitivity: "normal", importance: 4,
      sourceMessageId: null, sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: false, supersedesId: null,
    })).rejects.toThrow();
    await expect(repo.list(userA, { statuses: ["active"] })).resolves.toContainEqual(expect.objectContaining({ id: target.id }));
  });
});
