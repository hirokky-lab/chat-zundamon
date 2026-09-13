import { describe, expect, it, vi } from "vitest";
import {
  ALL_EXTERNAL_TOOLS_OFF,
  createExternalToolBoundary,
  type ExternalToolTelemetryEvent,
} from "../src/external-tools";
import type { CostGuard } from "../src/cost-guard";
import { LOCAL_USER } from "../src/request-user";

const context = {
  conversationId: "primary",
  channel: "chat" as const,
  personaId: "yui" as const,
  memoryScope: "shared" as const,
};

const maximumUsdByArea = {
  search: 0.1,
  calendar: 0.1,
  notification: 0.1,
  image: 0.1,
  work: 0.1,
  avatar: 0.1,
  storage: 0.1,
};

function costGuard(reserve = vi.fn<CostGuard["reserve"]>(async ({ requestId }) => ({
  requestId,
  settle: async () => undefined,
  hold: async () => undefined,
}))): CostGuard {
  return { reserve };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    user: LOCAL_USER,
    requestId: "tool-request-1",
    attempt: 1,
    feature: "web_search" as const,
    operation: "read" as const,
    context,
    input: { query: "本文に残してはいけない検索語" },
    timeoutMs: 100,
    execute: vi.fn(async () => ({ value: { answer: "外部本文" }, actualUsd: 0.02, quotaUnits: 1 })),
    ...overrides,
  };
}

