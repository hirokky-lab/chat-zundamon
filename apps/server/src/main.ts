import { buildProductionApp } from "./app.js";
import { loadConfig } from "./config.js";
import { chdir, loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

chdir(fileURLToPath(new URL("../../..", import.meta.url)));

try {
  loadEnvFile(".env");
} catch (error) {
  if (!isMissingFile(error)) {
    throw error;
  }
}

const config = loadConfig();
const app = buildProductionApp();

await app.listen({ host: "127.0.0.1", port: config.port });

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
