import { describe, expect, it, vi } from "vitest";
import { AuthoritativeMemoryTurnSource } from "../src/memory-turn-source.js";
import { LOCAL_USER } from "../src/request-user.js";

const at = "2026-08-13T00:00:00.000Z";
const laterAt = "2026-08-13T00:00:04.000Z";
const photoId = "22222222-2222-4222-8222-222222222222";
const laterId = "33333333-3333-4333-8333-333333333333";

function snapshot() {
  return {
    version: 3 as const, revision: 1, updatedAt: laterAt, lastOpeningAt: null, lastConversationAt: laterAt,
    timeline: [
      { id: "normal-1", type: "message" as const, role: "user" as const, text: "写真とは無関係な通常テキスト", createdAt: at, delivery: "sent" as const },
      { id: "normal-1:assistant:0", type: "message" as const, role: "assistant" as const, text: "通常の返事", createdAt: "2026-08-13T00:00:01.000Z", delivery: "sent" as const, replyGroupId: "normal-1:assistant", sequence: 0 as const },
      { id: photoId, type: "photo" as const, role: "user" as const, photoId, caption: "写真captionまたは解析", origin: "photo" as const, createdAt: "2026-08-13T00:00:02.000Z", delivery: "sent" as const },
      { id: `${photoId}:assistant:0`, type: "message" as const, role: "assistant" as const, text: "写真captionまたは解析", createdAt: "2026-08-13T00:00:03.000Z", delivery: "sent" as const, replyGroupId: `${photoId}:assistant`, sequence: 0 as const, origin: "photo_analysis" as const, sourcePhotoMessageId: photoId },
      { id: laterId, type: "message" as const, role: "user" as const, text: "後続の本人テキスト", createdAt: laterAt, delivery: "sent" as const },
      { id: `${laterId}:assistant:0`, type: "message" as const, role: "assistant" as const, text: "後続の返事", createdAt: "2026-08-13T00:00:05.000Z", delivery: "sent" as const, replyGroupId: `${laterId}:assistant`, sequence: 0 as const },
      { id: "too-late", type: "message" as const, role: "user" as const, text: "さらに後の本文", createdAt: "2026-08-13T00:00:06.000Z", delivery: "sent" as const },
    ],
  };
}

describe("AuthoritativeMemoryTurnSource", () => {
  it("rebuilds a later text source without photo lineage and stops at its completed reply", async () => {
    const repository = { get: vi.fn(async () => snapshot()) };
    const source = new AuthoritativeMemoryTurnSource(repository);
    const turns = await source.load(LOCAL_USER, { sourceMessageId: laterId, sourceOccurredAt: laterAt });
    expect(turns).toContainEqual({ role: "user", provenance: "authoritative_source", text: "後続の本人テキスト" });
    expect(turns).toContainEqual({ role: "user", provenance: "context", text: "写真とは無関係な通常テキスト" });
    expect(JSON.stringify(turns)).not.toContain("写真captionまたは解析");
    expect(JSON.stringify(turns)).not.toContain("さらに後の本文");
  });

  it.each([
    ["not_found", "missing", laterAt],
    ["not_eligible", laterId, "2026-08-13T00:00:04.001Z"],
    ["not_eligible", photoId, "2026-08-13T00:00:02.000Z"],
  ] as const)("returns %s for invalid authoritative identity", async (expected, sourceMessageId, sourceOccurredAt) => {
    const source = new AuthoritativeMemoryTurnSource({ get: async () => snapshot() });
    await expect(source.load(LOCAL_USER, { sourceMessageId, sourceOccurredAt })).resolves.toBe(expected);
  });

  it.each([
    ["non-user source", (value: ReturnType<typeof snapshot>) => { value.timeline[4] = { ...value.timeline[5]!, id: laterId }; }],
    ["sending source", (value: ReturnType<typeof snapshot>) => { value.timeline[4] = { ...value.timeline[4]!, delivery: "sending" }; }],
    ["failed source", (value: ReturnType<typeof snapshot>) => { value.timeline[4] = { ...value.timeline[4]!, delivery: "failed" }; }],
    ["incomplete reply", (value: ReturnType<typeof snapshot>) => { value.timeline[5] = { ...value.timeline[5]!, delivery: "failed" }; }],
  ] as const)("rejects %s without reconstructing client text", async (_name, mutate) => {
    const value = snapshot(); mutate(value);
    const source = new AuthoritativeMemoryTurnSource({ get: async () => value });
    await expect(source.load(LOCAL_USER, { sourceMessageId: laterId, sourceOccurredAt: laterAt })).resolves.toBe("not_eligible");
  });

  it.each(["calendar-1", "remember-1"])("never reconstructs external context or its immediate referential memory request: %s", async (sourceMessageId) => {
    const value = snapshot();
    value.timeline = [
      { id: "calendar-1", type: "message", role: "user", text: "今日の予定を教えて", createdAt: at, delivery: "sent" },
      { id: "calendar-1:assistant:0", type: "message", role: "assistant", text: "RAW_EXTERNAL_SENTINEL", createdAt: "2026-08-13T00:00:01.000Z", delivery: "sent", flow: "external_context", replyGroupId: "calendar-1:assistant", sequence: 0 },
      { id: "remember-1", type: "message", role: "user", text: "それを覚えておいて", createdAt: laterAt, delivery: "sent" },
      { id: "remember-1:assistant:0", type: "message", role: "assistant", text: "わかったよ", createdAt: "2026-08-13T00:00:05.000Z", delivery: "sent", replyGroupId: "remember-1:assistant", sequence: 0 },
    ];
    const source = new AuthoritativeMemoryTurnSource({ get: async () => value });
    const occurredAt = sourceMessageId === "calendar-1" ? at : laterAt;
    await expect(source.load(LOCAL_USER, { sourceMessageId, sourceOccurredAt: occurredAt })).resolves.toBe("not_eligible");
  });
});
