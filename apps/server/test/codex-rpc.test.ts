import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { CodexRpc } from '../src/codex/rpc';
function setup() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const writes: string[] = [];
  process.stdin.on('data', chunk => writes.push(String(chunk)));
  const rpc = new CodexRpc(process as unknown as ChildProcessWithoutNullStreams);
  return { process, rpc, writes };
}
describe('private Codex RPC', () => {
  it('handles split lines and returns only a sign-in boolean', async () => {
    const { rpc, process } = setup();
    const signedIn = rpc.signedIn();
    process.stdout.write('{"id":1,"result":');
    process.stdout.write('{"account":{"email":"private@example.test"}}}\n');
    await expect(signedIn).resolves.toBe(true);
    rpc.close();
  });
  it('rejects pending requests on disconnect without exposing diagnostics', async () => {
    const { rpc, process } = setup();
    const request = rpc.request('account/read', {});
    process.stderr.write('private diagnostics');
    process.emit('exit', 1);
    await expect(request).rejects.toThrow('codex_disconnected');
    expect(process.kill).toHaveBeenCalledOnce();
  });
  it('does not grant incoming approvals or execute tool requests', () => {
    const { rpc, process, writes } = setup();
    process.stdout.write('{"id":8,"method":"item/commandExecution/requestApproval","params":{}}\n');
    expect(JSON.parse(writes[0])).toMatchObject({ id: 8, error: { code: -32601 } });
    rpc.close();
  });
  it('disposes uncertain requests after timeout', async () => {
    const { rpc, process } = setup();
    await expect(rpc.request('account/read', {}, 5)).rejects.toThrow('codex_timeout');
    expect(process.kill).toHaveBeenCalledOnce();
  });
});
