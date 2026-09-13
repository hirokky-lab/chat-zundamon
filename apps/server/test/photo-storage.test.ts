import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createPhotoStorageAdapter } from "../src/photo-storage.js";

const owner = "11111111-1111-4111-8111-111111111111";
const photo = "22222222-2222-4222-8222-222222222222";

function backend() {
  return {
    put: vi.fn(async () => undefined), open: vi.fn(async () => ({ bytes: Buffer.from([1, 2]), contentType: "image/jpeg" })),
    exists: vi.fn(async () => true), remove: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ items: [{ path: `${owner}/${photo}.jpg`, createdAt: "2026-08-13T00:00:00.000Z" }], nextCursor: null })),
  };
}

describe("photo storage adapter", () => {
  it("uses one private canonical object and returns a Readable", async () => {
    const raw = backend(); const storage = createPhotoStorageAdapter(raw);
    await storage.put(`${owner}/${photo}.jpg`, Buffer.from([1]));
    const opened = await storage.open(`${owner}/${photo}.jpg`);
    expect(opened).toMatchObject({ byteSize: 2, contentType: "image/jpeg" });
    expect(opened.body).toBeInstanceOf(Readable);
    expect(raw.put).toHaveBeenCalledWith(`${owner}/${photo}.jpg`, expect.any(Uint8Array), { contentType: "image/jpeg", upsert: false });
  });

  it.each(["", `${owner}`, `../${photo}.jpg`, `${owner}/x.jpg`])("rejects invalid object path %s before provider", async (path) => {
    const raw = backend(); const storage = createPhotoStorageAdapter(raw);
    await expect(storage.put(path, Buffer.from([1]))).rejects.toThrow("invalid_photo_storage_path");
    expect(raw.put).not.toHaveBeenCalled();
  });

  it.each([["", 1], [`${owner}`, 1], [`${owner}/`, 0], [`${owner}/`, 51]])("rejects invalid list boundary", async (prefix, limit) => {
    const raw = backend(); const storage = createPhotoStorageAdapter(raw);
    await expect(storage.list({ ownerPrefix: prefix as `${string}/`, cursor: "opaque", limit })).rejects.toThrow("invalid_photo_storage_list");
    expect(raw.list).not.toHaveBeenCalled();
  });

  it("forwards opaque cursor and rejects foreign or noncanonical rows", async () => {
    const raw = backend(); const storage = createPhotoStorageAdapter(raw);
    await storage.list({ ownerPrefix: `${owner}/`, cursor: "opaque", limit: 50 });
    expect(raw.list).toHaveBeenCalledWith({ ownerPrefix: `${owner}/`, cursor: "opaque", limit: 50 });
    raw.list.mockResolvedValueOnce({ items: [{ path: `33333333-3333-4333-8333-333333333333/${photo}.jpg`, createdAt: "2026-08-13T00:00:00.000Z" }], nextCursor: null });
    await expect(storage.list({ ownerPrefix: `${owner}/`, limit: 1 })).rejects.toThrow("invalid_photo_storage_response");
    raw.list.mockResolvedValueOnce({ items: [{ path: `${owner}/${photo}.jpg`, createdAt: "2026-08-13T00:00:00Z" }], nextCursor: null });
    await expect(storage.list({ ownerPrefix: `${owner}/`, limit: 1 })).rejects.toThrow("invalid_photo_storage_response");
  });

  it("accepts two bounded terminal pages without cross-page duplicates", async () => {
    const raw = backend();
    raw.list
      .mockResolvedValueOnce({ items: [{ path: `${owner}/${photo}.jpg`, createdAt: "2026-08-13T00:00:00.000Z" }], nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [{ path: `${owner}/33333333-3333-4333-8333-333333333333.jpg`, createdAt: "2026-08-13T00:00:01.000Z" }], nextCursor: null });
    const storage = createPhotoStorageAdapter(raw);
    const first = await storage.list({ ownerPrefix: `${owner}/`, limit: 1 });
    const second = await storage.list({ ownerPrefix: `${owner}/`, cursor: first.nextCursor!, limit: 1 });
    expect(new Set([...first.items, ...second.items].map((item) => item.path)).size).toBe(2);
    expect(second.nextCursor).toBeNull();
  });
});
