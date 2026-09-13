import { afterEach, describe, expect, it, vi } from "vitest";
import { createPhotoContentLoader } from "../src/photo-content";

const photoId = "22222222-2222-4222-8222-222222222222";

describe("protected photo content", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const objectUrls = () => {
    const createObjectURL = vi.fn(() => "blob:protected");
    const revokeObjectURL = vi.fn();
    class TestURL extends globalThis.URL {}
    Object.assign(TestURL, { createObjectURL, revokeObjectURL });
    vi.stubGlobal("URL", TestURL);
    return { createObjectURL, revokeObjectURL };
  };

  it("uses the authorized no-store fetch and revokes its Object URL exactly once", async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
    const authorizedFetch = vi.fn(async () => new Response(blob, { headers: { "Content-Type": "image/jpeg", "Content-Length": "4" } }));
    const { revokeObjectURL: revoke } = objectUrls();
    const signal = new AbortController().signal;
    const handle = await createPhotoContentLoader(authorizedFetch).load(photoId, signal);
    expect(authorizedFetch).toHaveBeenCalledWith(`/api/photos/${photoId}/content`, { cache: "no-store", signal });
    expect(handle.objectUrl).toBe("blob:protected");
    handle.dispose(); handle.dispose();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it.each([
    [new Response("", { status: 401 }), "photo_auth_expired"],
    [new Response(new Blob(["bad"], { type: "text/plain" }), { headers: { "Content-Type": "text/plain" } }), "invalid_photo_content"],
    [new Response(new Uint8Array(), { headers: { "Content-Type": "image/jpeg" } }), "invalid_photo_content"],
  ])("rejects unauthorized or invalid content without creating a URL", async (response, expected) => {
    const { createObjectURL: create } = objectUrls();
    await expect(createPhotoContentLoader(async () => response).load(photoId, new AbortController().signal)).rejects.toThrow(expected);
    expect(create).not.toHaveBeenCalled();
  });

  it("revokes an undisposed loaded URL after thirty seconds", async () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = objectUrls();
    const response = new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "Content-Type": "image/jpeg" } });
    await createPhotoContentLoader(async () => response).load(photoId, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("propagates cancellation without creating an Object URL", async () => {
    const { createObjectURL } = objectUrls();
    const controller = new AbortController();
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const loading = createPhotoContentLoader(fetch).load(photoId, controller.signal);
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
