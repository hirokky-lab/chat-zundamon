import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {App} from '../src/App';
import {EMPTY_LOCAL_CHAT} from '../src/local-state';
import {createCloudLocalStateStore} from '../src/cloud-state';
import {SpeechPlaybackError} from '../src/sakura-speech';

const now='2026-09-12T02:00:00.000Z';
const profile={displayName:'テスト',addressingStyle:'san' as const,updatedAt:now};
const props={splashDurationMs:0,integratedUiEnabled:true,profileApi:{get:async()=>profile,save:async()=>profile},now:()=>now,nextId:()=>crypto.randomUUID()};
const snapshot={...EMPTY_LOCAL_CHAT,lastOpeningAt:now};
const reply=async({clientMessageId}:{clientMessageId:string})=>({replyGroupId:`${clientMessageId}:assistant`,bubbles:[{id:`${clientMessageId}:assistant:0`,text:'返答なのだ。',createdAt:now,sequence:0 as const}]});

it('clears an audio error after actual playback recovery in the current character UI',async()=>{
 let failed=true;
 render(<App {...props} chatStore={{load:async()=>snapshot,save:async()=>{}}} chatApi={{respond:reply}}
  createAvatarSpeechPlayer={()=>({close(){},play:async(_text,_signal,onStart)=>{if(failed)throw new SpeechPlaybackError('request');onStart?.();}})}/>);
 const composer=await screen.findByRole('textbox',{name:'メッセージ'});
 await waitFor(()=>expect(composer).toBeEnabled());
 fireEvent.change(composer,{target:{value:'一回目'}});fireEvent.click(screen.getByRole('button',{name:'メッセージを送信'}));
 expect(await screen.findByText(/音声を取得できませんでした/)).toBeVisible();
 failed=false;fireEvent.change(composer,{target:{value:'二回目'}});fireEvent.click(screen.getByRole('button',{name:'メッセージを送信'}));
 await waitFor(()=>expect(screen.queryByText(/音声を取得できませんでした/)).not.toBeInTheDocument());
});

it('retries a failed sync without losing the current conversation or regenerating a reply',async()=>{
 let blocked=false,revision=0;
 const respond=vi.fn(reply);
 const store=createCloudLocalStateStore({now:()=>now,cache:{load:async()=>snapshot,save:async()=>{}},remote:{
  load:async()=>({...snapshot,version:3,revision,updatedAt:now}),
  save:async({snapshot:input})=>{if(blocked)throw Error('offline');return {...input,revision:++revision};},
 }});
 render(<App {...props} requirePersistBeforeChat chatStore={store} chatApi={{respond}} createAvatarSpeechPlayer={()=>({play:async(_t,_s,start)=>start?.(),close(){}})}/>);
 const composer=await screen.findByRole('textbox',{name:'メッセージ'});await waitFor(()=>expect(composer).toBeEnabled());
 blocked=true;fireEvent.change(composer,{target:{value:'残してほしい文章'}});fireEvent.click(screen.getByRole('button',{name:'メッセージを送信'}));
 expect(await screen.findByText(/クラウドに保存できていません/)).toBeVisible();
 blocked=false;fireEvent.click(screen.getByRole('button',{name:'保存を再試行'}));
 await waitFor(()=>expect(screen.queryByText(/クラウドに保存できていません/)).not.toBeInTheDocument());
 fireEvent.click(screen.getByRole('button',{name:'トークを開く'}));
 expect(screen.getByLabelText('ずんだもんとの会話')).toHaveTextContent('残してほしい文章');
 expect(respond).not.toHaveBeenCalled();
});

it('does not create an empty replacement conversation when cloud hydration fails',async()=>{
 const save=vi.fn(),respond=vi.fn(reply);
 render(<App {...props} requirePersistBeforeChat chatStore={{load:async()=>{throw Error('offline');},save}} chatApi={{respond}}/>);
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
 expect(save).not.toHaveBeenCalled();expect(respond).not.toHaveBeenCalled();
 expect(await screen.findByText(/設定を読み込めませんでした/)).toBeVisible();
});

it('stops narration without losing the delivered reply or restarting late speech',async()=>{
 let audioSignal: AbortSignal | undefined;
 let finish!:()=>void;
 const play=vi.fn(async(_text:string,signal?:AbortSignal,onStart?:()=>void)=>{
  audioSignal=signal;onStart?.();await new Promise<void>(resolve=>{finish=resolve;});
 });
 render(<App {...props} chatStore={{load:async()=>snapshot,save:async()=>{}}} chatApi={{respond:reply}}
  createAvatarSpeechPlayer={()=>({close(){},play})}/>);
 const composer=await screen.findByRole('textbox',{name:'メッセージ'});
 await waitFor(()=>expect(composer).toBeEnabled());
 fireEvent.change(composer,{target:{value:'話して'}});fireEvent.click(screen.getByRole('button',{name:'メッセージを送信'}));
 await waitFor(()=>expect(play).toHaveBeenCalledOnce());
 fireEvent.click(screen.getByRole('button',{name:'生成を停止'}));
 expect(audioSignal?.aborted).toBe(true);
 expect(screen.queryByRole('button',{name:'生成を停止'})).not.toBeInTheDocument();
 expect(screen.getByLabelText('ずんだもんの今のセリフ')).toHaveTextContent('返答なのだ。');
 await act(async()=>finish());
 expect(play).toHaveBeenCalledOnce();
 expect(screen.getByRole('button',{name:'メッセージを送信'})).toBeInTheDocument();
});

it('restores an interrupted search as retryable text and lets the user stop a new search',async()=>{
 const old={id:'old-search',type:'message' as const,role:'user' as const,text:'最新ニュースを検索して',createdAt:now,delivery:'sending' as const};
 let signal:AbortSignal|undefined;
 const respond=vi.fn(async(_input:unknown,abortSignal?:AbortSignal)=>{signal=abortSignal;return new Promise<never>(()=>{});});
 render(<App {...props} chatStore={{load:async()=>({...snapshot,timeline:[old]}),save:async()=>{}}} chatApi={{respond}}/>);
 const composer=await screen.findByRole('textbox',{name:'メッセージ'});
 await waitFor(()=>expect(composer).toBeEnabled());
 expect(screen.queryByRole('button',{name:'生成を停止'})).not.toBeInTheDocument();
 expect(screen.queryByRole('status',{name:'検索中'})).not.toBeInTheDocument();
 expect(respond).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'トークを開く'}));
 expect(screen.getByText('前回の返答は中断されました。もう一度送れます。')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'もう一度送る'}));
 await waitFor(()=>expect(respond).toHaveBeenCalledOnce());
 expect(screen.getByRole('status',{name:'検索中'})).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'生成を停止'}));
 expect(signal?.aborted).toBe(true);
 expect(screen.queryByRole('status',{name:'検索中'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'生成を停止'})).not.toBeInTheDocument();
 expect(screen.getByLabelText('ずんだもんとの会話')).toHaveTextContent(old.text);
});
