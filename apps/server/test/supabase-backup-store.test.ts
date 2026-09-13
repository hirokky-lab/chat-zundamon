import { expect, it } from "vitest";
import { createSupabaseBackupBlobStore } from "../src/supabase-backup-store.js";
import { createBackupService, restoreBackup } from "../src/backup.js";

it("stores encrypted backups and prunes only dated backups across paginated listings", async () => {
  const files = new Map<string, string>();
  for (let n = 1; n <= 120; n++) files.set(`backups/daily/${new Date(Date.UTC(2025,0,n)).toISOString().slice(0,10)}.json`, "old");
  files.set("backups/daily/notes.txt", "keep");
  const store = createSupabaseBackupBlobStore({
    async upload(path, body) { files.set(path, body); return { error:null }; },
    async list(folder, options) { return {error:null, data:[...files.keys()].filter(p=>p.startsWith(folder+"/")).sort().slice(options.offset,options.offset+options.limit).map(p=>({name:p.slice(folder.length+1)}))}; },
    async remove(paths) { paths.forEach(p=>files.delete(p)); return {error:null}; },
  });
  const key=Buffer.alloc(32,1);
  await createBackupService({repository:{exportAll:async()=>({version:1,profiles:[{display_name:"private name"}],memories:[],chatSnapshots:[],usageEvents:[]})},blobs:store,key,now:()=>new Date("2026-09-07T00:00:00Z")}).run();
  expect([...files.keys()].filter(p=>p.endsWith(".json"))).toHaveLength(7);
  expect(files.get("backups/daily/notes.txt")).toBe("keep");
  const body=files.get("backups/daily/2026-09-07.json")!;
  expect(body).not.toContain("private name");
  expect(restoreBackup(JSON.parse(body),key).profiles).toEqual([{display_name:"private name"}]);
  await expect(store.delete(["../other/file"])).rejects.toThrow();
});
it("fails closed on storage errors without exposing provider errors", async () => {
  const failed=async()=>({error:{message:"private credential"},data:null});
  const store=createSupabaseBackupBlobStore({upload:failed,list:failed,remove:failed});
  await expect(store.put("backups/daily/2026-09-07.json","encrypted")).rejects.toThrow("Backup storage unavailable");
  await expect(store.list("backups/daily/")).rejects.toThrow("Backup storage unavailable");
  await expect(store.delete(["backups/daily/2026-09-07.json"])).rejects.toThrow("Backup storage unavailable");
});