describe("external tool boundary", () => {
  it("keeps every external feature OFF and performs no work, telemetry, or reservation", async () => {
    const reserve = vi.fn<CostGuard["reserve"]>();
    const record = vi.fn();
    const execute = vi.fn();
    const boundary = createExternalToolBoundary({
      flags: ALL_EXTERNAL_TOOLS_OFF,
      costGuard: costGuard(reserve),
      maximumUsdByArea,
      telemetry: { record },
    });

    expect(boundary.flags()).toEqual({
      web_search: false,
      youtube_search: false,
      calendar_read: false,
      tasks_read: false,
      one_time_reminder: false,
      photo_analysis: false,
      avatar: false,
    });
    await expect(boundary.run(request({ execute }))).resolves.toEqual({ status: "disabled" });
    expect(execute).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("passes one conversation, YUI persona, and shared-memory context through an enabled read", async () => {
    const execute = vi.fn(async () => ({ value: { ok: true }, actualUsd: 0, quotaUnits: 0 }));
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      costGuard: costGuard(),
      maximumUsdByArea,
    });

    await expect(boundary.run(request({
      feature: "calendar_read",
      input: { date: "2026-08-13" },
      execute,
    }))).resolves.toEqual({ status: "success", value: { ok: true } });
    expect(execute).toHaveBeenCalledWith({
      input: { date: "2026-08-13" },
      context,
      signal: expect.any(AbortSignal),
    });
  });

  it("uses a narrower per-request cost reservation only when it is within the configured area ceiling", async () => {
    const reserve = vi.fn<CostGuard["reserve"]>(async ({ requestId }) => ({
      requestId, settle: async () => undefined, hold: async () => undefined,
    }));
    const execute = vi.fn(async () => ({ value: { ok: true }, actualUsd: 0, quotaUnits: 1 }));
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      costGuard: costGuard(reserve), maximumUsdByArea,
    });

    await expect(boundary.run(request({ feature: "calendar_read", maximumUsd: 0.01, execute }))).resolves.toMatchObject({ status: "success" });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ feature: "calendar", maximumUsd: 0.01 }));

    reserve.mockClear();
    await expect(boundary.run(request({ feature: "calendar_read", maximumUsd: 0.11, execute }))).resolves.toEqual({ status: "failure" });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("fails closed before reservation or execution for a runtime-forged context channel", async () => {
    const reserve = vi.fn<CostGuard["reserve"]>();
    const execute = vi.fn(async () => ({ value: { ok: true }, actualUsd: 0, quotaUnits: 0 }));
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, web_search: true },
      costGuard: costGuard(reserve),
      maximumUsdByArea,
    });

    await expect(boundary.run(request({
      context: { ...context, channel: "forged" },
      execute,
    }) as never)).resolves.toEqual({ status: "failure" });
    expect(reserve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("routes external changes to just-in-time confirmation and never trusts a client token by itself", async () => {
    const execute = vi.fn(async () => ({ value: { created: true }, actualUsd: 0, quotaUnits: 1 }));
    const verify = vi.fn(async () => false);
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, one_time_reminder: true },
      costGuard: costGuard(),
      maximumUsdByArea,
      confirmationVerifier: { verify },
    });

    const mutation = request({
      feature: "one_time_reminder",
      operation: "external_change",
      confirmationToken: "opaque-confirmation",
      execute,
    });
    await expect(boundary.run(mutation)).resolves.toEqual({ status: "confirmation_required" });
    expect(verify).toHaveBeenCalledWith({
      user: LOCAL_USER,
      requestId: "tool-request-1",
      feature: "one_time_reminder",
      token: "opaque-confirmation",
    });
    expect(execute).not.toHaveBeenCalled();

    verify.mockResolvedValueOnce(true);
    await expect(boundary.run(mutation)).resolves.toMatchObject({ status: "success" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed when confirmation verification is unavailable", async () => {
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, one_time_reminder: true },
      costGuard: costGuard(),
      maximumUsdByArea,
      confirmationVerifier: { verify: () => new Promise(() => undefined) },
    });

    const result = await Promise.race([
      boundary.run(request({
        feature: "one_time_reminder",
        operation: "external_change",
        confirmationToken: "opaque-confirmation",
        timeoutMs: 5,
      })),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(result).toEqual({ status: "confirmation_required" });
  });

  it("fails closed when confirmation verification throws synchronously", async () => {
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, one_time_reminder: true },
      costGuard: costGuard(),
      maximumUsdByArea,
      confirmationVerifier: { verify: () => { throw new Error("private verifier error"); } },
    });

    await expect(boundary.run(request({
      feature: "one_time_reminder",
      operation: "external_change",
      confirmationToken: "opaque-confirmation",
    }))).resolves.toEqual({ status: "confirmation_required" });
  });

  it("records only classified numeric metadata and hashes cost identities", async () => {
    const events: ExternalToolTelemetryEvent[] = [];
    const reserve = vi.fn<CostGuard["reserve"]>(async ({ requestId }) => ({
      requestId,
      settle: async () => undefined,
      hold: async () => undefined,
    }));
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, web_search: true },
      costGuard: costGuard(reserve),
      maximumUsdByArea,
      telemetry: { record: (event) => events.push(event) },
      now: (() => {
        const values = [new Date("2026-08-13T00:00:00.000Z"), new Date("2026-08-13T00:00:00.250Z")];
        return () => values.shift() ?? new Date("2026-08-13T00:00:00.250Z");
      })(),
    });

    await boundary.run(request());

    expect(reserve).toHaveBeenCalledWith({
      user: LOCAL_USER,
      requestId: expect.stringMatching(/^external:search:sha256:[a-f0-9]{64}:1$/),
      feature: "search",
      maximumUsd: 0.1,
    });
    expect(events).toEqual([{
      featureArea: "external_tool",
      feature: "web_search",
      costArea: "search",
      idempotencyKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      outcome: "success",
      attempt: 1,
      retry: false,
      latencyMs: 250,
      charged: true,
      actualUsd: 0.02,
      quotaUnits: 1,
    }]);
    expect(JSON.stringify(events)).not.toContain("検索語");
    expect(JSON.stringify(events)).not.toContain("外部本文");
    expect(JSON.stringify(events)).not.toContain("tool-request-1");
    expect(JSON.stringify(events)).not.toContain(LOCAL_USER.userId);
  });

  it("separates photo analysis from save communication cost and rejects unrelated relabeling", async () => {
    const reserve = vi.fn<CostGuard["reserve"]>(async ({ requestId }) => ({
      requestId,
      settle: async () => undefined,
      hold: async () => undefined,
    }));
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, photo_analysis: true, web_search: true },
      costGuard: costGuard(reserve),
      maximumUsdByArea,
    });

    await expect(boundary.run(request({
      feature: "photo_analysis",
      costArea: "storage",
    }))).resolves.toMatchObject({ status: "success" });
    expect(reserve).toHaveBeenLastCalledWith(expect.objectContaining({ feature: "storage" }));

    reserve.mockClear();
    await expect(boundary.run(request({
      feature: "web_search",
      costArea: "storage",
    }))).resolves.toEqual({ status: "failure" });
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["failure", new Error("secret upstream body"), undefined],
    ["cancel", new DOMException("aborted", "AbortError"), "cancel"],
  ] as const)("turns %s into a non-throwing result without logging error content", async (expected, error, abortMode) => {
    const events: ExternalToolTelemetryEvent[] = [];
    const controller = new AbortController();
    if (abortMode) controller.abort();
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, web_search: true },
      costGuard: costGuard(),
      maximumUsdByArea,
      telemetry: { record: (event) => events.push(event) },
    });

    const result = await boundary.run(request({
      feature: "web_search",
      signal: controller.signal,
      execute: async () => { throw error; },
    }));
    expect(result).toEqual({ status: expected === "cancel" ? "cancelled" : "failure" });
    expect(events.at(-1)?.outcome).toBe(expected);
    expect(JSON.stringify(events)).not.toContain("secret upstream body");
  });

  it("keeps failure neutral when conservative cost holding also fails", async () => {
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, web_search: true },
      costGuard: costGuard(async ({ requestId }) => ({
        requestId,
        settle: async () => undefined,
        hold: () => { throw new Error("private cost backend error"); },
      })),
      maximumUsdByArea,
    });

    await expect(boundary.run(request({
      feature: "web_search",
      execute: async () => { throw new Error("private tool error"); },
    }))).resolves.toEqual({ status: "failure" });
  });

  it("times out without blocking the caller", async () => {
    const events: ExternalToolTelemetryEvent[] = [];
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, photo_analysis: true },
      costGuard: costGuard(),
      maximumUsdByArea,
      telemetry: { record: (event) => events.push(event) },
    });

    const result = await boundary.run(request({
      feature: "photo_analysis",
      timeoutMs: 5,
      execute: async ({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
      }),
    }));
    expect(result).toEqual({ status: "timeout" });
    expect(events.at(-1)?.outcome).toBe("timeout");
  });

  it("does not let unavailable cost accounting block the caller", async () => {
    const reserve = vi.fn<CostGuard["reserve"]>(() => new Promise(() => undefined));
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, web_search: true },
      costGuard: costGuard(reserve),
      maximumUsdByArea,
    });

    const result = await Promise.race([
      boundary.run(request({ timeoutMs: 5 })),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(result).toEqual({ status: "timeout" });
  });

  it("does not let unavailable cost settlement block the caller", async () => {
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, web_search: true },
      costGuard: costGuard(async ({ requestId }) => ({
        requestId,
        settle: () => new Promise(() => undefined),
        hold: async () => undefined,
      })),
      maximumUsdByArea,
    });

    const result = await Promise.race([
      boundary.run(request({ timeoutMs: 5 })),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(result).toEqual({ status: "timeout" });
  });

  it("keeps a successful execution successful after settlement completes even if the deadline fires immediately after", async () => {
    let completeSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { completeSettlement = resolve; });
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, web_search: true },
      costGuard: costGuard(async ({ requestId }) => ({
        requestId,
        settle: () => settlement,
        hold: async () => undefined,
      })),
      maximumUsdByArea,
    });
    const resultPromise = boundary.run(request({ timeoutMs: 20 }));
    setTimeout(completeSettlement, 15);

    await expect(resultPromise).resolves.toMatchObject({ status: "success" });
  });

  it("does not let unavailable conservative holding block a failed tool", async () => {
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, web_search: true },
      costGuard: costGuard(async ({ requestId }) => ({
        requestId,
        settle: async () => undefined,
        hold: () => new Promise(() => undefined),
      })),
      maximumUsdByArea,
    });

    const result = await Promise.race([
      boundary.run(request({
        timeoutMs: 5,
        execute: async () => { throw new Error("private upstream failure"); },
      })),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(result).toEqual({ status: "failure" });
  });

  it("never waits for optional telemetry before returning the tool result", async () => {
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, web_search: true },
      costGuard: costGuard(),
      maximumUsdByArea,
      telemetry: { record: () => new Promise(() => undefined) },
    });

    const result = await Promise.race([
      boundary.run(request()),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(result).toMatchObject({ status: "success" });
  });

  it("uses one cost identity for a duplicate attempt and a separate identity for a real retry", async () => {
    const ids: string[] = [];
    const reserve = vi.fn<CostGuard["reserve"]>(async ({ requestId }) => {
      ids.push(requestId);
      return { requestId, settle: async () => undefined, hold: async () => undefined };
    });
    const events: ExternalToolTelemetryEvent[] = [];
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, youtube_search: true },
      costGuard: costGuard(reserve),
      maximumUsdByArea,
      telemetry: { record: (event) => events.push(event) },
    });

    await boundary.run(request({ feature: "youtube_search", attempt: 1 }));
    await boundary.run(request({ feature: "youtube_search", attempt: 1 }));
    await boundary.run(request({ feature: "youtube_search", attempt: 2 }));

    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(events.map((event) => event.retry)).toEqual([false, false, true]);
  });
});
