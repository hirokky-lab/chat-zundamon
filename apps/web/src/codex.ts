import type { ChatApi, ChatRequest } from './api';
import { YuiRequestError } from './api';
import type { ChatReply } from '@yui/domain';
import { codexWorking, type CodexJob, type CodexAnswer } from '@yui/domain';
export { codexWorking };
export type { CodexJob };
export type CodexApi = {
  status(): Promise<{ enabled: boolean; project: string; mode: string; connected?: boolean; model?: string | null; projectCount?: number; message?: string }>;
  latest(signal?: AbortSignal): Promise<CodexJob | null>;
  get(requestId: string, signal?: AbortSignal): Promise<CodexJob>;
  start(requestId: string, prompt: string, signal?: AbortSignal, context?: { context?: string; previousRequestId?: string }): Promise<CodexJob>;
  answer(requestId: string, pendingId: string, answer: CodexAnswer): Promise<CodexJob>;
  cancel(requestId: string): Promise<CodexJob>;
};
type Fetch = typeof globalThis.fetch;
export function createCodexApi(fetch: Fetch): CodexApi {
  async function request(path: string, init?: RequestInit) {
    const response = await fetch('/api/codex/' + path, { cache: 'no-store', ...init });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (error.error === 'codex_busy') throw Error('Codexは別の作業中です。完了するか停止してから依頼してください。');
      if (error.error === 'secret_not_allowed') throw Error('秘密情報を含む依頼は送れません。');
      if (error.error === 'request_expired') throw Error('この確認は終了しています。最新の状態を確認してください。');
      if (error.error === 'invalid_answer') throw Error('回答を入力してください。');
      if (error.error === 'codex_disabled') throw Error('このサーバーではCodex連携が有効になっていません。');
      throw new YuiRequestError(response.status === 401 ? 'authentication' : 'network');
    }
    return response.json();
  }
  const write = (method: string, body: unknown, signal?: AbortSignal) => request('jobs', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  return {
    status: () => request('status'),
    latest: async signal => (await request('jobs/latest', { signal })).job,
    get: async (id, signal) => (await request('jobs/' + encodeURIComponent(id), { signal })).job,
    start: async (requestId, prompt, signal, context) => (await write('POST', { requestId, prompt, ...context }, signal)).job,
    answer: async (requestId, pendingId, answer) => (await request('jobs/' + encodeURIComponent(requestId) + '/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pendingId, ...answer }) })).job,
    cancel: async requestId => (await write('DELETE', { requestId })).job,
  };
}
export function codexPrompt(text: string): string | null {
  const trimmed = text.trim();
  const explicit = /^(?:codex|コーデックス)[:：]\s*(.+)$/isu.exec(trimmed);
  if (explicit) return explicit[1].trim();

  // The recipient can follow the subject, including text transcribed from speech.
  const recipient = /(?:codex|コーデックス)(?:くん|君|さん|ちゃん)?(?:を使って|をつかって|に|へ|で)?/iu.exec(trimmed);
  if (!recipient || /[a-z0-9_]/iu.test(trimmed[recipient.index - 1] ?? '')) return null;
  const after = trimmed.slice(recipient.index + recipient[0].length).trim();
  if (/^[a-z0-9_]/iu.test(trimmed.slice(recipient.index + recipient[0].length)) && /codex$/iu.test(recipient[0])) return null;
  if (/^(?:ついて|関して|対して|よる|は|も|できる|の|とは)/u.test(after)
    || /(?:頼まない|依頼しない|聞かない|きかない|実行しない|調べない|しらべない|使わない|つかわない|やめて|停止して|キャンセルして)/u.test(trimmed)) return null;
  const prompt = (trimmed.slice(0, recipient.index) + after).replace(/^[\s、,。.!！?？]+|[\s、,。.!！?？]+$/gu, '').trim();
  return /(?:聞いて|きいて|尋ね|たずね|進捗|調べ|しらべ|調査|確認|かくにん|見て|みて|まとめ|整理|分析|レビュー|原因|修正|実装|追加|直して|なおして|作って|つくって|変更|消して|削除|動かして|実行|テスト|続けて|つづけて|進めて|すすめて|お願い|依頼)/u.test(prompt) ? prompt : null;
}
export const codexResultRequest = (text: string) => /^(?:codex|コーデックス)の結果を見せて[。！!]?$/iu.test(text.trim());
/** Short follow-ups refer only to the preceding Codex request, never an unrelated latest job. */
function codexStatusQuery(text: string): { explicit: boolean } | null {
  const compact = text.trim().replace(/[\s、,。.!！?？]/gu, '');
  const recipient = /^(?:codex|コーデックス)(?:くん|君|さん|ちゃん)?(?:の|は)?/iu;
  const explicit = recipient.test(compact);
  const query = compact.replace(recipient, '');
  return /^(?:(?:今|いま)(?:は|の)?|その後|そのご)?(?:待ち(?:なの|ですか)?|まだ(?:なの|ですか)?|終わった(?:の|かな)?|おわった|どう(?:なってる|なった|ですか)?|進捗(?:は|どう|を教えて|教えて|確認して)?|状況(?:は|どう|を教えて|教えて|確認して)?|作業中(?:なの|ですか)?|動いてる(?:の)?|実行中(?:なの|ですか)?)$/u.test(query) ? { explicit } : null;
}
function previousCodexRequest(input: ChatRequest): string | null {
  const users = input.timeline.filter(item => item.type === 'message' && item.role === 'user' && item.id !== input.clientMessageId);
  for (const item of [...users].reverse()) {
    if (item.type !== 'message') continue;
    if (codexStatusQuery(item.text)) continue;
    return codexPrompt(item.text) ? item.id : null;
  }
  return null;
}
function reply(input: ChatRequest, text: string): ChatReply {
  const replyGroupId = `${input.clientMessageId}:assistant`, createdAt = new Date().toISOString();
  const source = text.length > 1100 ? text.slice(0, 1040) + '\n続きはCodex欄の「全文」で確認できるのだ。' : text;
  const parts: string[] = [];
  let rest = source;
  while (rest.length && parts.length < 3) {
    let end = Math.min(380, rest.length);
    if (end < rest.length) {
      const boundary = Math.max(rest.lastIndexOf('。', end - 1), rest.lastIndexOf('\n', end - 1));
      if (boundary > Math.max(220, rest.length - (2 - parts.length) * 380)) end = boundary + 1;
    }
    parts.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  return { replyGroupId, bubbles: parts.map((text, index) => ({ id: `${replyGroupId}:${index}`, text, createdAt, sequence: index as 0 | 1 | 2, flow: 'external_context' })) };
}
function pause(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, 1000);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  });
}
/** Only explicit Codex requests enter this path. Ordinary conversation keeps its existing gateway. */
export function withCodex(chat: ChatApi, api: CodexApi, onJob: (job: CodexJob) => void, onError: (message: string) => void = () => {}): ChatApi {
  return { async respond(input, signal) {
    const message = input.timeline.find(item => item.type === 'message' && item.role === 'user' && item.id === input.clientMessageId);
    const text = message?.type === 'message' ? message.text : '';
    const statusQuery = input.kind === 'reply' ? codexStatusQuery(text) : null;
    const targetRequest = statusQuery ? previousCodexRequest(input) : null;
    if (statusQuery && (statusQuery.explicit || targetRequest)) {
      try {
        const job = targetRequest ? await api.get(targetRequest, signal) : await api.latest(signal);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (!job) return reply(input, 'Codexへの依頼はまだ確認できないのだ。');
        onJob(job);
        const state = {
          connecting: 'Codexに接続しているところなのだ。', researching: 'Codexで調査中なのだ。', working: 'Codexで作業中なのだ。',
          waiting: 'Codexからの質問・承認への回答待ちなのだ。Codex欄で確認してね。',
          completed: 'Codexの作業は完了しているのだ。結果はCodex欄で確認できるよ。',
          cancelled: 'Codexの作業は停止しているのだ。', failed: 'Codexの作業はエラーで終了しているのだ。Codex欄で内容を確認してね。',
        }[job.status];
        return reply(input, state);
      } catch (error) {
        if (signal?.aborted || (error instanceof YuiRequestError && error.kind === 'authentication')) throw error;
        return reply(input, 'この依頼の受け付け・進捗をCodexで確認できなかったのだ。作業中かどうかは、まだ分からないよ。');
      }
    }
    const prompt = input.kind === 'reply' ? codexPrompt(text) : null;
    const resultRequest = input.kind === 'reply' && codexResultRequest(text);
    if (!prompt && !resultRequest) return chat.respond(input, signal);
    if (resultRequest) {
      const job = await api.latest(signal);
      if (job) onJob(job);
      return reply(input, job?.result ? 'Codexの作業結果なのだ。\n' + job.result : job?.message ?? 'まだCodexへの依頼はないのだ。');
    }
    onError('');
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      // Use the request key even before POST completes. The server remembers early cancellation.
      if (signal?.reason === 'chat-disposed') return;
      void api.cancel(input.clientMessageId).then(onJob).catch(() => onError('停止を確認できませんでした。Codex欄からもう一度停止してください。'));
    };
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const previous = await api.latest(signal);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const context = input.timeline.filter(item => item.type === 'message' && item.id !== input.clientMessageId).slice(-12).map(item => item.type === 'message' ? `${item.role}: ${item.text}` : '').join('\n').slice(-16000);
      const previousRequestId = previous && previous.requestId !== input.clientMessageId && input.timeline.some(item => item.type === 'message' && item.id === previous.requestId) ? previous.requestId : undefined;
      let job = await api.start(input.clientMessageId, prompt!, signal, { context, previousRequestId });
      onJob(job);
      while (codexWorking(job)) {
        await pause(signal);
        job = await api.get(input.clientMessageId, signal); onJob(job);
      }
      return reply(input, job.result ? 'Codexの作業結果なのだ。\n' + job.result : job.message);
    } catch (error) {
      if (cancelled || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (error instanceof YuiRequestError) throw error;
      return reply(input, error instanceof Error ? error.message : 'Codexに接続できなかったのだ。');
    } finally { signal?.removeEventListener('abort', stop); }
  } };
}
