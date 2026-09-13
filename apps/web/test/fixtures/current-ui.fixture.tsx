import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from '../../src/App';
import {createMemoryLocalStateStore,EMPTY_LOCAL_CHAT} from '../../src/local-state';
import {wallpaperRecord} from '../../src/wallpaper';
import {createZundamonModelManifest} from '../../src/live2d/zundamon-model-manifest';
import {trackInputModality} from '../../src/input-modality';
import '../../src/styles.css';import '../../src/dark-mode.css';
const scope='acceptance-fiction-only';
const now='2026-09-13T03:00:00.000Z';
const lifeServicesApi={getSettings:async()=>({revision:0,home:null,calendar:null,tasks:null}),saveSettings:async settings=>({...settings,revision:settings.revision+1})} as any;
const texts=['今日はちょっと疲れたな。','おつかれさまなのだ。少し休んで、おしゃべりしよう。','何か気分転換したい。','好きな音楽をかけて、ひと息つくのはどうなのだ？'];
const store=createMemoryLocalStateStore();
await store.save({...EMPTY_LOCAL_CHAT,lastOpeningAt:now,lastConversationAt:now,timeline:texts.map((text,i)=>({id:'demo-'+i,type:'message',role:i%2?'assistant':'user',text,createdAt:now,delivery:'sent'}))} as any);
const profile={displayName:'ゲスト',addressingStyle:'san' as const,updatedAt:now};
await wallpaperRecord(scope,{theme:'edamame',tone:new URLSearchParams(location.search).has('night')?'night':'day',mode:new URLSearchParams(location.search).has('night')?'dark':'light',x:50,y:50});
trackInputModality();
// Default acceptance uses the real static fallback; no private SDK/model material is required.
const model=new URLSearchParams(location.search).has('live2d') ? createZundamonModelManifest((await fetch('/live2d/zundamon/local-bridge.json').then(r=>r.json())).sha256) : undefined;
const job={id:'demo-codex',requestId:'demo-request',prompt:'Codexに、アプリの改善案を整理してと頼んで',status:'completed',message:'作業が完了しました。',result:'改善案を3つに整理しました。\n1. 使い始めの案内\n2. 音声の聞きやすさ\n3. スマホでの使いやすさ',createdAt:now,updatedAt:now};
let lastJob:any=null;
const codex={status:async()=>({enabled:true,connected:true,projects:[]}),latest:async()=>lastJob,get:async()=>lastJob??job,start:async(requestId:string)=>{lastJob={...job,requestId};return lastJob;},cancel:async()=>job,answer:async()=>job} as any;
createRoot(document.getElementById('root')!).render(<App wallpaperScope={scope} splashDurationMs={0} integratedUiEnabled lifeServicesApi={lifeServicesApi} chatStore={store} automaticMemoryEnabled={false}
 profileApi={{get:async()=>profile,save:async input=>({...input,updatedAt:now})}}
 chatApi={{respond:async input=>({replyGroupId:input.clientMessageId+':reply',bubbles:[{id:input.clientMessageId+':reply:0',sequence:0,createdAt:now,text:input.kind==='external_context'?'改善案を3つに整理したのだ。続きもCodexにお願いできるのだ。':'おつかれさまなのだ。少し休んで、おしゃべりしよう。'}]})}}
 memoryApi={{list:async()=>[],getSettings:async()=>({memoryEnabled:false,updatedAt:null}),listTombstones:async()=>[]} as any}
 realtimeClient={dispatch=>({start:async()=>{dispatch({type:'connected'});dispatch({type:'microphone',enabled:true});dispatch({type:'transcript',turn:{role:'user',text:'今日は何を話そう？'}});dispatch({type:'transcript',turn:{role:'assistant',text:'今日あったことを、気軽に聞かせてほしいのだ。'}});dispatch({type:'listening'});},stop:()=>dispatch({type:'stopped'})})}
 bgmApi={{load:async()=>{const b=new ArrayBuffer(44+16000);const v=new DataView(b); const str=(at:number,s:string)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};str(0,'RIFF');v.setUint32(4,b.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,16000,true);return b;}}}
 codexApi={codex}
 live2dAvatarEnabled live2dModel={model}
 createAvatarSpeechPlayer={()=>({play:async(_text,_signal,onStart)=>{onStart?.();},close:()=>{}})}
 now={()=>now}/>)
