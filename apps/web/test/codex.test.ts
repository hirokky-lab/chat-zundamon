import { describe, expect, it, vi } from 'vitest';
import { codexPrompt, withCodex, type CodexApi, type CodexJob } from '../src/codex';
import type { ChatRequest } from '../src/api';
const job: CodexJob = { id:'job',requestId:'request-1',prompt:'調査',status:'researching',message:'調査中',result:null,createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z' };
const input = (text: string): ChatRequest => ({ kind:'reply',clientMessageId:'request-1',timeline:[{type:'message',id:'request-1',role:'user',text,delivery:'sending',createdAt:job.createdAt}] });
function setup() {
  const api: CodexApi = {status:vi.fn(),answer:vi.fn(),latest:vi.fn(async()=>({...job,status:'completed' as const,result:'結果'})),start:vi.fn(async()=>({...job,status:'completed' as const,result:'READMEを確認しました。'})),get:vi.fn(async()=>job),cancel:vi.fn(async()=>({...job,status:'cancelled' as const}))};
  const normal = {respond:vi.fn()};const onJob=vi.fn(),onError=vi.fn();
  return {api,normal,onJob,onError,chat:withCodex(normal,api,onJob,onError)};
}
describe('Codex chat dispatch',()=>{
  it('only recognizes an explicit request to Codex',async()=>{
    expect(codexPrompt('CodexにVRMの仕組みを調べて')).toBe('VRMの仕組みを調べて');
    expect(codexPrompt('Codexについて教えて')).toBeNull();
    expect(codexPrompt('Codexに停止動作の原因を調べて')).toBe('停止動作の原因を調べて');
    expect(codexPrompt('Codexに調査を停止して')).toBeNull();
    const {chat,normal,api}=setup();await chat.respond(input('Codexについて教えて'));
    expect(normal.respond).toHaveBeenCalledOnce();expect(api.start).not.toHaveBeenCalled();
  });
  it.each([
    ['コーデックスくんにサンプルアプリの進捗聞いて', 'サンプルアプリの進捗聞いて'],
    ['CodexさんにChatずんだもんの進捗きいて', 'Chatずんだもんの進捗きいて'],
    ['コーデックス君にこのアプリの状態を尋ねて', 'このアプリの状態を尋ねて'],
    ['ずんだもんAIの進捗確認して　コーデックス', 'ずんだもんAIの進捗確認して'],
    ['ずんだもんAIの進捗確認して、コーデックス。', 'ずんだもんAIの進捗確認して'],
    ['Codex、ずんだもんAIの進捗確認して', 'ずんだもんAIの進捗確認して'],
    ['VRMの問題を確認して codex', 'VRMの問題を確認して'],
    ['ずんだもんAIの進捗確認して。コーデックスでお願い', 'ずんだもんAIの進捗確認して。お願い'],
    ['ずんだもんAIの進捗をコーデックスでしらべて', 'ずんだもんAIの進捗をしらべて'],
    ['VRMの実装をCodexに調べてもらって', 'VRMの実装を調べてもらって'],
    ['Codexで、このアプリを調べて', 'このアプリを調べて'],
    ['コーデックスにVRMをしらべて', 'VRMをしらべて'],
    ['このアプリをCodexを使って確認して', 'このアプリを確認して'],
  ])('routes natural research requests: %s', async (text, prompt) => {
    const {chat,normal,api}=setup();
    const response=await chat.respond(input(text));
    expect(normal.respond).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledWith('request-1',prompt,undefined,expect.objectContaining({ context: '' }));
    expect(response.bubbles[0].text).toContain('READMEを確認しました');
  });
  it.each(['コーデックスくんについて聞いて', 'Codexに進捗を聞かないで', 'Codexで何ができる？','ネットでCodexについて調べて','Codexには依頼しないで、仕組みを教えて','Codexで調べないで','Codexに聞く方法を教えて','Codexの使い方を確認したい','Codexとは何か調べて','確認はCodexを使わないで'])('keeps ordinary or negative mentions in normal chat: %s', async text => {
    const {chat,normal,api}=setup();await chat.respond(input(text));
    expect(normal.respond).toHaveBeenCalledOnce();expect(api.start).not.toHaveBeenCalled();
  });
  it('returns a research result as external-context talk bubbles',async()=>{
    const {chat,api}=setup();const reply=await chat.respond(input('CodexにREADMEを調べて'));
    expect(api.start).toHaveBeenCalledWith('request-1','READMEを調べて',undefined,expect.objectContaining({ context: '' }));
    expect(reply.replyGroupId).toBe('request-1:assistant');
    expect(reply.bubbles[0].text).toContain('READMEを確認しました');
    expect(reply.bubbles.every(bubble=>bubble.flow==='external_context'&&bubble.text.length<=400)).toBe(true);
  });
  it('keeps the complete summary within three bubbles', async () => {
    const {chat,api}=setup();
    const result='あ'.repeat(230)+'。'+'い'.repeat(850);
    vi.mocked(api.start).mockResolvedValue({...job,status:'completed',result});
    const response=await chat.respond(input('Codexに調査して'));
    expect(response.bubbles.map(b=>b.text).join('')).toBe('Codexの作業結果なのだ。\n'+result);
    expect(response.bubbles.length).toBeLessThanOrEqual(3);
  });
  it('fetches the existing result without starting another task',async()=>{
    const {chat,api}=setup();expect((await chat.respond(input('Codexの結果を見せて'))).bubbles[0].text).toContain('結果');expect(api.start).not.toHaveBeenCalled();
  });
  it('stops by request key even when creation has not returned',async()=>{
    const {chat,api}=setup();const controller=new AbortController();
    vi.mocked(api.start).mockImplementation((_id,_prompt,signal)=>new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))));
    const pending=chat.respond(input('Codexに調査して'),controller.signal);
    controller.abort();await expect(pending).rejects.toThrow('Aborted');
    expect(api.cancel).toHaveBeenCalledWith('request-1');
  });
  it('keeps background work when the chat controller unmounts',async()=>{
    const {chat,api}=setup();const controller=new AbortController();
    vi.mocked(api.start).mockImplementation((_id,_prompt,signal)=>new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))));
    const pending=chat.respond(input('Codexに調査して'),controller.signal);
    controller.abort('chat-disposed');await expect(pending).rejects.toThrow('Aborted');expect(api.cancel).not.toHaveBeenCalled();
  });
});

