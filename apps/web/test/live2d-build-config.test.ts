import { afterEach, expect, it, vi } from "vitest";
import type { UserConfigFnObject } from "vite";
import config from "../vite.config";

// Inspect configuration without starting Vite/esbuild or reading local env files.
vi.mock("vite", () => ({ defineConfig: (value: unknown) => value, loadEnv: () => ({}) }));

afterEach(() => vi.unstubAllEnvs());
it.each([
  ["preview", "preview-live2d", "true"],
  ["production", "preview-live2d", "false"],
  ["production", "local-live2d", "false"],
  ["preview", "production", "false"],
])("derives deployment identity from VERCEL_ENV and disables asset-free builds (%s/%s)", (deployment, mode, expected) => {
  vi.stubEnv("VERCEL_ENV", deployment);
  vi.stubEnv("VITE_YUI_DEPLOYMENT_ENV", "preview");
  vi.stubEnv("VITE_YUI_LIVE2D_AVATAR_ENABLED", "true");
  vi.stubEnv("VITE_YUI_LIVE2D_MODEL", "zundamon");
  vi.stubEnv("VITE_YUI_LIVE2D_BRIDGE_SHA256", "a".repeat(64));
  const result = (config as UserConfigFnObject)({ mode, command: "build" });
  expect(result.define?.["import.meta.env.VITE_YUI_DEPLOYMENT_ENV"]).toBe(JSON.stringify(deployment));
  expect(result.define?.["import.meta.env.VITE_YUI_LIVE2D_AVATAR_ENABLED"]).toBe(JSON.stringify(expected));
});
