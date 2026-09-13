import { createClient } from "@supabase/supabase-js";
import type { BackupBlobStore } from "./backup.js";

export const BACKUP_BUCKET = "zundamon-backups";
type Result = { error: unknown };
export type BackupStorageBucket = {
  upload(path: string, body: string, options: { upsert: boolean; contentType: string }): Promise<Result>;
  list(path: string, options: { limit: number; offset: number; sortBy: { column: string; order: string } }): Promise<Result & { data: Array<{ name: string }> | null }>;
  remove(paths: string[]): Promise<Result>;
};
const backupPath = /^backups\/(daily|weekly)\/\d{4}-\d{2}-\d{2}\.json$/;

/** Dedicated private bucket, accessed only through the server's service-role client. */
export function createSupabaseBackupBlobStore(bucket: BackupStorageBucket): BackupBlobStore {
  const assertPath = (path: string) => {
    if (!backupPath.test(path)) throw new Error("Invalid backup path");
  };
  return {
    async put(path, body) {
      assertPath(path);
      try {
        const result = await bucket.upload(path, body, { upsert: true, contentType: "application/json" });
        if (result.error) throw new Error();
      } catch { throw new Error("Backup storage unavailable"); }
    },
    async list(prefix) {
      if (!/^backups\/(daily|weekly)\/$/.test(prefix)) throw new Error("Invalid backup prefix");
      const paths: Array<{ pathname: string }> = [];
      try {
        for (let offset = 0; ; offset += 100) {
          const result = await bucket.list(prefix.slice(0, -1), { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
          if (result.error || !Array.isArray(result.data)) throw new Error();
          for (const file of result.data) {
            const pathname = prefix + file.name;
            if (backupPath.test(pathname)) paths.push({ pathname });
          }
          if (result.data.length < 100) break;
        }
        return paths;
      } catch { throw new Error("Backup storage unavailable"); }
    },
    async delete(paths) {
      paths.forEach(assertPath);
      try {
        for (let offset = 0; offset < paths.length; offset += 100) {
          const result = await bucket.remove(paths.slice(offset, offset + 100));
          if (result.error) throw new Error();
        }
      } catch { throw new Error("Backup storage unavailable"); }
    },
  };
}

export function createSupabaseBackupStore(url: string, serviceRoleKey: string): BackupBlobStore {
  const client = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } });
  return createSupabaseBackupBlobStore(client.storage.from(BACKUP_BUCKET));
}
