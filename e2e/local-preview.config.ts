import { defineConfig } from "playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "local-preview.spec.ts", workers: 1,
  outputDir: "../test-results/local-preview", use: { baseURL: "http://127.0.0.1:4390" },
  webServer: { command: "pnpm --filter @yui/web exec vite --host 127.0.0.1 --port 4390", url: "http://127.0.0.1:4390", reuseExistingServer: false },
});
