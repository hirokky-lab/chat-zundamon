import { describe, expect, it } from "vitest";
import {
  canTransition,
  effectiveMemoryStatus,
  isMemoryAvailable,
  normalizeMemory,
  parseMemoryRecord,
  upgradeMemory,
  type MemoryRecord,
} from "../src/memory";

describe("memory normalization", () => {
  it("normalizes spacing and punctuation for duplicate checks", () => {
    expect(normalizeMemory(" 会議が、不安。 ")).toBe("会議が不安");
  });
});

describe("versioned memories", () => {
  const legacy = {
    id: "legacy-memory",
    kind: "shared" as const,
    content: "ブラックコーヒーが好き",
    importance: 4 as const,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
  const record: MemoryRecord = {
    id: "10000000-0000-4000-8000-000000000001",
    kind: "preference",
    scope: "shared",
    content: "ブラックコーヒーが好き",
    normalizedContent: "ブラックコーヒーが好き",
    status: "active",
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
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };

  it("upgrades a legacy memory without losing its identity or text", () => {
    expect(upgradeMemory(legacy)).toMatchObject({
      id: legacy.id,
      content: legacy.content,
      scope: "shared",
      status: "active",
      origin: "explicit",
      sensitivity: "normal",
      pinned: true,
      sourceMessageId: null,
    });
  });

  it("accepts expired current records and rejects deleted states", () => {
    expect(parseMemoryRecord({ ...record, status: "expired" })?.status).toBe("expired");
    expect(parseMemoryRecord({ ...record, status: "deleted" })).toBeNull();
  });

  it("allows active memories to become past or uncertain without reviving expired memories", () => {
    expect(canTransition("active", "past")).toBe(true);
    expect(canTransition("active", "uncertain")).toBe(true);
    expect(canTransition("expired", "active")).toBe(false);
  });

  it("keeps expired records unavailable even when their original expiry is in the future", () => {
    expect(isMemoryAvailable({ ...record, status: "expired", expiresAt: "2030-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("derives expired status when an active record has passed its expiry", () => {
    const now = new Date("2026-08-12T00:00:00.000Z");
    expect(effectiveMemoryStatus({ ...record, expiresAt: "2026-08-11T23:59:59.999Z" }, now)).toBe("expired");
    expect(effectiveMemoryStatus({ ...record, expiresAt: "2026-08-12T00:00:00.001Z" }, now)).toBe("active");
    expect(effectiveMemoryStatus({ ...record, status: "past", expiresAt: "2026-08-11T23:59:59.999Z" }, now)).toBe("past");
  });
});
