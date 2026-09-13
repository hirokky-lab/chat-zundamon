import { isMemoryTombstoneMatch, normalizeMemory } from "../../../packages/domain/src/index.js";
import type {
  MemoryCandidateV2,
  MemoryKind,
  MemoryOrigin,
  MemoryRecord,
  MemoryReviewState,
  MemoryScope,
  MemorySensitivity,
  MemoryStatus,
  MemoryTombstone,
} from "../../../packages/domain/src/index.js";

import { DatabaseSync } from "node:sqlite";
import { LOCAL_USER, type RequestUser } from "./request-user.js";

export type MemoryRepositoryV2 = {
  create(user: RequestUser, candidate: MemoryCandidateV2): Promise<MemoryRecord>;
  replace(user: RequestUser, targetId: string, candidate: MemoryCandidateV2): Promise<MemoryRecord>;
  setStatus(user: RequestUser, id: string, status: MemoryStatus): Promise<MemoryRecord>;
  update(user: RequestUser, id: string, patch: { content?: string; pinned?: boolean; sensitivity?: MemorySensitivity }): Promise<MemoryRecord>;
  list(user: RequestUser, filter?: { statuses?: MemoryStatus[] }): Promise<MemoryRecord[]>;
  listForRecall(user: RequestUser, filter?: { statuses?: MemoryStatus[] }): Promise<MemoryRecord[]>;
  keep(user: RequestUser, id: string): Promise<MemoryRecord>;
  listActiveTombstones(user: RequestUser): Promise<MemoryTombstone[]>;
  releaseTombstone(user: RequestUser, id: string): Promise<void>;
  forget(user: RequestUser, id: string, blockRelearning: boolean): Promise<void>;
  getProcessing(user: RequestUser, sourceMessageId: string): Promise<"pending" | "completed" | "failed" | null>;
  claimProcessing(user: RequestUser, sourceMessageId: string): Promise<"claimed" | "pending" | "completed" | "quarantined">;
  applyPreparedAction(user: RequestUser, sourceMessageId: string, action: PreparedMemoryAction): Promise<"applied" | "pending" | "completed" | "quarantined" | "disabled">;
  setProcessing(user: RequestUser, sourceMessageId: string, state: "pending" | "completed" | "failed"): Promise<void>;
  getAutomaticProcessing(user: RequestUser, sourceMessageId: string): Promise<AutomaticMemoryProcessingReceipt | null>;
  claimAutomaticProcessing(user: RequestUser, sourceMessageId: string, mode?: "text" | "voice"): Promise<AutomaticMemoryProcessingClaim>;
  getAutomaticOutbox(user: RequestUser, sourceMessageId: string): Promise<AutomaticMemoryOutbox | null>;
  saveAutomaticOutbox(user: RequestUser, sourceMessageId: string, value: Omit<AutomaticMemoryOutbox, "outboxRef" | "usageSettled">): Promise<AutomaticMemoryOutbox>;
  markAutomaticOutboxUsageSettled(user: RequestUser, sourceMessageId: string): Promise<void>;
  clearAutomaticOutbox(user: RequestUser, sourceMessageId: string): Promise<void>;
  prepareAutomaticExtractionAttempt(user: RequestUser, sourceMessageId: string): Promise<AutomaticMemoryExtractionAttempt>;
  getLatestAutomaticExtractionAttempt(user: RequestUser, sourceMessageId: string): Promise<AutomaticMemoryExtractionAttempt | null>;
  setAutomaticExtractionAttemptState(user: RequestUser, sourceMessageId: string, attemptIndex: number, state: "dispatched" | "held" | "settled"): Promise<void>;
  getAutomaticActionProcessing(user: RequestUser, sourceMessageId: string, actionIndex: number): Promise<"pending" | "completed" | null>;
  applyPreparedAutomaticAction(user: RequestUser, sourceMessageId: string, actionIndex: number, action: PreparedMemoryAction): Promise<"applied" | "pending" | "completed" | "disabled">;
  setAutomaticProcessing(user: RequestUser, sourceMessageId: string, state: "completed" | "failed", appliedCount: number): Promise<void>;
  failAutomaticVoiceProcessing(user: RequestUser, sourceMessageId: string, appliedCount: number): Promise<void>;
  hasActiveVoiceProcessing(user: RequestUser, cutoff: string): Promise<boolean>;
  cleanupStaleVoiceProcessing(user: RequestUser, cutoff: string): Promise<number>;
};

export type AutomaticMemoryProcessingReceipt = {
  state: "pending" | "completed" | "failed";
  appliedCount: number;
  outboxRef: string | null;
};

export type AutomaticMemoryOutbox = {
  outboxRef: string;
  actions: unknown[];
  usage: {
    startedAt: string;
    endedAt: string;
    memoryInputTokens: number;
    memoryCachedInputTokens: number;
    memoryCacheWriteTokens: number;
    memoryOutputTokens: number;
  } | null;
  usageSettled: boolean;
  attemptIndex: number;
};

export type AutomaticMemoryExtractionAttempt = {
  attemptIndex: number;
  state: "prepared" | "dispatched" | "held" | "settled";
};

export type AutomaticMemoryProcessingClaim =
  | { state: "claimed"; appliedCount: number; retry: boolean }
  | { state: "pending" | "completed" | "disabled"; appliedCount: number; retry: false };

export type PreparedMemoryAction =
  | { type: "add"; candidate: MemoryCandidateV2 }
  | { type: "replace"; targetMemoryId: string; candidate: MemoryCandidateV2 }
  | { type: "mark_past"; targetMemoryId: string; replacement?: MemoryCandidateV2 }
  | { type: "mark_uncertain"; targetMemoryIds: string[] }
  | { type: "forget"; targetMemoryId: string; blockRelearning: boolean };

