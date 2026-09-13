import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CodexAnswer, CodexPendingRequest, CodexQuestion } from '@yui/domain';
import type { CodexServerRequest } from './rpc.js';

export type PendingRequest = { rpcId: string | number; asynchronous?: boolean; view: CodexPendingRequest; answer: (answer: CodexAnswer) => unknown };
const text = (v: unknown) => typeof v === 'string' ? v : '';
const display = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v, null, 2);
const question = z.object({ id: z.string(), question: z.string(), isSecret: z.boolean().optional(), options: z.array(z.object({ label: z.string() })).nullable().optional() });
const labels: Record<string, string> = { accept: '今回許可', acceptForSession: 'この作業中は許可', decline: '許可しない', cancel: '取り消す' };

/** Only decisions attached to the actual Codex request may be sent back. */
export function prepareRequest(request: CodexServerRequest, item?: unknown): PendingRequest | null {
  const p = z.record(z.string(), z.unknown()).parse(request.params);
  const id = randomUUID();
  const view: CodexPendingRequest = { id, kind: 'approval', title: 'Codexからの確認', details: text(p.reason), choices: [] };
  const choices = new Map<string, unknown>();
  const add = (key: string, label: string, response: unknown) => { view.choices.push({ id: key, label }); choices.set(key, response); };
  let answer: PendingRequest['answer'] = a => {
    if (!a.choice || !choices.has(a.choice)) throw Error('invalid_answer');
    return choices.get(a.choice);
  };
  if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
    view.title = request.method.includes('commandExecution') ? 'Codexが実行の許可を求めています' : 'Codexが変更の許可を求めています';
    view.details = [p.reason, p.cwd, p.command, p.grantRoot, p.networkApprovalContext, item].filter(Boolean).map(display).join('\n\n');
    // Preserve the offered decisions, including scoped policy amendments, without inventing grants.
    const offered = Array.isArray(p.availableDecisions) ? p.availableDecisions : ['accept', 'decline', 'cancel'];
    for (const [i, decision] of offered.entries()) {
      const label = typeof decision === 'string' ? labels[decision] : '提示されたルールで許可';
      if (label) add(String(i), label, { decision });
    }
  } else if (request.method === 'item/permissions/requestApproval') {
    view.title = 'Codexが追加のアクセス許可を求めています';
    view.details = [p.reason, p.cwd, p.permissions].filter(Boolean).map(display).join('\n\n');
    add('accept', '今回許可', { permissions: p.permissions, scope: 'turn' });
    add('decline', '許可しない', { permissions: {}, scope: 'turn' });
  } else if (request.method === 'item/tool/requestUserInput') {
    view.kind = 'questions'; view.title = 'Codexからの質問';
    view.questions = z.array(question).min(1).parse(p.questions).map(q => ({ id: q.id, question: q.question, options: q.options?.map(o => o.label), secret: q.isSecret, required: true }));
    view.choices = [{ id: 'send', label: '回答を送る' }];
    answer = a => {
      const answers: Record<string, { answers: string[] }> = Object.create(null);
      for (const q of view.questions!) {
        const value = a.answers?.[q.id]?.trim();
        if (!value) throw Error('invalid_answer');
        answers[q.id] = { answers: [value] };
      }
      return { answers };
    };
  } else if (request.method === 'mcpServer/elicitation/request') {
    view.title = `${text(p.serverName)}からの確認`; view.details = text(p.message);
    add('decline', '辞退する', { action: 'decline', content: null });
    add('cancel', '取り消す', { action: 'cancel', content: null });
    if (p.mode === 'url') {
      view.kind = 'url';
      const url = new URL(text(p.url));
      if (!['http:', 'https:'].includes(url.protocol)) throw Error('unsupported_request');
      view.url = url.href;
      add('accept', '確認しました', { action: 'accept', content: null });
    } else if (p.mode === 'form' || p.mode === 'openai/form' || p.mode === 'openaiForm') {
      view.kind = 'form';
      const schema = z.object({ properties: z.record(z.string(), z.record(z.string(), z.unknown())), required: z.array(z.string()).optional() }).parse(p.requestedSchema);
      view.questions = Object.entries(schema.properties).map(([key, prop]): CodexQuestion => {
        if (!['string', 'number', 'integer', 'boolean'].includes(text(prop.type))) throw Error('unsupported_request');
        return { id: key, question: text(prop.title) || key, required: schema.required?.includes(key), type: prop.type as CodexQuestion['type'], options: Array.isArray(prop.enum) ? prop.enum.map(String) : prop.type === 'boolean' ? ['true', 'false'] : undefined };
      });
      view.choices.unshift({ id: 'accept', label: '回答を送る' });
      const fallback = answer;
      answer = a => {
        if (a.choice !== 'accept') return fallback(a);
        const content: Record<string, unknown> = Object.create(null);
        for (const q of view.questions!) {
          const value = a.answers?.[q.id]?.trim();
          if (!value) { if (q.required) throw Error('invalid_answer'); else continue; }
          if (q.options && !q.options.includes(value)) throw Error('invalid_answer');
          content[q.id] = q.type === 'boolean' ? value === 'true' : q.type === 'number' || q.type === 'integer' ? Number(value) : value;
          if ((q.type === 'number' || q.type === 'integer') && (!Number.isFinite(content[q.id]) || q.type === 'integer' && !Number.isInteger(content[q.id]))) throw Error('invalid_answer');
        }
        return { action: 'accept', content };
      };
    } else return null;
  } else return null;
  return { rpcId: request.id, view, answer };
}

/** Default-mode questions arrive as agent-message items rather than blocking RPC requests. */
export function prepareAsyncQuestions(item: unknown): PendingRequest | null {
  const parsed = z.object({ id: z.string(), type: z.literal('agentMessage'), questions: z.array(z.object({ title: z.string(), options: z.array(z.string()).nullable().optional() })).min(1) }).safeParse(item);
  if (!parsed.success) return null;
  const view: CodexPendingRequest = { id: randomUUID(), kind: 'questions', title: 'Codexからの質問', details: '', choices: [{ id: 'send', label: '回答を送る' }], questions: parsed.data.questions.map((q, i) => ({ id: String(i), question: q.title, options: q.options ?? undefined, required: true })) };
  return { rpcId: parsed.data.id, asynchronous: true, view, answer: a => {
    const answers = view.questions!.map(q => {
      const value = a.answers?.[q.id]?.trim(); if (!value) throw Error('invalid_answer');
      return { question: q.question, answer: value };
    });
    return `本人から、Codexの質問への回答です。\n${JSON.stringify(answers)}\nこの回答を受けて依頼を続けてください。`;
  } };
}
