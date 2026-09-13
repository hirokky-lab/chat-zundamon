import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { createWriteGate } from "../src/write-gate";
import {
  createBackupEnvelope,
  createBackupService,
  createBackupRestoreMutations,
  createPhotoDeletionOutboxLedgerRepository,
  restoreBackup,
  restoreBackupInto,
  type BackupBlobStore,
  type BackupPayload,
  sanitizeChatSnapshotForBackup,
} from "../src/backup";

const key = Buffer.alloc(32, 7);
const now = new Date("2026-08-09T03:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111";
const photoId = "22222222-2222-4222-8222-222222222222";
const outboxId = "33333333-3333-4333-8333-333333333333";
const payload: BackupPayload = {
  version: 1,
  profiles: [{ user_id: "user-a", display_name: "秘密の大輝", addressing_style: "san", updated_at: "2026-08-10T00:00:00.000Z" }],
  memories: [{ user_id: "user-a", id: "memory-a", kind: "shared", content: "秘密の思い出", importance: 4, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z" }],
  chatSnapshots: [{ user_id: "user-a", version: 1, revision: 1, snapshot: { timeline: [] }, updated_at: "2026-08-10T00:00:00.000Z" }],
  usageEvents: [{ user_id: "user-a", session_id: "session-a", payload: { totalUsd: 0.01 }, created_at: "2026-08-10T00:00:00.000Z" }],
};
const ledgerRows = [{ id: outboxId, owner_id: ownerId, photo_id: photoId, storage_path: `${ownerId}/${photoId}.jpg`, state: "verified", snapshot_revision: 4 }];
const ledger = { version: 1 as const, entries: [{ id: outboxId, ownerId, photoId, storagePath: `${ownerId}/${photoId}.jpg`, state: "verified" as const, snapshotRevision: 4 }] };

function restoreAuthority(readRows: () => unknown = () => ledgerRows) {
  return {
    ownerId,
    deletionOutboxClient: {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ order: vi.fn(async () => ({ data: readRows(), error: null })) })),
        })),
      })),
    },
  };
}

class MemoryBlobStore implements BackupBlobStore {
  readonly objects = new Map<string, string>();
  readonly deleted: string[] = [];
  async put(pathname: string, body: string): Promise<void> { this.objects.set(pathname, body); }
  async list(prefix: string): Promise<Array<{ pathname: string }>> {
    return [...this.objects.keys()].filter((pathname) => pathname.startsWith(prefix)).map((pathname) => ({ pathname }));
  }
  async delete(pathnames: string[]): Promise<void> {
    for (const pathname of pathnames) { this.objects.delete(pathname); this.deleted.push(pathname); }
  }
}

