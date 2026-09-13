import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexJobs } from '../src/codex/jobs';
import { registerCodex } from '../src/codex/routes';
import { registerAuthentication } from '../src/auth';
import type { CodexServerRequest, CodexNotification } from '../src/codex/rpc';
const directories: string[] = [];
const services: CodexJobs[] = [];
afterEach(() => { services.splice(0).forEach(service => service.close()); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-jobs-')); directories.push(directory);
  let notify = (_message: CodexNotification) => {};
  let onRequest = (_message: CodexServerRequest) => {};
  const rpc = {
    onRequest: (listener: typeof onRequest) => { onRequest = listener; return () => {}; }, respond: vi.fn(), reject: vi.fn(),
    request: vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'project/list') return { data: [{ id: 'p2', name: 'another-app', roots: [{ path: '/another/app' }] }], nextCursor: null };
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, sandbox: { type: 'readOnly' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      return {};
    }),
    onNotification: (listener: typeof notify) => { notify = listener; return () => {}; },
    onClose: (_listener: () => void) => () => {}, close: vi.fn(),
  };
  const connect = vi.fn(async () => rpc);
  const options = { directory, project: '/fixed/project', binary: 'codex', connect };
  const jobs = new CodexJobs(options); services.push(jobs);
  return { jobs, options, rpc, connect, incoming: (message: CodexServerRequest) => onRequest(message), emit: (message: CodexNotification) => notify(message) };
}
const completed = { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'READMEを確認しました。' }] } } };
describe('Codex research jobs', () => {
  it('inherits Codex settings and deduplicates requests', async () => {
    const { jobs, rpc, connect } = setup();
    const first = jobs.start('owner', 'request-1', 'READMEを調べて');
    expect(jobs.start('owner', 'request-1', 'READMEを調べて').id).toBe(first.id);
    expect(() => jobs.start('owner', 'request-2', 'もう一件')).toThrow('codex_busy');
    await vi.waitFor(() => expect(jobs.latest('owner')?.status).toBe('working'));
    expect(connect).toHaveBeenCalledOnce();
    expect(rpc.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ cwd: '/fixed/project' }), 30000);
    const start = rpc.request.mock.calls.find(c => c[0] === 'thread/start')![1] as object;
    expect(start).not.toHaveProperty('sandbox'); expect(start).not.toHaveProperty('approvalPolicy');
    const turn = rpc.request.mock.calls.find(c => c[0] === 'turn/start')![1] as object;
    expect(turn).not.toHaveProperty('sandboxPolicy'); expect(turn).not.toHaveProperty('effort');
    expect(jobs.get('another-owner', 'request-1')).toBeNull();
  });
  it('uses projects from Codex and supports editing requests without fixed scope', async () => {
    const { jobs, rpc } = setup(); jobs.start('owner', 'r1', 'another-appを修正して');
    await vi.waitFor(() => expect(jobs.latest('owner')?.status).toBe('working'));
    expect(rpc.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ cwd: '/another/app', projectId: 'p2' }), 30000);
  });
  it('relays approvals, rejects foreign and stale answers, and never invents grants', async () => {
    const { jobs, rpc, incoming } = setup(); jobs.start('owner', 'r1', '修正して');
    await vi.waitFor(() => expect(jobs.latest('owner')?.turnId).toBe('turn-1'));
    incoming({ id: 23, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', command: 'npm test' } });
    const pending = jobs.latest('owner')!.pending![0];
    expect(jobs.latest('owner')?.status).toBe('waiting'); expect(rpc.respond).not.toHaveBeenCalled();
    await expect(jobs.answer('other', 'r1', pending.id, { choice: '0' })).rejects.toThrow('request_expired');
    await expect(jobs.answer('owner', 'r1', pending.id, { choice: 'invented' })).rejects.toThrow('invalid_answer');
    await jobs.answer('owner', 'r1', pending.id, { choice: '0' });
    expect(rpc.respond).toHaveBeenCalledWith(23, { decision: 'accept' });
    await expect(jobs.answer('owner', 'r1', pending.id, { choice: '0' })).rejects.toThrow('request_expired');
    expect(jobs.latest('owner')?.pending).toEqual([]);
  });
  it('restores pending questions on reload, removes resolved requests, and discards cancelled answers', async () => {
    const { jobs, rpc, incoming, emit } = setup(); jobs.start('owner', 'r1', '確認して');
    await vi.waitFor(() => expect(jobs.latest('owner')?.turnId).toBe('turn-1'));
    const params = { threadId: 'thread-1', turnId: 'turn-1', questions: [{ id: 'target', question: '対象は？' }] };
    incoming({ id: 'q1', method: 'item/tool/requestUserInput', params });
    const id = jobs.get('owner','r1')!.pending![0].id;
    await jobs.answer('owner', 'r1', id, { answers: { target: 'another-app' } });
    expect(rpc.respond).toHaveBeenCalledWith('q1', { answers: { target: { answers: ['another-app'] } } });
    incoming({ id: 'q2', method: 'item/tool/requestUserInput', params });
    emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'q2' } });
    expect(jobs.latest('owner')?.pending).toEqual([]);
    incoming({ id: 'q3', method: 'item/tool/requestUserInput', params });
    const id3 = jobs.latest('owner')!.pending![0].id; jobs.cancel('owner', 'r1');
    await expect(jobs.answer('owner', 'r1', id3, { answers: { target: 'x' } })).rejects.toThrow('request_expired');
  });
  it('keeps asynchronous questions after turn completion and continues with the answer', async () => {
    const { jobs, rpc, emit } = setup(); jobs.start('owner', 'r1', '質問して');
    await vi.waitFor(() => expect(jobs.latest('owner')?.turnId).toBe('turn-1'));
    emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'async-question', type: 'agentMessage', questions: [{ title: '色は？', options: ['緑','青'] }] } } });
    emit(completed);
    await new Promise(resolve=>setTimeout(resolve, 0));
    const pending = jobs.latest('owner')!.pending![0];
    expect(jobs.latest('owner')?.status).toBe('waiting'); expect(rpc.close).not.toHaveBeenCalled();
    await jobs.answer('owner', 'r1', pending.id, { answers: { '0': '緑' } });
    expect(rpc.request.mock.calls.filter(c=>c[0]==='turn/start')).toHaveLength(2);
    expect(JSON.stringify(rpc.request.mock.calls.at(-1))).toContain('緑');
    emit(completed); await vi.waitFor(()=>expect(jobs.latest('owner')?.status).toBe('completed'));
  });
  it('continues only an owned agent thread and passes conversation context', async () => {
    const { jobs, rpc, emit } = setup(); jobs.start('owner', 'r1', 'another-appを確認');
    await vi.waitFor(() => expect(jobs.latest('owner')?.turnId).toBe('turn-1')); emit(completed);
    await vi.waitFor(() => expect(jobs.latest('owner')?.status).toBe('completed'));
    jobs.start('owner', 'r2', '続けて直して', { previousRequestId: 'r1', context: '前の会話' });
    await vi.waitFor(() => expect(jobs.latest('owner')?.status).toBe('working'));
    expect(rpc.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId: 'thread-1', cwd: '/another/app' }), 30000);
    const turn = rpc.request.mock.calls.filter(c=>c[0]==='turn/start').at(-1)![1];
    expect(JSON.stringify(turn)).toContain('前の会話');
  });
  it('persists final results and never restarts them on retry', async () => {
    const { jobs, options, emit, connect } = setup();
    jobs.start('owner', 'request-1', '調査');
    await vi.waitFor(() => expect(jobs.latest('owner')?.turnId).toBe('turn-1'));
    emit(completed);
    await vi.waitFor(() => expect(jobs.latest('owner')?.status).toBe('completed'));
    const restored = new CodexJobs(options);
    expect(restored.latest('owner')?.result).toBe('READMEを確認しました。');
    restored.start('owner', 'request-1', '調査');
    expect(connect).toHaveBeenCalledOnce();
  });
  it('redacts concrete credentials without hiding useful paths or technical terminology', async () => {
    const { jobs, emit } = setup();
    jobs.start('owner', 'request-1', '調査');
    await vi.waitFor(() => expect(jobs.latest('owner')?.turnId).toBe('turn-1'));
    const event=structuredClone(completed);
    event.params.turn.items[0].text='READMEを確認しました。\nAPIキーは設定画面から入力します。\n値: sk-proj-abcdefghijklmnopqrstuvwxyza\n次はVRMの姿勢を見直します。';
    emit(event);
    await vi.waitFor(() => expect(jobs.latest('owner')?.status).toBe('completed'));
    expect(jobs.latest('owner')?.result).toBe('READMEを確認しました。\nAPIキーは設定画面から入力します。\n値: ［秘密値を省略］\n次はVRMの姿勢を見直します。');
  });
  it('remembers cancellation that arrives before creation', () => {
    const { jobs, connect } = setup();
    jobs.cancel('owner', 'request-1');
    expect(jobs.start('owner', 'request-1', '調査').status).toBe('cancelled');
    expect(connect).not.toHaveBeenCalled();
  });
  it('interrupts active work and rejects late completion', async () => {
    const { jobs, rpc, emit } = setup();
    jobs.start('owner', 'request-1', '調査');
    await vi.waitFor(() => expect(jobs.latest('owner')?.turnId).toBe('turn-1'));
    jobs.cancel('other-owner', 'request-1');
    expect(jobs.latest('owner')?.status).toBe('working');
    jobs.cancel('owner', 'request-1'); emit(completed);
    await vi.waitFor(() => expect(rpc.close).toHaveBeenCalled());
    expect(rpc.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' }, 2000);
    expect(jobs.latest('owner')).toMatchObject({ status: 'cancelled', result: null });
  });
  it('marks interrupted receipts as failed after server restart', async () => {
    const { jobs, options, connect } = setup();
    jobs.start('owner', 'request-1', '調査');
    await vi.waitFor(() => expect(jobs.latest('owner')?.status).toBe('working'));
    expect(new CodexJobs(options).latest('owner')?.status).toBe('failed');
    expect(connect).toHaveBeenCalledOnce();
  });
  it('requires authentication, origin, and refuses browser-selected cwd', async () => {
    const { jobs, connect } = setup();
    const app = Fastify();
    registerAuthentication(app, { allowedOrigin: 'https://app.test', verifier: { verify: async token => token === 'owner-token' ? { userId: 'owner', email: 'owner@test.test', accessToken: token } : null } });
    registerCodex(app, { jobs, origin: 'https://app.test' });
    expect((await app.inject({ method: 'POST', url: '/api/codex/jobs', payload: { requestId: 'r', prompt: '調査' } })).statusCode).toBe(401);
    const headers = { authorization: 'Bearer owner-token', origin: 'https://evil.test' };
    expect((await app.inject({ method: 'POST', url: '/api/codex/jobs', headers, payload: { requestId: 'r', prompt: '調査' } })).statusCode).toBe(403);
    headers.origin = 'https://app.test';
    expect((await app.inject({ method: 'POST', url: '/api/codex/jobs', headers, payload: { requestId: 'r', prompt: '調査', cwd: '/another/project' } })).statusCode).toBe(400);
    expect(connect).not.toHaveBeenCalled();
    await app.close();
  });
});
