import { describe, expect, it, vi } from 'vitest';
import { CodexRpc } from '../src/codex/rpc';
import { connectCodex } from '../src/codex/policy';
describe('Codex owner configuration', () => {
  it('inherits configuration without imposing research-only overrides', async () => {
    const rpc = { signedIn: vi.fn(async () => true), close: vi.fn() };
    const connect = vi.spyOn(CodexRpc, 'connect').mockResolvedValue(rpc as unknown as CodexRpc);
    expect(await connectCodex('codex', '/work')).toBe(rpc);
    expect(connect).toHaveBeenCalledWith('codex', [], '/work');
    expect(rpc.close).not.toHaveBeenCalled(); connect.mockRestore();
  });
  it('closes a signed-out connection', async () => {
    const rpc = { signedIn: vi.fn(async () => false), close: vi.fn() };
    const connect = vi.spyOn(CodexRpc, 'connect').mockResolvedValue(rpc as unknown as CodexRpc);
    await expect(connectCodex('codex', '/work')).rejects.toThrow('codex_login_required');
    expect(rpc.close).toHaveBeenCalled(); connect.mockRestore();
  });
});
