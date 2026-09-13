import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type SameOriginPrebuiltSummary = {
  staticAssetCount: number;
  functionCount: number;
  runtime: "nodejs22.x";
  cronCount: 0;
  functionEnvironmentKeyCount: number;
};

export type SameOriginPrebuiltOptions = {
  calendarReadEnabled?: boolean;
  calendarWriteEnabled?: boolean;
  integratedUiEnabled?: boolean;
  photoAnalysisEnabled?: boolean;
  prismEchoEnabled?: boolean;
  tasksReadEnabled?: boolean;
  tasksWriteEnabled?: boolean;
  webSearchEnabled?: boolean;
};

function readJson(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("prebuilt_invalid_json");
  }
}

function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

export function verifySameOriginPrebuiltOutput(
  outputDirectory: string,
  options: SameOriginPrebuiltOptions = {},
): SameOriginPrebuiltSummary {
  const deploymentRoot = resolve(outputDirectory, "../..");
  const realDeploymentRoot = realpathSync(deploymentRoot);
  const staticDirectory = join(outputDirectory, "static");
  const functionsDirectory = join(outputDirectory, "functions", "api");
  if (!existsSync(join(staticDirectory, "index.html"))) throw new Error("prebuilt_static_index_missing");
  const staticFiles = filesUnder(staticDirectory);
  if (!staticFiles.some((path) => path.endsWith(".js")) || !staticFiles.some((path) => path.endsWith(".css"))) {
    throw new Error("prebuilt_static_assets_missing");
  }

  const config = readJson(join(outputDirectory, "config.json"));
  if (config.version !== 3) throw new Error("prebuilt_version_invalid");
  if (!Array.isArray(config.crons) || config.crons.length !== 0) throw new Error("prebuilt_cron_not_empty");
  if (!Array.isArray(config.routes) || !config.routes.some((route) => {
    return Boolean(route) && typeof route === "object" && (route as Record<string, unknown>).dest === "/api?path=$1";
  })) throw new Error("prebuilt_api_route_missing");

  const expectedFunctions = ["[...path].func", "index.func"];
  const actualFunctions = readdirSync(functionsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".func"))
    .map((entry) => entry.name)
    .sort();
  if (actualFunctions.join(",") !== expectedFunctions.join(",")) throw new Error("prebuilt_functions_invalid");

  const expectedHandlers: Record<string, readonly string[]> = {
    "[...path].func": ["api/[...path].js", "apps/server/api/[...path].js"],
    "index.func": ["api/index.js", "apps/server/api/index.js"],
  };
  let selectedLayout: "root" | "server-monorepo" | undefined;
  let selectedRuntimeSources: string | undefined;
  let functionEnvironmentKeyCount = 0;
  for (const functionName of expectedFunctions) {
    const functionDirectory = join(functionsDirectory, functionName);
    if (filesUnder(functionDirectory).some((path) => path.endsWith(".map"))) {
      throw new Error("prebuilt_function_source_map_invalid");
    }
    const functionConfig = readJson(join(functionDirectory, ".vc-config.json"));
    const handler = functionConfig.handler;
    if (
      functionConfig.runtime !== "nodejs22.x"
      || typeof handler !== "string"
      || !expectedHandlers[functionName].includes(handler)
      || functionConfig.maxDuration !== 60
    ) {
      throw new Error("prebuilt_function_config_invalid");
    }
    const layout = handler.startsWith("apps/server/") ? "server-monorepo" : "root";
    if (selectedLayout && selectedLayout !== layout) throw new Error("prebuilt_function_layout_mismatch");
    selectedLayout = layout;
    const filePathMap = functionConfig.filePathMap;
    if (!filePathMap || typeof filePathMap !== "object" || Array.isArray(filePathMap)) {
      throw new Error("prebuilt_runtime_dependency_source_missing");
    }
    const runtimeSources = Object.entries(filePathMap as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    if (runtimeSources.length === 0) throw new Error("prebuilt_runtime_dependency_source_missing");
    const serializedRuntimeSources = JSON.stringify(runtimeSources);
    if (selectedRuntimeSources && selectedRuntimeSources !== serializedRuntimeSources) {
      throw new Error("prebuilt_runtime_dependency_source_mismatch");
    }
    selectedRuntimeSources = serializedRuntimeSources;
    const allowedRuntimeSource = /^(?:apps\/server\/node_modules\/(?:@[^/]+\/)?[^/]+|node_modules\/\.pnpm\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+)$/;
    for (const [destination, source] of runtimeSources) {
      if (
        typeof source !== "string"
        || destination !== source
        || isAbsolute(source)
        || source.split("/").includes("..")
        || !allowedRuntimeSource.test(source)
      ) {
        throw new Error("prebuilt_runtime_dependency_source_missing");
      }
      const sourcePath = join(deploymentRoot, source);
      if (!existsSync(sourcePath)) {
        throw new Error("prebuilt_runtime_dependency_source_missing");
      }
      const resolvedSourcePath = realpathSync(sourcePath);
      if (relative(realDeploymentRoot, resolvedSourcePath).startsWith("..")) {
        throw new Error("prebuilt_runtime_dependency_source_missing");
      }
    }
    const functionPackage = readJson(join(functionDirectory, dirname(dirname(handler)), "package.json"));
    if (functionPackage.type !== "module") throw new Error("prebuilt_function_module_invalid");
    const workspacePackagesDirectory = join(functionDirectory, "packages");
    const workspacePackages = readdirSync(workspacePackagesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const domainDirectory = join(workspacePackagesDirectory, "domain");
    const domainPackage = readJson(join(domainDirectory, "package.json"));
    if (
      workspacePackages.join(",") !== "domain"
      || domainPackage.name !== "@yui/domain"
      || domainPackage.private !== true
      || domainPackage.type !== "module"
      || domainPackage.exports !== "./src/index.js"
      || !existsSync(join(domainDirectory, "src", "index.js"))
      || filesUnder(domainDirectory).some((path) => path.endsWith(".ts"))
    ) {
      throw new Error("prebuilt_workspace_package_invalid");
    }
    const runtimeDomainDirectory = join(
      functionDirectory,
      ...(layout === "server-monorepo" ? ["apps", "server", "node_modules"] : ["node_modules"]),
      "@yui",
      "domain",
    );
    const mappedDomainSource = `${layout === "server-monorepo" ? "apps/server/" : ""}node_modules/@yui/domain`;
    if (runtimeSources.some(([, source]) => source === mappedDomainSource)) {
      throw new Error("prebuilt_workspace_package_invalid");
    }
    const runtimeDomainPackage = readJson(join(runtimeDomainDirectory, "package.json"));
    if (
      runtimeDomainPackage.name !== "@yui/domain"
      || runtimeDomainPackage.private !== true
      || runtimeDomainPackage.type !== "module"
      || runtimeDomainPackage.exports !== "./src/index.js"
      || !existsSync(join(runtimeDomainDirectory, "src", "index.js"))
      || filesUnder(runtimeDomainDirectory).some((path) => path.endsWith(".ts") || path.endsWith(".map"))
      || readFileSync(join(runtimeDomainDirectory, "src", "index.js"), "utf8")
        !== readFileSync(join(domainDirectory, "src", "index.js"), "utf8")
    ) {
      throw new Error("prebuilt_workspace_package_invalid");
    }
    if (filesUnder(functionDirectory).some((path) => path.endsWith(".ts"))) {
      throw new Error("prebuilt_function_typescript_invalid");
    }
    const enabledEnvironment = {
      ...(options.calendarWriteEnabled ? { YUI_CALENDAR_WRITE_ENABLED: "true" } : {}),
      ...(options.calendarReadEnabled ? { YUI_CALENDAR_READ_ENABLED: "true" } : {}),
      ...(options.integratedUiEnabled ? { YUI_INTEGRATED_UI_ENABLED: "true" } : {}),
      ...(options.photoAnalysisEnabled ? { YUI_PHOTO_ANALYSIS_ENABLED: "true" } : {}),
      ...(options.prismEchoEnabled ? { YUI_PRISM_ECHO_ENABLED: "true" } : {}),
      ...(options.tasksWriteEnabled ? { YUI_TASKS_WRITE_ENABLED: "true" } : {}),
      ...(options.tasksReadEnabled ? { YUI_TASKS_READ_ENABLED: "true" } : {}),
      ...(options.webSearchEnabled ? { YUI_WEB_SEARCH_ENABLED: "true" } : {}),
    };
    const environment = functionConfig.environment;
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      throw new Error(Object.keys(enabledEnvironment).length > 0 ? "prebuilt_function_environment_invalid" : "prebuilt_function_environment_not_empty");
    }
    const environmentRecord = environment as Record<string, unknown>;
    const environmentKeys = Object.keys(environmentRecord).sort();
    const expectedEnvironmentKeys = Object.keys(enabledEnvironment).sort();
    if (
      environmentKeys.join(",") !== expectedEnvironmentKeys.join(",")
      || expectedEnvironmentKeys.some((key) => environmentRecord[key] !== enabledEnvironment[key as keyof typeof enabledEnvironment])
    ) {
      throw new Error(expectedEnvironmentKeys.length > 0 ? "prebuilt_function_environment_invalid" : "prebuilt_function_environment_not_empty");
    }
    functionEnvironmentKeyCount += environmentKeys.length;
  }

  const serverPackage = readJson(join(deploymentRoot, "apps", "server", "package.json"));
  const dependencies = serverPackage.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("prebuilt_runtime_dependency_source_missing");
  }
  const runtimeSources = JSON.parse(selectedRuntimeSources ?? "[]") as Array<[string, string]>;
  const mappedRuntimeSources = new Set(runtimeSources.map(([, source]) => source));
  for (const dependency of Object.keys(dependencies as Record<string, unknown>)) {
    if (dependency === "@yui/domain") continue;
    if (!mappedRuntimeSources.has(`apps/server/node_modules/${dependency}`)) {
      throw new Error("prebuilt_runtime_dependency_source_missing");
    }
    const packagePath = [
      join(deploymentRoot, "apps", "server", "node_modules", dependency, "package.json"),
      join(deploymentRoot, "node_modules", dependency, "package.json"),
    ].find(existsSync);
    if (!packagePath) throw new Error("prebuilt_runtime_dependency_source_missing");
    const resolvedPackagePath = realpathSync(packagePath);
    if (relative(realDeploymentRoot, resolvedPackagePath).startsWith("..")) {
      throw new Error("prebuilt_runtime_dependency_source_missing");
    }
  }

  return {
    staticAssetCount: staticFiles.length,
    functionCount: expectedFunctions.length,
    runtime: "nodejs22.x",
    cronCount: 0,
    functionEnvironmentKeyCount,
  };
}
