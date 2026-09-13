import { expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";

it("does not reactivate retired YUI integrations from old environment settings", async () => {
  const config = loadConfig({
    ZUNDAMON_OPENAI_API_KEY: "test-key",
    ZUNDAMON_WORK_ASSIST_ENABLED: "true",
    ZUNDAMON_DASHBOARD_PROJECTION_TOKEN: "a".repeat(32),
    ZUNDAMON_DASHBOARD_MIN_GENERATION: "2",
  });
  expect(config).not.toHaveProperty("dashboardProjection");
  expect(config.externalToolFlags).not.toHaveProperty("work_assist");
  const app = buildApp({
    extractor: { extract: async () => ({ candidates: [] }) },
    externalToolFlags: config.externalToolFlags,
  });
  try {
    expect((await app.inject({ method: "GET", url: "/api/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/dashboard/progress" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/work-assist", payload: {} })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
