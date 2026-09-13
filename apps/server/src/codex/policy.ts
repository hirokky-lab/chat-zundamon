import { CodexRpc } from './rpc.js';

/** Use the owner's Codex settings; do not override its sandbox, approvals, model or tools. */
export async function connectCodex(binary: string, cwd: string): Promise<CodexRpc> {
  const rpc = await CodexRpc.connect(binary, [], cwd);
  try {
    if (!await rpc.signedIn()) throw Error('codex_login_required');
    return rpc;
  } catch (error) { rpc.close(); throw error; }
}
