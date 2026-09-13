import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractLocalBackup } from './restore-local.mjs';

async function fixture(t, link = false) {
  const root = await mkdtemp(join(tmpdir(), 'chat-zundamon-backup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'example.txt'), 'fictional recovery data');
  if (link) await symlink('/tmp', join(source, 'outside'));
  const tar = join(root, 'payload.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', tar, '-C', source, '.']);
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(await readFile(tar)), cipher.final()]);
  const archive = join(root, 'backup.enc'), keyPath = join(root, 'key'), destination = join(root, 'restored');
  await writeFile(archive, Buffer.concat([Buffer.from('CZB1'), iv, cipher.getAuthTag(), body]));
  await writeFile(keyPath, key);
  return { root, archive, keyPath, destination };
}
test('extracts authenticated backup into a new directory', async t => {
  const f = await fixture(t);
  await extractLocalBackup(f.archive, f.destination, f.keyPath);
  assert.equal(await readFile(join(f.destination, 'example.txt'), 'utf8'), 'fictional recovery data');
});
test('never replaces an existing directory or its contents', async t => {
  const f = await fixture(t); await mkdir(f.destination);
  await writeFile(join(f.destination, 'keep.txt'), 'keep');
  await assert.rejects(extractLocalBackup(f.archive, f.destination, f.keyPath));
  assert.equal(await readFile(join(f.destination, 'keep.txt'), 'utf8'), 'keep');
});
test('rejects tampering before creating a destination', async t => {
  const f = await fixture(t); const data = await readFile(f.archive); data[data.length - 1] ^= 1;
  await writeFile(f.archive, data);
  await assert.rejects(extractLocalBackup(f.archive, f.destination, f.keyPath));
  await assert.rejects(access(f.destination));
});
test('rejects archive links before extraction', async t => {
  const f = await fixture(t, true);
  await assert.rejects(extractLocalBackup(f.archive, f.destination, f.keyPath), /unsafe_archive_entry/);
  await assert.rejects(access(f.destination));
});
