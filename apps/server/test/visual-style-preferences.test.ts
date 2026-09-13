import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { createMemoryVisualStylePreferenceRepository, createSupabaseVisualStylePreferenceRepository } from "../src/visual-style-preferences";

const noMemoryExtractor = { extract: async () => ({ candidates: [] }) };
const owner = { userId: "owner-a", email: "owner@example.invalid", accessToken: "local" };

describe("visual style preferences", () => {
  it("keeps the owner preference separate and increments only on explicit saves", async () => {
    const app = buildApp({
      extractor: noMemoryExtractor,
      visualStylePreferenceRepository: createMemoryVisualStylePreferenceRepository(() => new Date("2026-08-26T00:00:00.000Z")),
    });

    expect((await app.inject({ method: "GET", url: "/api/visual-style-preference" })).json()).toEqual({ preference: null });
    const saved = await app.inject({ method: "PUT", url: "/api/visual-style-preference", payload: { style: "minimal", expectedRevision: 0 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ preference: { style: "minimal", revision: 1, updatedAt: "2026-08-26T00:00:00.000Z" } });
    expect((await app.inject({ method: "PUT", url: "/api/visual-style-preference", payload: { style: "unknown", expectedRevision: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/visual-style-preference", payload: { style: "minimal", expectedRevision: null } })).statusCode).toBe(400);
  });

  it("accepts only one exact Supabase RPC row", async () => {
    const rpc = async () => ({ data: [{ style: "minimal", revision: 1, updated_at: "2026-08-26T00:00:00.000Z" }], error: null });
    const repository = createSupabaseVisualStylePreferenceRepository(() => ({ rpc, from: () => { throw new Error("not used"); } }));

    await expect(repository.save(owner, "minimal", 0))
      .resolves.toEqual({ style: "minimal", revision: 1, updatedAt: "2026-08-26T00:00:00.000Z" });
  });

  it("maps an empty owner GET to no preference and normalizes a PostgreSQL timestamp", async () => {
    const responses = [
      { data: [], error: null },
      { data: [{ style: "minimal", revision: 1, updated_at: "2026-08-26T00:00:00.123456+00:00" }], error: null },
    ];
    const repository = createSupabaseVisualStylePreferenceRepository(() => ({
      rpc: async () => responses.shift()!,
      from: () => { throw new Error("not used"); },
    }));

    await expect(repository.get(owner)).resolves.toBeNull();
    await expect(repository.save(owner, "minimal", 0)).resolves.toEqual({
      style: "minimal", revision: 1, updatedAt: "2026-08-26T00:00:00.123Z",
    });
  });

  it.each([
    [[{ style: "minimal", revision: 1, updated_at: "2026-08-26T00:00:00.000Z" }, { style: "yui", revision: 2, updated_at: "2026-08-26T00:00:01.000Z" }]],
    [[{ style: "minimal", revision: 1, updated_at: "invalid" }]],
    [[{ style: "minimal", revision: 1, updated_at: "2026-08-26T00:00:00.000Z", owner_id: "owner-a" }]],
  ])("rejects malformed or non-single Supabase RPC rows", async (data) => {
    const repository = createSupabaseVisualStylePreferenceRepository(() => ({
      rpc: async () => ({ data, error: null }),
      from: () => { throw new Error("not used"); },
    }));

    await expect(repository.save(owner, "minimal", 0)).rejects.toThrow("visual_style_preference_unavailable");
  });

  it("uses expected revision to reject a stale write without changing the owner preference", async () => {
    const repository = createMemoryVisualStylePreferenceRepository(() => new Date("2026-08-26T00:00:00.000Z"));

    await expect(repository.save(owner, "minimal", 0)).resolves.toMatchObject({ style: "minimal", revision: 1 });
    await expect(repository.save(owner, "yui", 0)).resolves.toMatchObject({ style: "minimal", revision: 1 });
    await expect(repository.get({ ...owner, userId: "owner-b" })).resolves.toBeNull();
  });

  it("returns a content-free 503 when the owner preference GET is unavailable", async () => {
    const app = buildApp({
      extractor: noMemoryExtractor,
      visualStylePreferenceRepository: {
        get: async () => { throw new Error("private upstream detail"); },
        save: async () => { throw new Error("not used"); },
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/visual-style-preference" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "visual_style_preference_unavailable" });
    expect(response.body).not.toContain("private upstream detail");
  });
});
