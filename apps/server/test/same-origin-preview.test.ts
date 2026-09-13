import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = resolve(process.cwd(), "../..");
const readRoot = (path: string) => readFileSync(resolve(root, path), "utf8");
const originalEnv = { ...process.env };
const rootEntries = {
  index: () => import("../../../api/index.js"),
  catchAll: () => import("../../../api/[...path].js"),
};

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

// Deployment manifests were intentionally not copied; those three checks are NOT RUN until independent hosting is configured.
describe("same-origin protected Preview contract", () => {
  it("emits root API entrypoints as ES modules like the hosted server they import", () => {
    const packageJson = JSON.parse(readRoot("package.json")) as Record<string, unknown>;
    expect(packageJson.type).toBe("module");
  });

  it("pins the pnpm major that supports the committed build-script allowlist", () => {
    const packageJson = JSON.parse(readRoot("package.json")) as { packageManager?: string };
    const workspace = readRoot("pnpm-workspace.yaml");

    expect(workspace).toContain("allowBuilds:");
    expect(packageJson.packageManager).toBe("pnpm@11.19.0");
  });

  it.skipIf(!existsSync(resolve(root, "vercel.json")))("builds only the Web output and routes API paths to bounded root functions", () => {
    const config = JSON.parse(readRoot("vercel.json")) as Record<string, unknown>;
    expect(config).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      buildCommand: "VITE_YUI_API_BASE_URL=/ pnpm --filter @yui/web build",
      outputDirectory: "apps/web/dist",
      functions: {
        "api/index.ts": { maxDuration: 60 },
        "api/[...path].ts": { maxDuration: 60 },
      },
      rewrites: [{ source: "/api/:path*", destination: "/api" }],
    });
  });

  it.skipIf(!existsSync(resolve(root, ".vercelignore")))("excludes local secrets and generated test artifacts from a Preview upload", () => {
    expect(readRoot(".vercelignore")).toBe([
      ".env",
      ".env.*",
      "**/dist/",
      "apps/web/dist",
      "apps/server/dist",
      "coverage/",
      "coverage",
      "test-results/",
      "test-results",
      "playwright-report/",
      "playwright-report",
    ].join("\n") + "\n");
  });

  it.skipIf(!existsSync(resolve(root, "apps/server/vercel.json")))("makes the server-root Preview build serve the Web bundle before API rewrites", () => {
    expect(JSON.parse(readRoot("apps/server/vercel.json"))).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      framework: null,
      buildCommand: "cd ../.. && VITE_YUI_API_BASE_URL=/ pnpm --filter @yui/web build && rm -rf apps/server/dist && cp -R apps/web/dist apps/server/dist",
      outputDirectory: "dist",
      functions: { "api/index.ts": { maxDuration: 60 }, "api/[...path].ts": { maxDuration: 60 } },
      rewrites: [{ source: "/api/:path*", destination: "/api" }],
      crons: [{ path: "/api/cron/backup", schedule: "0 3 * * *" }],
    });
  });

  it("typechecks root functions with the existing hosted server compiler boundary", () => {
    expect(JSON.parse(readRoot("tsconfig.json"))).toEqual({
      extends: "./apps/server/tsconfig.json",
      compilerOptions: { strictNullChecks: true },
      include: ["api/**/*.ts", "apps/server/api/**/*.ts", "apps/server/src/**/*.ts"],
    });
  });

  it.each([
    ["index", rootEntries.index],
    ["[...path]", rootEntries.catchAll],
  ] as const)("reuses the existing hosted handler in root api/%s", async (_entry, importRootEntry) => {
    Object.assign(process.env, {
      ZUNDAMON_MODE: "hosted",
      ZUNDAMON_OPENAI_API_KEY: "test-placeholder",
      ZUNDAMON_SUPABASE_URL: "https://project.supabase.co",
      ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: "publishable-placeholder",
      ZUNDAMON_SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
      ZUNDAMON_ALLOWED_EMAIL: "owner@example.com",
      ZUNDAMON_ALLOWED_ORIGIN: "https://preview.example",
      ZUNDAMON_CRON_SECRET: "cron-placeholder",
      ZUNDAMON_BACKUP_KEY: Buffer.alloc(32, 7).toString("base64"),
      ZUNDAMON_BLOB_READ_WRITE_TOKEN: "blob-placeholder",
    });
    const existing = await import("../api/index.js");
    const rootEntry = await importRootEntry();

    expect(rootEntry.default).toBe(existing.default);
  });
});
