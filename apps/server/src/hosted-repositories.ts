import { normalizeMemory, parseMemoryRecord, parseProfile, parseRemoteChatSnapshot } from "../../../packages/domain/src/index.js";
import type { MemoryCandidateV2, MemoryRecord, MemoryStatus, MemoryTombstone, Profile, RemoteChatSnapshot } from "../../../packages/domain/src/index.js";
import type { MemoryRepository } from "./db.js";
import type { ProfileRepository } from "./profile-db.js";
import type { RequestUser } from "./request-user.js";
import { toUsageRow, type UsageLog } from "./usage-log.js";
import type { ChatStateRepository } from "./chat-state-routes.js";
import type { MemorySettings, MemorySettingsRepository } from "./memory-settings.js";

type QueryResult = { data: unknown; error: unknown };
type QueryBuilder = {
  select(...args: unknown[]): QueryBuilder;
  eq(...args: unknown[]): QueryBuilder;
  in(...args: unknown[]): QueryBuilder;
  order(...args: unknown[]): QueryBuilder;
  upsert(...args: unknown[]): QueryBuilder;
  insert(...args: unknown[]): QueryBuilder;
  update(...args: unknown[]): QueryBuilder;
  delete(...args: unknown[]): QueryBuilder;
  maybeSingle(): Promise<QueryResult>;
  single(): Promise<QueryResult>;
  then(resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown): Promise<unknown>;
};
export type UserClientFactory = (user: RequestUser) => {
  from(table: string): QueryBuilder;
  rpc(name: string, args: Record<string, unknown>): Promise<QueryResult>;
};

export class HostedRepositoryError extends Error {
  constructor() {
    super("Hosted repository unavailable");
    this.name = "HostedRepositoryError";
  }
}

const memorySelect = "id,kind,scope,content,content_normalized,status,origin,sensitivity,review_state,owner_reviewed_at,importance,source_message_id,source_occurred_at,valid_from,valid_until,expires_at,pinned,supersedes_id,created_at,updated_at";

