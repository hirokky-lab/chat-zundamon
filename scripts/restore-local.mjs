import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Extract only into a new directory. Never replace the running app or write to the DB.
export async function extractLocalBackup(archivePath, destination, keyPath) {
  const [encrypted, key] = await Promise.all([readFile(archivePath), readFile(keyPath)]);
  if (key.length !== 32 || encrypted.length <= 32 || encrypted.subarray(0, 4).toString() !== 'CZB1') throw Error('invalid_backup');
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(4, 16));
  decipher.setAuthTag(encrypted.subarray(16, 32));
  const payload = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
  const stage = await mkdtemp(join(tmpdir(), 'chat-zundamon-restore-'));
  let created = false;
  try {
    const tarPath = join(stage, 'backup.tar.gz');
    await writeFile(tarPath, payload, { mode: 0o600 });
    const names = execFileSync('/usr/bin/tar', ['-tzf', tarPath], { encoding: 'utf8' }).trim().split('\n');
    const entries = execFileSync('/usr/bin/tar', ['-tvzf', tarPath], { encoding: 'utf8' }).trim().split('\n');
    if (names.some(name => !name || name.startsWith('/') || name.split('/').includes('..')) || entries.some(line => !['-', 'd'].includes(line[0]))) throw Error('unsafe_archive_entry');
    await mkdir(destination, { mode: 0o700 }); // EEXIST is intentional, even for an empty directory.
    created = true;
    execFileSync('/usr/bin/tar', ['-xzf', tarPath, '-C', destination, '--no-same-owner'], { stdio: 'pipe' });
    return { extracted: true, entries: names.length, destination };
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const [archivePath, destination, keyPath = join(homedir(), '.local/share/chat-zundamon/backup.key')] = process.argv.slice(2);
  if (!archivePath || !destination) {
    console.error('使い方: pnpm restore:local <バックアップ.enc> <新しい展開先フォルダ> [鍵ファイルのパス]');
    process.exitCode = 1;
  } else {
    extractLocalBackup(resolve(archivePath), resolve(destination), resolve(keyPath))
      .then(result => console.log(JSON.stringify(result)))
      .catch(() => { console.error('展開できませんでした。バックアップ・鍵・新規の展開先を確認してください。既存フォルダやDBには書き込んでいません。'); process.exitCode = 1; });
  }
}
