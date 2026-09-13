import {
  isCanonicalTimestamp,
  parseTimelineItem,
  type LocalChatSnapshot,
  type TimelineItem,
} from "./chat.js";
import type { LegacyMemory, LegacyMemoryKind } from "./memory.js";
import { parseProfile, type Profile } from "./profile.js";

export const REMOTE_TIMELINE_LIMIT = 20_000;
export const MIGRATION_MEMORY_LIMIT = 500;

export type RemoteChatSnapshot = Omit<LocalChatSnapshot, "draft" | "pendingDisplayName"> & {
  version: 2 | 3;
  revision: number;
  updatedAt: string;
};

export type MigrationBundle = {
  version: 1;
  profile: Profile;
  memories: LegacyMemory[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isLegacyCanonicalLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]);
}

export function parseRemoteChatSnapshot(value: unknown): RemoteChatSnapshot | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) return null;
  const expectedKeys = value.version === 1
    ? ["timeline", "lastOpeningAt", "lastConversationAt", "reviewedLocalDates", "version", "revision", "updatedAt"]
    : ["timeline", "lastOpeningAt", "lastConversationAt", "version", "revision", "updatedAt"];
  if (
    !hasExactKeys(value, expectedKeys) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isCanonicalTimestamp(value.updatedAt) ||
    (value.lastOpeningAt !== null && !isCanonicalTimestamp(value.lastOpeningAt)) ||
    (value.lastConversationAt !== null && !isCanonicalTimestamp(value.lastConversationAt)) ||
    (value.version === 1 && (!Array.isArray(value.reviewedLocalDates) || !value.reviewedLocalDates.every(isLegacyCanonicalLocalDate))) ||
    !Array.isArray(value.timeline) ||
    value.timeline.length > REMOTE_TIMELINE_LIMIT
  ) {
    return null;
  }

  const ids = new Set<string>();
  const timeline: TimelineItem[] = [];
  for (const item of value.timeline) {
    const parsed = parseTimelineItem(item, { strict: true, snapshotVersion: value.version });
    if (!parsed || ids.has(parsed.id)) return null;
    ids.add(parsed.id);
    timeline.push(parsed);
  }

  return {
    timeline,
    lastOpeningAt: value.lastOpeningAt,
    lastConversationAt: value.lastConversationAt,
    version: value.version === 1 ? 2 : value.version,
    revision: value.revision as number,
    updatedAt: value.updatedAt,
  };
}

const memoryKinds = new Set<LegacyMemoryKind>(["preference", "event", "ongoing", "shared"]);
const japaneseCharacter = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

function parseMemory(value: unknown): LegacyMemory | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "kind", "content", "importance", "createdAt", "updatedAt"]) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.kind !== "string" ||
    !memoryKinds.has(value.kind as LegacyMemoryKind) ||
    typeof value.content !== "string" ||
    value.content.length < 1 ||
    value.content.length > 40 ||
    !japaneseCharacter.test(value.content) ||
    (value.importance !== 1 &&
      value.importance !== 2 &&
      value.importance !== 3 &&
      value.importance !== 4 &&
      value.importance !== 5) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt)
  ) {
    return null;
  }

  return {
    id: value.id,
    kind: value.kind as LegacyMemoryKind,
    content: value.content,
    importance: value.importance,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseMigrationBundle(value: unknown): MigrationBundle | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "profile", "memories"]) ||
    value.version !== 1 ||
    !isRecord(value.profile) ||
    !hasExactKeys(value.profile, ["displayName", "addressingStyle", "updatedAt"]) ||
    !Array.isArray(value.memories) ||
    value.memories.length > MIGRATION_MEMORY_LIMIT
  ) {
    return null;
  }

  const profile = parseProfile(value.profile);
  if (!profile) return null;
  const memories: LegacyMemory[] = [];
  const ids = new Set<string>();
  for (const item of value.memories) {
    const parsed = parseMemory(item);
    if (!parsed || ids.has(parsed.id)) return null;
    ids.add(parsed.id);
    memories.push(parsed);
  }

  return { version: 1, profile, memories };
}
