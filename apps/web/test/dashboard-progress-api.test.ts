import { describe, expect, it, vi } from "vitest";
import { createDashboardProgressApi } from "../src/api";

const payload = {
  connection: "available",
  updates: [{
    project: "yui",
    requestId: "YUI-DASHBOARD-PROJECTION-20260823-001",
    shortTitle: "進捗の安全な参照を追加する",
    status: "working",
    currentPhase: "autonomous_execution",
    needsOwnerAction: false,
    updatedAt: "2026-08-23T00:00:00.000Z",
    nextSafeAction: "作業を継続する",
  }],
};

describe("dashboard progress API", () => {
  it("fails closed and aborts when the same-origin projection exceeds the client deadline", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      });
      const pending = createDashboardProgressApi(fetch, { timeoutMs: 25 }).get();
      let settled = false;
      void pending.finally(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(25);

      expect(requestSignal?.aborted).toBe(true);
      expect(settled).toBe(true);
      await expect(pending).resolves.toEqual({ connection: "unavailable", updates: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the fixed YUI endpoint and accepts only the minimal projection", async () => {
    const fetch = vi.fn(async () => Response.json(payload));

    await expect(createDashboardProgressApi(fetch).get()).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledWith("/api/dashboard/progress", { signal: expect.any(AbortSignal) });
  });

  it.each([
    { ...payload, updates: [{ ...payload.updates[0], prompt: "do not expose" }] },
    { ...payload, updates: [{ ...payload.updates[0], status: "unknown" }] },
    { ...payload, updates: [{ ...payload.updates[0], project: "novel" }] },
    { ...payload, updates: [{ ...payload.updates[0], status: "completed" }] },
    { ...payload, updates: [{ ...payload.updates[0], nextSafeAction: "ログを読む" }] },
    { ...payload, updates: [{ ...payload.updates[0], shortTitle: "/Users/owner/private/report" }] },
    { ...payload, updates: [{ ...payload.updates[0], shortTitle: "docs/internal/report" }] },
    { ...payload, updates: [{ ...payload.updates[0], shortTitle: "C:\\Users\\owner\\private" }] },
    { ...payload, updates: [{ ...payload.updates[0], shortTitle: "https://internal.example/report" }] },
    { connection: "unconnected", updates: payload.updates },
  ])("fails closed for a malformed or contradictory server response", async (invalid) => {
    await expect(createDashboardProgressApi(async () => Response.json(invalid)).get())
      .resolves.toEqual({ connection: "unavailable", updates: [] });
  });
});
