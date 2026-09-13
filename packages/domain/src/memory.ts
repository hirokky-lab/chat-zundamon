export type MemoryKind = "preference" | "person" | "routine" | "work" | "event" | "schedule" | "shared";
export type MemoryScope = "daily" | "work" | "shared";
export type MemoryStatus = "active" | "past" | "uncertain" | "expired";
export type MemoryOrigin = "explicit" | "extracted" | "manual" | "voice";
export type MemorySensitivity = "normal" | "sensitive";
export type MemoryReviewState = "eligible" | "needs_review";

export type LegacyMemoryKind = "preference" | "event" | "ongoing" | "shared";

export type MemoryCandidate = {
  kind: LegacyMemoryKind;
  content: string;
  importance: 1 | 2 | 3 | 4 | 5;
};

export type LegacyMemory = MemoryCandidate & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  normalizedContent: string;
  status: MemoryStatus;
  origin: MemoryOrigin;
  sensitivity: MemorySensitivity;
  reviewState?: MemoryReviewState;
  ownerReviewedAt?: string | null;
  importance: 1 | 2 | 3 | 4 | 5;
  sourceMessageId: string | null;
  sourceOccurredAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  expiresAt: string | null;
  pinned: boolean;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryCandidateV2 = Omit<
  MemoryRecord,
  "id" | "normalizedContent" | "status" | "reviewState" | "ownerReviewedAt" | "createdAt" | "updatedAt"
>;

export type MemoryRetention = "light" | "recent" | null;

export type MemoryCandidateProposal = Pick<
  MemoryCandidateV2,
  "kind" | "scope" | "content" | "importance" | "sourceOccurredAt" | "validFrom" | "validUntil"
> & {
  retention: MemoryRetention;
};

export type MemoryWriteTrust = {
  origin: MemoryOrigin;
  pinned: boolean;
  sourceMessageId: string | null;
  sourceOccurredAt: string | null;
  scheduleOccurredAt: string | null;
  serverNow: string;
};

export type MemoryTombstone = {
  id: string;
  memoryId: string | null;
  normalizedFingerprint: string;
  createdAt: string;
  releasedAt: string | null;
};

export type MemoryAction =
  | { type: "add"; candidate: MemoryCandidateProposal }
  | { type: "replace"; targetMemoryId: string; candidate: MemoryCandidateProposal }
  | { type: "mark_past"; targetMemoryId: string; replacement?: MemoryCandidateProposal }
  | { type: "mark_uncertain"; targetMemoryIds: string[] }
  | { type: "forget"; targetMemoryId: string; blockRelearning: boolean };

// Kept while existing callers transition from v1 confirmation to v2 operations.
export type Memory = MemoryRecord;

const memoryKinds = new Set<MemoryKind>(["preference", "person", "routine", "work", "event", "schedule", "shared"]);
const memoryScopes = new Set<MemoryScope>(["daily", "work", "shared"]);
const memoryStatuses = new Set<MemoryStatus>(["active", "past", "uncertain", "expired"]);
const memoryOrigins = new Set<MemoryOrigin>(["explicit", "extracted", "manual", "voice"]);
const memorySensitivities = new Set<MemorySensitivity>(["normal", "sensitive"]);
const memoryReviewStates = new Set<MemoryReviewState>(["eligible", "needs_review"]);

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parseMemoryRecord(value: unknown): MemoryRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !memoryKinds.has(record.kind as MemoryKind) ||
    !memoryScopes.has(record.scope as MemoryScope) ||
    typeof record.content !== "string" ||
    typeof record.normalizedContent !== "string" ||
    !memoryStatuses.has(record.status as MemoryStatus) ||
    !memoryOrigins.has(record.origin as MemoryOrigin) ||
    !memorySensitivities.has(record.sensitivity as MemorySensitivity) ||
    !(record.reviewState === undefined || memoryReviewStates.has(record.reviewState as MemoryReviewState)) ||
    !(record.ownerReviewedAt === undefined || isNullableTimestamp(record.ownerReviewedAt)) ||
    ![1, 2, 3, 4, 5].includes(record.importance as number) ||
    !isNullableString(record.sourceMessageId) ||
    !isNullableTimestamp(record.sourceOccurredAt) ||
    !isNullableTimestamp(record.validFrom) ||
    !isNullableTimestamp(record.validUntil) ||
    !isNullableTimestamp(record.expiresAt) ||
    typeof record.pinned !== "boolean" ||
    !isNullableString(record.supersedesId) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt)
  ) return null;

  return { ...record, reviewState: (record.reviewState ?? "eligible") as MemoryReviewState, ownerReviewedAt: (record.ownerReviewedAt ?? null) as string | null } as MemoryRecord;
}

