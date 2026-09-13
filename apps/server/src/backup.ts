import { createCipheriv, createDecipheriv, createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { del, list, put } from "@vercel/blob";
import type { FastifyInstance } from "fastify";
import type { WriteGate } from "./write-gate.js";
import { runClosedRestore, runRestoreMutation, type RestoreWriteCapability } from "./write-gate.js";

type BackupRow = Record<string, unknown>;

export type BackupPayload = {
  version: 1;
  profiles: BackupRow[];
  memories: BackupRow[];
  chatSnapshots: BackupRow[];
  usageEvents: BackupRow[];
};

export type BackupEnvelope = {
  version: 1;
  algorithm: "AES-256-GCM";
  createdAt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type BackupRepository = { exportAll(): Promise<BackupPayload> };
/** Authoritative, independently retained deletion state; never reconstructed from a backup. */
export type DeletionLedger = {
  version: 1;
  entries: ReadonlyArray<{
    id: string;
    ownerId: string;
    photoId: string;
    storagePath: string;
    state: "requested" | "deleting" | "deleted" | "verified";
    snapshotRevision: number;
  }>;
};
/** The restore coordinator alone reads independently retained outbox state; it is never an HTTP payload. */
export type DeletionLedgerRepository = { readForRestore(): Promise<DeletionLedger> };
export type PhotoDeletionOutboxServiceClient = {
  from(table: "photo_deletion_outbox"): {
    select(columns: "id,owner_id,photo_id,storage_path,state,snapshot_revision"): {
      eq(column: "owner_id", ownerId: string): {
        order(column: "id", options: { ascending: true }): Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};
export type PhotoRestoreAuthority = { ownerId: string; deletionOutboxClient: PhotoDeletionOutboxServiceClient };

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Server-role-only adapter. Backup payloads and HTTP callers never contribute ledger rows. */
export function createPhotoDeletionOutboxLedgerRepository(
  client: PhotoDeletionOutboxServiceClient,
  ownerId: string,
): DeletionLedgerRepository {
  return {
    async readForRestore() {
      if (!uuidV4.test(ownerId)) throw new Error("Invalid deletion ledger");
      const result = await client.from("photo_deletion_outbox")
        .select("id,owner_id,photo_id,storage_path,state,snapshot_revision")
        .eq("owner_id", ownerId)
        .order("id", { ascending: true });
      if (result.error || !Array.isArray(result.data)) throw new Error("Deletion ledger unavailable");
      const entries = result.data.map((row) => {
        if (!row || typeof row !== "object") throw new Error("Invalid deletion ledger");
        const value = row as Record<string, unknown>;
        if (typeof value.id !== "string" || !uuidV4.test(value.id)
          || value.owner_id !== ownerId || typeof value.photo_id !== "string" || !uuidV4.test(value.photo_id)
          || value.storage_path !== `${ownerId}/${value.photo_id}.jpg`
          || !["requested", "deleting", "deleted", "verified"].includes(String(value.state))
          || !Number.isSafeInteger(value.snapshot_revision) || (value.snapshot_revision as number) < 0) throw new Error("Invalid deletion ledger");
        return { id: value.id, ownerId: value.owner_id, photoId: value.photo_id, storagePath: value.storage_path,
          state: value.state as DeletionLedger["entries"][number]["state"], snapshotRevision: value.snapshot_revision as number };
      });
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length
        || new Set(entries.map((entry) => entry.photoId)).size !== entries.length
        || new Set(entries.map((entry) => entry.storagePath)).size !== entries.length) throw new Error("Invalid deletion ledger");
      return { version: 1, entries };
    },
  };
}
export type RestorePreflight = {
  schemaVersion: number;
  resurrectingIds: string[];
  deletedIds: string[];
  expiredIds: string[];
  externalReferences: string[];
  sanitizedSnapshotCount: number;
  accepted: boolean;
};
export type BackupRestoreMutationHandlers = {
  blockAllPhotos(): Promise<void>;
  awaitPhotoVerification(): Promise<void>;
  replaceNonPhotoAll(payload: BackupPayload): Promise<void>;
  reapplyDeletionLedger(ledger: DeletionLedger): Promise<void>;
  verifyLineageAndExternalReferences(): Promise<void>;
};
declare const backupRestoreMutationsBrand: unique symbol;
export type BackupRestoreMutations = {
  readonly [backupRestoreMutationsBrand]: true;
  blockAllPhotos(capability: RestoreWriteCapability): Promise<void>;
  awaitPhotoVerification(capability: RestoreWriteCapability): Promise<void>;
  replaceNonPhotoAll(payload: BackupPayload, capability: RestoreWriteCapability): Promise<void>;
  reapplyDeletionLedger(ledger: DeletionLedger, capability: RestoreWriteCapability): Promise<void>;
  verifyLineageAndExternalReferences(capability: RestoreWriteCapability): Promise<void>;
};
const backupRestoreMutationFacades = new WeakMap<object, WriteGate>();

export function createBackupRestoreMutations(gate: WriteGate, handlers: BackupRestoreMutationHandlers): BackupRestoreMutations {
  const facade = {
    blockAllPhotos: (capability) => runRestoreMutation(gate, capability, "block_all_photos", handlers.blockAllPhotos),
    awaitPhotoVerification: (capability) => runRestoreMutation(gate, capability, "await_photo_verification", handlers.awaitPhotoVerification),
    replaceNonPhotoAll: (payload, capability) => runRestoreMutation(gate, capability, "replace_non_photo", () => handlers.replaceNonPhotoAll(payload)),
    reapplyDeletionLedger: (ledger, capability) => runRestoreMutation(gate, capability, "reapply_deletion_ledger", () => handlers.reapplyDeletionLedger(ledger)),
    verifyLineageAndExternalReferences: (capability) => runRestoreMutation(gate, capability, "verify_lineage", handlers.verifyLineageAndExternalReferences),
  } as BackupRestoreMutations;
  Object.freeze(facade);
  backupRestoreMutationFacades.set(facade, gate);
  return facade;
}

export type BackupRestoreTarget = {
  writeGate: WriteGate;
  preflight(payload: BackupPayload, ledger: DeletionLedger): Promise<RestorePreflight>;
  closeWrites(): void;
  waitForWriteDrain(): Promise<void>;
  mutations: BackupRestoreMutations;
  reopenWrites(): void;
};
export type BackupBlobStore = {
  put(pathname: string, body: string): Promise<void>;
  list(prefix: string): Promise<Array<{ pathname: string }>>;
  delete(pathnames: string[]): Promise<void>;
};
export type BackupService = { run(): Promise<{ dailyPath: string; weeklyPath: string | null }> };

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("Invalid backup key");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function sortedRows(rows: BackupRow[], keys: string[]): BackupRow[] {
  return [...rows]
    .sort((left, right) => keys.map((key) => String(left[key] ?? "")).join("\0").localeCompare(keys.map((key) => String(right[key] ?? "")).join("\0")))
    .map((row) => canonicalValue(row) as BackupRow);
}

function canonicalPayload(payload: BackupPayload): BackupPayload {
  return {
    version: 1,
    profiles: sortedRows(payload.profiles, ["user_id"]),
    memories: sortedRows(payload.memories, ["user_id", "id"]),
    chatSnapshots: sortedRows(payload.chatSnapshots, ["user_id"]),
    usageEvents: sortedRows(payload.usageEvents, ["user_id", "session_id"]),
  };
}

/**
 * Backups intentionally omit photo turns and their analysis replies. Primary chat history may
 * still show the reply after a photo-only delete; restore cannot recreate either side of a photo turn.
 */
export function sanitizeChatSnapshotForBackup(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const value = snapshot as Record<string, unknown>;
  if (!Array.isArray(value.timeline)) return { ...value };
  const timeline = value.timeline.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const row = item as Record<string, unknown>;
    return row.type !== "photo" && row.origin !== "photo_analysis";
  });
  const { reviewedLocalDates: _legacy, ...rest } = value;
  return { ...rest, timeline, version: 2 };
}

function sanitizeBackupPayload(payload: BackupPayload): BackupPayload {
  return {
    ...payload,
    chatSnapshots: payload.chatSnapshots.map((row) => {
      const snapshot = row.snapshot;
      return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? { ...row, version: 2, snapshot: sanitizeChatSnapshotForBackup(snapshot) }
        : row;
    }),
  };
}

export function createBackupEnvelope(
  payload: BackupPayload,
  key: Buffer,
  now: Date,
  randomBytes: () => Buffer = () => nodeRandomBytes(12),
): BackupEnvelope {
  assertKey(key);
  const iv = randomBytes();
  if (iv.length !== 12) throw new Error("Invalid backup IV");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(canonicalPayload(payload)), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    createdAt: now.toISOString(),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function restoreBackup(envelope: BackupEnvelope, key: Buffer): BackupPayload {
  try {
    assertKey(key);
    if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") throw new Error();
    const iv = Buffer.from(envelope.iv, "base64");
    const authTag = Buffer.from(envelope.authTag, "base64");
    if (iv.length !== 12 || authTag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as BackupPayload;
    if (parsed.version !== 1 || !Array.isArray(parsed.profiles) || !Array.isArray(parsed.memories) || !Array.isArray(parsed.chatSnapshots) || !Array.isArray(parsed.usageEvents)) throw new Error();
    return canonicalPayload(parsed);
  } catch {
    throw new Error("Invalid backup");
  }
}

export async function restoreBackupInto(envelope: BackupEnvelope, key: Buffer, target: BackupRestoreTarget, authority: PhotoRestoreAuthority): Promise<void> {
  const mutations = target && typeof target === "object" ? target.mutations : null;
  if (!mutations || typeof mutations !== "object" || backupRestoreMutationFacades.get(mutations) !== target.writeGate) {
    throw new Error("invalid_backup_restore_mutations");
  }
  if (!authority || typeof authority !== "object" || !uuidV4.test(authority.ownerId)
    || !authority.deletionOutboxClient || typeof authority.deletionOutboxClient.from !== "function") {
    throw new Error("Invalid deletion ledger authority");
  }
  const ledgerRepository = createPhotoDeletionOutboxLedgerRepository(authority.deletionOutboxClient, authority.ownerId);
  const ledger = await ledgerRepository.readForRestore();
  if (!ledger || ledger.version !== 1 || !Array.isArray(ledger.entries)
    || ledger.entries.some((entry) => !entry || typeof entry.id !== "string" || !entry.id
      || typeof entry.ownerId !== "string" || !entry.ownerId
      || typeof entry.photoId !== "string" || !entry.photoId
      || typeof entry.storagePath !== "string" || !entry.storagePath
      || !["requested", "deleting", "deleted", "verified"].includes(entry.state)
      || !Number.isSafeInteger(entry.snapshotRevision) || entry.snapshotRevision < 0)
    || new Set(ledger.entries.map((entry) => entry.id)).size !== ledger.entries.length
    || new Set(ledger.entries.map((entry) => `${entry.ownerId}:${entry.photoId}`)).size !== ledger.entries.length
  ) throw new Error("Invalid deletion ledger");
  const payload = sanitizeBackupPayload(restoreBackup(envelope, key));
  const preflight = await target.preflight(payload, ledger);
  if (!preflight.accepted) throw new Error("Backup restore rejected");
  target.closeWrites();
  try {
    await target.waitForWriteDrain();
    await runClosedRestore(target.writeGate, async (session) => {
      await session.runMutation("block_all_photos", (capability) => mutations.blockAllPhotos(capability));
      await session.runMutation("await_photo_verification", (capability) => mutations.awaitPhotoVerification(capability));
      await session.runMutation("replace_non_photo", (capability) => mutations.replaceNonPhotoAll(payload, capability));
      await session.runMutation("reapply_deletion_ledger", (capability) => mutations.reapplyDeletionLedger(ledger, capability));
      await session.runMutation("verify_lineage", (capability) => mutations.verifyLineageAndExternalReferences(capability));
    });
    // The ledger is the authoritative deletion state. A concurrent revision before reopening
    // means the verified lineage is stale, so keep the gate closed for operator recovery.
    const beforeReopen = await ledgerRepository.readForRestore();
    if (JSON.stringify(beforeReopen) !== JSON.stringify(ledger)) throw new Error("Deletion ledger changed during restore");
    target.reopenWrites();
  } catch (error) {
    // Fail closed: a failed storage or lineage verification leaves semantic mutations closed.
    throw error;
  }
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function retain(blobs: BackupBlobStore, prefix: string, keep: number): Promise<void> {
  const paths = (await blobs.list(prefix)).map((item) => item.pathname).sort().reverse();
  const expired = paths.slice(keep);
  if (expired.length > 0) await blobs.delete(expired);
}

export function createBackupService(options: {
  repository: BackupRepository;
  blobs: BackupBlobStore;
  key: Buffer;
  now?: () => Date;
  randomBytes?: () => Buffer;
}): BackupService {
  return {
    async run() {
      const now = options.now?.() ?? new Date();
      const date = utcDate(now);
      const envelope = createBackupEnvelope(sanitizeBackupPayload(await options.repository.exportAll()), options.key, now, options.randomBytes);
      const body = JSON.stringify(envelope);
      const dailyPath = `backups/daily/${date}.json`;
      const weeklyPath = now.getUTCDay() === 0 ? `backups/weekly/${date}.json` : null;
      await options.blobs.put(dailyPath, body);
      if (weeklyPath) await options.blobs.put(weeklyPath, body);
      await Promise.all([retain(options.blobs, "backups/daily/", 7), retain(options.blobs, "backups/weekly/", 4)]);
      return { dailyPath, weeklyPath };
    },
  };
}

export function createVercelBackupBlobStore(token: string): BackupBlobStore {
  return {
    async put(pathname, body) {
      await put(pathname, body, { access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json", token });
    },
    async list(prefix) {
      const result = await list({ prefix, token });
      return result.blobs.map((blob) => ({ pathname: blob.pathname }));
    },
    async delete(pathnames) {
      if (pathnames.length > 0) await del(pathnames, { token });
    },
  };
}

export function createSupabaseBackupRepository(url: string, serviceRoleKey: string, fetchImpl?: typeof fetch): BackupRepository {
  const client = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }, ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}) });
  const read = async (table: string): Promise<BackupRow[]> => {
    const rows: BackupRow[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      let query = client.from(table).select("*").order("user_id");
      if (table === "memories") query = query.order("id");
      if (table === "usage_events") query = query.order("session_id");
      const result = await query.range(offset, offset + pageSize - 1);
      if (result.error || !Array.isArray(result.data)) throw new Error("Backup export unavailable");
      rows.push(...result.data as BackupRow[]);
      if (result.data.length < pageSize) return rows;
    }
  };
  return {
    async exportAll() {
      const [profiles, memories, chatSnapshots, usageEvents] = await Promise.all([
        read("profiles"), read("memories"), read("chat_snapshots"), read("usage_events"),
      ]);
      return canonicalPayload(sanitizeBackupPayload({ version: 1, profiles, memories, chatSnapshots, usageEvents }));
    },
  };
}

function safeSecretMatches(header: string | undefined, secret: string): boolean {
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const actual = createHash("sha256").update(header ?? "").digest();
  return timingSafeEqual(expected, actual);
}

export function registerBackupRoute(app: FastifyInstance, options: { cronSecret: string; service: BackupService; writeGate?: WriteGate }): void {
  app.get("/api/cron/backup", async (request, reply) => {
    if (!safeSecretMatches(request.headers.authorization, options.cronSecret)) {
      return reply.header("Cache-Control", "no-store").code(401).send({ error: "unauthorized" });
    }
    const lease = options.writeGate?.enter("backup_cron") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.header("Cache-Control", "no-store").code(503).send({ error: "maintenance" });
    try {
      await options.service.run();
      return reply.header("Cache-Control", "no-store").send({ ok: true });
    } catch {
      return reply.header("Cache-Control", "no-store").code(503).send({ error: "backup_unavailable" });
    } finally {
      lease.release();
    }
  });
}
