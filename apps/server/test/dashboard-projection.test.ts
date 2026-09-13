import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import {
  DashboardProjectionService,
  createOwnerLocalDashboardProjectionGateway,
  type DashboardProjectionGateway,
} from "../src/dashboard-projection";

const validItem = {
  project: "yui",
  requestId: "YUI-DASHBOARD-PROJECTION-20260823-001",
  shortTitle: "進捗の安全な参照を追加する",
  status: "working",
  currentPhase: "autonomous_execution",
  needsOwnerAction: false,
  updatedAt: "2026-08-23T00:00:00.000Z",
  nextSafeAction: "作業を継続する",
};

function gateway(result: Awaited<ReturnType<DashboardProjectionGateway["get"]>>): DashboardProjectionGateway {
  return { get: vi.fn(async () => result) };
}

function envelope(records: unknown, generation = 2) {
  return { schemaVersion: "codex-work-dashboard.yui-projection.v1", generation, generatedAt: "2026-08-23T00:00:00.000Z", records };
}

const now = () => new Date("2026-08-23T00:05:00.000Z");

describe("dashboard projection", () => {
  it("remains unconnected without an injected owner-local gateway", async () => {
    const service = new DashboardProjectionService();

    await expect(service.load()).resolves.toEqual({ connection: "unconnected", updates: [] });
  });

  it("accepts only the fixed allowlist record fields from an authenticated current generation", async () => {
    const source = gateway({ kind: "success", body: envelope([validItem]) });
    const service = new DashboardProjectionService({ gateway: source, now });

    await expect(service.load()).resolves.toEqual({ connection: "available", updates: [validItem] });
    expect(source.get).toHaveBeenCalledOnce();
  });

  it("times out a stalled owner-local projection instead of delaying the YUI route", async () => {
    const source: DashboardProjectionGateway = {
      get: (signal) => new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve({ kind: "unavailable" }), { once: true });
      }),
    };
    const service = new DashboardProjectionService({ gateway: source, timeoutMs: 1, now });

    await expect(service.load()).resolves.toEqual({ connection: "unavailable", updates: [] });
  });

  it.each([
    ["unknown record field", { ...validItem, rawReport: "never render this" }],
    ["path-like title", { ...validItem, shortTitle: "/Users/owner/private/report" }],
    ["relative path-like title", { ...validItem, shortTitle: "docs/internal/report" }],
    ["Windows path-like title", { ...validItem, shortTitle: "C:\\Users\\owner\\private" }],
    ["URL-like title", { ...validItem, shortTitle: "https://internal.example/report" }],
    ["unknown status", { ...validItem, status: "running_elsewhere" }],
    ["malformed timestamp", { ...validItem, updatedAt: "yesterday" }],
  ])("fails closed for %s", async (_label, record) => {
    const service = new DashboardProjectionService({ gateway: gateway({ kind: "success", body: envelope([record]) }), now });

    await expect(service.load()).resolves.toEqual({ connection: "unavailable", updates: [] });
  });

  it("fails closed for an old generation, authentication mismatch, or fetch failure", async () => {
    const source = gateway({ kind: "success", body: envelope([validItem], 3) });
    const service = new DashboardProjectionService({ gateway: source, now });
    await expect(service.load()).resolves.toMatchObject({ connection: "available" });

    vi.mocked(source.get).mockResolvedValueOnce({ kind: "success", body: envelope([validItem], 2) });
    await expect(service.load()).resolves.toEqual({ connection: "unavailable", updates: [] });

    const mismatch = new DashboardProjectionService({ gateway: gateway({ kind: "authentication_mismatch" }), now });
    await expect(mismatch.load()).resolves.toEqual({ connection: "unavailable", updates: [] });

    const failure = new DashboardProjectionService({ gateway: { get: async () => { throw new Error("network details must not escape"); } }, now });
    await expect(failure.load()).resolves.toEqual({ connection: "unavailable", updates: [] });
  });

  it("serves a private no-store GET projection and never exposes a gateway failure", async () => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      dashboardProjectionGateway: gateway({ kind: "success", body: envelope([validItem], 1) }),
      now,
    });

    const response = await app.inject({ method: "GET", url: "/api/dashboard/progress" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ connection: "available", updates: [validItem] });
  });

  it("uses the one fixed owner-local GET and rejects unknown envelope fields, stale payloads, and status-phase mismatches", async () => {
    const fetch = vi.fn(async () => Response.json({ ...envelope([validItem]), unexpected: true }));
    const service = new DashboardProjectionService({
      gateway: createOwnerLocalDashboardProjectionGateway({ token: "a".repeat(32), fetchImpl: fetch }),
      minimumGeneration: 2,
      now,
    });
    await expect(service.load()).resolves.toEqual({ connection: "unavailable", updates: [] });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4310/api/projection/yui/v1", expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error" }));

    const redirected = new DashboardProjectionService({
      gateway: createOwnerLocalDashboardProjectionGateway({ token: "a".repeat(32), fetchImpl: async () => new Response(null, { status: 302 }) }), now,
    });
    await expect(redirected.load()).resolves.toEqual({ connection: "unavailable", updates: [] });

    const old = new DashboardProjectionService({ gateway: gateway({ kind: "success", body: envelope([validItem], 1) }), minimumGeneration: 2, now });
    await expect(old.load()).resolves.toEqual({ connection: "unavailable", updates: [] });
    const mismatched = new DashboardProjectionService({ gateway: gateway({ kind: "success", body: envelope([{ ...validItem, status: "completed" }]) }), now });
    await expect(mismatched.load()).resolves.toEqual({ connection: "unavailable", updates: [] });
    const stale = new DashboardProjectionService({ gateway: gateway({ kind: "success", body: { ...envelope([validItem]), generatedAt: "2026-08-22T23:49:59.000Z" } }), now });
    await expect(stale.load()).resolves.toEqual({ connection: "unavailable", updates: [] });
    const tooMany = new DashboardProjectionService({ gateway: gateway({ kind: "success", body: envelope(Array.from({ length: 25 }, () => validItem)) }), now });
    await expect(tooMany.load()).resolves.toEqual({ connection: "unavailable", updates: [] });
  });
});
