import { Readable } from "node:stream";
import { createClient } from "@supabase/supabase-js";

export type CanonicalTimestamp = `${string}Z`;
export type PhotoStorage = {
  put(path: string, bytes: Uint8Array): Promise<void>;
  open(path: string): Promise<{ body: Readable; byteSize: number; contentType: "image/jpeg" }>;
  exists(path: string): Promise<boolean>;
  list(input: { ownerPrefix: `${string}/`; cursor?: string; limit: number }): Promise<{ items: Array<{ path: string; createdAt: CanonicalTimestamp }>; nextCursor: string | null }>;
  remove(path: string): Promise<void>;
};

export type PhotoStorageBackend = {
  put(path: string, bytes: Uint8Array, options: { contentType: "image/jpeg"; upsert: false }): Promise<void>;
  open(path: string): Promise<{ bytes: Uint8Array; contentType: unknown }>;
  exists(path: string): Promise<boolean>;
  list(input: { ownerPrefix: `${string}/`; cursor?: string; limit: number }): Promise<{ items: Array<{ path: string; createdAt: string }>; nextCursor: string | null }>;
  remove(path: string): Promise<void>;
};

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const pathPattern = new RegExp(`^${uuidV4}/${uuidV4}\\.jpg$`, "i");
const prefixPattern = new RegExp(`^${uuidV4}/$`, "i");
const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validTimestamp(value: string): value is CanonicalTimestamp {
  if (!canonicalTimestamp.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function assertPath(path: string): void { if (!pathPattern.test(path)) throw new Error("invalid_photo_storage_path"); }

export function createPhotoStorageAdapter(backend: PhotoStorageBackend): PhotoStorage {
  return {
    async put(path, bytes) { assertPath(path); await backend.put(path, bytes, { contentType: "image/jpeg", upsert: false }); },
    async open(path) {
      assertPath(path); const result = await backend.open(path);
      if (result.contentType !== "image/jpeg" || result.bytes.byteLength < 1 || result.bytes.byteLength > 5 * 1024 * 1024) throw new Error("invalid_photo_storage_response");
      return { body: Readable.from(Buffer.from(result.bytes)), byteSize: result.bytes.byteLength, contentType: "image/jpeg" };
    },
    async exists(path) { assertPath(path); return backend.exists(path); },
    async remove(path) { assertPath(path); await backend.remove(path); },
    async list(input) {
      if (!prefixPattern.test(input.ownerPrefix) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50
        || (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length === 0))) throw new Error("invalid_photo_storage_list");
      const result = await backend.list(input);
      const seen = new Set<string>();
      for (const item of result.items) {
        if (!item.path.startsWith(input.ownerPrefix) || !pathPattern.test(item.path) || !validTimestamp(item.createdAt) || seen.has(item.path)) {
          throw new Error("invalid_photo_storage_response");
        }
        seen.add(item.path);
      }
      if (result.items.length > input.limit || (result.nextCursor !== null && (typeof result.nextCursor !== "string" || result.nextCursor.length === 0))) {
        throw new Error("invalid_photo_storage_response");
      }
      return result as { items: Array<{ path: string; createdAt: CanonicalTimestamp }>; nextCursor: string | null };
    },
  };
}

/** Server-only adapter for the one private photo bucket. */
export function createSupabasePhotoStorage(url: string, serviceRoleKey: string): PhotoStorage {
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const bucket = client.storage.from("yui-photo");
  return createPhotoStorageAdapter({
    async put(path, bytes, options) {
      const result = await bucket.upload(path, bytes, options);
      if (result.error) throw new Error("photo_storage_unavailable");
    },
    async open(path) {
      const result = await bucket.download(path);
      if (result.error || !result.data) throw new Error("photo_storage_unavailable");
      return { bytes: new Uint8Array(await result.data.arrayBuffer()), contentType: result.data.type };
    },
    async exists(path) {
      const slash = path.lastIndexOf("/");
      const result = await bucket.list(path.slice(0, slash), { limit: 1, search: path.slice(slash + 1) });
      if (result.error || !result.data) throw new Error("photo_storage_unavailable");
      return result.data.some((entry: { name: string }) => entry.name === path.slice(slash + 1));
    },
    async list(input) {
      if (input.cursor) throw new Error("photo_storage_unavailable");
      const result = await bucket.list(input.ownerPrefix.slice(0, -1), { limit: input.limit });
      if (result.error || !result.data) throw new Error("photo_storage_unavailable");
      return {
        items: result.data.map((entry: { name: string; created_at: string | null }) => ({ path: `${input.ownerPrefix}${entry.name}`, createdAt: entry.created_at ?? "" })),
        nextCursor: null,
      };
    },
    async remove(path) {
      const result = await bucket.remove([path]);
      if (result.error) throw new Error("photo_storage_unavailable");
    },
  });
}
