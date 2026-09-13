import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";

const browserConfig = {
  supabaseUrl: "https://project.supabase.co",
  supabasePublishableKey: "publishable-placeholder",
  photoAnalysisEnabled: true,
  prismEchoEnabled: true,
  integratedUiEnabled: true,
};

function privateApp() {
  const verify = vi.fn(async () => null);
  const app = buildApp({
    authVerifier: { verify },
    allowedOrigin: "https://existing-web.example",
    extractor: { extract: async () => ({ candidates: [] }) },
    browserConfig,
  } as Parameters<typeof buildApp>[0] & { browserConfig: typeof browserConfig });
  return { app, verify };
}

describe("protected Preview browser configuration", () => {
  it("serves the allowlisted photo switch with the public bootstrap fields before YUI bearer authentication", async () => {
    const { app, verify } = privateApp();

    const response = await app.inject({ method: "GET", url: "/api/browser-config" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(browserConfig);
    expect(Object.keys(response.json()).sort()).toEqual(["integratedUiEnabled", "photoAnalysisEnabled", "prismEchoEnabled", "supabasePublishableKey", "supabaseUrl"]);
    expect(response.body).not.toMatch(/service|openai|owner|backup|cron|blob|cost|limit/i);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/api/browser-config"],
    ["GET", "/api/browser-config/extra"],
    ["GET", "/api/profile"],
  ])("keeps %s %s behind bearer authentication", async (method, url) => {
    const { app, verify } = privateApp();

    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
    expect(verify).not.toHaveBeenCalled();
  });
});
