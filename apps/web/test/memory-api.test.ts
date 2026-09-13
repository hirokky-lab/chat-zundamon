import { describe, expect, it, vi } from "vitest";
import type { Memory } from "@yui/domain";
import { createMemoryApi } from "../src/api";

const candidate = {
  kind: "event",
  content: "金曜に会議",
  importance: 3,
};

const memory: Memory = {
  ...candidate,
  id: "8e0adba9-aa7e-4bbd-88d5-3d0fc22f620b",
  scope: "shared",
  normalizedContent: "金曜に会議",
  status: "active",
  origin: "explicit",
  sensitivity: "normal",
  reviewState: "eligible",
  ownerReviewedAt: null,
  sourceMessageId: "message-1",
  sourceOccurredAt: "2026-08-08T03:00:00.000Z",
  validFrom: null,
  validUntil: null,
  expiresAt: null,
  pinned: true,
  supersedesId: null,
  createdAt: "2026-08-08T03:00:00.000Z",
  updatedAt: "2026-08-08T03:00:00.000Z",
};

describe("memory API", () => {
  it("posts automatic processing input and validates its receipt", async () => {
    const fetch = vi.fn(async () => Response.json({ sourceMessageId: "message-1", state: "completed", appliedCount: 1 }, { status: 202 }));
    const api = createMemoryApi(fetch);
    const signal = new AbortController().signal;

    await expect(api.process({
      sourceMessageId: "message-1",
      sourceOccurredAt: "2026-08-11T00:00:00.000Z",
    }, signal)).resolves.toEqual({ sourceMessageId: "message-1", state: "completed", appliedCount: 1 });
    expect(fetch).toHaveBeenCalledWith("/api/memory/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        sourceMessageId: "message-1",
        sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      }),
    });
  });

  it("lists memories without exposing the removed confirmation endpoints", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ memories: [memory] }));
    const api = createMemoryApi(fetch);

    await expect(api.list()).resolves.toEqual([memory]);
    expect(fetch).toHaveBeenCalledWith("/api/memories");
    expect(api).not.toHaveProperty("candidates");
    expect(api).not.toHaveProperty("confirm");
  });

  it("updates, forgets, and releases a tombstone with strict paths and bodies", async () => {
    const edited = { ...memory, content: "最近はカフェラテが好き", normalizedContent: "最近はカフェラテが好き", pinned: false };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ memory: edited }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createMemoryApi(fetch);

    await expect(api.update(memory.id, { content: edited.content, pinned: false })).resolves.toEqual(edited);
    await expect(api.forget(memory.id, true)).resolves.toBeUndefined();
    await expect(api.releaseTombstone("00000000-0000-4000-8000-000000000010")).resolves.toBeUndefined();

    expect(fetch).toHaveBeenNthCalledWith(1, `/api/memories/${memory.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: edited.content, pinned: false }),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, `/api/memories/${memory.id}/forget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockRelearning: true }),
    });
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/memory-tombstones/00000000-0000-4000-8000-000000000010/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });

  it("uses the owner-only keep endpoint and validates the returned record", async () => {
    const reviewed = { ...memory, reviewState: "eligible" as const, ownerReviewedAt: "2026-08-20T00:00:00.000Z" };
    const fetch = vi.fn(async () => Response.json({ memory: reviewed }));
    const api = createMemoryApi(fetch);

    await expect(api.keep(memory.id)).resolves.toEqual(reviewed);
    expect(fetch).toHaveBeenCalledWith(`/api/memories/${memory.id}/keep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });

  it("lists safe tombstone metadata and persists one memory setting", async () => {
    const settings = { memoryEnabled: true, updatedAt: "2026-08-11T00:00:00.000Z" };
    const tombstone = { id: "00000000-0000-4000-8000-000000000010", memoryId: memory.id, createdAt: "2026-08-11T00:00:00.000Z" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ tombstones: [tombstone] }))
      .mockResolvedValueOnce(Response.json({ settings }))
      .mockResolvedValueOnce(Response.json({ settings: { ...settings, memoryEnabled: false } }));
    const api = createMemoryApi(fetch);

    await expect(api.listTombstones()).resolves.toEqual([tombstone]);
    await expect(api.getSettings()).resolves.toEqual(settings);
    await expect(api.updateSettings({ memoryEnabled: false })).resolves.toEqual({ ...settings, memoryEnabled: false });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/memory-tombstones");
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/memory-settings");
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/memory-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memoryEnabled: false }),
    });
  });

  it("rejects malformed successful memory payloads and neutralizes failed responses", async () => {
    const malformed = createMemoryApi(async () => Response.json({ memory: { ...memory, status: "deleted" } }));
    await expect(malformed.update(memory.id, { pinned: true })).rejects.toThrow("Yui response was invalid");

    const secret = "パスワードは hunter2";
    const failed = createMemoryApi(async () => Response.json({ error: secret }, { status: 503 }));
    await expect(failed.update(memory.id, { content: secret })).rejects.toMatchObject({ name: "YuiRequestError", status: 503 });
    await expect(failed.forget(memory.id, true)).rejects.toMatchObject({ name: "YuiRequestError", status: 503 });
  });
});
