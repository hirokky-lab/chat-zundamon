import { parseMigrationBundle, type MigrationBundle, type Profile } from "@yui/domain";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FileLike = { name: string; text?: () => Promise<string> } & Partial<Blob>;

export type MigrationReceipt = { importedProfile: true; importedMemories: number };
export type MigrationPreview = {
  fileName: string;
  importId: string;
  profile: Profile;
  memoryCount: number;
  bundle: MigrationBundle;
};
export type MigrationApi = {
  importBundle(importId: string, bundle: MigrationBundle): Promise<MigrationReceipt>;
};

function validReceipt(value: unknown): MigrationReceipt | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.importedProfile !== true || !Number.isSafeInteger(row.importedMemories) || (row.importedMemories as number) < 0) return null;
  return { importedProfile: true, importedMemories: row.importedMemories as number };
}

export async function readMigrationFile(file: FileLike, createImportId: () => string = () => crypto.randomUUID()): Promise<MigrationPreview> {
  let value: unknown;
  try {
    const source = file.text
      ? await file.text()
      : await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
        reader.addEventListener("error", () => reject(reader.error), { once: true });
        reader.readAsText(file as Blob);
      });
    value = JSON.parse(source);
  } catch {
    throw new Error("Invalid migration file");
  }
  const bundle = parseMigrationBundle(value);
  if (!bundle) throw new Error("Invalid migration file");
  return { fileName: file.name, importId: createImportId(), profile: bundle.profile, memoryCount: bundle.memories.length, bundle };
}

export function createMigrationApi(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): MigrationApi {
  return {
    async importBundle(importId, bundle) {
      const response = await fetchImpl("/api/migration/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId, bundle }),
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* status is authoritative */ }
        throw new Error("Migration unavailable");
      }
      const parsed = validReceipt(await response.json());
      if (!parsed) throw new Error("Migration unavailable");
      return parsed;
    },
  };
}
