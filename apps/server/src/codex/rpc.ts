import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type CodexNotification = { method: string; params?: unknown };
export type CodexServerRequest = { id: string | number; method: string; params?: unknown };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Private stdio transport. Never forwards arbitrary browser RPC or raw process logs. */
export class CodexRpc {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;
  private closeListeners = new Set<() => void>();
  private listeners = new Set<(message: CodexNotification) => void>();
  private requestListener?: (message: CodexServerRequest) => void;

  constructor(private process: ChildProcessWithoutNullStreams) {
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Process diagnostics can contain paths or credentials. Drain without publishing them.
    process.stderr.resume();
    process.on('error', () => this.close(new Error('codex_unavailable')));
    process.on('exit', () => this.close(new Error('codex_disconnected')));
    process.stdin.on('error', () => this.close(new Error('codex_disconnected')));
  }

  static async connect(binary = 'codex', configuration: string[] = [], cwd?: string) {
    const env = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'SHELL', 'CODEX_HOME'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
    const rpc = new CodexRpc(spawn(binary, ['app-server', '--stdio', ...configuration.flatMap(value => ['-c', value])], { stdio: 'pipe', shell: false, env, cwd }));
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'zundamon_ai', title: 'ずんだもんAI', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      rpc.send({ method: 'initialized' });
      return rpc;
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  async signedIn(): Promise<boolean> {
    const response = await this.request('account/read', { refreshToken: false }) as { account?: unknown };
    return !!response.account;
  }

  onNotification(listener: (message: CodexNotification) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onRequest(listener: (message: CodexServerRequest) => void) {
    this.requestListener = listener;
    return () => { if (this.requestListener === listener) this.requestListener = undefined; };
  }

  respond(id: string | number, result: unknown) { this.send({ id, result }); }
  reject(id: string | number) { this.send({ id, error: { code: -32601, message: 'Request not supported by this client' } }); }

  onClose(listener: () => void) {
    if (this.closed) { listener(); return () => {}; }
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('codex_disconnected'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('codex_timeout'));
        // An uncertain request may still be executing. Dispose the private session.
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  close(reason = new Error('codex_disconnected')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
    this.listeners.clear();
    this.requestListener = undefined;
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.process.stdin.end();
    this.process.kill();
    const force = setTimeout(() => { if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill("SIGKILL"); }, 2000);
    force.unref();
  }

  private send(message: unknown) {
    if (!this.closed) this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  private receive(chunk: string) {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > 2_000_000) { this.close(new Error('codex_response_too_large')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object') throw new Error();
        if (typeof message.method === 'string') {
          if (message.id !== undefined) {
            if (this.requestListener) this.requestListener(message);
            else this.reject(message.id);
          } else {
            for (const listener of this.listeners) listener({ method: message.method, params: message.params });
          }
        } else if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error('codex_request_failed'));
          else if ('result' in message) pending.resolve(message.result);
          else pending.reject(new Error('codex_invalid_response'));
        }
      } catch { this.close(new Error('codex_invalid_response')); return; }
    }
  }
}
