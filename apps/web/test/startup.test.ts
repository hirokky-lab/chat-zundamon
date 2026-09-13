import { describe, expect, it, vi } from "vitest";
import { resolveYuiStartup } from "../src/startup";

describe("YUI hosted startup", () => {
  it("starts hosted mode from the protected same-origin runtime configuration", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "publishable",
      photoAnalysisEnabled: false,
      prismEchoEnabled: false,
      integratedUiEnabled: true,
    }));

    await expect(resolveYuiStartup({ VITE_ZUNDAMON_API_BASE_URL: "/" }, fetchImpl)).resolves.toEqual({
      mode: "hosted",
      config: {
        supabaseUrl: "https://project.supabase.co",
        supabasePublishableKey: "publishable",
        apiBaseUrl: "",
        photoAnalysisEnabled: false,
        prismEchoEnabled: false,
        integratedUiEnabled: true,
      },
    });
  });

  it("fails closed instead of rendering the unauthenticated local app", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "publishable",
      unknown: "field",
    }));

    await expect(resolveYuiStartup({ VITE_ZUNDAMON_API_BASE_URL: "/" }, fetchImpl)).resolves.toEqual({
      mode: "error",
    });
  });

  it("preserves local mode only when every hosted marker is absent", async () => {
    const fetchImpl = vi.fn();

    await expect(resolveYuiStartup({}, fetchImpl)).resolves.toEqual({ mode: "local" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
