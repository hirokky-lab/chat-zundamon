import type { PhotoReceipt } from "./photo.js";

export type PhotoRequestState = "claimed" | "uploading" | "uploaded" | "analyzing" | "succeeded" | "failed" | "ambiguous" | "blocked";
export type PhotoAnalysisState = "not_dispatched" | "dispatched" | "succeeded" | "failed" | "ambiguous" | "scrubbed";
export type PhotoRequestRecord = {
  ownerId: string; clientMessageId: string; photoId: string; requestState: PhotoRequestState; analysisState: PhotoAnalysisState;
  deletionState: string | null; receipt: PhotoReceipt | null; usage: unknown; leaseOwner: string | null; leaseExpiresAt: string | null;
};
export type PhotoCleanupRecord = { id: string; ownerId: string; photoId: string; storagePath: string; state: "requested" | "deleting" | "deleted" | "verified" };

export type PhotoRepository = {
  claim(input: { ownerId: string; clientMessageId: string; captionDigest: string; jpegDigest: string; leaseOwner: string }): Promise<PhotoRequestRecord>;
  beginUpload(input: { ownerId: string; clientMessageId: string; leaseOwner: string }): Promise<PhotoRequestRecord>;
  completeUpload(input: { ownerId: string; clientMessageId: string; leaseOwner: string; storagePath: string; byteSize: number }): Promise<PhotoRequestRecord>;
  claimAnalysis(input: { ownerId: string; clientMessageId: string; leaseOwner: string }): Promise<PhotoRequestRecord>;
  complete(input: { ownerId: string; clientMessageId: string; leaseOwner: string; receipt: PhotoReceipt; usage: unknown }): Promise<PhotoRequestRecord>;
  fail(input: { ownerId: string; clientMessageId: string; leaseOwner: string; ambiguous: boolean }): Promise<PhotoRequestRecord>;
  getActive(input: { ownerId: string; photoId: string }): Promise<{ photoId: string; storagePath: string; byteSize: number } | null>;
  claimCleanup(input: { leaseOwner: string; limit: number; leaseMs: number }): Promise<PhotoCleanupRecord[]>;
  markVerified(input: { id: string; leaseOwner: string; objectAbsent: boolean }): Promise<PhotoCleanupRecord>;
  getStorageScanCursor(input: { ownerId: string }): Promise<string | null>;
  saveStorageScanCursor(input: { ownerId: string; cursor: string | null }): Promise<void>;
  registerOrphan(input: { ownerId: string; photoId: string; storagePath: string }): Promise<boolean>;
};

type RpcClient = { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
const states = new Set<PhotoRequestState>(["claimed", "uploading", "uploaded", "analyzing", "succeeded", "failed", "ambiguous", "blocked"]);
const analysisStates = new Set<PhotoAnalysisState>(["not_dispatched", "dispatched", "succeeded", "failed", "ambiguous", "scrubbed"]);

function parseRow(value: unknown): PhotoRequestRecord {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row.owner_id !== "string" || typeof row.client_message_id !== "string" || typeof row.photo_id !== "string"
    || !states.has(row.request_state as PhotoRequestState) || !analysisStates.has(row.analysis_state as PhotoAnalysisState)
    || (row.lease_owner !== null && typeof row.lease_owner !== "string") || (row.lease_expires_at !== null && typeof row.lease_expires_at !== "string")) {
    throw new Error("photo_repository_unavailable");
  }
  return {
    ownerId: row.owner_id, clientMessageId: row.client_message_id, photoId: row.photo_id,
    requestState: row.request_state as PhotoRequestState, analysisState: row.analysis_state as PhotoAnalysisState,
    deletionState: typeof row.deletion_state === "string" ? row.deletion_state : null,
    receipt: row.receipt as PhotoReceipt | null, usage: row.usage,
    leaseOwner: row.lease_owner as string | null, leaseExpiresAt: row.lease_expires_at as string | null,
  };
}