describe("encrypted YUI backup", () => {
  it("encrypts canonical private data and restores it exactly", () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    const uploaded = JSON.stringify(envelope);

    expect(uploaded).not.toContain("秘密の大輝");
    expect(uploaded).not.toContain("秘密の思い出");
    expect(restoreBackup(envelope, key)).toEqual(payload);
  });

  it("produces the same encrypted bytes for logically identical rows with different key order", () => {
    const reordered: BackupPayload = {
      ...payload,
      profiles: [{ updated_at: "2026-08-10T00:00:00.000Z", addressing_style: "san", display_name: "秘密の大輝", user_id: "user-a" }],
    };
    expect(createBackupEnvelope(reordered, key, now, () => Buffer.alloc(12, 9)))
      .toEqual(createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9)));
  });

  it("exports a lossy non-photo backup while primary history retains the visible photo reply", () => {
    const photoId = "10000000-0000-4000-8000-000000000001";
    const primary = {
      version: 3, revision: 2, updatedAt: now, lastOpeningAt: null, lastConversationAt: null,
      timeline: [
        { id: photoId, type: "photo", role: "user", photoId, caption: "内緒", origin: "photo", createdAt: now, delivery: "sent" },
        { id: `${photoId}:assistant:0`, type: "message", role: "assistant", text: "きれい", createdAt: now, delivery: "sent", replyGroupId: `${photoId}:assistant`, sequence: 0, origin: "photo_analysis", sourcePhotoMessageId: photoId },
      ],
    };
    expect(primary.timeline).toContainEqual(expect.objectContaining({ origin: "photo_analysis" }));
    expect(JSON.stringify(sanitizeChatSnapshotForBackup(primary))).not.toMatch(/photoId|caption|photo_analysis|sourcePhotoMessageId/);
  });

  it("restores every canonical collection into an empty operator target", async () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    const events: string[] = [];
    const writeGate = createWriteGate();
    const mutations = createBackupRestoreMutations(writeGate, {
      blockAllPhotos: async () => { events.push("block"); },
      awaitPhotoVerification: async () => { events.push("verify-photo"); },
      replaceNonPhotoAll: async () => { events.push("replace"); },
      reapplyDeletionLedger: async () => { events.push("ledger"); },
      verifyLineageAndExternalReferences: async () => { events.push("verify-lineage"); },
    });
    const target = {
      preflight: vi.fn(async () => ({ schemaVersion: 1, resurrectingIds: [], deletedIds: [], expiredIds: [], externalReferences: [], sanitizedSnapshotCount: 0, accepted: true })),
      writeGate, closeWrites: () => { writeGate.closeForRestore(); events.push("close"); },
      waitForWriteDrain: async () => { await writeGate.waitForDrain(); events.push("drain"); },
      mutations,
      reopenWrites: () => { events.push("open"); },
    };
    await restoreBackupInto(envelope, key, target, restoreAuthority());
    expect(events).toEqual(["close", "drain", "block", "verify-photo", "replace", "ledger", "verify-lineage", "open"]);
  });

  it("does no write when preflight rejects and leaves writes closed after ledger or storage verification failure", async () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    const events: string[] = [];
    const writeGate = createWriteGate();
    const mutations = createBackupRestoreMutations(writeGate, {
      blockAllPhotos: async () => { events.push("block"); }, awaitPhotoVerification: async () => { events.push("verify"); throw new Error("timeout"); },
      replaceNonPhotoAll: async () => { events.push("replace"); }, reapplyDeletionLedger: async () => { events.push("ledger"); },
      verifyLineageAndExternalReferences: async () => { events.push("lineage"); },
    });
    const target = {
      preflight: async () => ({ schemaVersion: 1, resurrectingIds: ["old"], deletedIds: ["old"], expiredIds: [], externalReferences: [], sanitizedSnapshotCount: 0, accepted: false }),
      writeGate, closeWrites: () => { writeGate.closeForRestore(); events.push("close"); }, waitForWriteDrain: async () => { await writeGate.waitForDrain(); events.push("drain"); },
      mutations, reopenWrites: () => { events.push("open"); },
    };
    await expect(restoreBackupInto(envelope, key, target, restoreAuthority())).rejects.toThrow("Backup restore rejected");
    expect(events).toEqual([]);
    const accepted = { ...target, preflight: async () => ({ schemaVersion: 1, resurrectingIds: [], deletedIds: [], expiredIds: [], externalReferences: [], sanitizedSnapshotCount: 0, accepted: true }) };
    await expect(restoreBackupInto(envelope, key, accepted, restoreAuthority())).rejects.toThrow("timeout");
    expect(events).toEqual(["close", "drain", "block", "verify"]);
  });

  it("fails closed before preflight for a duplicate or malformed independently retained ledger", async () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    const writeGate = createWriteGate();
    const handlers = { blockAllPhotos: vi.fn(), awaitPhotoVerification: vi.fn(), replaceNonPhotoAll: vi.fn(), reapplyDeletionLedger: vi.fn(), verifyLineageAndExternalReferences: vi.fn() };
    const target = { writeGate, preflight: vi.fn(), closeWrites: vi.fn(), waitForWriteDrain: vi.fn(), mutations: createBackupRestoreMutations(writeGate, handlers), reopenWrites: vi.fn() };
    await expect(restoreBackupInto(envelope, key, target, restoreAuthority(() => [{ ...ledgerRows[0], id: outboxId }, { ...ledgerRows[0], id: outboxId }]))).rejects.toThrow("Invalid deletion ledger");
    expect(target.preflight).not.toHaveBeenCalled();
    expect(target.closeWrites).not.toHaveBeenCalled();
  });

  it("does not accept a caller-supplied deletion ledger repository", async () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    const writeGate = createWriteGate();
    const target = { writeGate, preflight: vi.fn(), closeWrites: vi.fn(), waitForWriteDrain: vi.fn(), mutations: createBackupRestoreMutations(writeGate, { blockAllPhotos: vi.fn(), awaitPhotoVerification: vi.fn(), replaceNonPhotoAll: vi.fn(), reapplyDeletionLedger: vi.fn(), verifyLineageAndExternalReferences: vi.fn() }), reopenWrites: vi.fn() };
    const arbitraryRepository = { readForRestore: vi.fn(async () => ledger) };
    await expect(restoreBackupInto(envelope, key, target, arbitraryRepository as never)).rejects.toThrow("Invalid deletion ledger authority");
    expect(arbitraryRepository.readForRestore).not.toHaveBeenCalled();
    expect(target.preflight).not.toHaveBeenCalled();
  });

  it("rejects forged and cross-gate restore mutation facades before any target mutation", async () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    const targetGate = createWriteGate();
    const foreignGate = createWriteGate();
    const handlers = {
      blockAllPhotos: vi.fn(async () => undefined),
      awaitPhotoVerification: vi.fn(async () => undefined),
      replaceNonPhotoAll: vi.fn(async () => undefined),
      reapplyDeletionLedger: vi.fn(async () => undefined),
      verifyLineageAndExternalReferences: vi.fn(async () => undefined),
    };
    const preflight = vi.fn(async () => ({ schemaVersion: 1, resurrectingIds: [], deletedIds: [], expiredIds: [], externalReferences: [], sanitizedSnapshotCount: 0, accepted: true }));
    const closeWrites = vi.fn(() => targetGate.closeForRestore());
    const waitForWriteDrain = vi.fn(() => targetGate.waitForDrain());
    const reopenWrites = vi.fn();
    const plainFacade = {
      blockAllPhotos: handlers.blockAllPhotos,
      awaitPhotoVerification: handlers.awaitPhotoVerification,
      replaceNonPhotoAll: handlers.replaceNonPhotoAll,
      reapplyDeletionLedger: handlers.reapplyDeletionLedger,
      verifyLineageAndExternalReferences: handlers.verifyLineageAndExternalReferences,
    };
    const baseTarget = { writeGate: targetGate, preflight, closeWrites, waitForWriteDrain, reopenWrites };

    await expect(restoreBackupInto(envelope, key, { ...baseTarget, mutations: plainFacade } as never, restoreAuthority()))
      .rejects.toThrow("invalid_backup_restore_mutations");
    await expect(restoreBackupInto(envelope, key, {
      ...baseTarget,
      mutations: createBackupRestoreMutations(foreignGate, handlers),
    }, restoreAuthority())).rejects.toThrow("invalid_backup_restore_mutations");

    expect(preflight).not.toHaveBeenCalled();
    expect(closeWrites).not.toHaveBeenCalled();
    expect(waitForWriteDrain).not.toHaveBeenCalled();
    expect(reopenWrites).not.toHaveBeenCalled();
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it("does not allow a registered same-gate facade method to be replaced", async () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    const writeGate = createWriteGate();
    const guardedBlock = vi.fn(async () => undefined);
    const rawBlock = vi.fn(async () => undefined);
    const mutations = createBackupRestoreMutations(writeGate, {
      blockAllPhotos: guardedBlock,
      awaitPhotoVerification: async () => undefined,
      replaceNonPhotoAll: async () => undefined,
      reapplyDeletionLedger: async () => undefined,
      verifyLineageAndExternalReferences: async () => undefined,
    });
    let tamperError: unknown;
    try { (mutations as { blockAllPhotos: typeof rawBlock }).blockAllPhotos = rawBlock; } catch (error) { tamperError = error; }
    const target = {
      writeGate,
      preflight: async () => ({ schemaVersion: 1, resurrectingIds: [], deletedIds: [], expiredIds: [], externalReferences: [], sanitizedSnapshotCount: 0, accepted: true }),
      closeWrites: () => writeGate.closeForRestore(),
      waitForWriteDrain: () => writeGate.waitForDrain(),
      mutations,
      reopenWrites: () => writeGate.openAfterVerifiedRestore(),
    };

    await expect(restoreBackupInto(envelope, key, target, restoreAuthority())).resolves.toBeUndefined();
    expect(tamperError).toBeInstanceOf(TypeError);
    expect(guardedBlock).toHaveBeenCalledOnce();
    expect(rawBlock).not.toHaveBeenCalled();
  });

  it("captures the validated facade once so a mutations getter cannot swap in raw methods", async () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    const writeGate = createWriteGate();
    const guardedBlock = vi.fn(async () => undefined);
    const rawBlock = vi.fn(async () => undefined);
    const guarded = createBackupRestoreMutations(writeGate, {
      blockAllPhotos: guardedBlock,
      awaitPhotoVerification: async () => undefined,
      replaceNonPhotoAll: async () => undefined,
      reapplyDeletionLedger: async () => undefined,
      verifyLineageAndExternalReferences: async () => undefined,
    });
    const raw = {
      blockAllPhotos: rawBlock,
      awaitPhotoVerification: vi.fn(async () => undefined),
      replaceNonPhotoAll: vi.fn(async () => undefined),
      reapplyDeletionLedger: vi.fn(async () => undefined),
      verifyLineageAndExternalReferences: vi.fn(async () => undefined),
    };
    let reads = 0;
    const target = {
      writeGate,
      preflight: async () => ({ schemaVersion: 1, resurrectingIds: [], deletedIds: [], expiredIds: [], externalReferences: [], sanitizedSnapshotCount: 0, accepted: true }),
      closeWrites: () => writeGate.closeForRestore(),
      waitForWriteDrain: () => writeGate.waitForDrain(),
      get mutations() { reads += 1; return reads <= 3 ? guarded : raw; },
      reopenWrites: () => writeGate.openAfterVerifiedRestore(),
    };

    await expect(restoreBackupInto(envelope, key, target as never, restoreAuthority())).resolves.toBeUndefined();
    expect(reads).toBe(1);
    expect(guardedBlock).toHaveBeenCalledOnce();
    for (const mutation of Object.values(raw)) expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects direct calls to every restore mutation without a capability from the active session", async () => {
    const writeGate = createWriteGate();
    writeGate.closeForRestore();
    const handlers = { blockAllPhotos: vi.fn(), awaitPhotoVerification: vi.fn(), replaceNonPhotoAll: vi.fn(), reapplyDeletionLedger: vi.fn(), verifyLineageAndExternalReferences: vi.fn() };
    const mutations = createBackupRestoreMutations(writeGate, handlers);
    await expect(mutations.blockAllPhotos({} as never)).rejects.toThrow("invalid_restore_write_capability");
    await expect(mutations.awaitPhotoVerification({} as never)).rejects.toThrow("invalid_restore_write_capability");
    await expect(mutations.replaceNonPhotoAll(payload, {} as never)).rejects.toThrow("invalid_restore_write_capability");
    await expect(mutations.reapplyDeletionLedger(ledger, {} as never)).rejects.toThrow("invalid_restore_write_capability");
    await expect(mutations.verifyLineageAndExternalReferences({} as never)).rejects.toThrow("invalid_restore_write_capability");
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it("keeps writes closed when the authoritative ledger revision changes before reopen", async () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    const writeGate = createWriteGate();
    const reopenWrites = vi.fn(() => writeGate.openAfterVerifiedRestore());
    const mutations = createBackupRestoreMutations(writeGate, {
      blockAllPhotos: async () => undefined, awaitPhotoVerification: async () => undefined, replaceNonPhotoAll: async () => undefined,
      reapplyDeletionLedger: async () => undefined, verifyLineageAndExternalReferences: async () => undefined,
    });
    const target = {
      writeGate, preflight: async () => ({ schemaVersion: 1, resurrectingIds: [], deletedIds: [], expiredIds: [], externalReferences: [], sanitizedSnapshotCount: 0, accepted: true }),
      closeWrites: () => writeGate.closeForRestore(), waitForWriteDrain: () => writeGate.waitForDrain(),
      mutations, reopenWrites,
    };
    let reads = 0;
    await expect(restoreBackupInto(envelope, key, target, restoreAuthority(() => {
      reads += 1;
      return reads === 1 ? ledgerRows : [{ ...ledgerRows[0], snapshot_revision: 5 }];
    }))).rejects.toThrow("Deletion ledger changed during restore");
    expect(reopenWrites).not.toHaveBeenCalled();
    expect(writeGate.isOpen()).toBe(false);
  });

  it("loads restore lineage only from the authoritative outbox with owner, path, state, and revision", async () => {
    const rows = [...ledgerRows];
    const order = vi.fn(async () => ({ data: rows, error: null }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const repository = createPhotoDeletionOutboxLedgerRepository({
      from,
    }, ownerId);
    await expect(repository.readForRestore()).resolves.toEqual({
      version: 1,
      entries: [{ id: outboxId, ownerId, photoId, storagePath: `${ownerId}/${photoId}.jpg`, state: "verified", snapshotRevision: 4 }],
    });
    expect(from).toHaveBeenCalledWith("photo_deletion_outbox");
    expect(select).toHaveBeenCalledWith("id,owner_id,photo_id,storage_path,state,snapshot_revision");
    expect(eq).toHaveBeenCalledWith("owner_id", ownerId);
    expect(order).toHaveBeenCalledWith("id", { ascending: true });
    rows[0] = { ...rows[0], storage_path: "", state: "wrong" };
    await expect(repository.readForRestore()).rejects.toThrow("Invalid deletion ledger");
  });

  it("rejects a cross-owner outbox row even when the service query returns it", async () => {
    const foreignOwnerId = "22222222-2222-4222-8222-222222222222";
    const foreignPhotoId = "44444444-4444-4444-8444-444444444444";
    const repository = createPhotoDeletionOutboxLedgerRepository({
      from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [{
        id: outboxId, owner_id: foreignOwnerId, photo_id: foreignPhotoId,
        storage_path: `${foreignOwnerId}/${foreignPhotoId}.jpg`, state: "verified", snapshot_revision: 4,
      }], error: null }) }) }) }),
    }, ownerId);
    await expect(repository.readForRestore()).rejects.toThrow("Invalid deletion ledger");
  });

  it.each([
    ["noncanonical path", [{ ...ledgerRows[0], storage_path: `${ownerId}/wrong.jpg` }]],
    ["unknown state", [{ ...ledgerRows[0], state: "blocked" }]],
    ["negative revision", [{ ...ledgerRows[0], snapshot_revision: -1 }]],
    ["conflicting duplicate lineage", [ledgerRows[0], { ...ledgerRows[0], id: "44444444-4444-4444-8444-444444444444", state: "deleted", snapshot_revision: 3 }]],
  ])("rejects %s from the owner-scoped outbox", async (_case, rows) => {
    const repository = createPhotoDeletionOutboxLedgerRepository({
      from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: rows, error: null }) }) }) }),
    }, ownerId);
    await expect(repository.readForRestore()).rejects.toThrow("Invalid deletion ledger");
  });

  it("fails closed for a wrong key or modified authentication tag", () => {
    const envelope = createBackupEnvelope(payload, key, now, () => Buffer.alloc(12, 9));
    expect(() => restoreBackup(envelope, Buffer.alloc(32, 8))).toThrow("Invalid backup");
    expect(() => restoreBackup({ ...envelope, authTag: Buffer.alloc(16, 1).toString("base64") }, key)).toThrow("Invalid backup");
  });

  it("uses stable daily and weekly paths and retains seven daily plus four weekly backups", async () => {
    const blobs = new MemoryBlobStore();
    for (let day = 1; day <= 8; day += 1) blobs.objects.set(`backups/daily/2026-08-0${day}.json`, "old");
    for (let day = 1; day <= 5; day += 1) blobs.objects.set(`backups/weekly/2026-07-0${day}.json`, "old");
    const service = createBackupService({
      repository: { exportAll: async () => payload },
      blobs,
      key,
      now: () => now,
      randomBytes: () => Buffer.alloc(12, 9),
    });

    const first = await service.run();
    const retry = await service.run();

    expect(first).toEqual({ dailyPath: "backups/daily/2026-08-09.json", weeklyPath: "backups/weekly/2026-08-09.json" });
    expect(retry).toEqual(first);
    expect((await blobs.list("backups/daily/")).map((item) => item.pathname).sort()).toHaveLength(7);
    expect((await blobs.list("backups/weekly/")).map((item) => item.pathname).sort()).toHaveLength(4);
    expect(restoreBackup(JSON.parse(blobs.objects.get(first.dailyPath) ?? ""), key)).toMatchObject({
      ...payload,
      chatSnapshots: [{ ...payload.chatSnapshots[0], version: 2, snapshot: { timeline: [], version: 2 } }],
    });
  });

  it("rejects the cron route before touching backup data when its secret is wrong", async () => {
    const run = vi.fn(async () => ({ dailyPath: "backups/daily/2026-08-09.json", weeklyPath: null }));
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      backup: { cronSecret: "cron-secret", service: { run } },
    });

    const denied = await app.inject({ method: "GET", url: "/api/cron/backup", headers: { authorization: "Bearer wrong" } });
    const accepted = await app.inject({ method: "GET", url: "/api/cron/backup", headers: { authorization: "Bearer cron-secret" } });

    expect(denied.statusCode).toBe(401);
    expect(run).toHaveBeenCalledTimes(1);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ ok: true });
  });
});
