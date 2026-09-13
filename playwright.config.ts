import { defineConfig, devices } from "playwright/test";

const browserChannel = process.env.PLAYWRIGHT_CHANNEL as
  | "chrome"
  | "chromium"
  | "msedge"
  | undefined;
const e2ePort = Number(process.env.ZUNDAMON_E2E_PORT ?? "4385");
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;
const integratedE2ePort = e2ePort + 1;
const integratedE2eOrigin = `http://127.0.0.1:${integratedE2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  // Keep browser traces separate from Vitest's visual evidence.
  outputDir: "./test-results/e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: e2eOrigin,
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `./apps/web/node_modules/.bin/vite apps/web --host 127.0.0.1 --port ${e2ePort}`,
      env: { VITE_ZUNDAMON_E2E: "true", VITE_YUI_INTEGRATED_UI_ENABLED: "false" },
      url: e2eOrigin,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `./apps/web/node_modules/.bin/vite apps/web --host 127.0.0.1 --port ${integratedE2ePort}`,
      env: { VITE_ZUNDAMON_E2E: "true", VITE_YUI_INTEGRATED_UI_ENABLED: "true" },
      url: integratedE2eOrigin,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: "legacy-chromium",
      testIgnore: /integrated-ui\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
    {
      name: "integrated-chromium",
      testMatch: /integrated-ui\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: integratedE2eOrigin,
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
});
