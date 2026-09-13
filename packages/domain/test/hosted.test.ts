import { describe, expect, it } from "vitest";
import type { LegacyMemory } from "../src/memory";
import type { Profile } from "../src/profile";
import {
  parseMigrationBundle,
  parseRemoteChatSnapshot,
} from "../src/hosted";

const timestamp = "2026-08-10T00:00:00.000Z";

const profile: Profile = {
  displayName: "大輝",
  addressingStyle: "san",
  updatedAt: timestamp,
};

const memory: LegacyMemory = {
  id: "memory-1",
  kind: "shared",
  content: "ユイと初めて電話した",
  importance: 4,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const remoteSnapshot = {
  timeline: [],
  lastOpeningAt: null,
  lastConversationAt: null,
  version: 2,
  revision: 0,
  updatedAt: timestamp,
} as const;

const photo = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "photo",
  role: "user",
  photoId: "22222222-2222-4222-8222-222222222222",
  caption: "これ見て",
  origin: "photo",
  createdAt: timestamp,
  delivery: "sent",
} as const;

describe("remote chat snapshot", () => {
  it("parses only the cloud-safe versioned fields", () => {
    expect(parseRemoteChatSnapshot(remoteSnapshot)).toEqual(remoteSnapshot);
    expect(parseRemoteChatSnapshot({ ...remoteSnapshot, draft: "端末だけの下書き" })).toBeNull();
    expect(parseRemoteChatSnapshot({ ...remoteSnapshot, pendingDisplayName: "途中の名前" })).toBeNull();
    expect(parseRemoteChatSnapshot({ ...remoteSnapshot, futureField: true })).toBeNull();
  });

  it("upgrades a version 1 snapshot while discarding daily review state", () => {
    const legacy = {
      ...remoteSnapshot,
      version: 1,
      reviewedLocalDates: ["2026-08-09"],
    } as const;

    expect(parseRemoteChatSnapshot(legacy)).toEqual(remoteSnapshot);
  });

  it("round-trips v3 photo lineage without downcasting", () => {
    const assistant = {
      id: "photo-reply:0",
      type: "message",
      role: "assistant",
      text: "夕焼けがきれいだね",
      createdAt: timestamp,
      delivery: "sent",
      replyGroupId: "photo-reply",
      sequence: 0,
      origin: "photo_analysis",
      sourcePhotoMessageId: photo.id,
    } as const;
    const snapshot = { ...remoteSnapshot, version: 3, timeline: [photo, assistant] } as const;

    expect(parseRemoteChatSnapshot(snapshot)).toEqual(snapshot);
    expect(parseRemoteChatSnapshot({ ...remoteSnapshot, timeline: [photo] })).toBeNull();
  });

  it("rejects noncanonical dates and negative revisions", () => {
    expect(parseRemoteChatSnapshot({ ...remoteSnapshot, updatedAt: "2026-08-10T00:00:00Z" })).toBeNull();
    expect(parseRemoteChatSnapshot({ ...remoteSnapshot, revision: -1 })).toBeNull();
    expect(parseRemoteChatSnapshot({
      ...remoteSnapshot,
      version: 1,
      reviewedLocalDates: ["August 9, 2026"],
    })).toBeNull();
  });

  it("rejects duplicate timeline IDs and unknown nested fields", () => {
    const message = {
      id: "message-1",
      type: "message",
      role: "user",
      text: "ただいま",
      createdAt: timestamp,
      delivery: "sent",
    } as const;

    expect(parseRemoteChatSnapshot({
      ...remoteSnapshot,
      timeline: [message, { ...message, text: "重複" }],
    })).toBeNull();
    expect(parseRemoteChatSnapshot({
      ...remoteSnapshot,
      timeline: [{ ...message, transcript: "保存禁止" }],
    })).toBeNull();
  });

  it("rejects duplicate v3 IDs and unknown v3 top-level or nested fields", () => {
    const snapshot = { ...remoteSnapshot, version: 3, timeline: [photo] } as const;

    expect(parseRemoteChatSnapshot({ ...snapshot, timeline: [photo, { ...photo, photoId: "33333333-3333-4333-8333-333333333333" }] })).toBeNull();
    expect(parseRemoteChatSnapshot({ ...snapshot, futureField: true })).toBeNull();
    expect(parseRemoteChatSnapshot({ ...snapshot, timeline: [{ ...photo, width: 100 }] })).toBeNull();
  });

  it("accepts 20,000 timeline items and rejects 20,001", () => {
    const timeline = Array.from({ length: 20_001 }, (_, index) => ({
      id: `call-${index}`,
      type: "call" as const,
      startedAt: timestamp,
      endedAt: timestamp,
    }));

    expect(parseRemoteChatSnapshot({ ...remoteSnapshot, timeline: timeline.slice(0, 20_000) })?.timeline)
      .toHaveLength(20_000);
    expect(parseRemoteChatSnapshot({ ...remoteSnapshot, timeline })).toBeNull();

    const v3 = { ...remoteSnapshot, version: 3 } as const;
    expect(parseRemoteChatSnapshot({ ...v3, timeline: timeline.slice(0, 20_000) })?.timeline)
      .toHaveLength(20_000);
    expect(parseRemoteChatSnapshot({ ...v3, timeline })).toBeNull();
  });
});

describe("migration bundle", () => {
  it("parses exactly one profile and confirmed memories", () => {
    expect(parseMigrationBundle({ version: 1, profile, memories: [memory] })).toEqual({
      version: 1,
      profile,
      memories: [memory],
    });
  });

  it("rejects chat history, profile-flow history, and any unknown field", () => {
    const profileFlowMessage = {
      id: "profile-greeting:0",
      type: "message",
      role: "assistant",
      text: "はじめまして",
      createdAt: timestamp,
      delivery: "sent",
      flow: "profile",
    };

    expect(parseMigrationBundle({ version: 1, profile, memories: [memory], timeline: [] })).toBeNull();
    expect(parseMigrationBundle({ version: 1, profile, memories: [memory], timeline: [profileFlowMessage] })).toBeNull();
    expect(parseMigrationBundle({ version: 1, profile: { ...profile, extra: true }, memories: [memory] })).toBeNull();
    expect(parseMigrationBundle({ version: 1, profile, memories: [{ ...memory, extra: true }] })).toBeNull();
  });

  it("rejects malformed memories and more than 500 memories", () => {
    expect(parseMigrationBundle({
      version: 1,
      profile,
      memories: [{ ...memory, updatedAt: "2026-08-10T00:00:00Z" }],
    })).toBeNull();
    expect(parseMigrationBundle({
      version: 1,
      profile,
      memories: Array.from({ length: 501 }, (_, index) => ({ ...memory, id: `memory-${index}` })),
    })).toBeNull();
  });
});