export function upgradeMemory(legacy: LegacyMemory): MemoryRecord {
  return {
    id: legacy.id,
    kind: legacy.kind === "ongoing" ? "routine" : legacy.kind,
    scope: "shared",
    content: legacy.content,
    normalizedContent: normalizeMemory(legacy.content),
    status: "active",
    origin: "explicit",
    sensitivity: "normal",
    reviewState: "eligible",
    ownerReviewedAt: null,
    importance: legacy.importance,
    sourceMessageId: null,
    sourceOccurredAt: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    pinned: true,
    supersedesId: null,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  };
}

export function normalizeMemory(text: string): string {
  return text.normalize("NFKC").replace(/[、。]/g, "").replace(/\s+/g, "").trim();
}

function tombstoneCanonical(text: string): string {
  return normalizeMemory(text)
    .replace(/昼ご飯|お昼ご飯|ランチ/gu, "昼食")
    .replace(/食べて(?:き|い)た|食べました|食べてる/gu, "食べた");
}

function characterShingles(text: string, size = 2): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index <= text.length - size; index += 1) result.add(text.slice(index, index + size));
  return result;
}

function diceSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

export function isMemoryTombstoneMatch(candidate: string, fingerprint: string): boolean {
  const left = tombstoneCanonical(candidate);
  const right = tombstoneCanonical(fingerprint);
  if (left === right) return true;
  const split = (value: string) => value.split(/(?:って|とは|から|まで|より|は|が|を|に|で|と|の)/u).filter((part) => part.length >= 2).sort();
  const leftParts = split(left);
  const rightParts = split(right);
  if (leftParts.length >= 2 && leftParts.length === rightParts.length && leftParts.every((part, index) => part === rightParts[index])) return true;
  return Math.min(left.length, right.length) >= 6
    && Math.abs(left.length - right.length) <= Math.ceil(Math.max(left.length, right.length) * 0.35)
    && diceSimilarity(characterShingles(left), characterShingles(right)) >= 0.72;
}

const allowedTransitions: Record<MemoryStatus, ReadonlySet<MemoryStatus>> = {
  active: new Set(["active", "past", "uncertain", "expired"]),
  past: new Set(["past", "expired"]),
  uncertain: new Set(["active", "past", "uncertain", "expired"]),
  expired: new Set(["expired"]),
};

export function canTransition(from: MemoryStatus, to: MemoryStatus): boolean {
  return allowedTransitions[from].has(to);
}

export function isMemoryAvailable(record: MemoryRecord, now = new Date()): boolean {
  if (record.status !== "active") return false;
  const nowMs = now.getTime();
  if (record.validFrom && new Date(record.validFrom).getTime() > nowMs) return false;
  if (record.validUntil && new Date(record.validUntil).getTime() < nowMs) return false;
  return !record.expiresAt || new Date(record.expiresAt).getTime() > nowMs;
}

export function effectiveMemoryStatus(record: MemoryRecord, now = new Date()): MemoryStatus {
  if (record.status !== "active") return record.status;
  return record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime() ? "expired" : "active";
}
