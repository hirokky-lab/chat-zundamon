import { describe, expect, it, vi } from "vitest";
import { createVisualStylePreferenceApi } from "../src/api";

describe("visual style preference API", () => {
  it("uses only the fixed same-origin endpoint and fails closed", async () => {
    const fetch = vi.fn(async () => Response.json({ preference: { style: "minimal", revision: 1, updatedAt: "2026-08-26T00:00:00.000Z" } }));
    const api = createVisualStylePreferenceApi(fetch);

    await expect(api.get()).resolves.toEqual({ style: "minimal", revision: 1, updatedAt: "2026-08-26T00:00:00.000Z" });
    expect(fetch).toHaveBeenCalledWith("/api/visual-style-preference", {});
    await expect(createVisualStylePreferenceApi(async () => Response.json({ preference: { style: "unknown", revision: 1, updatedAt: "2026-08-26T00:00:00.000Z" } })).get()).resolves.toBeNull();
  });

  it("sends the exact style and expected revision with an abort signal", async () => {
    const fetch = vi.fn(async () => Response.json({ preference: { style: "minimal", revision: 4, updatedAt: "2026-08-26T00:00:00.000Z" } }));
    const api = createVisualStylePreferenceApi(fetch);
    const controller = new AbortController();

    await expect(api.save("minimal", 3, controller.signal)).resolves.toMatchObject({ style: "minimal", revision: 4 });
    expect(fetch).toHaveBeenCalledWith("/api/visual-style-preference", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style: "minimal", expectedRevision: 3 }),
      signal: controller.signal,
    });
  });
});