function followup(text: string, prior = 'コーデックスくんにサンプルアプリの進捗聞いて'): ChatRequest {
 const request=input(prior);
 return {...request,clientMessageId:'followup',timeline:[...request.timeline,{type:'message',id:'followup',role:'user',text,delivery:'sending',createdAt:job.createdAt}]};
}
it.each(['今は待ち？','まだ？','終わった？','今どうなってる？'])('checks the referenced Codex job for %s without web search or another task',async text=>{
 const {chat,api,normal,onJob}=setup();
 vi.mocked(api.get).mockResolvedValue({...job,status:'waiting'});
 const response=await chat.respond(followup(text));
 expect(api.get).toHaveBeenCalledWith('request-1',undefined);
 expect(api.latest).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled();expect(normal.respond).not.toHaveBeenCalled();
 expect(onJob).toHaveBeenCalled();expect(response.bubbles[0].text).toContain('回答待ち');
});
it('does not substitute an unrelated historical job when the original request was never accepted',async()=>{
 const {chat,api,normal,onJob}=setup();
 vi.mocked(api.get).mockRejectedValue(Error('not found'));
 const response=await chat.respond(followup('今は待ち？'));
 expect(response.bubbles[0].text).toContain('まだ分からない');
 expect(api.latest).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled();expect(normal.respond).not.toHaveBeenCalled();expect(onJob).not.toHaveBeenCalled();
});
it.each(['working','completed','cancelled','failed'] as const)('reports the actual %s state on follow-up',async status=>{
 const {chat,api,normal}=setup();vi.mocked(api.get).mockResolvedValue({...job,status});
 const response=await chat.respond(followup('今は待ち？'));
 expect(response.bubbles[0].text).toContain({working:'作業中',completed:'完了',cancelled:'停止',failed:'エラー'}[status]);
 expect(normal.respond).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled();
});
it('keeps follow-up context across status questions but stops at a different topic',async()=>{
 const {chat,api,normal}=setup();
 const first=followup('今は待ち？');
 await chat.respond({...first,clientMessageId:'followup-2',timeline:[...first.timeline,{type:'message',id:'followup-2',role:'user',text:'終わった？',delivery:'sending',createdAt:job.createdAt}]});
 expect(api.get).toHaveBeenCalledWith('request-1',undefined);
 vi.mocked(api.get).mockClear();
 await chat.respond(followup('今は待ち？','料理の話をしよう'));
 expect(api.get).not.toHaveBeenCalled();expect(normal.respond).toHaveBeenCalledOnce();
});
it('handles an explicit Codex status question even without a prior request in the chat',async()=>{
 const {chat,api,normal}=setup();
 const response=await chat.respond(input('Codexの進捗は？'));
 expect(api.latest).toHaveBeenCalledOnce();expect(api.start).not.toHaveBeenCalled();expect(normal.respond).not.toHaveBeenCalled();
 expect(response.bubbles[0].text).toContain('完了');
});
