import { describe, expect, it, vi } from "vitest";
import { createSupabasePhotoRepository } from "../src/photo-repository.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const clientMessageId = "22222222-2222-4222-8222-222222222222";
const photoId = "33333333-3333-4333-8333-333333333333";
const row = {
  owner_id: ownerId, client_message_id: clientMessageId, photo_id: photoId,
  request_state: "claimed", analysis_state: "not_dispatched", deletion_state: null,
  receipt: null, usage: null, lease_owner: "worker", lease_expires_at: "2026-08-13T00:02:00.000Z",
};

describe("Supabase photo repository", () => {
  it("maps the strict Task 2 claim RPC without persisting raw caption", async () => {
    const rpc = vi.fn(async () => ({ data: row, error: null }));
    const repository = createSupabasePhotoRepository({ rpc });
    await expect(repository.claim({ ownerId, clientMessageId, captionDigest: "a".repeat(64), jpegDigest: "b".repeat(64), leaseOwner: "worker" }))
      .resolves.toMatchObject({ ownerId, clientMessageId, photoId, requestState: "claimed", analysisState: "not_dispatched" });
    expect(rpc).toHaveBeenCalledWith("claim_photo_request", {
      p_owner_id: ownerId, p_client_message_id: clientMessageId, p_caption_digest: "a".repeat(64), p_jpeg_digest: "b".repeat(64), p_lease_owner: "worker",
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("raw caption");
  });

  it("sends the authoritative receipt unchanged to completion RPC", async () => {
    const receipt = { photo: { id: clientMessageId, createdAt: "2026-08-13T00:00:00.000Z", delivery: "sent" }, replyGroupId: `${clientMessageId}:assistant`, bubbles: [{ id: `${clientMessageId}:assistant:0`, text: "見えたよ", createdAt: "2026-08-13T00:00:00.000Z", sequence: 0, delivery: "sent", origin: "photo_analysis", sourcePhotoMessageId: clientMessageId }] };
    const rpc = vi.fn(async () => ({ data: { ...row, request_state: "succeeded", analysis_state: "succeeded", receipt, lease_owner: null, lease_expires_at: null }, error: null }));
    const repository = createSupabasePhotoRepository({ rpc });
    await repository.complete({ ownerId, clientMessageId, leaseOwner: "worker", receipt, usage: { inputTokens: 1 } });
    expect(rpc).toHaveBeenCalledWith("complete_photo_analysis", { p_owner_id: ownerId, p_client_message_id: clientMessageId, p_lease_owner: "worker", p_receipt: receipt, p_usage: { inputTokens: 1 } });
  });

  it("redacts database errors", async () => {
    const repository = createSupabasePhotoRepository({ rpc: async () => ({ data: null, error: new Error("secret SQL body") }) });
    await expect(repository.beginUpload({ ownerId, clientMessageId, leaseOwner: "worker" })).rejects.toThrow("photo_repository_unavailable");
  });

  it("maps only the exact digest mismatch to a safe conflict", async () => {
    const repository = createSupabasePhotoRepository({ rpc: async () => ({ data: null, error: { message: "photo digest mismatch", details: "secret digest" } }) });
    await expect(repository.claim({ ownerId, clientMessageId, captionDigest: "a".repeat(64), jpegDigest: "b".repeat(64), leaseOwner: "worker" })).rejects.toThrow("photo_request_conflict");
  });

  it("reads an active owner-scoped asset through its dedicated RPC", async () => {
    const rpc = vi.fn(async () => ({ data: { id: photoId, storage_path: `${ownerId}/${photoId}.jpg`, byte_size: 123 }, error: null }));
    await expect(createSupabasePhotoRepository({ rpc }).getActive({ ownerId, photoId })).resolves.toEqual({ photoId, storagePath: `${ownerId}/${photoId}.jpg`, byteSize: 123 });
    expect(rpc).toHaveBeenCalledWith("get_active_photo", { p_owner_id: ownerId, p_photo_id: photoId });
  });
});
