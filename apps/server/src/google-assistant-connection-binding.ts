import { createHash } from 'node:crypto';
/** Server-only identity of the exact credential snapshot. Never expose this or token bytes. */
export function googleConnectionBinding(connection: { googleSubject: string; refreshToken: Buffer; generation?: string }): string {
  return createHash('sha256').update('yui-google-credential-v1\n').update(connection.googleSubject).update('\0').update(connection.generation ?? '').update('\0').update(connection.refreshToken).digest('hex');
}
