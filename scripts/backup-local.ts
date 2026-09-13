import { mkdir, readFile, writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadEnvFile } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createSupabaseBackupRepository, createBackupEnvelope, restoreBackup } from '../apps/server/src/backup';

// Operator-only local export. No route, uploads, source database mutations or live restore.
process.umask(0o077);
const root = fileURLToPath(new URL('..', import.meta.url));
const backupRoot = resolve(root, 'data/backups');
const keyPath = resolve(homedir(), '.local/share/chat-zundamon/backup.key');
async function run() {
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!existsSync(keyPath)) await writeFile(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  await chmod(keyPath, 0o600);
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new Error('backup_key_invalid');
  loadEnvFile(resolve(root, '.env.connection.local'));
  const { ZUNDAMON_SUPABASE_URL: url, ZUNDAMON_SUPABASE_SERVICE_ROLE_KEY: token } = process.env;
  if (!url || !token) throw new Error('backup_configuration_missing');
  const stage = await mkdtemp(resolve(backupRoot, '.stage-'));
  try {
    const snapshot = await createSupabaseBackupRepository(url, token).exportAll();
    const envelope = createBackupEnvelope(snapshot, key, new Date());
    const restored = restoreBackup(envelope, key);
    if (JSON.stringify(restored) !== JSON.stringify(snapshot)) throw new Error('backup_roundtrip_failed');
    await writeFile(resolve(stage, 'cloud-non-photo.json'), JSON.stringify(envelope), { mode: 0o600 });
    const archive = resolve(stage, 'payload.tar.gz');
    const localPaths = ['.env.connection.local', 'apps/web/.env.local-live2d.local', 'data', 'apps/web/public/live2d'];
    const available = localPaths.filter(path => existsSync(resolve(root, path)));
    execFileSync('/usr/bin/tar', ['-czf', archive, '--exclude=data/backups', '-C', root, ...available, '-C', stage, 'cloud-non-photo.json'], { stdio: 'pipe' });
    const payload = await readFile(archive);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const destination = resolve(backupRoot, `chat-zundamon-${new Date().toISOString().replace(/[:.]/g, '-')}.enc`);
    await writeFile(destination, Buffer.concat([Buffer.from('CZB1'), iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
    // Verify the actual persisted encrypted bytes, then open the archive in an isolated directory.
    const persisted = await readFile(destination);
    const decipher = createDecipheriv('aes-256-gcm', key, persisted.subarray(4, 16));
    decipher.setAuthTag(persisted.subarray(16, 32));
    const decoded = Buffer.concat([decipher.update(persisted.subarray(32)), decipher.final()]);
    if (!decoded.equals(payload)) throw new Error('backup_readback_failed');
    await writeFile(archive, decoded);
    const names = execFileSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean);
    if (names.some(name => name.startsWith('/') || name.split('/').includes('..'))) throw new Error('backup_path_invalid');
    const check = resolve(stage, 'restore-check'); await mkdir(check, { mode: 0o700 });
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', check], { stdio: 'pipe' });
    for (const path of available.filter(path => path.startsWith('.env') || path.includes('/.env'))) {
      if (!(await readFile(resolve(check, path))).equals(await readFile(resolve(root, path)))) throw new Error('local_restore_verification_failed');
    }
    const summary = { version: 1, createdAt: new Date().toISOString(), encryptedFile: destination,
      sha256: createHash('sha256').update(persisted).digest('hex'), bytes: persisted.length,
      verified: true, collections: Object.fromEntries(Object.entries(snapshot).filter(([, value]) => Array.isArray(value)).map(([name, value]) => [name, (value as unknown[]).length])),
      scope: 'local configuration, local data, Live2D assets, cloud profiles/memories/non-photo history/usage',
      excludes: 'Supabase auth, Google tokens in cloud, cloud photos/VRM objects, deletion ledger and other cloud tables; not a full database recovery image',
      consistency: 'paginated read, not a transactional database snapshot; keep the app idle during export' };
    await writeFile(destination + '.json', JSON.stringify(summary, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(summary));
  } finally { await rm(stage, { recursive: true, force: true }); }
}
run().catch(() => { console.error('バックアップを完了できませんでした。接続と手元の空き容量を確認してください。既存データは変更していません。'); process.exitCode = 1; });
