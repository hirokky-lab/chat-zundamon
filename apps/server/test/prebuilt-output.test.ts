import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifySameOriginPrebuiltOutput } from "../../../scripts/verify-same-origin-prebuilt";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { force: true, recursive: true });
});

function fixture(
  environment: Record<string, string> = {},
  maxDuration = 60,
  moduleType = "module",
  layout: "root" | "server-monorepo" = "root",
  catchAllEnvironment: Record<string, string> = environment,
  domainExport = "./src/index.js",
  includeDomainEntry = true,
  additionalWorkspacePackage = false,
  includeDomainTypeScript = false,
) {
  const root = mkdtempSync(join(tmpdir(), "yui-prebuilt-test-"));
  temporaryDirectories.push(root);
  const output = join(root, ".vercel", "output");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, "apps", "server", "node_modules", "fastify"), { recursive: true });
  writeFileSync(join(root, "apps", "server", "package.json"), JSON.stringify({
    dependencies: { fastify: "1.0.0" },
  }));
  writeFileSync(join(root, "apps", "server", "node_modules", "fastify", "package.json"), JSON.stringify({
    name: "fastify",
    version: "1.0.0",
    main: "index.js",
  }));
  writeFileSync(join(root, "apps", "server", "node_modules", "fastify", "index.js"), "module.exports = () => ({});");
  mkdirSync(join(output, "static", "assets"), { recursive: true });
  mkdirSync(join(output, "functions", "api", "index.func"), { recursive: true });
  mkdirSync(join(output, "functions", "api", "[...path].func"), { recursive: true });
  writeFileSync(join(output, "static", "index.html"), "<!doctype html><div id=\"root\"></div>");
  writeFileSync(join(output, "static", "assets", "app.js"), "export {};");
  writeFileSync(join(output, "static", "assets", "app.css"), "body{}");
  const packageRoot = layout === "server-monorepo" ? join("apps", "server") : "";
  for (const functionName of ["index.func", "[...path].func"]) {
    const functionRoot = join(output, "functions", "api", functionName, packageRoot);
    mkdirSync(functionRoot, { recursive: true });
    writeFileSync(join(functionRoot, "package.json"), JSON.stringify({ type: moduleType }));
    const domainRoot = join(output, "functions", "api", functionName, "packages", "domain");
    mkdirSync(join(domainRoot, "src"), { recursive: true });
    writeFileSync(join(domainRoot, "package.json"), JSON.stringify({
      name: "@yui/domain",
      private: true,
      type: "module",
      exports: domainExport,
    }));
    if (includeDomainEntry) writeFileSync(join(domainRoot, "src", "index.js"), "export const PRODUCT_NAME = 'YUI';");
    if (includeDomainTypeScript) writeFileSync(join(domainRoot, "src", "index.ts"), "export const PRIVATE_FIXTURE = 'must-not-ship';");
    if (additionalWorkspacePackage) {
      const unrelatedRoot = join(output, "functions", "api", functionName, "packages", "unrelated");
      mkdirSync(unrelatedRoot, { recursive: true });
      writeFileSync(join(unrelatedRoot, "package.json"), JSON.stringify({ name: "@yui/unrelated" }));
    }
    const runtimeDomainRoot = join(
      output,
      "functions",
      "api",
      functionName,
      ...(layout === "server-monorepo" ? ["apps", "server", "node_modules"] : ["node_modules"]),
      "@yui",
      "domain",
    );
    mkdirSync(join(runtimeDomainRoot, "src"), { recursive: true });
    writeFileSync(join(runtimeDomainRoot, "package.json"), JSON.stringify({
      name: "@yui/domain",
      private: true,
      type: "module",
      exports: "./src/index.js",
    }));
    if (includeDomainEntry) writeFileSync(join(runtimeDomainRoot, "src", "index.js"), "export const PRODUCT_NAME = 'YUI';");
  }
  writeFileSync(join(output, "config.json"), JSON.stringify({
    version: 3,
    crons: [],
    routes: [
      { handle: "filesystem" },
      { src: "^/api(?:/(.*))?$", dest: "/api?path=$1", check: true },
      { src: "^/api(/.*)?$", status: 404 },
    ],
  }));
  const functionConfig = JSON.stringify({
    runtime: "nodejs22.x",
    handler: layout === "server-monorepo" ? "apps/server/api/index.js" : "api/index.js",
    maxDuration,
    environment,
    filePathMap: {
      "apps/server/node_modules/fastify": "apps/server/node_modules/fastify",
    },
  });
  writeFileSync(join(output, "functions", "api", "index.func", ".vc-config.json"), functionConfig);
  writeFileSync(join(output, "functions", "api", "[...path].func", ".vc-config.json"), JSON.stringify({
    runtime: "nodejs22.x",
    handler: layout === "server-monorepo" ? "apps/server/api/[...path].js" : "api/[...path].js",
    maxDuration,
    environment: catchAllEnvironment,
    filePathMap: {
      "apps/server/node_modules/fastify": "apps/server/node_modules/fastify",
    },
  }));
  return output;
}