function normalizeDatabaseTimestamp(value: string): string;
function normalizeDatabaseTimestamp(value: unknown): unknown;
function normalizeDatabaseTimestamp(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function profileFromRow(row: unknown): Profile {
  const source = row as Record<string, unknown> | null;
  const profile = parseProfile(source && {
    displayName: source.display_name,
    addressingStyle: source.addressing_style,
    updatedAt: normalizeDatabaseTimestamp(source.updated_at),
    ...(source.occupation != null ? { occupation: source.occupation } : {}),
    ...(source.region != null ? { region: source.region } : {}),
  });
  if (!profile) throw new HostedRepositoryError();
  return profile;
}

function memoryFromRow(row: unknown): MemoryRecord {
  const source = row as Record<string, unknown> | null;
  const memory = parseMemoryRecord(source && {
    id: source.id,
    kind: source.kind,
    scope: source.scope,
    content: source.content,
    normalizedContent: source.content_normalized,
    status: source.status,
    origin: source.origin,
    sensitivity: source.sensitivity,
    reviewState: source.review_state,
    ownerReviewedAt: normalizeDatabaseTimestamp(source.owner_reviewed_at),
    importance: source.importance,
    sourceMessageId: source.source_message_id,
    sourceOccurredAt: normalizeDatabaseTimestamp(source.source_occurred_at),
    validFrom: normalizeDatabaseTimestamp(source.valid_from),
    validUntil: normalizeDatabaseTimestamp(source.valid_until),
    expiresAt: normalizeDatabaseTimestamp(source.expires_at),
    pinned: source.pinned,
    supersedesId: source.supersedes_id,
    createdAt: normalizeDatabaseTimestamp(source.created_at),
    updatedAt: normalizeDatabaseTimestamp(source.updated_at),
  });
  if (!memory) throw new HostedRepositoryError();
  return memory;
}

function tombstoneFromRow(row: unknown): MemoryTombstone {
  const source = row as Record<string, unknown> | null;
  if (
    !source
    || typeof source.id !== "string"
    || (source.memory_id !== null && typeof source.memory_id !== "string")
    || typeof source.normalized_fingerprint !== "string"
    || typeof normalizeDatabaseTimestamp(source.created_at) !== "string"
    || (source.released_at !== null && typeof normalizeDatabaseTimestamp(source.released_at) !== "string")
  ) throw new HostedRepositoryError();
  return {
    id: source.id,
    memoryId: source.memory_id as string | null,
    normalizedFingerprint: source.normalized_fingerprint,
    createdAt: normalizeDatabaseTimestamp(source.created_at) as string,
    releasedAt: normalizeDatabaseTimestamp(source.released_at) as string | null,
  };
}

function memoryWriteRow(candidate: MemoryCandidateV2, normalized: string, now: string): Record<string, unknown> {
  return {
    kind: candidate.kind,
    scope: candidate.scope,
    content: candidate.content,
    content_normalized: normalized,
    status: "active",
    origin: candidate.origin,
    sensitivity: candidate.sensitivity,
    importance: candidate.importance,
    source_message_id: candidate.sourceMessageId,
    source_occurred_at: candidate.sourceOccurredAt,
    valid_from: candidate.validFrom,
    valid_until: candidate.validUntil,
    expires_at: candidate.expiresAt,
    pinned: candidate.pinned,
    supersedes_id: candidate.supersedesId,
    updated_at: now,
  };
}

function preparedActionForRpc(action: Parameters<MemoryRepository["applyPreparedAction"]>[2]): Record<string, unknown> {
  const candidate = (value: MemoryCandidateV2): Record<string, unknown> => ({
    ...value,
    normalizedContent: normalizeMemory(value.content),
  });
  if (action.type === "add" || action.type === "replace") return { ...action, candidate: candidate(action.candidate) };
  if (action.type === "mark_past" && action.replacement) return { ...action, replacement: candidate(action.replacement) };
  return action;
}

function checked(result: QueryResult): unknown {
  if (result.error) throw new HostedRepositoryError();
  return result.data;
}

function remoteContent(snapshot: RemoteChatSnapshot): object {
  return {
    timeline: snapshot.timeline,
    lastOpeningAt: snapshot.lastOpeningAt,
    lastConversationAt: snapshot.lastConversationAt,
  };
}

function chatSnapshotFromRow(row: unknown): RemoteChatSnapshot {
  const source = row as Record<string, unknown> | null;
  const body = source?.snapshot as Record<string, unknown> | null;
  const parsed = parseRemoteChatSnapshot(body && {
    ...body,
    version: source?.version,
    revision: source?.revision,
    updatedAt: normalizeDatabaseTimestamp(source?.updated_at),
  });
  if (!parsed) throw new HostedRepositoryError();
  return parsed;
}

function sameRemoteContent(left: RemoteChatSnapshot, right: RemoteChatSnapshot): boolean {
  return JSON.stringify(remoteContent(left)) === JSON.stringify(remoteContent(right));
}

function hasPhotoLineage(snapshot: RemoteChatSnapshot): boolean {
  return snapshot.timeline.some((item) => item.type === "photo" || ("origin" in item && item.origin === "photo_analysis"));
}

function isSnapshotRevisionMismatch(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : "";
  return /snapshot revision mismatch/i.test(message);
}

function isPhotoLineageError(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : "";
  return /photo lineage/i.test(message);
}

function isMissingReconciledSnapshotRpc(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "PGRST202";
}

function chatMutationFailure(error: unknown): "stale" | "not_found" | "not_ready" | "blocked" | "unavailable" {
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
  if (/revision mismatch|serialization/i.test(message)) return "stale";
  if (/asset missing|not found/i.test(message)) return "not_found";
  if (/receipt is not complete|not ready/i.test(message)) return "not_ready";
  if (/blocked/i.test(message)) return "blocked";
  return "unavailable";
}

export function createSupabaseChatStateRepository(factory: UserClientFactory, mutationFactory: UserClientFactory): ChatStateRepository {
  const get: ChatStateRepository["get"] = async (user) => {
    const result = await factory(user).from("chat_snapshots")
      .select("version,revision,snapshot,updated_at")
      .eq("user_id", user.userId)
      .maybeSingle();
    const data = checked(result);
    return data === null ? null : chatSnapshotFromRow(data);
  };

  const saveLegacyTextSnapshot = async (
    user: RequestUser,
    input: { expectedRevision: number; snapshot: RemoteChatSnapshot },
    current: RemoteChatSnapshot | null,
  ): Promise<RemoteChatSnapshot | "stale" | "unavailable"> => {
    if (current) {
      if (current.revision === input.expectedRevision + 1 && sameRemoteContent(current, input.snapshot)) return current;
      if (current.revision !== input.expectedRevision) return "stale";
    } else if (input.expectedRevision !== 0) {
      return "stale";
    }

    const nextRevision = input.expectedRevision + 1;
    const row = {
      user_id: user.userId,
      version: 2,
      revision: nextRevision,
      snapshot: remoteContent(input.snapshot),
      updated_at: input.snapshot.updatedAt,
    };
    const client = factory(user);
    const query = current
      ? client.from("chat_snapshots").update(row)
          .eq("user_id", user.userId)
          .eq("revision", input.expectedRevision)
          .select("version,revision,snapshot,updated_at")
          .maybeSingle()
      : client.from("chat_snapshots").insert(row)
          .select("version,revision,snapshot,updated_at")
          .maybeSingle();
    const result = await query;
    if (!result.error && result.data !== null) return chatSnapshotFromRow(result.data);

    const latest = await get(user);
    if (latest?.revision === nextRevision && sameRemoteContent(latest, input.snapshot)) return latest;
    if (latest && latest.revision !== input.expectedRevision) return "stale";
    return "unavailable";
  };

  return {
    get,
    async saveReconciled(user, input) {
      // The HTTP contract carries the currently observed revision while the database RPC
      // atomically stores the next one. Keep that translation at the repository boundary so
      // browser clients never have to predict a committed revision.
      const candidate = { ...input.snapshot, revision: input.expectedRevision + 1 };
      const result = await mutationFactory(user).rpc("save_chat_snapshot_reconciled", {
        p_expected_revision: input.expectedRevision,
        p_snapshot: candidate,
      });
      if (result.error) {
        if (isPhotoLineageError(result.error)) return "rejected";
        let current: RemoteChatSnapshot | null;
        try {
          current = await get(user);
        } catch {
          return "stale";
        }
        if (current?.revision === input.expectedRevision + 1 && sameRemoteContent(current, input.snapshot)) return current;
        if (current?.revision !== undefined && current.revision !== input.expectedRevision) return "stale";
        if (isMissingReconciledSnapshotRpc(result.error)) {
          if (hasPhotoLineage(input.snapshot)) return "rejected";
          return saveLegacyTextSnapshot(user, input, current);
        }
        if (!isSnapshotRevisionMismatch(result.error)) return "unavailable";
        if (current !== null || input.expectedRevision !== 0) return "stale";
        if (hasPhotoLineage(input.snapshot)) return "rejected";

        const inserted = await mutationFactory(user).from("chat_snapshots").insert({
          user_id: user.userId,
          version: candidate.version,
          revision: candidate.revision,
          snapshot: candidate,
          updated_at: candidate.updatedAt,
        }).select("version,revision,snapshot,updated_at").single();
        if (!inserted.error) return chatSnapshotFromRow(inserted.data);
        try {
          current = await get(user);
          if (current?.revision === candidate.revision && sameRemoteContent(current, candidate)) return current;
        } catch {
          // A failed reconciliation read must not turn an unknown insert result into success.
        }
        return "stale";
      }
      return chatSnapshotFromRow(checked(result));
    },
    async save(user, input) { return this.saveReconciled(user, input); },
    async commitPhoto(user, input) {
      const current = await get(user);
      if (current && current.revision === input.expectedRevision + 1 && sameRemoteContent(current, input.snapshot)) return current;
      const photo = input.snapshot.timeline.find((item) => item.type === "photo" && item.photoId === input.photoId);
      if (!photo) return "not_found";
      const result = await mutationFactory(user).rpc("commit_photo_exchange", {
        p_client_message_id: photo.id,
        p_expected_revision: input.expectedRevision,
        p_snapshot: input.snapshot,
      });
      if (result.error) return chatMutationFailure(result.error);
      return chatSnapshotFromRow(checked(result));
    },
    async deletePhoto(user, input) {
      const current = await get(user);
      if (!current) return { kind: "not_found" };
      if (current.revision !== input.expectedRevision) return { kind: "stale" };
      const photo = current.timeline.find((item) => item.type === "photo" && item.photoId === input.photoId);
      if (!photo) return { kind: "not_found" };
      const snapshot: RemoteChatSnapshot = {
        ...current,
        version: 3,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        timeline: current.timeline.filter((item) => item.id !== photo.id),
      };
      const result = await mutationFactory(user).rpc("delete_photo_message", {
        p_photo_id: input.photoId,
        p_expected_revision: input.expectedRevision,
        p_snapshot: snapshot,
      });
      if (result.error) return { kind: chatMutationFailure(result.error) };
      return { kind: "deleted", snapshot: chatSnapshotFromRow(checked(result)) };
    },
    async deleteWholeChat(user, expectedRevision) {
      const current = await get(user);
      if (!current) return { kind: "not_found" };
      if (current.revision !== expectedRevision) return { kind: "stale" };
      const result = await mutationFactory(user).rpc("delete_whole_chat_v2", { p_expected_revision: expectedRevision });
      if (result.error) {
        const kind = chatMutationFailure(result.error);
        return { kind: kind === "stale" || kind === "not_found" ? kind : "unavailable" };
      }
      const blockedPhotoCount = checked(result);
      if (!Number.isSafeInteger(blockedPhotoCount) || (blockedPhotoCount as number) < 0) return { kind: "unavailable" };
      return { kind: "deleted", snapshot: emptyRemoteSnapshot(new Date().toISOString()), blockedPhotoCount: blockedPhotoCount as number };
    },
  };
}

function emptyRemoteSnapshot(now: string): RemoteChatSnapshot {
  return { timeline: [], lastOpeningAt: null, lastConversationAt: null, version: 3, revision: 0, updatedAt: now };
}

export function createSupabaseProfileRepository(factory: UserClientFactory): ProfileRepository {
  return {
    async get(user) {
      const result = await factory(user).from("profiles")
        .select("display_name,addressing_style,updated_at,occupation,region")
        .eq("user_id", user.userId)
        .maybeSingle();
      const data = checked(result);
      return data === null ? null : profileFromRow(data);
    },
    async save(user, input) {
      const current = typeof input === "string"
        ? { displayName: input, addressingStyle: "san" as const }
        : input;
      const profile = parseProfile({ ...current, updatedAt: new Date().toISOString() });
      if (!profile) throw new HostedRepositoryError();
      const result = await factory(user).from("profiles").upsert({
        user_id: user.userId,
        display_name: profile.displayName,
        addressing_style: profile.addressingStyle,
        ...(profile.occupation !== undefined ? { occupation: profile.occupation } : {}),
        ...(profile.region !== undefined ? { region: profile.region } : {}),
        updated_at: profile.updatedAt,
      }, { onConflict: "user_id" }).select("display_name,addressing_style,updated_at,occupation,region").single();
      return profileFromRow(checked(result));
    },
  };
}

export function createSupabaseMemoryRepository(factory: UserClientFactory, mutationFactory: UserClientFactory = factory): MemoryRepository {
  const create: MemoryRepository["create"] = async (user, candidate) => {
    const normalized = normalizeMemory(candidate.content);
    const client = factory(user);
    const mutationClient = mutationFactory(user);
    const lookup = await client.from("memories")
      .select(memorySelect)
      .eq("user_id", user.userId)
      .eq("content_normalized", normalized)
      .maybeSingle();
    const existing = checked(lookup);
    if (existing !== null) {
      const row = memoryFromRow(existing);
      const now = new Date().toISOString();
      const result = await mutationClient.from("memories")
        .update(memoryWriteRow(candidate, normalized, now))
        .eq("user_id", user.userId)
        .eq("id", row.id)
        .select(memorySelect)
        .single();
      return memoryFromRow(checked(result));
    }

    const now = new Date().toISOString();
    const result = await mutationClient.from("memories").insert({
      user_id: user.userId,
      id: crypto.randomUUID(),
      ...memoryWriteRow(candidate, normalized, now),
      created_at: now,
    }).select(memorySelect).single();
    return memoryFromRow(checked(result));
  };

  return {
    create,
    async replace(user, targetId, candidate) {
      const now = new Date().toISOString();
      const result = await mutationFactory(user).rpc("replace_memory", {
        p_target_id: targetId,
        p_candidate: memoryWriteRow({ ...candidate, supersedesId: targetId }, normalizeMemory(candidate.content), now),
      });
      return memoryFromRow(checked(result));
    },
    async setStatus(user, id, status) {
      const result = await mutationFactory(user).from("memories")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("user_id", user.userId)
        .eq("id", id)
        .select(memorySelect)
        .single();
      return memoryFromRow(checked(result));
    },
    async update(user, id, patch) {
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.content !== undefined) {
        row.content = patch.content;
        row.content_normalized = normalizeMemory(patch.content);
      }
      if (patch.pinned !== undefined) row.pinned = patch.pinned;
      if (patch.sensitivity !== undefined) row.sensitivity = patch.sensitivity;
      if (patch.pinned === true) row.expires_at = null;
      const result = await mutationFactory(user).from("memories")
        .update(row)
        .eq("user_id", user.userId)
        .eq("id", id)
        .select(memorySelect)
        .single();
      return memoryFromRow(checked(result));
    },
    async list(user, filter) {
      const query = factory(user).from("memories")
        .select(memorySelect)
        .eq("user_id", user.userId)
        .order("importance", { ascending: false })
        .order("updated_at", { ascending: false });
      const result = await (filter?.statuses?.length ? query.in("status", filter.statuses) : query) as unknown as QueryResult;
      return (checked(result) as unknown[]).map(memoryFromRow);
    },
    async listForRecall(user, filter) {
      const query = factory(user).from("memories")
        .select(memorySelect)
        .eq("user_id", user.userId)
        .eq("review_state", "eligible")
        .order("importance", { ascending: false })
        .order("updated_at", { ascending: false });
      const result = await (filter?.statuses?.length ? query.in("status", filter.statuses) : query) as unknown as QueryResult;
      return (checked(result) as unknown[]).map(memoryFromRow);
    },
    async keep(user, id) {
      const result = await mutationFactory(user).rpc("keep_memory", { p_owner_id: user.userId, p_target_id: id });
      const memory = memoryFromRow(checked(result));
      if (memory.reviewState !== "eligible" || memory.ownerReviewedAt === null) throw new HostedRepositoryError();
      return memory;
    },
    async listActiveTombstones(user) {
      const result = await factory(user).from("memory_tombstones")
        .select("id,memory_id,normalized_fingerprint,created_at,released_at")
        .eq("user_id", user.userId)
        .order("created_at", { ascending: false });
      const rows = checked(result);
      if (!Array.isArray(rows)) throw new HostedRepositoryError();
      return rows.map(tombstoneFromRow).filter((tombstone) => tombstone.releasedAt === null);
    },
    async releaseTombstone(user, id) {
      const result = await mutationFactory(user).rpc("release_memory_tombstone", { p_tombstone_id: id });
      if (checked(result) !== true) throw new HostedRepositoryError();
    },
    async forget(user, id, blockRelearning) {
      const result = await mutationFactory(user).rpc("forget_memory", {
        p_target_id: id,
        p_block_relearning: blockRelearning,
      });
      if (checked(result) !== true) throw new HostedRepositoryError();
    },
    async getProcessing(user, sourceMessageId) {
      const result = await factory(user).from("memory_processing")
        .select("state")
        .eq("user_id", user.userId)
        .eq("source_message_id", sourceMessageId)
        .maybeSingle();
      const row = checked(result) as { state?: unknown } | null;
      return row?.state === "pending" || row?.state === "completed" || row?.state === "failed" ? row.state : null;
    },
    async claimProcessing(user, sourceMessageId) {
      const result = await mutationFactory(user).rpc("claim_memory_processing", { p_source_message_id: sourceMessageId });
      const state = checked(result);
      if (state === "claimed" || state === "pending" || state === "completed" || state === "quarantined") return state;
      throw new HostedRepositoryError();
    },
    async applyPreparedAction(user, sourceMessageId, action) {
      const result = await mutationFactory(user).rpc("apply_memory_action_once", {
        p_source_message_id: sourceMessageId,
        p_action: preparedActionForRpc(action),
      });
      const state = checked(result);
      if (state === "applied" || state === "pending" || state === "completed" || state === "quarantined" || state === "disabled") return state;
      throw new HostedRepositoryError();
    },
    async setProcessing(user, sourceMessageId, state) {
      const now = new Date().toISOString();
      const result = await (mutationFactory(user).from("memory_processing").upsert({
        user_id: user.userId,
        source_message_id: sourceMessageId,
        state,
        attempted_at: now,
        completed_at: state === "completed" ? now : null,
      }, { onConflict: "user_id,source_message_id" }) as unknown as Promise<QueryResult>);
      checked(result);
    },
    async getAutomaticProcessing(user, sourceMessageId) {
      const result = await factory(user).from("automatic_memory_processing")
        .select("state,applied_count,outbox_ref")
        .eq("user_id", user.userId)
        .eq("source_message_id", sourceMessageId)
        .maybeSingle();
      const row = checked(result) as { state?: unknown; applied_count?: unknown; outbox_ref?: unknown } | null;
      if (row === null) return null;
      if (
        (row.state !== "pending" && row.state !== "completed" && row.state !== "failed")
        || !Number.isInteger(row.applied_count)
        || (row.applied_count as number) < 0
        || (row.applied_count as number) > 3
        || (row.outbox_ref !== null && typeof row.outbox_ref !== "string")
      ) throw new HostedRepositoryError();
      return { state: row.state, appliedCount: row.applied_count as number, outboxRef: row.outbox_ref as string | null };
    },
    async claimAutomaticProcessing(user, sourceMessageId, _mode = "text") {
      const result = await mutationFactory(user).rpc("claim_automatic_memory_processing", { p_source_message_id: sourceMessageId });
      const value = checked(result) as Record<string, unknown> | null;
      if (
        !value
        || (value.state !== "claimed" && value.state !== "pending" && value.state !== "completed" && value.state !== "disabled")
        || !Number.isInteger(value.appliedCount)
        || (value.appliedCount as number) < 0
        || (value.appliedCount as number) > 3
        || typeof value.retry !== "boolean"
        || (value.state !== "claimed" && value.retry !== false)
      ) throw new HostedRepositoryError();
      return {
        state: value.state,
        appliedCount: value.appliedCount as number,
        retry: value.retry,
      } as Awaited<ReturnType<MemoryRepository["claimAutomaticProcessing"]>>;
    },
    async getAutomaticOutbox(user, sourceMessageId) {
      const result = await mutationFactory(user).rpc("get_automatic_memory_outbox", { p_source_message_id: sourceMessageId });
      const value = checked(result) as Record<string, unknown> | null;
      if (value === null) return null;
      if (
        typeof value.outboxRef !== "string"
        || !Array.isArray(value.actions)
        || value.actions.length > 3
        || typeof value.usageSettled !== "boolean"
        || !Number.isInteger(value.attemptIndex)
        || (value.usage !== null && (typeof value.usage !== "object" || Array.isArray(value.usage)))
      ) throw new HostedRepositoryError();
      return value as Awaited<ReturnType<MemoryRepository["getAutomaticOutbox"]>>;
    },
    async saveAutomaticOutbox(user, sourceMessageId, value) {
      const result = await mutationFactory(user).rpc("save_automatic_memory_outbox", {
        p_source_message_id: sourceMessageId,
        p_action_plan: value.actions,
        p_usage: value.usage,
        p_attempt_index: value.attemptIndex,
      });
      const stored = checked(result) as Record<string, unknown> | null;
      if (
        !stored
        || typeof stored.outboxRef !== "string"
        || !Array.isArray(stored.actions)
        || stored.actions.length > 3
        || typeof stored.usageSettled !== "boolean"
        || !Number.isInteger(stored.attemptIndex)
      ) throw new HostedRepositoryError();
      return stored as Awaited<ReturnType<MemoryRepository["saveAutomaticOutbox"]>>;
    },
    async markAutomaticOutboxUsageSettled(user, sourceMessageId) {
      const result = await mutationFactory(user).rpc("mark_automatic_memory_usage_settled", { p_source_message_id: sourceMessageId });
      checked(result);
    },
    async clearAutomaticOutbox(user, sourceMessageId) {
      const result = await mutationFactory(user).rpc("clear_automatic_memory_outbox", { p_source_message_id: sourceMessageId });
      checked(result);
    },
    async getLatestAutomaticExtractionAttempt(user, sourceMessageId) {
      const result = await mutationFactory(user).rpc("get_latest_automatic_memory_attempt", { p_source_message_id: sourceMessageId });
      const value = checked(result) as Record<string, unknown> | null;
      if (value === null) return null;
      if (!Number.isInteger(value.attemptIndex) || !["prepared", "dispatched", "held", "settled"].includes(value.state as string)) throw new HostedRepositoryError();
      return value as Awaited<ReturnType<MemoryRepository["getLatestAutomaticExtractionAttempt"]>>;
    },
    async prepareAutomaticExtractionAttempt(user, sourceMessageId) {
      const result = await mutationFactory(user).rpc("prepare_automatic_memory_attempt", { p_source_message_id: sourceMessageId });
      const value = checked(result) as Record<string, unknown> | null;
      if (!value || !Number.isInteger(value.attemptIndex) || value.state !== "prepared") throw new HostedRepositoryError();
      return value as Awaited<ReturnType<MemoryRepository["prepareAutomaticExtractionAttempt"]>>;
    },
    async setAutomaticExtractionAttemptState(user, sourceMessageId, attemptIndex, state) {
      const result = await mutationFactory(user).rpc("set_automatic_memory_attempt_state", {
        p_source_message_id: sourceMessageId,
        p_attempt_index: attemptIndex,
        p_state: state,
      });
      checked(result);
    },
    async getAutomaticActionProcessing(user, sourceMessageId, actionIndex) {
      const result = await factory(user).from("automatic_memory_actions")
        .select("state")
        .eq("user_id", user.userId)
        .eq("source_message_id", sourceMessageId)
        .eq("action_index", actionIndex)
        .maybeSingle();
      const row = checked(result) as { state?: unknown } | null;
      if (row === null) return null;
      if (row.state !== "pending" && row.state !== "completed") throw new HostedRepositoryError();
      return row.state;
    },
    async applyPreparedAutomaticAction(user, sourceMessageId, actionIndex, action) {
      const result = await mutationFactory(user).rpc("apply_automatic_memory_action_once", {
        p_source_message_id: sourceMessageId,
        p_action_index: actionIndex,
        p_action: action,
      });
      const value = checked(result);
      if (value !== "applied" && value !== "pending" && value !== "completed" && value !== "disabled") throw new HostedRepositoryError();
      return value;
    },
    async setAutomaticProcessing(user, sourceMessageId, state, appliedCount) {
      const result = await mutationFactory(user).rpc("finish_automatic_memory_processing", {
        p_source_message_id: sourceMessageId,
        p_state: state,
        p_applied_count: appliedCount,
      });
      const value = checked(result) as Record<string, unknown> | null;
      if (!value || value.state !== state || value.appliedCount !== appliedCount) throw new HostedRepositoryError();
    },
    async failAutomaticVoiceProcessing(user, sourceMessageId, appliedCount) {
      const result = await mutationFactory(user).rpc("fail_voice_automatic_memory_processing", {
        p_source_message_id: sourceMessageId,
        p_applied_count: appliedCount,
      });
      const value = checked(result) as Record<string, unknown> | null;
      if (!value || (value.state !== "failed" && value.state !== "completed") || !Number.isInteger(value.appliedCount)) {
        throw new HostedRepositoryError();
      }
    },
    async hasActiveVoiceProcessing(user, cutoff) {
      const result = await mutationFactory(user).rpc("has_active_voice_memory_processing", { p_cutoff: cutoff });
      const value = checked(result);
      if (typeof value !== "boolean") throw new HostedRepositoryError();
      return value;
    },
    async cleanupStaleVoiceProcessing(user, cutoff) {
      const result = await mutationFactory(user).rpc("cleanup_stale_voice_memory_processing", { p_cutoff: cutoff });
      const value = checked(result);
      if (!Number.isInteger(value) || (value as number) < 0) throw new HostedRepositoryError();
      return value as number;
    },
  };
}

