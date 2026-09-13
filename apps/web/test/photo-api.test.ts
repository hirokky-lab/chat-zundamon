import { afterEach, describe, expect, it, vi } from "vitest";
import { createPhotoApi } from "../src/api";

const photoId = "11111111-1111-4111-8111-111111111111";
const snapshot = {
  timeline: [],
  lastOpeningAt: null,
  lastConversationAt: null,
  version: 3 as const,
  revision: 0,
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("photo commit deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("preserves a successful commit before the deadline", async () => {
    vi.useFakeTimers();
    const committedSnapshot = { ...snapshot, revision: 1, updatedAt: "2026-08-24T00:00:01.000Z" };
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!init?.signal) throw new Error("missing_commit_deadline");
      return Response.json({ snapshot: committedSnapshot });
    });
    const api = createPhotoApi(fetch, { commitTimeoutMs: 20 });

    await expect(api.commit({ photoId, expectedRevision: 0, snapshot }))
      .resolves.toEqual(committedSnapshot);
    await vi.advanceTimersByTimeAsync(20);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("returns the photo to retryable state before the protected Preview function limit", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!init?.signal) throw new Error("missing_commit_deadline");
      return await new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const api = createPhotoApi(fetch, { commitTimeoutMs: 20 });

    const committed = expect(api.commit({ photoId, expectedRevision: 0, snapshot }))
      .rejects.toThrow("photo_unavailable");
    await vi.advanceTimersByTimeAsync(20);
    await committed;

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