export function createSupabasePhotoRepository(client: RpcClient): PhotoRepository {
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.rpc(name, args);
    if (result.error) {
      const message = typeof result.error === "object" && result.error !== null && "message" in result.error ? String(result.error.message) : "";
      if (message === "photo digest mismatch") throw new Error("photo_request_conflict");
      throw new Error("photo_repository_unavailable");
    }
    return parseRow(result.data);
  };
  return {
    claim: (i) => call("claim_photo_request", { p_owner_id: i.ownerId, p_client_message_id: i.clientMessageId, p_caption_digest: i.captionDigest, p_jpeg_digest: i.jpegDigest, p_lease_owner: i.leaseOwner }),
    beginUpload: (i) => call("begin_photo_upload", { p_owner_id: i.ownerId, p_client_message_id: i.clientMessageId, p_lease_owner: i.leaseOwner }),
    completeUpload: (i) => call("complete_photo_upload", { p_owner_id: i.ownerId, p_client_message_id: i.clientMessageId, p_lease_owner: i.leaseOwner, p_storage_path: i.storagePath, p_byte_size: i.byteSize }),
    claimAnalysis: (i) => call("claim_photo_analysis", { p_owner_id: i.ownerId, p_client_message_id: i.clientMessageId, p_lease_owner: i.leaseOwner }),
    complete: (i) => call("complete_photo_analysis", { p_owner_id: i.ownerId, p_client_message_id: i.clientMessageId, p_lease_owner: i.leaseOwner, p_receipt: i.receipt, p_usage: i.usage }),
    fail: (i) => call("fail_photo_request", { p_owner_id: i.ownerId, p_client_message_id: i.clientMessageId, p_lease_owner: i.leaseOwner, p_ambiguous: i.ambiguous }),
    async getActive(i) {
      const result = await client.rpc("get_active_photo", { p_owner_id: i.ownerId, p_photo_id: i.photoId });
      if (result.error) throw new Error("photo_repository_unavailable");
      if (result.data === null) return null;
      const row = result.data as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.storage_path !== "string" || typeof row.byte_size !== "number") throw new Error("photo_repository_unavailable");
      return { photoId: row.id, storagePath: row.storage_path, byteSize: row.byte_size };
    },
    async claimCleanup(i) {
      const result = await client.rpc("claim_photo_cleanup_batch", { p_lease_owner: i.leaseOwner, p_limit: i.limit, p_lease_ms: i.leaseMs });
      if (result.error || !Array.isArray(result.data)) throw new Error("photo_repository_unavailable");
      return result.data.map(parseCleanup);
    },
    async markVerified(i) {
      const result = await client.rpc("complete_photo_delete", { p_id: i.id, p_lease_owner: i.leaseOwner, p_object_absent: i.objectAbsent });
      if (result.error) throw new Error("photo_repository_unavailable");
      return parseCleanup(result.data);
    },
    async getStorageScanCursor(i) {
      const result = await client.rpc("get_photo_scan_cursor", { p_owner_id: i.ownerId });
      if (result.error || (result.data !== null && typeof result.data !== "string")) throw new Error("photo_repository_unavailable");
      return result.data as string | null;
    },
    async saveStorageScanCursor(i) {
      const result = await client.rpc("save_photo_scan_cursor", { p_owner_id: i.ownerId, p_cursor: i.cursor });
      if (result.error) throw new Error("photo_repository_unavailable");
    },
    async registerOrphan(i) {
      const result = await client.rpc("register_orphan_photo", { p_owner_id: i.ownerId, p_photo_id: i.photoId, p_storage_path: i.storagePath });
      if (result.error || typeof result.data !== "boolean") throw new Error("photo_repository_unavailable");
      return result.data;
    },
  };
}

function parseCleanup(value: unknown): PhotoCleanupRecord {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row.id !== "string" || typeof row.owner_id !== "string" || typeof row.photo_id !== "string" || typeof row.storage_path !== "string"
    || !["requested", "deleting", "deleted", "verified"].includes(String(row.state))) throw new Error("photo_repository_unavailable");
  return { id: row.id, ownerId: row.owner_id, photoId: row.photo_id, storagePath: row.storage_path, state: row.state as PhotoCleanupRecord["state"] };
}