export const MEMORY_ACTION_LEASE_MS = 5 * 60 * 1000;

export type MemoryRepository = MemoryRepositoryV2;

type MemoryRow = {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  content_normalized: string;
  status: MemoryStatus;
  origin: MemoryOrigin;
  sensitivity: MemorySensitivity;
  review_state: MemoryReviewState;
  owner_reviewed_at: string | null;
  importance: 1 | 2 | 3 | 4 | 5;
  source_message_id: string | null;
  source_occurred_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  expires_at: string | null;
  pinned: number;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
};

type TombstoneRow = {
  id: string;
  memory_id: string | null;
  normalized_fingerprint: string;
  created_at: string;
  released_at: string | null;
};

const memoryColumns = `id, kind, scope, content, content_normalized, status, origin, sensitivity, review_state, owner_reviewed_at, importance,
  source_message_id, source_occurred_at, valid_from, valid_until, expires_at, pinned, supersedes_id, created_at, updated_at`;

function createMemoryTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('preference', 'person', 'routine', 'work', 'event', 'schedule', 'shared')),
      scope TEXT NOT NULL DEFAULT 'shared' CHECK (scope IN ('daily', 'work', 'shared')),
      content TEXT NOT NULL,
      content_normalized TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past', 'uncertain', 'expired')),
      origin TEXT NOT NULL DEFAULT 'explicit' CHECK (origin IN ('explicit', 'extracted', 'manual', 'voice')),
      sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive')),
      review_state TEXT NOT NULL DEFAULT 'eligible' CHECK (review_state IN ('eligible', 'needs_review')),
      owner_reviewed_at TEXT,
      importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
      source_message_id TEXT,
      source_occurred_at TEXT,
      valid_from TEXT,
      valid_until TEXT,
      expires_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0, 1)),
      supersedes_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id),
      UNIQUE (user_id, content_normalized)
    );
    CREATE TABLE IF NOT EXISTS memory_processing (
      user_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
      attempted_at TEXT NOT NULL,
      completed_at TEXT,
      processing_version INTEGER NOT NULL DEFAULT 1 CHECK (processing_version IN (1, 2)),
      PRIMARY KEY (user_id, source_message_id)
    );
    CREATE TABLE IF NOT EXISTS memory_tombstones (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      memory_id TEXT,
      normalized_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      released_at TEXT,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS memory_settings (
      user_id TEXT PRIMARY KEY,
      automatic_memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (automatic_memory_enabled IN (0, 1)),
      recall_memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (recall_memory_enabled IN (0, 1)),
      voice_memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (voice_memory_enabled IN (0, 1)),
      memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (memory_enabled IN (0, 1)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automatic_memory_processing (
      user_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
      applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count BETWEEN 0 AND 3),
      attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
      attempted_at TEXT NOT NULL,
      completed_at TEXT,
      outbox_ref TEXT,
      PRIMARY KEY (user_id, source_message_id)
    );
    CREATE TABLE IF NOT EXISTS automatic_memory_outbox (
      user_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      outbox_ref TEXT NOT NULL,
      action_plan TEXT NOT NULL,
      usage_json TEXT,
      usage_settled INTEGER NOT NULL DEFAULT 0 CHECK (usage_settled IN (0, 1)),
      attempt_index INTEGER NOT NULL DEFAULT 1 CHECK (attempt_index >= 1),
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, source_message_id),
      UNIQUE (outbox_ref),
      FOREIGN KEY (user_id, source_message_id) REFERENCES automatic_memory_processing(user_id, source_message_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS automatic_memory_extraction_attempts (
      user_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      attempt_index INTEGER NOT NULL CHECK (attempt_index >= 1),
      state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'held', 'settled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, source_message_id, attempt_index),
      FOREIGN KEY (user_id, source_message_id) REFERENCES automatic_memory_processing(user_id, source_message_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS automatic_memory_actions (
      user_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      action_index INTEGER NOT NULL CHECK (action_index BETWEEN 0 AND 2),
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
      attempted_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (user_id, source_message_id, action_index)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      transcript_json TEXT NOT NULL
    );
  `);
}

function migrateMemoryProcessing(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const columns = database.prepare("PRAGMA table_info(memory_processing)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "processing_version")) {
      database.exec("ALTER TABLE memory_processing ADD COLUMN processing_version INTEGER NOT NULL DEFAULT 1 CHECK (processing_version IN (1, 2));");
    }
    const settingsColumns = database.prepare("PRAGMA table_info(memory_settings)").all() as Array<{ name: string }>;
    if (!settingsColumns.some((column) => column.name === "voice_memory_enabled")) {
      database.exec("ALTER TABLE memory_settings ADD COLUMN voice_memory_enabled INTEGER NOT NULL DEFAULT 0 CHECK (voice_memory_enabled IN (0, 1));");
    }
    if (!settingsColumns.some((column) => column.name === "memory_enabled")) {
      database.exec("ALTER TABLE memory_settings ADD COLUMN memory_enabled INTEGER;");
      database.exec("UPDATE memory_settings SET memory_enabled = CASE WHEN automatic_memory_enabled = 1 AND recall_memory_enabled = 1 AND voice_memory_enabled = 1 THEN 1 ELSE 0 END WHERE memory_enabled IS NULL;");
    }
    const automaticColumns = database.prepare("PRAGMA table_info(automatic_memory_processing)").all() as Array<{ name: string }>;
    const memoryColumns = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    if (!memoryColumns.some((column) => column.name === "review_state")) database.exec("ALTER TABLE memories ADD COLUMN review_state TEXT NOT NULL DEFAULT 'eligible' CHECK (review_state IN ('eligible', 'needs_review'));");
    if (!memoryColumns.some((column) => column.name === "owner_reviewed_at")) database.exec("ALTER TABLE memories ADD COLUMN owner_reviewed_at TEXT;");
    if (!automaticColumns.some((column) => column.name === "outbox_ref")) {
      database.exec("ALTER TABLE automatic_memory_processing ADD COLUMN outbox_ref TEXT;");
    }
    const outboxColumns = database.prepare("PRAGMA table_info(automatic_memory_outbox)").all() as Array<{ name: string }>;
    if (!outboxColumns.some((column) => column.name === "attempt_index")) {
      database.exec("ALTER TABLE automatic_memory_outbox ADD COLUMN attempt_index INTEGER NOT NULL DEFAULT 1 CHECK (attempt_index >= 1);");
    }
    if (automaticColumns.some((column) => column.name === "action_plan")) {
      database.exec(`
        INSERT OR IGNORE INTO automatic_memory_outbox
          (user_id, source_message_id, outbox_ref, action_plan, usage_json, usage_settled, created_at)
        SELECT user_id, source_message_id, lower(hex(randomblob(16))), action_plan, NULL, 1, attempted_at
        FROM automatic_memory_processing WHERE action_plan IS NOT NULL;
        UPDATE automatic_memory_processing
        SET outbox_ref = (SELECT outbox_ref FROM automatic_memory_outbox outbox
          WHERE outbox.user_id = automatic_memory_processing.user_id
            AND outbox.source_message_id = automatic_memory_processing.source_message_id),
            action_plan = NULL
        WHERE action_plan IS NOT NULL;
      `);
      database.exec("ALTER TABLE automatic_memory_processing DROP COLUMN action_plan;");
    }
    database.exec(`INSERT OR IGNORE INTO automatic_memory_extraction_attempts
      (user_id, source_message_id, attempt_index, state, created_at, updated_at)
      SELECT user_id, source_message_id, attempt_index,
        CASE WHEN usage_settled = 1 THEN CASE WHEN usage_json IS NULL THEN 'held' ELSE 'settled' END ELSE 'dispatched' END,
        created_at, created_at
      FROM automatic_memory_outbox;`);
    database.exec("UPDATE memory_processing SET processing_version = 1 WHERE processing_version = 2 AND state IN ('pending', 'failed');");
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function migrateLegacyMemories(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const v2ColumnNames = ["user_id", "scope", "status", "origin", "sensitivity", "source_message_id", "source_occurred_at", "valid_from", "valid_until", "expires_at", "pinned", "supersedes_id"];
  if (columns.length === 0 || v2ColumnNames.every((name) => columns.some((column) => column.name === name))) return;

  const hasUserId = columns.some((column) => column.name === "user_id");
  const userId = hasUserId ? "user_id" : `'${LOCAL_USER.userId}'`;
  database.exec(`
    BEGIN;
    CREATE TABLE memories_v2 (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('preference', 'person', 'routine', 'work', 'event', 'schedule', 'shared')),
      scope TEXT NOT NULL DEFAULT 'shared' CHECK (scope IN ('daily', 'work', 'shared')),
      content TEXT NOT NULL,
      content_normalized TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past', 'uncertain', 'expired')),
      origin TEXT NOT NULL DEFAULT 'explicit' CHECK (origin IN ('explicit', 'extracted', 'manual', 'voice')),
      sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive')),
      importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
      source_message_id TEXT,
      source_occurred_at TEXT,
      valid_from TEXT,
      valid_until TEXT,
      expires_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0, 1)),
      supersedes_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id),
      UNIQUE (user_id, content_normalized)
    );
    INSERT INTO memories_v2 (
      user_id, id, kind, scope, content, content_normalized, status, origin, sensitivity, importance,
      source_message_id, source_occurred_at, valid_from, valid_until, expires_at, pinned, supersedes_id, created_at, updated_at
    )
    SELECT
      ${userId}, id, CASE kind WHEN 'ongoing' THEN 'routine' ELSE kind END, 'shared', content, content_normalized,
      'active', 'explicit', 'normal', importance, NULL, NULL, NULL, NULL, NULL, 1, NULL, created_at, updated_at
    FROM memories;
    DROP TABLE memories;
    ALTER TABLE memories_v2 RENAME TO memories;
    COMMIT;
  `);
}

function toMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    content: row.content,
    normalizedContent: row.content_normalized,
    status: row.status,
    origin: row.origin,
    sensitivity: row.sensitivity,
    reviewState: row.review_state,
    ownerReviewedAt: row.owner_reviewed_at,
    importance: row.importance,
    sourceMessageId: row.source_message_id,
    sourceOccurredAt: row.source_occurred_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    expiresAt: row.expires_at,
    pinned: row.pinned === 1,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTombstone(row: TombstoneRow): MemoryTombstone {
  return {
    id: row.id,
    memoryId: row.memory_id,
    normalizedFingerprint: row.normalized_fingerprint,
    createdAt: row.created_at,
    releasedAt: row.released_at,
  };
}

export function createMemoryRepository(databasePath: string): MemoryRepository {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000;");
  migrateLegacyMemories(database);
  createMemoryTables(database);
  migrateMemoryProcessing(database);

  const get = (user: RequestUser, id: string): MemoryRecord => {
    const row = database.prepare(`SELECT ${memoryColumns} FROM memories WHERE user_id = ? AND id = ?`).get(user.userId, id) as MemoryRow | undefined;
    if (!row) throw new Error("Memory not found");
    return toMemory(row);
  };

  const insert = (user: RequestUser, candidate: MemoryCandidateV2, mergeDuplicate: boolean): MemoryRecord => {
    assertCandidateIsNotTombstoned(user, candidate);
    const normalized = normalizeMemory(candidate.content);
    const existing = database.prepare(`SELECT ${memoryColumns} FROM memories WHERE user_id = ? AND content_normalized = ?`).get(user.userId, normalized) as MemoryRow | undefined;
    const now = new Date().toISOString();
    if (existing) {
      if (!mergeDuplicate) throw new Error("Memory already exists");
      database.prepare(`
        UPDATE memories SET
          kind = ?, scope = ?, content = ?, content_normalized = ?, status = 'active', origin = ?, sensitivity = ?, importance = ?,
          source_message_id = ?, source_occurred_at = ?, valid_from = ?, valid_until = ?, expires_at = ?, pinned = ?, supersedes_id = ?, updated_at = ?
        WHERE user_id = ? AND id = ?
      `).run(
        candidate.kind, candidate.scope, candidate.content, normalized, candidate.origin, candidate.sensitivity, candidate.importance,
        candidate.sourceMessageId, candidate.sourceOccurredAt, candidate.validFrom, candidate.validUntil, candidate.expiresAt,
        candidate.pinned ? 1 : 0, candidate.supersedesId, now, user.userId, existing.id,
      );
      return get(user, existing.id);
    }

    const memory: MemoryRecord = {
      id: crypto.randomUUID(),
      ...candidate,
      normalizedContent: normalized,
      status: "active",
      reviewState: candidate.sensitivity === "sensitive" && (candidate.origin === "extracted" || (candidate.origin === "voice" && !candidate.pinned)) ? "needs_review" : "eligible",
      ownerReviewedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    database.prepare(`
      INSERT INTO memories (
        user_id, id, kind, scope, content, content_normalized, status, origin, sensitivity, review_state, importance,
        source_message_id, source_occurred_at, valid_from, valid_until, expires_at, pinned, supersedes_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.userId, memory.id, memory.kind, memory.scope, memory.content, memory.normalizedContent, memory.status,
      memory.origin, memory.sensitivity, memory.reviewState ?? "eligible", memory.importance, memory.sourceMessageId, memory.sourceOccurredAt,
      memory.validFrom, memory.validUntil, memory.expiresAt, memory.pinned ? 1 : 0, memory.supersedesId,
      memory.createdAt, memory.updatedAt,
    );
    return memory;
  };

  const assertCandidateIsNotTombstoned = (user: RequestUser, candidate: MemoryCandidateV2): void => {
    const tombstones = database.prepare("SELECT normalized_fingerprint FROM memory_tombstones WHERE user_id = ? AND released_at IS NULL")
      .all(user.userId) as Array<{ normalized_fingerprint: string }>;
    const blocked = tombstones.some((tombstone) => isMemoryTombstoneMatch(candidate.content, tombstone.normalized_fingerprint));
    if (blocked) throw new Error("Memory candidate is tombstoned");
  };

  const applyPrepared = (user: RequestUser, action: PreparedMemoryAction): void => {
    if (action.type === "add") {
      assertCandidateIsNotTombstoned(user, action.candidate);
      insert(user, action.candidate, true);
      return;
    }
    if (action.type === "replace") {
      const target = get(user, action.targetMemoryId);
      if (target.status !== "active" && target.status !== "uncertain") throw new Error("Memory target is unavailable");
      assertCandidateIsNotTombstoned(user, action.candidate);
      database.prepare("UPDATE memories SET status = 'past', updated_at = ? WHERE user_id = ? AND id = ?")
        .run(new Date().toISOString(), user.userId, action.targetMemoryId);
      insert(user, { ...action.candidate, supersedesId: action.targetMemoryId }, false);
      return;
    }
    if (action.type === "mark_past") {
      const target = get(user, action.targetMemoryId);
      if (target.status !== "active" && target.status !== "uncertain") throw new Error("Memory target is unavailable");
      database.prepare("UPDATE memories SET status = 'past', updated_at = ? WHERE user_id = ? AND id = ?")
        .run(new Date().toISOString(), user.userId, action.targetMemoryId);
      if (action.replacement) {
        assertCandidateIsNotTombstoned(user, action.replacement);
        insert(user, { ...action.replacement, supersedesId: action.targetMemoryId }, false);
      }
      return;
    }
    if (action.type === "mark_uncertain") {
      for (const id of action.targetMemoryIds) {
        const target = get(user, id);
        if (target.status !== "active" && target.status !== "uncertain") throw new Error("Memory target is unavailable");
        database.prepare("UPDATE memories SET status = 'uncertain', updated_at = ? WHERE user_id = ? AND id = ?")
          .run(new Date().toISOString(), user.userId, id);
      }
      return;
    }
    const target = get(user, action.targetMemoryId);
    if (action.blockRelearning) {
      database.prepare("INSERT INTO memory_tombstones (user_id, id, memory_id, normalized_fingerprint, created_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)")
        .run(user.userId, crypto.randomUUID(), target.id, target.normalizedContent, new Date().toISOString());
    }
    database.prepare("DELETE FROM memories WHERE user_id = ? AND id = ?").run(user.userId, action.targetMemoryId);
  };

  return {
    async create(user, candidate) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        const saved = insert(user, candidate, true);
        database.exec("COMMIT;");
        return saved;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async replace(user, targetId, candidate) {
      get(user, targetId);
      database.exec("BEGIN IMMEDIATE;");
      try {
        database.prepare("UPDATE memories SET status = 'past', updated_at = ? WHERE user_id = ? AND id = ?")
          .run(new Date().toISOString(), user.userId, targetId);
        const replacement = insert(user, { ...candidate, supersedesId: targetId }, false);
        database.exec("COMMIT;");
        return replacement;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async setStatus(user, id, status) {
      get(user, id);
      const now = new Date().toISOString();
      database.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE user_id = ? AND id = ?")
        .run(status, now, user.userId, id);
      return { ...get(user, id), updatedAt: now };
    },
    async update(user, id, patch) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        const current = get(user, id);
        const content = patch.content ?? current.content;
        if (patch.content !== undefined) assertCandidateIsNotTombstoned(user, { ...current, content });
        const pinned = patch.pinned ?? current.pinned;
        const sensitivity = patch.sensitivity ?? current.sensitivity;
        const expiresAt = pinned ? null : current.expiresAt;
        const now = new Date().toISOString();
        database.prepare("UPDATE memories SET content = ?, content_normalized = ?, pinned = ?, sensitivity = ?, expires_at = ?, updated_at = ? WHERE user_id = ? AND id = ?")
          .run(content, normalizeMemory(content), pinned ? 1 : 0, sensitivity, expiresAt, now, user.userId, id);
        database.exec("COMMIT;");
        return { ...current, content, normalizedContent: normalizeMemory(content), pinned, sensitivity, expiresAt, updatedAt: now };
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async list(user, filter) {
      const statuses = filter?.statuses;
      const statusFilter = statuses && statuses.length > 0 ? ` AND status IN (${statuses.map(() => "?").join(", ")})` : "";
      const rows = database.prepare(`SELECT ${memoryColumns} FROM memories WHERE user_id = ?${statusFilter} ORDER BY importance DESC, updated_at DESC`)
        .all(user.userId, ...(statuses ?? [])) as MemoryRow[];
      return rows.map(toMemory);
    },
    async listForRecall(user, filter) {
      const statuses = filter?.statuses;
      const statusFilter = statuses && statuses.length > 0 ? ` AND status IN (${statuses.map(() => "?").join(", ")})` : "";
      const rows = database.prepare(`SELECT ${memoryColumns} FROM memories WHERE user_id = ? AND review_state = 'eligible'${statusFilter} ORDER BY importance DESC, updated_at DESC`)
        .all(user.userId, ...(statuses ?? [])) as MemoryRow[];
      return rows.map(toMemory);
    },
    async keep(user, id) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        const current = get(user, id);
        if (current.reviewState === "eligible") {
          if (current.ownerReviewedAt === null) throw new Error("Memory is not awaiting owner review");
          database.exec("COMMIT;");
          return current;
        }
        const reviewedAt = new Date().toISOString();
        database.prepare("UPDATE memories SET review_state = 'eligible', owner_reviewed_at = ?, updated_at = ? WHERE user_id = ? AND id = ? AND review_state = 'needs_review'")
          .run(reviewedAt, reviewedAt, user.userId, id);
        const kept = get(user, id);
        database.exec("COMMIT;");
        return kept;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async listActiveTombstones(user) {
      const rows = database.prepare("SELECT id, memory_id, normalized_fingerprint, created_at, released_at FROM memory_tombstones WHERE user_id = ? AND released_at IS NULL ORDER BY created_at DESC")
        .all(user.userId) as TombstoneRow[];
      return rows.map(toTombstone);
    },
    async releaseTombstone(user, id) {
      const current = database.prepare("SELECT id, memory_id, normalized_fingerprint, created_at, released_at FROM memory_tombstones WHERE user_id = ? AND id = ?")
        .get(user.userId, id) as TombstoneRow | undefined;
      if (!current || current.released_at !== null) throw new Error("Tombstone not found");
      database.prepare("UPDATE memory_tombstones SET released_at = ? WHERE user_id = ? AND id = ?")
        .run(new Date().toISOString(), user.userId, id);
    },
    async forget(user, id, blockRelearning) {
      const current = get(user, id);
      const now = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE;");
      try {
        if (blockRelearning) {
          database.prepare("INSERT INTO memory_tombstones (user_id, id, memory_id, normalized_fingerprint, created_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)")
            .run(user.userId, crypto.randomUUID(), current.id, current.normalizedContent, now);
        }
        database.prepare("DELETE FROM memories WHERE user_id = ? AND id = ?").run(user.userId, id);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async getProcessing(user, sourceMessageId) {
      const row = database.prepare("SELECT state FROM memory_processing WHERE user_id = ? AND source_message_id = ?")
        .get(user.userId, sourceMessageId) as { state: "pending" | "completed" | "failed" } | undefined;
      return row?.state ?? null;
    },
    async claimProcessing(user, sourceMessageId) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        const current = database.prepare("SELECT state, processing_version FROM memory_processing WHERE user_id = ? AND source_message_id = ?")
          .get(user.userId, sourceMessageId) as { state: "pending" | "completed" | "failed"; processing_version: 1 | 2 } | undefined;
        if (!current) {
          database.prepare("INSERT INTO memory_processing (user_id, source_message_id, state, attempted_at, completed_at, processing_version) VALUES (?, ?, 'pending', ?, NULL, 1)")
            .run(user.userId, sourceMessageId, new Date().toISOString());
          database.exec("COMMIT;");
          return "claimed";
        }
        if (current.processing_version !== 2) {
          database.exec("COMMIT;");
          return current.state === "completed" ? "completed" : "quarantined";
        }
        if (current.state === "failed") {
          database.exec("COMMIT;");
          return "quarantined";
        }
        database.exec("COMMIT;");
        return current.state;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async applyPreparedAction(user, sourceMessageId, action) {
      const now = new Date();
      database.exec("BEGIN IMMEDIATE;");
      try {
        const createsMemory = action.type === "add" || action.type === "replace" || (action.type === "mark_past" && action.replacement !== undefined);
        if (createsMemory) {
          const settings = database.prepare("SELECT memory_enabled FROM memory_settings WHERE user_id = ?")
            .get(user.userId) as { memory_enabled: number | null } | undefined;
          if (settings && settings.memory_enabled !== 1) {
            database.exec("COMMIT;");
            return "disabled";
          }
        }
        const current = database.prepare("SELECT state, attempted_at, processing_version FROM memory_processing WHERE user_id = ? AND source_message_id = ?")
          .get(user.userId, sourceMessageId) as { state: "pending" | "completed" | "failed"; attempted_at: string; processing_version: 1 | 2 } | undefined;
        if (current?.state === "completed") {
          database.exec("COMMIT;");
          return "completed";
        }
        if (current && (current.processing_version !== 2 || current.state !== "pending")) {
          database.exec("COMMIT;");
          return "quarantined";
        }
        const attemptedAt = current ? Date.parse(current.attempted_at) : Number.NaN;
        if (current?.state === "pending" && Number.isFinite(attemptedAt) && now.getTime() - attemptedAt < MEMORY_ACTION_LEASE_MS) {
          database.exec("COMMIT;");
          return "pending";
        }
        if (current) {
          database.prepare("UPDATE memory_processing SET state = 'pending', attempted_at = ?, completed_at = NULL WHERE user_id = ? AND source_message_id = ? AND processing_version = 2")
            .run(now.toISOString(), user.userId, sourceMessageId);
        } else {
          database.prepare("INSERT INTO memory_processing (user_id, source_message_id, state, attempted_at, completed_at, processing_version) VALUES (?, ?, 'pending', ?, NULL, 2)")
            .run(user.userId, sourceMessageId, now.toISOString());
        }
        applyPrepared(user, action);
        database.prepare("UPDATE memory_processing SET state = 'completed', completed_at = ? WHERE user_id = ? AND source_message_id = ?")
          .run(new Date().toISOString(), user.userId, sourceMessageId);
        database.exec("COMMIT;");
        return "applied";
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async setProcessing(user, sourceMessageId, state) {
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO memory_processing (user_id, source_message_id, state, attempted_at, completed_at)
        VALUES (?, ?, ?, ?, CASE WHEN ? = 'completed' THEN ? ELSE NULL END)
        ON CONFLICT(user_id, source_message_id) DO UPDATE SET
          state = excluded.state,
          attempted_at = excluded.attempted_at,
          completed_at = excluded.completed_at
      `).run(user.userId, sourceMessageId, state, now, state, now);
    },
    async getAutomaticProcessing(user, sourceMessageId) {
      const row = database.prepare("SELECT state, applied_count, outbox_ref FROM automatic_memory_processing WHERE user_id = ? AND source_message_id = ?")
        .get(user.userId, sourceMessageId) as { state: "pending" | "completed" | "failed"; applied_count: number; outbox_ref: string | null } | undefined;
      if (!row) return null;
      return { state: row.state, appliedCount: row.applied_count, outboxRef: row.outbox_ref };
    },
    async claimAutomaticProcessing(user, sourceMessageId, mode = "text") {
      const now = new Date();
      database.exec("BEGIN IMMEDIATE;");
      try {
        if (mode === "voice") {
          const settings = database.prepare("SELECT memory_enabled FROM memory_settings WHERE user_id = ?")
            .get(user.userId) as { memory_enabled: number | null } | undefined;
          if (settings && settings.memory_enabled !== 1) {
            database.exec("COMMIT;");
            return { state: "disabled", appliedCount: 0, retry: false };
          }
        }
        const current = database.prepare("SELECT state, applied_count, attempt_count, attempted_at FROM automatic_memory_processing WHERE user_id = ? AND source_message_id = ?")
          .get(user.userId, sourceMessageId) as {
            state: "pending" | "completed" | "failed";
            applied_count: number;
            attempt_count: number;
            attempted_at: string;
          } | undefined;
        if (!current) {
          database.prepare("INSERT INTO automatic_memory_processing (user_id, source_message_id, state, applied_count, attempt_count, attempted_at, completed_at) VALUES (?, ?, 'pending', 0, 1, ?, NULL)")
            .run(user.userId, sourceMessageId, now.toISOString());
          database.exec("COMMIT;");
          return { state: "claimed", appliedCount: 0, retry: false };
        }
        if (current.state === "completed") {
          database.exec("COMMIT;");
          return { state: "completed", appliedCount: current.applied_count, retry: false };
        }
        const attemptedAt = Date.parse(current.attempted_at);
        if (current.state === "pending" && Number.isFinite(attemptedAt) && now.getTime() - attemptedAt < MEMORY_ACTION_LEASE_MS) {
          database.exec("COMMIT;");
          return { state: "pending", appliedCount: current.applied_count, retry: false };
        }
        database.prepare("UPDATE automatic_memory_processing SET state = 'pending', attempt_count = ?, attempted_at = ?, completed_at = NULL WHERE user_id = ? AND source_message_id = ?")
          .run(current.attempt_count + 1, now.toISOString(), user.userId, sourceMessageId);
        database.exec("COMMIT;");
        return { state: "claimed", appliedCount: current.applied_count, retry: true };
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async getAutomaticOutbox(user, sourceMessageId) {
      const row = database.prepare("SELECT outbox_ref, action_plan, usage_json, usage_settled, attempt_index FROM automatic_memory_outbox WHERE user_id = ? AND source_message_id = ?")
        .get(user.userId, sourceMessageId) as { outbox_ref: string; action_plan: string; usage_json: string | null; usage_settled: number; attempt_index: number } | undefined;
      if (!row) return null;
      const actions = JSON.parse(row.action_plan) as unknown;
      if (!Array.isArray(actions) || actions.length > 3) throw new Error("Invalid automatic memory outbox");
      return {
        outboxRef: row.outbox_ref,
        actions,
        usage: row.usage_json === null ? null : JSON.parse(row.usage_json),
        usageSettled: row.usage_settled === 1,
        attemptIndex: row.attempt_index,
      };
    },
    async saveAutomaticOutbox(user, sourceMessageId, value) {
      if (value.actions.length > 3) throw new Error("Invalid automatic memory outbox");
      const outboxRef = crypto.randomUUID();
      database.exec("BEGIN IMMEDIATE;");
      try {
        const receipt = database.prepare("SELECT state FROM automatic_memory_processing WHERE user_id = ? AND source_message_id = ?")
          .get(user.userId, sourceMessageId) as { state: string } | undefined;
        if (receipt?.state !== "pending") throw new Error("Automatic memory processing receipt not pending");
        const attempt = database.prepare(`SELECT state FROM automatic_memory_extraction_attempts
          WHERE user_id = ? AND source_message_id = ? AND attempt_index = ?`)
          .get(user.userId, sourceMessageId, value.attemptIndex) as { state: string } | undefined;
        if (attempt?.state !== "dispatched") throw new Error("Automatic memory extraction attempt not dispatched");
        database.prepare(`
          INSERT OR IGNORE INTO automatic_memory_outbox
            (user_id, source_message_id, outbox_ref, action_plan, usage_json, usage_settled, attempt_index, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).run(user.userId, sourceMessageId, outboxRef, JSON.stringify(value.actions), value.usage === null ? null : JSON.stringify(value.usage), value.attemptIndex, new Date().toISOString());
        database.prepare(`UPDATE automatic_memory_processing SET outbox_ref = (
          SELECT outbox_ref FROM automatic_memory_outbox WHERE user_id = ? AND source_message_id = ?
        ) WHERE user_id = ? AND source_message_id = ?`).run(user.userId, sourceMessageId, user.userId, sourceMessageId);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      const stored = await this.getAutomaticOutbox(user, sourceMessageId);
      if (!stored) throw new Error("Automatic memory outbox unavailable");
      return stored;
    },
    async markAutomaticOutboxUsageSettled(user, sourceMessageId) {
      const result = database.prepare("UPDATE automatic_memory_outbox SET usage_settled = 1 WHERE user_id = ? AND source_message_id = ?")
        .run(user.userId, sourceMessageId);
      if (result.changes !== 1) throw new Error("Automatic memory outbox unavailable");
    },
    async clearAutomaticOutbox(user, sourceMessageId) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        database.prepare("DELETE FROM automatic_memory_outbox WHERE user_id = ? AND source_message_id = ? AND EXISTS (SELECT 1 FROM automatic_memory_processing WHERE user_id = ? AND source_message_id = ? AND state = 'failed')")
          .run(user.userId, sourceMessageId, user.userId, sourceMessageId);
        database.prepare("UPDATE automatic_memory_processing SET outbox_ref = NULL WHERE user_id = ? AND source_message_id = ? AND state = 'failed'")
          .run(user.userId, sourceMessageId);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async getLatestAutomaticExtractionAttempt(user, sourceMessageId) {
      return (database.prepare(`SELECT attempt_index AS attemptIndex, state
        FROM automatic_memory_extraction_attempts
        WHERE user_id = ? AND source_message_id = ?
        ORDER BY attempt_index DESC LIMIT 1`).get(user.userId, sourceMessageId) as AutomaticMemoryExtractionAttempt | undefined) ?? null;
    },
    async prepareAutomaticExtractionAttempt(user, sourceMessageId) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        const latest = database.prepare(`SELECT attempt_index AS attemptIndex, state
          FROM automatic_memory_extraction_attempts
          WHERE user_id = ? AND source_message_id = ?
          ORDER BY attempt_index DESC LIMIT 1`).get(user.userId, sourceMessageId) as AutomaticMemoryExtractionAttempt | undefined;
        if (latest?.state === "prepared") {
          database.exec("COMMIT;");
          return latest;
        }
        const attemptIndex = (latest?.attemptIndex ?? 0) + 1;
        const now = new Date().toISOString();
        database.prepare(`INSERT INTO automatic_memory_extraction_attempts
          (user_id, source_message_id, attempt_index, state, created_at, updated_at)
          VALUES (?, ?, ?, 'prepared', ?, ?)`).run(user.userId, sourceMessageId, attemptIndex, now, now);
        database.exec("COMMIT;");
        return { attemptIndex, state: "prepared" };
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async setAutomaticExtractionAttemptState(user, sourceMessageId, attemptIndex, state) {
      const current = database.prepare(`SELECT state FROM automatic_memory_extraction_attempts
        WHERE user_id = ? AND source_message_id = ? AND attempt_index = ?`)
        .get(user.userId, sourceMessageId, attemptIndex) as { state: AutomaticMemoryExtractionAttempt["state"] } | undefined;
      if (!current) throw new Error("Automatic memory extraction attempt unavailable");
      if (current.state === state) return;
      if (!(
        (current.state === "prepared" && state === "dispatched")
        || (current.state === "dispatched" && (state === "held" || state === "settled"))
      )) throw new Error("Invalid automatic memory extraction attempt transition");
      database.prepare(`UPDATE automatic_memory_extraction_attempts SET state = ?, updated_at = ?
        WHERE user_id = ? AND source_message_id = ? AND attempt_index = ?`)
        .run(state, new Date().toISOString(), user.userId, sourceMessageId, attemptIndex);
    },
    async getAutomaticActionProcessing(user, sourceMessageId, actionIndex) {
      const row = database.prepare("SELECT state FROM automatic_memory_actions WHERE user_id = ? AND source_message_id = ? AND action_index = ?")
        .get(user.userId, sourceMessageId, actionIndex) as { state: "pending" | "completed" } | undefined;
      return row?.state ?? null;
    },
    async applyPreparedAutomaticAction(user, sourceMessageId, actionIndex, action) {
      if (!Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex > 2) throw new Error("Invalid automatic memory action index");
      const now = new Date();
      database.exec("BEGIN IMMEDIATE;");
      try {
        const settings = database.prepare("SELECT memory_enabled FROM memory_settings WHERE user_id = ?")
          .get(user.userId) as { memory_enabled: number | null } | undefined;
        const enabled = !settings || settings.memory_enabled === 1;
        if (!enabled) {
          database.exec("COMMIT;");
          return "disabled";
        }
        const current = database.prepare("SELECT state, attempted_at FROM automatic_memory_actions WHERE user_id = ? AND source_message_id = ? AND action_index = ?")
          .get(user.userId, sourceMessageId, actionIndex) as { state: "pending" | "completed"; attempted_at: string } | undefined;
        if (current?.state === "completed") {
          database.exec("COMMIT;");
          return "completed";
        }
        const attemptedAt = current ? Date.parse(current.attempted_at) : Number.NaN;
        if (current?.state === "pending" && Number.isFinite(attemptedAt) && now.getTime() - attemptedAt < MEMORY_ACTION_LEASE_MS) {
          database.exec("COMMIT;");
          return "pending";
        }
        if (current) {
          database.prepare("UPDATE automatic_memory_actions SET attempted_at = ?, completed_at = NULL WHERE user_id = ? AND source_message_id = ? AND action_index = ?")
            .run(now.toISOString(), user.userId, sourceMessageId, actionIndex);
        } else {
          database.prepare("INSERT INTO automatic_memory_actions (user_id, source_message_id, action_index, state, attempted_at, completed_at) VALUES (?, ?, ?, 'pending', ?, NULL)")
            .run(user.userId, sourceMessageId, actionIndex, now.toISOString());
        }
        applyPrepared(user, action);
        database.prepare("UPDATE automatic_memory_actions SET state = 'completed', completed_at = ? WHERE user_id = ? AND source_message_id = ? AND action_index = ?")
          .run(new Date().toISOString(), user.userId, sourceMessageId, actionIndex);
        database.exec("COMMIT;");
        return "applied";
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async setAutomaticProcessing(user, sourceMessageId, state, appliedCount) {
      const now = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE;");
      try {
        const result = database.prepare(`
          UPDATE automatic_memory_processing
          SET state = ?, applied_count = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
              outbox_ref = CASE WHEN ? = 'completed' THEN NULL ELSE outbox_ref END
          WHERE user_id = ? AND source_message_id = ? AND state <> 'completed'
        `).run(state, appliedCount, state, now, state, user.userId, sourceMessageId);
        if (result.changes === 1) {
          if (state === "completed") database.prepare("DELETE FROM automatic_memory_outbox WHERE user_id = ? AND source_message_id = ?").run(user.userId, sourceMessageId);
          database.exec("COMMIT;");
          return;
        }
        const existing = database.prepare("SELECT state FROM automatic_memory_processing WHERE user_id = ? AND source_message_id = ?")
          .get(user.userId, sourceMessageId) as { state: string } | undefined;
        if (existing?.state !== "completed") throw new Error("Automatic memory processing receipt not found");
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async failAutomaticVoiceProcessing(user, sourceMessageId, appliedCount) {
      if (!sourceMessageId.startsWith("voice:")) throw new Error("Invalid voice memory processing receipt");
      database.exec("BEGIN IMMEDIATE;");
      try {
        const existing = database.prepare("SELECT state FROM automatic_memory_processing WHERE user_id = ? AND source_message_id = ?")
          .get(user.userId, sourceMessageId) as { state: string } | undefined;
        if (!existing) throw new Error("Automatic memory processing receipt not found");
        if (existing.state === "completed") {
          database.exec("COMMIT;");
          return;
        }
        database.prepare("DELETE FROM automatic_memory_outbox WHERE user_id = ? AND source_message_id = ?")
          .run(user.userId, sourceMessageId);
        database.prepare(`UPDATE automatic_memory_processing
          SET state = 'failed', applied_count = ?, completed_at = NULL, outbox_ref = NULL
          WHERE user_id = ? AND source_message_id = ? AND state <> 'completed'`)
          .run(appliedCount, user.userId, sourceMessageId);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async hasActiveVoiceProcessing(user, cutoff) {
      const row = database.prepare(`SELECT 1 AS active FROM automatic_memory_processing
        WHERE user_id = ? AND state = 'pending' AND source_message_id LIKE 'voice:%' AND attempted_at >= ? LIMIT 1`)
        .get(user.userId, cutoff) as { active: number } | undefined;
      return row?.active === 1;
    },
    async cleanupStaleVoiceProcessing(user, cutoff) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        const stale = database.prepare(`SELECT COUNT(*) AS count FROM automatic_memory_processing receipt
          WHERE receipt.user_id = ? AND receipt.source_message_id LIKE 'voice:%' AND receipt.attempted_at < ?
            AND (receipt.state = 'pending' OR (receipt.state = 'failed' AND (
              receipt.outbox_ref IS NOT NULL OR EXISTS (
                SELECT 1 FROM automatic_memory_outbox outbox
                WHERE outbox.user_id = receipt.user_id AND outbox.source_message_id = receipt.source_message_id
              )
            )))`).get(user.userId, cutoff) as { count: number };
        database.prepare(`DELETE FROM automatic_memory_outbox
          WHERE user_id = ? AND source_message_id LIKE 'voice:%' AND EXISTS (
            SELECT 1 FROM automatic_memory_processing receipt
            WHERE receipt.user_id = automatic_memory_outbox.user_id
              AND receipt.source_message_id = automatic_memory_outbox.source_message_id
              AND receipt.state IN ('pending', 'failed') AND receipt.attempted_at < ?
          )`).run(user.userId, cutoff);
        database.prepare(`UPDATE automatic_memory_processing
          SET state = 'failed', completed_at = NULL, outbox_ref = NULL
          WHERE user_id = ? AND state IN ('pending', 'failed') AND source_message_id LIKE 'voice:%' AND attempted_at < ?`)
          .run(user.userId, cutoff);
        database.exec("COMMIT;");
        return Number(stale.count);
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
  };
}

export function makeTestRepository(): MemoryRepository {
  return createMemoryRepository(":memory:");
}