describe("same-origin prebuilt output verifier", () => {
  it("rejects a prebuilt artifact whose referenced runtime dependency sources are absent", () => {
    const output = fixture();
    const deploymentRoot = resolve(output, "../..");
    rmSync(join(deploymentRoot, "node_modules"), { recursive: true });
    rmSync(join(deploymentRoot, "apps", "server", "node_modules"), { recursive: true });

    expect(() => verifySameOriginPrebuiltOutput(output))
      .toThrow("prebuilt_runtime_dependency_source_missing");
  });

  it("rejects a runtime dependency map that escapes the deployment root", () => {
    const output = fixture();
    for (const functionName of ["index.func", "[...path].func"]) {
      const configPath = join(output, "functions", "api", functionName, ".vc-config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      config.filePathMap = { "../outside": "../outside" };
      writeFileSync(configPath, JSON.stringify(config));
    }

    expect(() => verifySameOriginPrebuiltOutput(output))
      .toThrow("prebuilt_runtime_dependency_source_missing");
  });

  it("rejects an allowlisted runtime dependency symlink that resolves outside the deployment root", () => {
    const output = fixture();
    const deploymentRoot = resolve(output, "../..");
    const externalPackage = mkdtempSync(join(tmpdir(), "yui-external-runtime-package-"));
    temporaryDirectories.push(externalPackage);
    writeFileSync(join(externalPackage, "package.json"), JSON.stringify({ name: "fastify" }));
    const mappedPackage = join(deploymentRoot, "apps", "server", "node_modules", "fastify");
    rmSync(mappedPackage, { recursive: true });
    symlinkSync(externalPackage, mappedPackage, "dir");

    expect(() => verifySameOriginPrebuiltOutput(output))
      .toThrow("prebuilt_runtime_dependency_source_missing");
  });

  it("rejects a runtime dependency whose destination differs from its source", () => {
    const output = fixture();
    for (const functionName of ["index.func", "[...path].func"]) {
      const configPath = join(output, "functions", "api", functionName, ".vc-config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      config.filePathMap = { "apps/server/node_modules/zod": "apps/server/node_modules/fastify" };
      writeFileSync(configPath, JSON.stringify(config));
    }

    expect(() => verifySameOriginPrebuiltOutput(output))
      .toThrow("prebuilt_runtime_dependency_source_missing");
  });

  it("rejects runtime dependency maps that differ between the two API functions", () => {
    const output = fixture();
    const deploymentRoot = resolve(output, "../..");
    mkdirSync(join(deploymentRoot, "apps", "server", "node_modules", "zod"), { recursive: true });
    const configPath = join(output, "functions", "api", "index.func", ".vc-config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.filePathMap = {
      "apps/server/node_modules/fastify": "apps/server/node_modules/fastify",
      "apps/server/node_modules/zod": "apps/server/node_modules/zod",
    };
    writeFileSync(configPath, JSON.stringify(config));

    expect(() => verifySameOriginPrebuiltOutput(output))
      .toThrow("prebuilt_runtime_dependency_source_mismatch");
  });

  it("rejects an omitted direct runtime dependency even when its source exists", () => {
    const output = fixture();
    const deploymentRoot = resolve(output, "../..");
    const serverPackagePath = join(deploymentRoot, "apps", "server", "package.json");
    writeFileSync(serverPackagePath, JSON.stringify({ dependencies: { fastify: "1.0.0", zod: "1.0.0" } }));
    const zodRoot = join(deploymentRoot, "apps", "server", "node_modules", "zod");
    mkdirSync(zodRoot, { recursive: true });
    writeFileSync(join(zodRoot, "package.json"), JSON.stringify({ name: "zod", version: "1.0.0" }));

    expect(() => verifySameOriginPrebuiltOutput(output))
      .toThrow("prebuilt_runtime_dependency_source_missing");
  });

  it("accepts only static Web assets, two bounded API functions, no cron, and no function-local environment", () => {
    expect(verifySameOriginPrebuiltOutput(fixture())).toEqual({
      staticAssetCount: 3,
      functionCount: 2,
      runtime: "nodejs22.x",
      cronCount: 0,
      functionEnvironmentKeyCount: 0,
    });
  });

  it("accepts the fixed apps/server package layout emitted by a server-root Vercel build", () => {
    expect(verifySameOriginPrebuiltOutput(fixture({}, 60, "module", "server-monorepo"))).toEqual({
      staticAssetCount: 3,
      functionCount: 2,
      runtime: "nodejs22.x",
      cronCount: 0,
      functionEnvironmentKeyCount: 0,
    });
  });

  it("rejects an emitted workspace package that still exports an omitted TypeScript entrypoint", () => {
    expect(() => verifySameOriginPrebuiltOutput(
      fixture({}, 60, "module", "server-monorepo", {}, "./src/index.ts"),
    )).toThrow("prebuilt_workspace_package_invalid");
  });

  it("rejects an emitted workspace package whose runtime JavaScript entrypoint is absent", () => {
    expect(() => verifySameOriginPrebuiltOutput(
      fixture({}, 60, "module", "server-monorepo", {}, "./src/index.js", false),
    )).toThrow("prebuilt_workspace_package_invalid");
  });

  it("rejects unneeded workspace packages from both function artifacts", () => {
    expect(() => verifySameOriginPrebuiltOutput(
      fixture({}, 60, "module", "server-monorepo", {}, "./src/index.js", true, true),
    )).toThrow("prebuilt_workspace_package_invalid");
  });

  it("rejects TypeScript workspace sources that the runtime does not need", () => {
    expect(() => verifySameOriginPrebuiltOutput(
      fixture({}, 60, "module", "server-monorepo", {}, "./src/index.js", true, false, true),
    )).toThrow("prebuilt_workspace_package_invalid");
  });

  it.each(["index.func", "[...path].func"])(
    "rejects source maps with local TypeScript from %s",
    (functionName) => {
    const output = fixture({}, 60, "module", "server-monorepo");
    writeFileSync(
      join(output, "functions", "api", functionName, "packages", "domain", "src", "index.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["/private/tmp/yui/packages/domain/src/index.ts"],
        sourcesContent: ["export const PRIVATE_FIXTURE = 'must-not-ship';"],
        mappings: "",
      }),
    );

    expect(() => verifySameOriginPrebuiltOutput(output))
      .toThrow("prebuilt_function_source_map_invalid");
    },
  );

  it.each(["index.func", "[...path].func"])(
    "rejects unnecessary TypeScript sources from %s",
    (functionName) => {
      const output = fixture({}, 60, "module", "server-monorepo");
      const sourceRoot = join(output, "functions", "api", functionName, "apps", "server", "src");
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(join(sourceRoot, "private-fixture.ts"), "export const PRIVATE_FIXTURE = 'must-not-ship';");

      expect(() => verifySameOriginPrebuiltOutput(output))
        .toThrow("prebuilt_function_typescript_invalid");
    },
  );

  it("fails closed when the two API functions mix root and server-monorepo layouts", () => {
    const output = fixture();
    const catchAllRoot = join(output, "functions", "api", "[...path].func");
    mkdirSync(join(catchAllRoot, "apps", "server"), { recursive: true });
    writeFileSync(join(catchAllRoot, "apps", "server", "package.json"), JSON.stringify({ type: "module" }));
    cpSync(
      join(catchAllRoot, "node_modules", "@yui", "domain"),
      join(catchAllRoot, "apps", "server", "node_modules", "@yui", "domain"),
      { recursive: true },
    );
    writeFileSync(join(catchAllRoot, ".vc-config.json"), JSON.stringify({
      runtime: "nodejs22.x",
      handler: "apps/server/api/[...path].js",
      maxDuration: 60,
      environment: {},
      filePathMap: {
        "apps/server/node_modules/fastify": "apps/server/node_modules/fastify",
      },
    }));

    expect(() => verifySameOriginPrebuiltOutput(output)).toThrow("prebuilt_function_layout_mismatch");
  });

  it("fails closed when a prebuilt function contains an additional environment value", () => {
    expect(() => verifySameOriginPrebuiltOutput(fixture({ SECRET: "must-not-ship" })))
      .toThrow("prebuilt_function_environment_not_empty");
  });

  it("accepts only the exact non-secret reviewed Preview feature opt-ins", () => {
    expect(verifySameOriginPrebuiltOutput(
      fixture({ YUI_INTEGRATED_UI_ENABLED: "true", YUI_PRISM_ECHO_ENABLED: "true" }),
      { integratedUiEnabled: true, prismEchoEnabled: true },
    )).toEqual({
      staticAssetCount: 3,
      functionCount: 2,
      runtime: "nodejs22.x",
      cronCount: 0,
      functionEnvironmentKeyCount: 4,
    });
    expect(() => verifySameOriginPrebuiltOutput(
      fixture({ YUI_PRISM_ECHO_ENABLED: "TRUE" }),
      { prismEchoEnabled: true },
    )).toThrow("prebuilt_function_environment_invalid");
    expect(() => verifySameOriginPrebuiltOutput(
      fixture({ YUI_INTEGRATED_UI_ENABLED: "TRUE", YUI_PRISM_ECHO_ENABLED: "true" }),
      { integratedUiEnabled: true, prismEchoEnabled: true },
    )).toThrow("prebuilt_function_environment_invalid");
    expect(() => verifySameOriginPrebuiltOutput(
      fixture({ YUI_PRISM_ECHO_ENABLED: "true", EXTRA: "forbidden" }),
      { prismEchoEnabled: true },
    )).toThrow("prebuilt_function_environment_invalid");
    expect(() => verifySameOriginPrebuiltOutput(
      fixture(
        { YUI_PRISM_ECHO_ENABLED: "true" },
        60,
        "module",
        "root",
        { YUI_PRISM_ECHO_ENABLED: "TRUE" },
      ),
      { prismEchoEnabled: true },
    )).toThrow("prebuilt_function_environment_invalid");
    expect(() => verifySameOriginPrebuiltOutput(
      fixture(
        { YUI_PRISM_ECHO_ENABLED: "true", EXTRA: "forbidden" },
        60,
        "module",
        "root",
        { YUI_PRISM_ECHO_ENABLED: "true" },
      ),
      { prismEchoEnabled: true },
    )).toThrow("prebuilt_function_environment_invalid");

    expect(verifySameOriginPrebuiltOutput(
      fixture({
        YUI_CALENDAR_READ_ENABLED: "true",
        YUI_INTEGRATED_UI_ENABLED: "true",
        YUI_PHOTO_ANALYSIS_ENABLED: "true",
        YUI_PRISM_ECHO_ENABLED: "true",
        YUI_TASKS_READ_ENABLED: "true",
        YUI_WEB_SEARCH_ENABLED: "true",
      }),
      {
        calendarReadEnabled: true,
        integratedUiEnabled: true,
        photoAnalysisEnabled: true,
        prismEchoEnabled: true,
        tasksReadEnabled: true,
        webSearchEnabled: true,
      },
    )).toEqual({
      staticAssetCount: 3,
      functionCount: 2,
      runtime: "nodejs22.x",
      cronCount: 0,
      functionEnvironmentKeyCount: 12,
    });
    expect(() => verifySameOriginPrebuiltOutput(
      fixture({
        YUI_CALENDAR_READ_ENABLED: "true",
        YUI_INTEGRATED_UI_ENABLED: "true",
        YUI_PHOTO_ANALYSIS_ENABLED: "true",
        YUI_PRISM_ECHO_ENABLED: "true",
        YUI_TASKS_READ_ENABLED: "true",
        YUI_WEB_SEARCH_ENABLED: "TRUE",
      }),
      {
        calendarReadEnabled: true,
        integratedUiEnabled: true,
        photoAnalysisEnabled: true,
        prismEchoEnabled: true,
        tasksReadEnabled: true,
        webSearchEnabled: true,
      },
    )).toThrow("prebuilt_function_environment_invalid");
  });

  it("requires explicit reviewed write opt-ins for both functions", () => {
    const output = fixture({ YUI_CALENDAR_WRITE_ENABLED: "true", YUI_TASKS_WRITE_ENABLED: "true" });
    expect(() => verifySameOriginPrebuiltOutput(output)).toThrow();
    expect(verifySameOriginPrebuiltOutput(output, { calendarWriteEnabled: true, tasksWriteEnabled: true }).functionEnvironmentKeyCount).toBe(4);
  });

  it("fails closed when a prebuilt function exceeds the fixed 60 second duration", () => {
    expect(() => verifySameOriginPrebuiltOutput(fixture({}, 61)))
      .toThrow("prebuilt_function_config_invalid");
  });

  it("fails closed when root API entrypoints are not emitted as ES modules", () => {
    expect(() => verifySameOriginPrebuiltOutput(fixture({}, 60, "commonjs")))
      .toThrow("prebuilt_function_module_invalid");
  });

  it.runIf(Boolean(process.env.YUI_PREBUILT_OUTPUT))("verifies the freshly generated Vercel Build Output", () => {
    const calendarWriteEnabled = process.env.YUI_PREBUILT_CALENDAR_WRITE_ENABLED === "true";
    const tasksWriteEnabled = process.env.YUI_PREBUILT_TASKS_WRITE_ENABLED === "true";
    const calendarReadEnabled = process.env.YUI_PREBUILT_CALENDAR_READ_ENABLED === "true";
    const integratedUiEnabled = process.env.YUI_PREBUILT_INTEGRATED_UI_ENABLED === "true";
    const photoAnalysisEnabled = process.env.YUI_PREBUILT_PHOTO_ANALYSIS_ENABLED === "true";
    const prismEchoEnabled = process.env.YUI_PREBUILT_PRISM_ECHO_ENABLED === "true";
    const tasksReadEnabled = process.env.YUI_PREBUILT_TASKS_READ_ENABLED === "true";
    const webSearchEnabled = process.env.YUI_PREBUILT_WEB_SEARCH_ENABLED === "true";
    const summary = verifySameOriginPrebuiltOutput(
      process.env.YUI_PREBUILT_OUTPUT!,
      {
        calendarWriteEnabled,
        tasksWriteEnabled,
        calendarReadEnabled,
        integratedUiEnabled,
        photoAnalysisEnabled,
        prismEchoEnabled,
        tasksReadEnabled,
        webSearchEnabled,
      },
    );
    expect(summary.functionCount).toBe(2);
    expect(summary.staticAssetCount).toBeGreaterThanOrEqual(3);
    expect(summary.cronCount).toBe(0);
    expect(summary.functionEnvironmentKeyCount).toBe((
      Number(calendarWriteEnabled)
      + Number(tasksWriteEnabled)
      + Number(calendarReadEnabled)
      + Number(integratedUiEnabled)
      + Number(photoAnalysisEnabled)
      + Number(prismEchoEnabled)
      + Number(tasksReadEnabled)
      + Number(webSearchEnabled)
    ) * 2);
  });

  it.runIf(Boolean(process.env.YUI_PREBUILT_OUTPUT)).each(["index.func", "[...path].func"])(
    "starts the freshly generated %s function and serves health without external I/O",
    (functionName) => {
      const stagedRoot = mkdtempSync(join(tmpdir(), "yui-prebuilt-runtime-smoke-"));
      temporaryDirectories.push(stagedRoot);
      const stagedFunctionRoot = join(stagedRoot, functionName);
      cpSync(join(process.env.YUI_PREBUILT_OUTPUT!, "functions", "api", functionName), stagedFunctionRoot, {
        recursive: true,
      });
      const deploymentRoot = resolve(process.env.YUI_PREBUILT_OUTPUT!, "../..");
      const functionConfig = JSON.parse(readFileSync(join(stagedFunctionRoot, ".vc-config.json"), "utf8")) as {
        filePathMap: Record<string, string>;
        environment: Record<string, string>;
      };
      for (const [destination, source] of Object.entries(functionConfig.filePathMap)) {
        cpSync(
          join(deploymentRoot, source),
          join(stagedFunctionRoot, destination),
          { recursive: true, dereference: false, verbatimSymlinks: true, force: true },
        );
      }
      const smokeEnv = {
        ...process.env,
        YUI_MODE: "hosted",
        OPENAI_API_KEY: "test-placeholder",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "publishable-placeholder",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
        YUI_ALLOWED_EMAIL: "owner@example.com",
        YUI_ALLOWED_ORIGIN: "https://preview.example",
        CRON_SECRET: "cron-placeholder",
        YUI_BACKUP_KEY: Buffer.alloc(32, 7).toString("base64"),
        BLOB_READ_WRITE_TOKEN: "blob-placeholder",
        ...functionConfig.environment,
      };
      const appModuleUrl = pathToFileURL(join(
        stagedFunctionRoot,
        "apps",
        "server",
        "src",
        "app.js",
      ));
      const script = [
        "let outboundIoAttempts = 0;",
        "const denyOutboundIo = () => { outboundIoAttempts += 1; throw new Error('YUI_PREBUILT_RUNTIME_SMOKE_OUTBOUND_IO'); };",
        "globalThis.fetch = denyOutboundIo;",
        "const http = (await import('node:http')).default;",
        "const https = (await import('node:https')).default;",
        "http.request = denyOutboundIo; http.get = denyOutboundIo;",
        "https.request = denyOutboundIo; https.get = denyOutboundIo;",
        `const { buildHostedApp } = await import(${JSON.stringify(appModuleUrl.href)});`,
        "const app = buildHostedApp({ logger: false });",
        "await app.ready();",
        "const response = await app.inject({ method: 'GET', url: '/api/healthz' });",
        "await app.close();",
        "if (response.statusCode !== 200) { console.error(`YUI_PREBUILT_RUNTIME_SMOKE_STATUS_${response.statusCode}`); process.exit(2); }",
        "if (outboundIoAttempts !== 0) { console.error(`YUI_PREBUILT_RUNTIME_SMOKE_IO_${outboundIoAttempts}`); process.exit(3); }",
        "console.log('YUI_PREBUILT_RUNTIME_SMOKE_OK_IO_0');",
      ].join("\n");
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        env: smokeEnv,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
        status: 0,
        signal: null,
        stderr: "",
      });
      expect(result.stdout.trim()).toBe("YUI_PREBUILT_RUNTIME_SMOKE_OK_IO_0");
    },
  );
});