export function createSupabaseMemorySettingsRepository(factory: UserClientFactory, mutationFactory: UserClientFactory = factory): MemorySettingsRepository {
  const fromRow = (value: unknown): MemorySettings => {
    const row = value as Record<string, unknown> | null;
    if (!row) return { memoryEnabled: true, updatedAt: null };
    if (typeof row.memory_enabled !== "boolean" || typeof normalizeDatabaseTimestamp(row.updated_at) !== "string") {
      throw new HostedRepositoryError();
    }
    return {
      memoryEnabled: row.memory_enabled,
      updatedAt: normalizeDatabaseTimestamp(row.updated_at) as string,
    };
  };
  return {
    async get(user) {
      const result = await factory(user).from("memory_settings")
        .select("memory_enabled,updated_at")
        .eq("user_id", user.userId)
        .maybeSingle();
      return fromRow(checked(result));
    },
    async patch(user, settings) {
      const result = await mutationFactory(user).rpc("patch_memory_settings", {
        p_key: "memory_enabled",
        p_enabled: settings.memoryEnabled,
      });
      return fromRow(checked(result));
    },
  };
}

export function createSupabaseUsageLog(factory: UserClientFactory): UsageLog {
  return {
    async append(user, input) {
      const row = toUsageRow(user, input);
      const result = await (factory(user).from("usage_events").upsert({
        user_id: user.userId,
        session_id: row.sessionId,
        payload: row,
      }, { onConflict: "user_id,session_id" }) as unknown as Promise<QueryResult>);
      checked(result);
    },
  };
}
