import { defineConfig, devices } from "playwright/test";

const port = 4386;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "integrated-ui.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, timezoneId: "Asia/Tokyo", trace: "retain-on-failure", serviceWorkers: "block" },
  webServer: {
    command: `./apps/web/node_modules/.bin/vite apps/web --host 127.0.0.1 --port ${port}`,
    env: { VITE_ZUNDAMON_E2E: "true", VITE_YUI_INTEGRATED_UI_ENABLED: "true" },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
